import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AiGates,
  aiCost,
  aiSettings,
  householdAi,
  RETRY_DELAYS_MS,
  runAiRetries,
  startAiRetries,
} from "../ai/index.ts";
import { newAiKey, type StubMessage, StubModels } from "../ai/testing.ts";
import { markNotAProblem } from "../anomalies/index.ts";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import {
  addGoal,
  deleteRemovedConnection,
  listInsightCards,
  markConnectionRemoved,
  readAiRetry,
  storeAlerts,
  storeMonthlyReview,
} from "../db/index.ts";
import { followUpAgain, runFollowUp } from "../follow-up/index.ts";
import { householdTimeZone, saveHouseholdFacts } from "../household/index.ts";
import { scheduledTasks } from "../jobs/list.ts";
import { createScheduler } from "../jobs/scheduler.ts";
import type { LogFields, Logger } from "../log.ts";
import { tickPlanItem } from "../monthly-review/index.ts";
import { fixtureReview } from "../monthly-review/testing.ts";
import { propose, skipProposal } from "../proposals/index.ts";
import {
  INSIGHT_CARD_CHECK_SCHEDULE,
  INSIGHT_CARDS_REPLY,
  INSIGHT_CARDS_TASK,
  InsightCardCheckJob,
  insightCards,
  markInsightCard,
  startInsightCards,
} from "./index.ts";

// Insight cards (spec 08, Insight cards; When AI does not run; Failures; Limits on each call),
// through the daily Insight card check job and the follow-up job's last step: Transactions arrive
// through the fake adapter, and the AI is AI SDK test models, on a
// fake clock. No test calls an AI provider. The Household is in New York: on Nov 4, 2026, 6 AM
// there is 11:00 UTC.

const BANK = "fake-insight-bank";
const CARD = fakeAccount({
  id: "acc-card",
  name: "Everyday Card",
  type: "credit",
  subtype: "credit card",
  mask: "4821",
});
const PRICE = { input: 1_000_000, output: 2_000_000 };
const at = (iso: string) => new Date(iso);
// Nov 4, 2026, Household time.
const THREE_AM = at("2026-11-04T08:00:00.000Z");
const BEFORE_SIX = at("2026-11-04T10:59:00.000Z");
const SIX = at("2026-11-04T11:00:00.000Z");
const EIGHT_PM = at("2026-11-05T01:00:00.000Z");
const NEXT_SIX = at("2026-11-05T11:00:00.000Z");
const NEXT_DAY = at("2026-11-05T11:30:00.000Z");

type ReplyCard = Record<string, unknown>;

const card = (n: number, fields: ReplyCard = {}): ReplyCard => ({
  group: "worth_acting_on",
  about: `Topic ${n}`,
  figure: 40 + n,
  figureKind: "dollars",
  figureLabel: "a month",
  title: `Card ${n} title`,
  why: `Why card ${n} matters.`,
  nextStep: `Do step ${n} this week.`,
  picture: null,
  ...fields,
});
const cards = (count: number) => Array.from({ length: count }, (_, index) => card(index + 1));
const reply = (each: readonly ReplyCard[]) => JSON.stringify({ cards: each });

// The texts of a request's user messages, as the model read them: the summary, the task, and the
// feedback.
function userTexts(messages: readonly StubMessage[]): string[] {
  return messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => part.text ?? "").join(""),
    );
}

describe("Insight cards", () => {
  let bank: TestBank;
  let stub: StubModels;
  let stops: (() => void)[];
  let connectionId: string;
  let historyLoaded: boolean;
  let saveCalls: number;
  let lines: { level: string; message: string; fields?: LogFields }[];
  let txns = 0;

  const clock = () => new Date();
  const gates: AiGates = {
    historyLoaded: async () => historyLoaded,
    costCapPausedUntil: async () => undefined,
  };
  const logger: Logger = {
    info: (message, fields) => lines.push({ level: "info", message, fields }),
    warn: (message, fields) => lines.push({ level: "warn", message, fields }),
    error: (message, fields) => lines.push({ level: "error", message, fields }),
  };
  const aiOptions = () => ({
    database: bank.database,
    secrets: bank.secrets,
    makeModels: stub.makeModels,
    cost: aiCost({ database: bank.database }),
    gates,
    notices: { raise: async () => undefined, end: async () => undefined },
  });

  // The Writer calls of Insight card runs: every call after the two checks on save.
  const runs = () => stub.calls.length - saveCalls;
  const cardRows = () => listInsightCards(bank.database);

  // The daily Insight card check at 6 AM, which is also the Insight cards' AI retry.
  const sixAmCheck = () => new InsightCardCheckJob().run();

  // A sync that brings one new Transaction, posted unless `fields` says otherwise, with no
  // follow-up job.
  const arrive = async (fields: Partial<TxnRecord> = {}) => {
    txns += 1;
    bank.fake.addPages(BANK, {
      added: [
        fakeTxn({
          id: `t${txns}`,
          accountId: CARD.id,
          amount: -2_500,
          postedDate: "2026-11-03",
          merchantName: "Corner Bistro",
          ...fields,
        }),
      ],
    });
    await syncConnection(connectionId, clock);
  };
  // A sync, then the follow-up job.
  const sync = async (fields: Partial<TxnRecord> = {}) => {
    await arrive(fields);
    return runFollowUp(clock);
  };
  // A sync whose only page changes a stored Transaction, then the follow-up job.
  const change = async (id: string, fields: Partial<TxnRecord>) => {
    bank.fake.addPages(BANK, {
      changed: [
        fakeTxn({
          id,
          accountId: CARD.id,
          amount: -2_500,
          postedDate: "2026-11-03",
          merchantName: "Corner Bistro",
          ...fields,
        }),
      ],
    });
    await syncConnection(connectionId, clock);
    return runFollowUp(clock);
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: BEFORE_SIX });
    stops = [];
    txns = 0;
    bank = await newTestBank();
    stub = new StubModels();
    stub.reply = reply(cards(4));
    historyLoaded = true;
    lines = [];
    for (const [id, name] of [
      ["member-1", "Dana Okafor"],
      ["member-2", "Sam Okafor"],
    ] as const) {
      await bank.database.$client.execute({
        sql: `INSERT INTO members (id, name, email, created_at, updated_at)
              VALUES (?, ?, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
        args: [id, name, `${id}@example.com`],
      });
    }
    // ZIP 18950 is in New York's time zone.
    const facts = await saveHouseholdFacts(
      bank.database,
      { zipCode: "18950", ages: [41, 39], rentOrOwn: "rent" },
      "member-1",
      BEFORE_SIX,
    );
    expect(facts).toMatchObject({ saved: { timeZone: "America/New_York" } });
    const saved = await aiSettings(aiOptions()).save({
      provider: "anthropic",
      apiKey: newAiKey(),
      baseUrl: null,
      quickModel: "quick-model",
      writerModel: "writer-model",
      prices: { quick: PRICE, writer: PRICE },
    });
    expect(saved).toMatchObject({ saved: true });
    saveCalls = stub.calls.length;
    stops = [
      startInsightCards({
        database: bank.database,
        ai: householdAi(aiOptions()),
        now: clock,
        logger,
      }).stop,
    ];
    connectionId = await bank.connect(BANK);
    bank.fake.addPages(BANK, { accounts: [CARD] });
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  it("runs once a day after 6 AM: the 6 AM check runs for a posted Transaction stored at 3 AM, with no sync after 6 AM", async () => {
    vi.setSystemTime(THREE_AM);
    // Before 6 AM, a follow-up job makes no run.
    expect(await sync()).toBeUndefined();
    expect(runs()).toBe(0);

    vi.setSystemTime(SIX);
    await sixAmCheck();
    expect(runs()).toBe(1);
    expect((await cardRows()).map((row) => row.title)).toEqual([
      "Card 1 title",
      "Card 2 title",
      "Card 3 title",
      "Card 4 title",
    ]);
    // The cards carry the moment the run started.
    expect((await cardRows())[0]?.writtenAt).toEqual(SIX);

    // With a run written today, a second check and later follow-up jobs that bring new posted
    // Transactions make no run.
    await sixAmCheck();
    vi.setSystemTime(at("2026-11-04T22:00:00.000Z"));
    await sync();
    await sync();
    expect(runs()).toBe(1);
  });

  it("runs the next day's 6 AM check for a Transaction stored at 8 PM, after the day's run", async () => {
    vi.setSystemTime(SIX);
    await sync();
    expect(runs()).toBe(1);

    vi.setSystemTime(EIGHT_PM);
    expect(await sync()).toBeUndefined();
    expect(runs()).toBe(1);

    // Not before 6 AM: neither the check nor a follow-up job.
    vi.setSystemTime(at("2026-11-05T10:59:00.000Z"));
    await sixAmCheck();
    await sync({ pending: true });
    expect(runs()).toBe(1);

    vi.setSystemTime(NEXT_SIX);
    await sixAmCheck();
    expect(runs()).toBe(2);
  });

  it("makes no AI call at 6 AM with no posted Transaction since the last run: a Member's edit, a change, or a pending one is not new, and one that posts is new from then", async () => {
    vi.setSystemTime(SIX);
    await sync();
    await sync({ pending: true });
    expect(runs()).toBe(1);

    vi.setSystemTime(EIGHT_PM);
    // A Member's edit makes t1 unhandled again, with no sync.
    const found = await bank.database.$client.execute(
      "SELECT id FROM transactions WHERE provider_transaction_id = 't1'",
    );
    await followUpAgain(bank.database, [String(found.rows[0]?.id)]);
    await runFollowUp(clock);
    // A sync whose only page changes the posted t1.
    await change("t1", { amount: -3_000 });

    vi.setSystemTime(NEXT_SIX);
    await sixAmCheck();
    expect(runs()).toBe(1);
    expect(await change("t1", { amount: -3_500 })).toBeUndefined();
    expect(runs()).toBe(1);

    // At 9 AM the pending t2 posts: it arrived now, so the follow-up job runs.
    vi.setSystemTime(at("2026-11-05T14:00:00.000Z"));
    await change("t2", { pending: false });
    expect(runs()).toBe(2);
    expect(await cardRows()).toHaveLength(4);
  });

  it("counts only posted Transactions that are shown: a pending one, or a posted one the bank removed, starts no run", async () => {
    vi.setSystemTime(THREE_AM);
    await arrive({ pending: true });
    await arrive();
    bank.fake.addPages(BANK, { removed: [{ id: "t2" }] });
    await syncConnection(connectionId, clock);

    vi.setSystemTime(SIX);
    await sixAmCheck();
    expect(await runFollowUp(clock)).toBeUndefined();
    expect(runs()).toBe(0);
    expect(await cardRows()).toEqual([]);

    // The pending t1 posts, and arrives now.
    await change("t1", { pending: false });
    expect(runs()).toBe(1);
  });

  it("runs the 6 AM check once at the next start when the app was down at 6 AM", async () => {
    const task = scheduledTasks.find((each) => each.name === "insight card check");
    expect(task?.schedule).toBe(INSIGHT_CARD_CHECK_SCHEDULE);
    const scheduler = createScheduler({
      database: bank.database,
      tasks: task === undefined ? [] : [task],
      timeZone: () => householdTimeZone(bank.database),
      now: clock,
      startTask: (started) => new started.job().run(),
    });
    // The last tick before the app stops, at 3 AM, finds the next run at 6 AM.
    vi.setSystemTime(THREE_AM);
    await arrive();
    expect(await scheduler.tick()).toEqual([]);

    // The app is down at 6 AM. The tick at the next start, at 9 AM, runs the check once.
    vi.setSystemTime(at("2026-11-04T14:00:00.000Z"));
    expect(await scheduler.tick()).toEqual(["insight card check"]);
    expect(runs()).toBe(1);
    vi.setSystemTime(at("2026-11-04T14:01:00.000Z"));
    expect(await scheduler.tick()).toEqual([]);
    expect(runs()).toBe(1);
  });

  it("counts the new posted Transactions a sync stored before it failed", async () => {
    vi.setSystemTime(SIX);
    // Page 1 adds t1; the request for page 2 fails.
    bank.fake.addPages(
      BANK,
      {
        added: [
          fakeTxn({ id: "t1", accountId: CARD.id, amount: -2_500, postedDate: "2026-11-03" }),
        ],
      },
      {
        added: [
          fakeTxn({ id: "t2", accountId: CARD.id, amount: -1_500, postedDate: "2026-11-03" }),
        ],
      },
    );
    bank.fake.failAt(BANK, 2, "temporary");
    await syncConnection(connectionId, clock).catch(() => undefined);
    const stored = await bank.database.$client.execute(
      "SELECT provider_transaction_id AS id FROM transactions",
    );
    expect(stored.rows.map((row) => row.id)).toEqual(["t1"]);

    await runFollowUp(clock);
    expect(runs()).toBe(1);
  });

  it("are deleted, Done marks and all, by Delete history, as their words come from that history", async () => {
    vi.setSystemTime(SIX);
    await sync();
    const [first] = await cardRows();
    await markInsightCard(bank.database, {
      cardId: first?.id ?? "",
      memberId: "member-1",
      done: true,
    });
    expect(await cardRows()).toHaveLength(4);

    expect(await markConnectionRemoved(bank.database, connectionId, new Date())).toMatchObject({
      removed: true,
    });
    expect(await deleteRemovedConnection(bank.database, connectionId, new Date())).toBeDefined();

    expect(await cardRows()).toEqual([]);
    expect(await insightCards(bank.database)).toEqual([]);
  });

  it("replaces every current card with a new run's, Done marks and all, in the AI's order", async () => {
    vi.setSystemTime(SIX);
    await sync();
    const first = await cardRows();
    expect(
      await markInsightCard(bank.database, {
        cardId: first[0]?.id ?? "",
        memberId: "member-1",
        done: true,
      }),
    ).toBe(true);

    vi.setSystemTime(NEXT_DAY);
    stub.reply = reply([
      card(9, { group: "good_news", title: "Groceries came in under Budget" }),
      card(8, { group: "heads_up" }),
      card(7),
      card(6),
      card(5),
    ]);
    await sync();

    const next = await cardRows();
    expect(next.map((row) => row.title)).toEqual([
      "Groceries came in under Budget",
      "Card 8 title",
      "Card 7 title",
      "Card 6 title",
      "Card 5 title",
    ]);
    expect(next.every((row) => row.doneAt === null)).toBe(true);
    const firstIds = new Set(first.map((row) => row.id));
    expect(next.some((row) => firstIds.has(row.id))).toBe(false);
    // The AI box keeps the AI's order inside each group.
    expect((await insightCards(bank.database)).map((each) => [each.group, each.title])).toEqual([
      ["Good news", "Groceries came in under Budget"],
      ["Heads up", "Card 8 title"],
      ["Worth acting on", "Card 7 title"],
      ["Worth acting on", "Card 6 title"],
      ["Worth acting on", "Card 5 title"],
    ]);
  });

  it("takes 4 to 7 cards: 3 or 8 fail the schema", () => {
    expect(INSIGHT_CARDS_REPLY.safeParse({ cards: cards(3) }).success).toBe(false);
    expect(INSIGHT_CARDS_REPLY.safeParse({ cards: cards(4) }).success).toBe(true);
    expect(INSIGHT_CARDS_REPLY.safeParse({ cards: cards(7) }).success).toBe(true);
    expect(INSIGHT_CARDS_REPLY.safeParse({ cards: cards(8) }).success).toBe(false);
    // A card with a field off its list fails too.
    expect(
      INSIGHT_CARDS_REPLY.safeParse({ cards: [card(1, { group: "urgent" }), ...cards(3)] }).success,
    ).toBe(false);
  });

  it("retries a 3-card reply after 1, 5, and 30 minutes in the Insight card check job, then keeps the last cards, and a later follow-up job that day runs again", async () => {
    stops.push(
      startAiRetries({ database: bank.database, runners: { "insight cards": sixAmCheck } }).stop,
    );
    vi.setSystemTime(SIX);
    await sync();
    const kept = (await cardRows()).map((row) => row.id);

    vi.setSystemTime(EIGHT_PM);
    await arrive();
    vi.setSystemTime(NEXT_SIX);
    stub.reply = reply(cards(3));
    await sixAmCheck();
    expect(runs()).toBe(2);
    expect(await readAiRetry(bank.database, "insight cards")).toMatchObject({ failures: 1 });

    // Each retry is one call, until the last retry fails.
    for (const delay of RETRY_DELAYS_MS) {
      const before = runs();
      // The follow-up job a sync starts early makes no call while the retry waits.
      expect(await sync()).toBeUndefined();
      expect(await runAiRetries(clock())).toEqual([]);
      expect(runs()).toBe(before);
      vi.setSystemTime(Date.now() + delay);
      expect(await runAiRetries(clock())).toEqual(["insight cards"]);
      expect(runs()).toBe(before + 1);
    }
    expect(await readAiRetry(bank.database, "insight cards")).toBeUndefined();
    expect((await cardRows()).map((row) => row.id)).toEqual(kept);
    // The no-AI path is the end: nothing runs the check again by itself.
    const calls = runs();
    vi.setSystemTime(Date.now() + 60 * 60_000);
    expect(await runAiRetries(clock())).toEqual([]);
    expect(runs()).toBe(calls);

    // The failed run did not use up the day: the next follow-up job that day runs, though its sync
    // only changes a Transaction.
    stub.reply = reply(cards(5));
    await change("t1", { amount: -3_000 });
    expect(runs()).toBe(calls + 1);
    expect(await cardRows()).toHaveLength(5);
  });

  it("makes no call while AI is held back and keeps the last cards; the next follow-up job that day tries once more, with no loop", async () => {
    stops.push(
      startAiRetries({ database: bank.database, runners: { "insight cards": sixAmCheck } }).stop,
    );
    vi.setSystemTime(SIX);
    await sync();
    const kept = (await cardRows()).map((row) => row.id);

    vi.setSystemTime(EIGHT_PM);
    await arrive();
    vi.setSystemTime(NEXT_SIX);
    historyLoaded = false;
    await sixAmCheck();
    expect(runs()).toBe(1);
    expect((await cardRows()).map((row) => row.id)).toEqual(kept);
    expect((await insightCards(bank.database)).map((each) => each.id)).toEqual(kept);
    // The no-AI path waits for no retry, and nothing runs the check again by itself.
    expect(await readAiRetry(bank.database, "insight cards")).toBeUndefined();
    vi.setSystemTime(NEXT_DAY);
    expect(await runAiRetries(clock())).toEqual([]);
    expect(runs()).toBe(1);

    // The next follow-up job that day tries once more, though its sync only changes a Transaction.
    historyLoaded = true;
    await change("t1", { amount: -3_000 });
    expect(runs()).toBe(2);
    expect((await cardRows()).map((row) => row.id)).not.toEqual(kept);
    // Then the day is used up.
    await sync();
    await sixAmCheck();
    expect(runs()).toBe(2);
  });

  it("sends one Writer call with at most 1,000 reply tokens and no cache mark: the summary, then the task, then the feedback", async () => {
    vi.setSystemTime(SIX);
    await sync();

    expect(stub.calls.slice(saveCalls)).toEqual([
      { tier: "writer", modelId: "writer-model", maxOutputTokens: 8_000 },
    ]);
    const prompt = stub.prompts.at(-1) ?? [];
    expect(JSON.stringify(prompt)).not.toMatch(/cache_?control/i);
    const [summary, task, feedback] = userTexts(prompt);
    expect(summary).toMatch(/^Household summary\. /);
    expect(summary).toContain("## The month");
    expect(task).toBe(INSIGHT_CARDS_TASK);
    expect(feedback).toBe(
      [
        "Feedback: this is the first Insight card run, so none came before it.",
        "Cards a Member marked Done:",
        "- None.",
        'Alerts a Member marked "Not a problem":',
        "- None.",
        "Proposals a Member accepted or skipped:",
        "- None.",
        "Plan items a Member ticked in the latest Monthly review:",
        "- None.",
        "",
      ].join("\n"),
    );
  });

  it("sends the feedback since the last run as the model reads it: Done cards, Not a problem marks, closed Proposals, and plan ticks, with the app's numbers kept", async () => {
    await storeMonthlyReview(bank.database, {
      month: "2026-10",
      writtenAt: at("2026-11-01T14:00:00.000Z"),
      review: fixtureReview(),
    });
    await tickPlanItem(bank.database, {
      month: "2026-10",
      item: 0,
      memberId: "member-1",
      done: true,
    });
    const largeAlert = (id: string, category: string) => ({
      id,
      kind: "Large purchase" as const,
      createdAt: new Date(),
      facts: {
        kind: "Large purchase" as const,
        merchant: { id: null, name: "Bluebird Books" },
        amount: 84_000,
        date: "2026-11-03",
        budget: null,
      },
      text: "Large purchase: $840.00 at Bluebird Books on Nov 3.",
      category,
      state: "sent" as const,
      transactionIds: [],
    });
    const skipGoalAmount = async (words: string, category: string) => {
      const goalId = await addGoal(bank.database, {
        words,
        authorId: "member-1",
        date: "2026-11-04",
        target: { kind: "Category", category },
        change: null,
        deadline: null,
      });
      const shown = await propose(
        bank.database,
        {
          kind: "Goal amount",
          source: "Monthly review",
          runId: `review-${category}`,
          reason: "A set amount shows the Goal's progress.",
          goalId,
          goalAmount: 482_100,
        },
        new Date(),
      );
      expect(shown).toMatchObject({ outcome: "shown" });
      await skipProposal(
        bank.database,
        { id: shown.outcome === "shown" ? shown.id : "", memberId: "member-2" },
        new Date(),
      );
    };
    // Before the first run: a Not a problem mark and a skipped Proposal, which the next run's
    // feedback leaves out.
    await storeAlerts(bank.database, [largeAlert("early", "Games")]);
    await markNotAProblem(bank.database, "early", "member-1", new Date());
    await skipGoalAmount("Spend less on games", "Games");

    vi.setSystemTime(SIX);
    // The AI names a Member by name; the card stores the title as it wrote it.
    stub.reply = reply([
      card(1, { title: "Dana Okafor's lunches add up", about: "Restaurants" }),
      ...cards(3),
    ]);
    await sync();
    const [lunches] = await cardRows();
    expect(lunches?.title).toBe("Dana Okafor's lunches add up");
    await markInsightCard(bank.database, {
      cardId: lunches?.id ?? "",
      memberId: "member-2",
      done: true,
    });

    // After the run: a Not a problem mark, and a Proposal whose Goal amount's digits are the
    // card's last 4.
    vi.setSystemTime(at("2026-11-04T15:00:00.000Z"));
    await storeAlerts(bank.database, [largeAlert("large", "Books")]);
    await markNotAProblem(bank.database, "large", "member-1", new Date());
    vi.setSystemTime(at("2026-11-04T16:00:00.000Z"));
    await skipGoalAmount("Spend less on books", "Books");

    await tickPlanItem(
      bank.database,
      { month: "2026-10", item: 2, memberId: "member-2", done: true },
      new Date(),
    );

    vi.setSystemTime(NEXT_DAY);
    await sync();

    const feedback = userTexts(stub.prompts.at(-1) ?? []).at(-1) ?? "";
    expect(feedback).toBe(
      [
        "Feedback since the last Insight card run, on 2026-11-04:",
        "Cards a Member marked Done:",
        "- Restaurants: Dana Okafor's lunches add up",
        'Alerts a Member marked "Not a problem":',
        "- Large purchase Alert in Books from 2026-11-04, marked on 2026-11-04",
        "Proposals a Member accepted or skipped:",
        '- Skipped on 2026-11-04: Goal amount, from Monthly review: Goal amount of 4821.00 for the Goal "Spend less on books". Reason: "A set amount shows the Goal\'s progress."',
        "Plan items a Member ticked in the latest Monthly review:",
        "- Ticked on 2026-11-04: Drop one streaming service, Before Nov 15",
        "",
      ].join("\n"),
    );
    // No encoder escape puts a letter in the text.
    for (const text of userTexts(stub.prompts.at(-1) ?? [])) {
      expect(text).not.toMatch(/\\[A-Za-z]/);
    }
  });

  it("keeps a picture only as the menu takes it: a field the picture does not name means no picture", async () => {
    vi.setSystemTime(SIX);
    stub.reply = reply([
      card(1, { picture: { type: "trend", category: "Restaurants", merchants: null } }),
      card(2, { picture: { type: "cards", category: "Restaurants", merchants: null } }),
      card(3, {
        picture: { type: "days", category: "Restaurants", merchants: ["Corner Bistro"] },
      }),
      card(4, { picture: { type: "recurring", category: "  ", merchants: null } }),
      card(5, { picture: { type: "days", category: null, merchants: ["Corner Bistro"] } }),
      card(6, { picture: { type: "trend", category: "Restaurants", merchants: ["Shell"] } }),
      card(7, { picture: { type: "cards", category: null, merchants: null } }),
    ]);
    await sync();

    expect((await cardRows()).map((row) => row.picture)).toEqual([
      { type: "trend", category: "Restaurants" },
      null,
      null,
      null,
      { type: "days", merchants: ["Corner Bistro"] },
      null,
      { type: "cards" },
    ]);
    expect((await cardRows())[0]?.month).toBe("2026-11");
  });

  it("logs a check that throws by its error's name only, and the job goes on", async () => {
    vi.setSystemTime(SIX);
    await bank.database.$client.execute("DROP TABLE insight_cards");

    expect(await sync()).toBeUndefined();
    expect(lines).toContainEqual({
      level: "error",
      message: "The Insight card check failed",
      fields: { errorName: expect.any(String) },
    });
    expect(JSON.stringify(lines)).not.toMatch(/insight_cards|SELECT/);
    // Nothing is left for the step, so no job runs it again by itself.
    expect(await runFollowUp(clock)).toBeUndefined();
    expect(runs()).toBe(0);
    // The 6 AM check logs the same way and never fails, so Sidequest never runs it again.
    await expect(sixAmCheck()).resolves.toBeUndefined();
    expect(lines.filter((line) => line.level === "error")).toHaveLength(2);
  });
});
