import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AiGates, aiCost, aiSettings, householdAi, RETRY_DELAYS_MS } from "../ai/index.ts";
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
import { saveHouseholdFacts } from "../household/index.ts";
import type { LogFields, Logger } from "../log.ts";
import { tickPlanItem } from "../monthly-review/index.ts";
import { fixtureReview } from "../monthly-review/testing.ts";
import { propose, skipProposal } from "../proposals/index.ts";
import { householdHourOn } from "./cards.ts";
import {
  INSIGHT_CARDS_REPLY,
  INSIGHT_CARDS_TASK,
  insightCards,
  markInsightCard,
  startInsightCards,
} from "./index.ts";

describe("householdHourOn", () => {
  it("finds 6 AM on the Household's day, in summer and winter time", () => {
    const sixOn = (iso: string, timeZone: string) =>
      householdHourOn(new Date(iso), 6, timeZone).toISOString();
    expect(sixOn("2026-07-01T15:00:00.000Z", "America/New_York")).toBe("2026-07-01T10:00:00.000Z");
    expect(sixOn("2026-11-04T23:00:00.000Z", "America/New_York")).toBe("2026-11-04T11:00:00.000Z");
    expect(sixOn("2026-11-05T09:00:00.000Z", "America/Los_Angeles")).toBe(
      "2026-11-05T14:00:00.000Z",
    );
    // At 03:00 UTC on Nov 5, it is still Nov 4 in Los Angeles.
    expect(sixOn("2026-11-05T03:00:00.000Z", "America/Los_Angeles")).toBe(
      "2026-11-04T14:00:00.000Z",
    );
    // The day the clocks go back, and a zone east of UTC.
    expect(sixOn("2026-11-01T20:00:00.000Z", "America/New_York")).toBe("2026-11-01T11:00:00.000Z");
    expect(sixOn("2026-03-08T20:00:00.000Z", "America/New_York")).toBe("2026-03-08T10:00:00.000Z");
    expect(sixOn("2026-11-04T23:00:00.000Z", "Asia/Tokyo")).toBe("2026-11-04T21:00:00.000Z");
  });
});

// Insight cards (spec 08, Insight cards; Failures; Limits on each call), through the follow-up
// job's last step: Transactions arrive through the fake adapter, and the AI is AI SDK test models
// behind the real privacy filter, on a fake clock. No test calls an AI provider. The Household is
// in New York: on Nov 4, 2026, 6 AM there is 11:00 UTC.

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
const BEFORE_SIX = at("2026-11-04T10:59:00.000Z");
const SIX = at("2026-11-04T11:00:00.000Z");
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

  // A sync that brings one new Transaction, posted unless `fields` says otherwise, then the
  // follow-up job.
  const sync = async (fields: Partial<TxnRecord> = {}) => {
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
    const saved = await aiSettings(aiOptions()).save(
      {
        provider: "anthropic",
        apiKey: newAiKey(),
        baseUrl: null,
        quickModel: "quick-model",
        writerModel: "writer-model",
        prices: { quick: PRICE, writer: PRICE },
      },
      { freshCode: true },
    );
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

  it("runs once a day, on the first sync after 6 AM Household time that brings a new posted Transaction", async () => {
    // Before 6 AM, a posted Transaction starts no run.
    expect(await sync()).toBeUndefined();
    expect(runs()).toBe(0);

    vi.setSystemTime(SIX);
    // A sync that brings only a pending Transaction, or only hides one, starts no run.
    await sync({ pending: true });
    bank.fake.addPages(BANK, { removed: [{ id: "t1" }] });
    await syncConnection(connectionId, clock);
    await runFollowUp(clock);
    expect(runs()).toBe(0);
    expect(await cardRows()).toEqual([]);

    // The first posted one at 6 AM or later: one call writes every card.
    await sync();
    expect(runs()).toBe(1);
    expect((await cardRows()).map((row) => row.title)).toEqual([
      "Card 1 title",
      "Card 2 title",
      "Card 3 title",
      "Card 4 title",
    ]);

    // Later syncs that day make no call.
    vi.setSystemTime(at("2026-11-04T22:00:00.000Z"));
    await sync();
    await sync();
    expect(runs()).toBe(1);

    // The next day, not before 6 AM.
    vi.setSystemTime(at("2026-11-05T10:59:00.000Z"));
    await sync();
    expect(runs()).toBe(1);
    vi.setSystemTime(NEXT_DAY);
    await sync();
    expect(runs()).toBe(2);
  });

  it("starts no run from a Member's edit or a change to a posted Transaction, and does from a pending one that turns posted", async () => {
    const txn = (id: string, fields: Partial<TxnRecord> = {}) =>
      fakeTxn({
        id,
        accountId: CARD.id,
        amount: -2_500,
        postedDate: "2026-11-03",
        merchantName: "Corner Bistro",
        ...fields,
      });
    // Before 6 AM: t1 posted, t2 pending.
    await sync();
    await sync({ pending: true });
    expect(runs()).toBe(0);

    vi.setSystemTime(SIX);
    // A Member's edit makes t1 unhandled again, with no sync.
    const found = await bank.database.$client.execute(
      "SELECT id FROM transactions WHERE provider_transaction_id = 't1'",
    );
    await followUpAgain(bank.database, [String(found.rows[0]?.id)]);
    await runFollowUp(clock);
    expect(runs()).toBe(0);

    // A sync whose only page changes the posted t1.
    bank.fake.addPages(BANK, { changed: [txn("t1", { amount: -3_000 })] });
    await syncConnection(connectionId, clock);
    await runFollowUp(clock);
    expect(runs()).toBe(0);
    expect(await cardRows()).toEqual([]);

    // A sync that turns the pending t2 posted.
    bank.fake.addPages(BANK, { changed: [txn("t2", { pending: false })] });
    await syncConnection(connectionId, clock);
    await runFollowUp(clock);
    expect(runs()).toBe(1);
    expect(await cardRows()).toHaveLength(4);
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

    expect(await markConnectionRemoved(bank.database, connectionId, new Date())).toBe(true);
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

  it("retries a 3-card reply after 1, 5, and 30 minutes, then keeps the last cards, and a later sync that day runs again", async () => {
    vi.setSystemTime(SIX);
    await sync();
    const kept = (await cardRows()).map((row) => row.id);

    vi.setSystemTime(NEXT_DAY);
    stub.reply = reply(cards(3));
    expect(await sync()).toEqual({ stoppedAt: "insight card check", again: expect.any(Date) });
    expect(runs()).toBe(2);
    expect(await readAiRetry(bank.database, "insight cards")).toMatchObject({ failures: 1 });

    // Each retry is one call: the step stops again until the last retry fails, then ends.
    for (const delay of RETRY_DELAYS_MS) {
      const before = runs();
      // The follow-up job a sync starts early makes no call while the retry waits.
      expect(await runFollowUp(clock)).toMatchObject({ stoppedAt: "insight card check" });
      expect(runs()).toBe(before);
      vi.setSystemTime(Date.now() + delay);
      const run = await runFollowUp(clock);
      expect(runs()).toBe(before + 1);
      if (delay !== RETRY_DELAYS_MS.at(-1))
        expect(run).toMatchObject({ stoppedAt: "insight card check" });
      else expect(run).toBeUndefined();
    }
    expect(await readAiRetry(bank.database, "insight cards")).toBeUndefined();
    expect((await cardRows()).map((row) => row.id)).toEqual(kept);
    // Nothing is left for the step: no job runs it again by itself.
    const calls = runs();
    expect(await runFollowUp(clock)).toBeUndefined();
    expect(runs()).toBe(calls);

    // The failed run did not use up the day: the next sync that brings a posted Transaction runs.
    stub.reply = reply(cards(5));
    await sync();
    expect(runs()).toBe(calls + 1);
    expect(await cardRows()).toHaveLength(5);
  });

  it("makes no call while AI is held back, keeps the last cards, and the next sync that day runs", async () => {
    vi.setSystemTime(SIX);
    await sync();
    const kept = (await cardRows()).map((row) => row.id);

    vi.setSystemTime(NEXT_DAY);
    historyLoaded = false;
    expect(await sync()).toBeUndefined();
    expect(runs()).toBe(1);
    expect((await cardRows()).map((row) => row.id)).toEqual(kept);
    expect((await insightCards(bank.database)).map((each) => each.id)).toEqual(kept);

    historyLoaded = true;
    await sync();
    expect(runs()).toBe(2);
    expect((await cardRows()).map((row) => row.id)).not.toEqual(kept);
  });

  it("sends one Writer call with at most 1,000 reply tokens and no cache mark: the summary, then the task, then the feedback", async () => {
    vi.setSystemTime(SIX);
    await sync();

    expect(stub.calls.slice(saveCalls)).toEqual([
      { tier: "writer", modelId: "writer-model", maxOutputTokens: 1_000 },
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
    // The AI names a Member by label; the card stores the name for the screen.
    stub.reply = reply([
      card(1, { title: "Member A's lunches add up", about: "Restaurants" }),
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
        "- Restaurants: Member A's lunches add up",
        'Alerts a Member marked "Not a problem":',
        "- Large purchase Alert in Books from 2026-11-04, marked on 2026-11-04",
        "Proposals a Member accepted or skipped:",
        '- Skipped on 2026-11-04: Goal amount, from Monthly review: Goal amount of 4821.00 for the Goal "Spend less on books". Reason: "A set amount shows the Goal\'s progress."',
        "Plan items a Member ticked in the latest Monthly review:",
        "- Ticked on 2026-11-04: Drop one streaming service, Before Nov 15",
        "",
      ].join("\n"),
    );
    // No Member name reaches the model, and no encoder escape puts a letter in the text.
    const read = JSON.stringify(stub.prompts.at(-1));
    expect(read).not.toContain("Dana");
    expect(read).not.toContain("Okafor");
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

  it("logs a step that throws by its error's name only, and the job goes on", async () => {
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
  });
});
