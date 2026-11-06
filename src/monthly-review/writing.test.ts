import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AiGates,
  aiCost,
  aiSettings,
  householdAi,
  MONTHLY_REVIEW_RETRY_MS,
} from "../ai/index.ts";
import { newAiKey, type StubMessage, StubModels } from "../ai/testing.ts";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import {
  addGoal,
  endMonthlyReviewRun,
  listOpenNotices,
  readAiRetry,
  readMonthlyReviewRun,
  storeAiFailure,
  storeDecisions,
  storeFirstDraft,
  storeHouseholdFacts,
  storeMonthlyReviewReply,
  storeMonthlyReviewRetry,
} from "../db/index.ts";
import { markGoal, readGoalsWithProgress } from "../goals/index.ts";
import { householdTimeZone } from "../household/index.ts";
import { openReviewProposals, propose } from "../proposals/index.ts";
import {
  checkMonthlyReview,
  MONTHLY_REVIEW_TASK,
  markReviewDue,
  ON_THE_FIRST,
  REVIEW_STOPPED,
  REVIEW_WAIT_MS,
  type ReviewAnswer,
  readReview,
  reviewAnswer,
  startMonthlyReview,
} from "./index.ts";

// Writing the Monthly review (spec 08, Monthly review; Review fields; Every AI use; Limits on each
// call; Failures; The AI cost cap): when it is due, the one Writer call, the retries, and the
// review and its Proposals stored once. Transactions arrive through the fake adapter; the AI is AI
// SDK test models behind the real privacy filter. No test calls an AI provider. The Household time
// zone is New York: on Sunday, Nov 1, 2026, the clocks go back at 2 AM, so noon is 17:00 UTC.

const BANK = "fake-review-bank";
const CHECKING = fakeAccount({ id: "acc-checking", mask: "4821" });
const PRICE = { input: 1_000_000, output: 2_000_000 };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const $ = (dollars: number) => Math.round(dollars * 100);

// Times on Nov 1, Household time, in Eastern Standard Time after 2 AM.
const ON_THE_1ST = (time: string) => new Date(`2026-11-01T${time}:00.000-05:00`);
const NOON = ON_THE_1ST("12:00");

// A card number that passes the Luhn check, made at test time. Its digits are drawn from 3, 5, 6,
// and 9, so no group of it is the Account's last 4.
function newCardNumber(): string {
  const digits = [
    4,
    ...Array.from({ length: 14 }, () => [3, 5, 6, 9][Math.floor(Math.random() * 4)] ?? 3),
  ];
  const doubled = (digit: number) => (digit * 2 > 9 ? digit * 2 - 9 : digit * 2);
  const sum = digits
    .toReversed()
    .reduce((total, digit, place) => total + (place % 2 === 0 ? doubled(digit) : digit), 0);
  return [...digits, (10 - (sum % 10)) % 10].join("");
}

// A reply that fits the review fields, with a line for each of `goals` Goals.
function answerOf(goals: number, fields: Partial<ReviewAnswer> = {}): ReviewAnswer {
  return {
    headline: "Takeout carried October, and the card still holds a balance.",
    habits: [
      {
        name: "Takeout fills the busy nights",
        line: "Most delivery orders land late in the week.",
        costMonth: 420,
        picture: { type: "days", category: "Restaurants", merchants: null },
      },
      {
        name: "The card never quite gets paid off",
        line: "Member A's card carried a balance into every month!",
        costMonth: 96,
        picture: { type: "cards", category: null, merchants: null },
      },
    ],
    ideas: [
      {
        idea: "Cook two more nights a week",
        savesMonth: 180,
        effort: "Some effort",
        kind: "Habit",
        habit: 0,
        why: "Eight orders at $45 is $360; cooking two of those nights saves about $180.",
        catch: "It needs a plan for the busiest nights.",
      },
      {
        idea: "Pay the statement in full",
        savesMonth: 96,
        effort: "Big step",
        kind: "Debt",
        habit: 1,
        why: "At 24.99% APR, $4,600 carried costs about $96 a month.",
        catch: null,
      },
      {
        idea: "Drop one streaming service",
        savesMonth: 17,
        effort: "Easy",
        kind: "Recurring charge",
        habit: null,
        why: "Two services carry the same shows; the smaller one is $17 a month.",
        catch: null,
      },
      {
        idea: "Order takeout for pickup",
        savesMonth: 60,
        effort: "Easy",
        kind: "Habit",
        habit: 0,
        why: "Delivery fees and tips added $60 to October's orders.",
        catch: null,
      },
      {
        idea: "Shop the insurance renewal",
        savesMonth: 40,
        effort: "Some effort",
        kind: "Bill",
        habit: null,
        why: "The car insurance renews in December at $180 a month.",
        catch: "Quotes take an evening.",
      },
    ],
    plan: [
      { idea: 0, when: "Starting this week" },
      { idea: 1, when: "By the next due date" },
      { idea: 2, when: "Before Nov 15" },
    ],
    goals: Array.from({ length: goals }, (_, index) => ({
      goal: index + 1,
      line: "Cooking two more nights moves this about $180.",
    })),
    budgetChanges: [
      {
        category: "Restaurants",
        newAmount: 450,
        reason: "Takeout ran over, so a smaller Budget keeps it in view.",
      },
    ],
    ...fields,
  };
}

// The user texts of one request, as the model read them after the privacy filter.
const userTexts = (messages: StubMessage[]) =>
  messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => part.text ?? "").join(""),
    );

describe("writing the Monthly review", () => {
  let bank: TestBank;
  let stub: StubModels;
  let stops: (() => void)[];
  let connectionId: string;
  let goalId: string;
  let pausedUntil: string | undefined;
  // What the Writer answers, given how many Goals the call lists.
  let answer: (goals: number) => unknown;
  // The review calls the model answered: the texts after the task, as the model read them.
  let asked: { summary: string; goals: string }[];
  let writerBase: number;
  const ids = new Map<string, string>();

  const gates: AiGates = {
    historyLoaded: async () => true,
    costCapPausedUntil: async () => pausedUntil,
  };
  const aiOptions = () => ({
    database: bank.database,
    secrets: bank.secrets,
    makeModels: stub.makeModels,
    cost: aiCost({ database: bank.database }),
    gates,
    notices: { raise: async () => undefined, end: async () => undefined },
  });
  const connectAi = async () => {
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
    writerBase = stub.calls.filter((call) => call.tier === "writer").length;
  };
  // Writer calls made since the AI was set up, failed ones included.
  const writerCalls = () => stub.calls.filter((call) => call.tier === "writer").length - writerBase;

  const at = (moment: Date) => vi.setSystemTime(moment);
  const check = (moment: Date) => {
    at(moment);
    return checkMonthlyReview();
  };

  // Syncs Transactions on checking with their parts, as Money movement and Categorization would
  // store them.
  const load = async (
    txns: { id: string; date: string; merchant: string; dollars: number; category: string }[],
    syncedAt: Date,
  ) => {
    bank.fake.addPages(BANK, {
      accounts: [CHECKING],
      added: txns.map((txn) =>
        fakeTxn({
          id: txn.id,
          accountId: CHECKING.id,
          amount: $(txn.dollars),
          postedDate: txn.date,
          merchantName: txn.merchant,
        }),
      ),
    });
    await syncConnection(connectionId, () => syncedAt);
    const rows = await bank.database.$client.execute(
      "SELECT id, provider_transaction_id FROM transactions",
    );
    for (const row of rows.rows) ids.set(String(row.provider_transaction_id), String(row.id));
    await storeDecisions(
      bank.database,
      txns.map((txn) => ({
        transactionId: ids.get(txn.id) ?? "",
        step: "5.7",
        provisionalUntil: null,
        decidedAt: syncedAt,
        parts: [
          {
            type: txn.dollars < 0 ? "Spending" : "Refund",
            amount: $(txn.dollars),
            category: txn.category,
          },
        ],
      })),
    );
  };

  const reviewProposals = async () =>
    (
      await bank.database.$client.execute(
        "SELECT source, run_id, status FROM proposals WHERE source = 'Monthly review'",
      )
    ).rows.map((row) => ({ ...row }));

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-31T12:00:00.000-04:00") });
    ids.clear();
    asked = [];
    pausedUntil = undefined;
    answer = (goals) => answerOf(goals);
    bank = await newTestBank();
    stub = new StubModels();
    stub.replyTo = (messages) => {
      const texts = userTexts(messages);
      const task = texts.indexOf(MONTHLY_REVIEW_TASK);
      if (task === -1) return "O";
      const goals = texts[task + 1] ?? "";
      asked.push({ summary: texts.slice(0, task).join("\n"), goals });
      return JSON.stringify(answer([...goals.matchAll(/^\d+\. "/gm)].length));
    };
    const ai = householdAi(aiOptions());
    stops = [startMonthlyReview({ database: bank.database, ai }).stop];
    await storeHouseholdFacts(bank.database, {
      zipCode: "10001",
      state: "NY",
      timeZone: "America/New_York",
      ages: [41, 39, 8],
      rentOrOwn: "rent",
      updatedAt: new Date("2026-10-01T00:00:00.000Z"),
      updatedBy: null,
    });
    await bank.database.$client.execute({
      sql: "INSERT INTO members (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      args: [
        "member-1",
        "Dana Okafor",
        "dana.okafor@example.com",
        "2026-10-01T00:00:00.000Z",
        "2026-10-01T00:00:00.000Z",
      ],
    });
    await storeFirstDraft(bank.database, {
      inputs: {
        steadyIncome: $(6_000),
        ceDataYear: 2024,
        sampleBenchmarks: false,
        firstDraftMonth: "2026-10",
        fixedCostsPassIncome: false,
        recordedAt: new Date("2026-10-01T15:00:00.000Z"),
      },
      budgets: [
        {
          category: "Restaurants",
          amount: $(500),
          period: "monthly",
          takesEffect: "2026-10",
          source: "formula",
          setBy: null,
          pinned: null,
          setAt: new Date("2026-10-01T15:00:00.000Z"),
        },
        {
          category: "Groceries",
          amount: $(600),
          period: "monthly",
          takesEffect: "2026-10",
          source: "formula",
          setBy: null,
          pinned: null,
          setAt: new Date("2026-10-01T15:00:00.000Z"),
        },
      ],
    });
    goalId = await addGoal(bank.database, {
      words: "Spend less on eating out",
      authorId: "member-1",
      date: "2026-10-05",
      target: { kind: "Category", category: "Restaurants" },
      change: { amount: $(100) },
      deadline: null,
    });
    connectionId = await bank.connect(BANK, "Review Bank");
    // October's Spending, synced on Oct 31.
    await load(
      [
        {
          id: "bistro",
          date: "2026-10-09",
          merchant: "Corner Bistro",
          dollars: -62,
          category: "Restaurants",
        },
        {
          id: "noodles",
          date: "2026-10-23",
          merchant: "Noodle Bar",
          dollars: -48,
          category: "Restaurants",
        },
      ],
      new Date("2026-10-31T20:00:00.000Z"),
    );
    // The task on the 1st, at midnight.
    at(ON_THE_1ST("00:00"));
    expect(await markReviewDue(bank.database)).toBe("2026-10");
  });

  afterEach(() => {
    for (const stop of stops) stop();
    bank.close();
    vi.useRealTimers();
  });

  it("comes due at midnight on the 1st, Household time, and a 1st missed while the app was down comes due at the next start", () => {
    const zone = "America/New_York";
    // A new install waits for its first 1st.
    expect(ON_THE_FIRST.next(new Date("2026-11-15T12:00:00.000Z"), zone)).toEqual(
      new Date("2026-12-01T05:00:00.000Z"),
    );
    expect(ON_THE_FIRST.next(new Date("2026-10-31T12:00:00.000Z"), zone)).toEqual(
      new Date("2026-11-01T04:00:00.000Z"),
    );
    expect(ON_THE_FIRST.next(new Date("2026-11-01T04:00:00.000Z"), zone)).toEqual(
      new Date("2026-12-01T05:00:00.000Z"),
    );
  });

  it("writes at noon on the 1st when a Healthy Connection has not synced that day", async () => {
    await connectAi();

    expect(await check(ON_THE_1ST("08:00"))).toBe("waits");
    expect(await check(ON_THE_1ST("11:59"))).toBe("waits");
    expect(writerCalls()).toBe(0);

    expect(await check(NOON)).toBe("written");
    expect(writerCalls()).toBe(1);
    const review = await readReview(bank.database, "2026-10");
    expect(review?.writtenAt).toEqual(NOON);
    expect(review?.review).toMatchObject({
      writtenOn: "2026-11-01",
      headline: "Takeout carried October, and the card still holds a balance.",
      // The plain voice, with the Member's name for "Member A". Amounts are stored in cents.
      habits: [
        { name: "Takeout fills the busy nights", costMonth: 42_000 },
        { line: "Dana Okafor's card carried a balance into every month.", costMonth: 9_600 },
      ],
      plan: [{ idea: 0 }, { idea: 1 }, { idea: 2 }],
      goals: [{ goalId, line: "Cooking two more nights moves this about $180." }],
    });
    expect(review?.review.ideas[0]?.savesMonth).toBe(18_000);
    expect((await readMonthlyReviewRun(bank.database, "2026-10"))?.outcome).toBe("written");
  });

  it("writes once every Healthy Connection has synced that day, before noon", async () => {
    await connectAi();
    // A Connection that needs a Member, a held one, and a removed one hold nothing back.
    for (const [bankId, set] of [
      ["fake-needs", "health = 'needs a member'"],
      ["fake-held", "sync_held = 1"],
      ["fake-removed", "removed_at = '2026-10-20T00:00:00.000Z'"],
    ] as const) {
      const id = await bank.connect(bankId);
      await bank.database.$client.execute({
        sql: `UPDATE connections SET ${set} WHERE id = ?`,
        args: [id],
      });
    }
    // A second Healthy Connection syncs at 7 AM; the first has not synced today.
    const second = await bank.connect("fake-second");
    bank.fake.addPages("fake-second", { accounts: [fakeAccount({ id: "acc-second" })] });
    await syncConnection(second, () => ON_THE_1ST("07:00"));
    expect(await check(ON_THE_1ST("07:01"))).toBe("waits");

    bank.fake.addPages(BANK, { accounts: [CHECKING] });
    await syncConnection(connectionId, () => ON_THE_1ST("08:00"));
    expect(await check(ON_THE_1ST("08:01"))).toBe("written");
    expect(writerCalls()).toBe(1);
  });

  it("writes a review the app missed on the 1st at once at the next start", async () => {
    await connectAi();
    // The app was down from Oct 31 to Nov 3: the scheduler runs the missed task once at start.
    at(new Date("2026-11-03T09:00:00.000-05:00"));
    expect(await markReviewDue(bank.database)).toBe("2026-10");
    expect(await checkMonthlyReview()).toBe("written");
    expect(writerCalls()).toBe(1);
  });

  it("rebuilds the summary for the month just ended and sends the rules, the Goals by number, no cache mark, and a 4,000-token limit", async () => {
    await connectAi();
    const card = newCardNumber();
    // A Goal whose words name a Member after a tab and glued, and hold a card number split by a
    // newline.
    await addGoal(bank.database, {
      words: `Dana\tOkafor wants to pay off ${card.slice(0, 8)}\n${card.slice(8)} with DanaOkafor`,
      authorId: "member-1",
      date: "2026-10-06",
      target: null,
      change: null,
      deadline: null,
    });

    expect(await check(NOON)).toBe("written");

    expect(stub.calls.slice(-1)).toEqual([
      { tier: "writer", modelId: "writer-model", maxOutputTokens: 4_000 },
    ]);
    const prompt = stub.prompts.at(-1) ?? [];
    expect(JSON.stringify(prompt)).not.toContain("cacheControl");
    expect(asked).toHaveLength(1);
    const { summary, goals } = asked[0] ?? { summary: "", goals: "" };
    // The summary is October's, and October's Spending is in it.
    expect(summary).toContain("2026-10");
    expect(summary).toContain("Restaurants");
    // The Habit rules and the idea rules.
    for (const rule of [
      "name: no numbers, and fewer than 8 words.",
      "under 16 words, with at most one number.",
      "Never judgmental. A one-off is not a Habit.",
      "Every idea comes from this Household's data",
      "Debt ideas compare real options with the math",
      "effort: Easy, Some effort, or Big step. kind: Habit, Recurring charge, Debt, or Bill.",
    ]) {
      expect(MONTHLY_REVIEW_TASK).toContain(rule);
    }
    // Each Goal by its number, as one line, never by its ID. The privacy filter read the exact
    // text the model read: no Member name, no card number, and no escape that puts a letter in a
    // number.
    expect(goals).toMatch(
      /^Active Goals, by number:\n1\. "Spend less on eating out"\n2\. "[^\n]*"$/,
    );
    expect(goals).not.toContain(goalId);
    expect(goals).not.toMatch(/Dana|Okafor/i);
    expect(goals.replace(/\D/g, "")).not.toContain(card);
    expect(goals).not.toMatch(/\\[A-Za-z]/);
    // Each Goal's line goes to its own Goal.
    const review = await readReview(bank.database, "2026-10");
    expect(review?.review.goals.map((goal) => goal.line)).toEqual([
      "Cooking two more nights moves this about $180.",
      "Cooking two more nights moves this about $180.",
    ]);
  });

  // Spec 05, Rules: done and dropped Goals leave the AI's context, though a Goal done this month
  // still shows with the active ones on the Goals page.
  it("sends only the active Goals: a Goal done this month is not in the call", async () => {
    await connectAi();
    const done = await addGoal(bank.database, {
      words: "Put money aside for the beach trip",
      authorId: "member-1",
      date: "2026-10-06",
      target: null,
      change: null,
      deadline: null,
    });
    expect(await markGoal(bank.database, done, "done", "member-1", ON_THE_1ST("00:00"))).toBe(
      "marked",
    );
    expect(
      (await readGoalsWithProgress(bank.database, NOON)).find((goal) => goal.id === done),
    ).toMatchObject({ status: "done", list: "active" });

    expect(await check(NOON)).toBe("written");

    expect(asked[0]?.goals).toBe('Active Goals, by number:\n1. "Spend less on eating out"');
    expect(JSON.stringify(stub.prompts.at(-1))).not.toContain("beach trip");
  });

  it("refuses a reply with 3 Budget changes, or one that breaks the review fields, as an AI error", async () => {
    const three = answerOf(1, {
      budgetChanges: ["Restaurants", "Groceries", "Shopping"].map((category) => ({
        category,
        newAmount: 400,
        reason: "It ran over.",
      })),
    });
    expect(reviewAnswer(1).safeParse(three).success).toBe(false);
    expect(reviewAnswer(1).safeParse(answerOf(1)).success).toBe(true);
    // One line for each Goal, each once; indexes that point at a Habit or idea; and the counts.
    expect(reviewAnswer(2).safeParse(answerOf(1)).success).toBe(false);
    const twice = answerOf(2);
    twice.goals[1] = { goal: 1, line: "Again." };
    expect(reviewAnswer(2).safeParse(twice).success).toBe(false);
    const ideas = answerOf(1);
    ideas.plan[0] = { idea: 9, when: "Soon" };
    expect(reviewAnswer(1).safeParse(ideas).success).toBe(false);
    expect(reviewAnswer(1).safeParse(answerOf(1, { habits: [] })).success).toBe(false);
    expect(reviewAnswer(1).safeParse(answerOf(1, { headline: "" })).success).toBe(false);

    // Through the call: no review and no Proposal, and the AI retry a minute later.
    await connectAi();
    answer = () => three;
    expect(await check(NOON)).toBe("waits");
    expect(writerCalls()).toBe(1);
    expect(await readReview(bank.database, "2026-10")).toBeUndefined();
    expect(await reviewProposals()).toEqual([]);
    expect((await readMonthlyReviewRun(bank.database, "2026-10"))?.retryAt).toEqual(
      new Date(NOON.getTime() + MINUTE),
    );
  });

  it("makes one Writer call a month: a second check, a check while the call runs, and a second due mark make none", async () => {
    await connectAi();
    let during: Promise<unknown> | undefined;
    stub.beforeAnswer = async () => {
      during ??= checkMonthlyReview();
    };

    expect(await check(NOON)).toBe("written");
    expect(await during).toBe("running");
    expect(await check(ON_THE_1ST("12:01"))).toBe("nothing due");
    expect(await markReviewDue(bank.database)).toBe("2026-10");
    expect(await check(ON_THE_1ST("13:00"))).toBe("nothing due");
    expect(await check(new Date("2026-11-20T12:00:00.000-05:00"))).toBe("nothing due");
    expect(writerCalls()).toBe(1);
  });

  it("makes one Writer call when three checks start at once", async () => {
    await connectAi();
    at(NOON);

    const results = await Promise.all([
      checkMonthlyReview(),
      checkMonthlyReview(),
      checkMonthlyReview(),
    ]);

    expect(results.toSorted()).toEqual(["running", "running", "written"]);
    expect(writerCalls()).toBe(1);
  });

  it("turns each Budget change into a Proposal of the review's run, and shows the Proposals still open on the 1st", async () => {
    await connectAi();
    // A Chat Proposal still open on the 1st, and one skipped before it.
    const open = await propose(
      bank.database,
      {
        kind: "new Goal",
        source: "Chat",
        runId: "thread-1",
        reason: "A bike fund keeps the summer trip in reach.",
        words: "Save for a new bike",
      },
      new Date("2026-10-20T12:00:00.000Z"),
    );
    expect(open).toMatchObject({ outcome: "shown" });
    // A second Budget change names a Bills Category, which guardrail 4 refuses: the review still
    // stores, with the other one.
    answer = (goals) =>
      answerOf(goals, {
        budgetChanges: [
          { category: "Restaurants", newAmount: 450, reason: "Takeout ran over, Member A!" },
          { category: "Rent", newAmount: 1_500, reason: "Rent is high." },
        ],
      });

    expect(await check(NOON)).toBe("written");

    const review = await readReview(bank.database, "2026-10");
    if (review === undefined) throw new Error("No review.");
    const shown = await openReviewProposals(bank.database, review, ON_THE_1ST("13:00"));
    expect(shown.map((proposal) => [proposal.source, proposal.reason])).toEqual([
      ["Monthly review", "Takeout ran over, Dana Okafor."],
      ["Chat", "A bike fund keeps the summer trip in reach."],
    ]);
    expect(await reviewProposals()).toEqual([
      { source: "Monthly review", run_id: "2026-10", status: "open" },
    ]);
  });

  it("keeps the paid reply when storing the review fails, and stores it later with no second call", async () => {
    await connectAi();
    await bank.database.$client.execute(
      "CREATE TRIGGER no_review BEFORE INSERT ON monthly_reviews BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );

    expect(await check(NOON)).toBe("waits");
    expect(writerCalls()).toBe(1);
    expect(await readReview(bank.database, "2026-10")).toBeUndefined();
    const run = await readMonthlyReviewRun(bank.database, "2026-10");
    expect(run?.reply).not.toBeNull();
    expect(run?.retryAt).toEqual(new Date(NOON.getTime() + REVIEW_WAIT_MS));
    // The Proposal went once, before the failure.
    expect(await reviewProposals()).toHaveLength(1);

    await bank.database.$client.execute("DROP TRIGGER no_review");
    expect(await check(new Date(NOON.getTime() + REVIEW_WAIT_MS - 1))).toBe("waits");
    expect(await check(new Date(NOON.getTime() + REVIEW_WAIT_MS))).toBe("written");
    expect(writerCalls()).toBe(1);
    expect(await reviewProposals()).toHaveLength(1);
    expect(await readReview(bank.database, "2026-10")).toBeDefined();
  });

  it("makes each Budget change once when a look fails between two Proposals, with no second call", async () => {
    await connectAi();
    answer = (goals) =>
      answerOf(goals, {
        budgetChanges: [
          {
            category: "Restaurants",
            newAmount: 450,
            reason: "Takeout ran over, so a smaller Budget keeps it in view.",
          },
          {
            category: "Groceries",
            newAmount: 550,
            reason: "Groceries came in under, so a smaller Budget still fits.",
          },
        ],
      });
    // The second Proposal's write fails, as when a sync on the 1st holds app.db.
    await bank.database.$client.execute(
      "CREATE TRIGGER second_proposal BEFORE INSERT ON proposals WHEN (SELECT count(*) FROM proposals WHERE source = 'Monthly review') >= 1 BEGIN SELECT RAISE(ABORT, 'database is locked'); END",
    );
    const madeChanges = async () =>
      (
        await bank.database.$client.execute(
          "SELECT proposal_budgets.category, proposals.status FROM proposals JOIN proposal_budgets ON proposal_budgets.proposal_id = proposals.id WHERE proposals.source = 'Monthly review' ORDER BY proposals.created_at, proposals.rowid",
        )
      ).rows.map((row) => ({ ...row }));

    expect(await check(NOON)).toBe("waits");
    expect(writerCalls()).toBe(1);
    expect(await madeChanges()).toEqual([{ category: "Restaurants", status: "open" }]);
    expect(await readReview(bank.database, "2026-10")).toBeUndefined();

    await bank.database.$client.execute("DROP TRIGGER second_proposal");
    expect(await check(new Date(NOON.getTime() + REVIEW_WAIT_MS))).toBe("written");
    expect(writerCalls()).toBe(1);
    expect(await madeChanges()).toEqual([
      { category: "Restaurants", status: "open" },
      { category: "Groceries", status: "open" },
    ]);
    expect(await reviewProposals()).toHaveLength(2);
  });

  it("makes its own Proposal when September's review or another source holds the same reason", async () => {
    await connectAi();
    const reason = "Takeout ran over, so a smaller Budget keeps it in view.";
    // September's review, and a Chat run whose ID is the same month, each with October's reason.
    const september = await propose(
      bank.database,
      {
        kind: "Budget change",
        source: "Monthly review",
        runId: "2026-09",
        reason,
        budgets: [{ category: "Groceries", amount: $(550) }],
      },
      new Date("2026-10-20T12:00:00.000Z"),
    );
    expect(september).toMatchObject({ outcome: "shown" });
    const chat = await propose(
      bank.database,
      { kind: "new Goal", source: "Chat", runId: "2026-10", reason, words: "Cook at home more" },
      new Date("2026-10-21T12:00:00.000Z"),
    );
    expect(chat).toMatchObject({ outcome: "shown" });
    answer = (goals) =>
      answerOf(goals, {
        budgetChanges: [{ category: "Restaurants", newAmount: 450, reason }],
      });

    expect(await check(NOON)).toBe("written");

    expect(
      (await reviewProposals()).toSorted((a, b) =>
        String(a.run_id).localeCompare(String(b.run_id)),
      ),
    ).toEqual([
      { source: "Monthly review", run_id: "2026-09", status: "open" },
      { source: "Monthly review", run_id: "2026-10", status: "open" },
    ]);
  });

  it("never changes once written: a later Refund changes nothing and makes no call", async () => {
    await connectAi();
    expect(await check(NOON)).toBe("written");
    const before = await readReview(bank.database, "2026-10");

    await load(
      [
        {
          id: "bistro-refund",
          date: "2026-10-30",
          merchant: "Corner Bistro",
          dollars: 62,
          category: "Restaurants",
        },
      ],
      ON_THE_1ST("15:00"),
    );
    expect(await check(ON_THE_1ST("15:01"))).toBe("nothing due");

    expect(await readReview(bank.database, "2026-10")).toEqual(before);
    expect(writerCalls()).toBe(1);
  });

  it("retries after 1, 5, and 30 minutes, then every 6 hours, and stops with one System notice when the month ends", async () => {
    await connectAi();
    stub.answers.writer = "fail";
    const start = NOON.getTime();

    expect(await check(NOON)).toBe("waits");
    expect(await check(new Date(start + 30_000))).toBe("waits");
    expect(writerCalls()).toBe(1);
    for (const [after, calls] of [
      [MINUTE, 2],
      [6 * MINUTE, 3],
      [36 * MINUTE, 4],
    ] as const) {
      expect(await check(new Date(start + after - 1))).toBe("waits");
      expect(writerCalls()).toBe(calls - 1);
      expect(await check(new Date(start + after))).toBe("waits");
      expect(writerCalls()).toBe(calls);
    }
    // After the third retry fails: every 6 hours.
    let next = start + 36 * MINUTE + MONTHLY_REVIEW_RETRY_MS;
    expect((await readMonthlyReviewRun(bank.database, "2026-10"))?.retryAt).toEqual(new Date(next));
    for (const calls of [5, 6, 7]) {
      expect(await check(new Date(next - 1))).toBe("waits");
      expect(await check(new Date(next))).toBe("waits");
      expect(writerCalls()).toBe(calls);
      next += MONTHLY_REVIEW_RETRY_MS;
    }

    // November ends with no review: the run stops at its cap, and its AI retry ends with it.
    const december = new Date("2026-12-01T00:00:00.000-05:00");
    expect(await check(december)).toBe("stopped");
    expect(await check(new Date(december.getTime() + 7 * HOUR))).toBe("nothing due");
    expect(writerCalls()).toBe(7);
    expect((await readMonthlyReviewRun(bank.database, "2026-10"))?.outcome).toBe("stopped");
    expect(await readAiRetry(bank.database, "monthly review")).toBeUndefined();
    const stopped = (await listOpenNotices(bank.database)).filter(
      (notice) => notice.condition === REVIEW_STOPPED,
    );
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.text).toContain("Oct 2026 Monthly review");

    // November's review, due on Dec 1, starts its retries anew, and ends the notice once written.
    stub.answers.writer = "work";
    expect(await markReviewDue(bank.database)).toBe("2026-11");
    expect(await check(new Date("2026-12-01T12:00:00.000-05:00"))).toBe("written");
    expect(writerCalls()).toBe(8);
    expect(
      (await listOpenNotices(bank.database)).filter(
        (notice) => notice.condition === REVIEW_STOPPED,
      ),
    ).toEqual([]);
  });

  it("waits, and does not stop, when the clock moves back across midnight on the 1st", async () => {
    await connectAi();

    expect(await check(new Date("2026-10-31T23:30:00.000-04:00"))).toBe("waits");
    expect((await readMonthlyReviewRun(bank.database, "2026-10"))?.endedAt).toBeNull();
    expect(writerCalls()).toBe(0);
    expect(
      (await listOpenNotices(bank.database)).filter(
        (notice) => notice.condition === REVIEW_STOPPED,
      ),
    ).toEqual([]);

    expect(await check(NOON)).toBe("written");
    expect(writerCalls()).toBe(1);
  });

  it("at the AI cost cap reached in October, writes the review at noon on the 1st, once the cap's month resets", async () => {
    // The real cost count and cap, in the Household time zone, as the app wires them.
    const cost = aiCost({
      database: bank.database,
      timeZone: () => householdTimeZone(bank.database),
      raiseNotice: async () => undefined,
    });
    for (const stop of stops) stop();
    const ai = householdAi({
      ...aiOptions(),
      cost,
      gates: { historyLoaded: async () => true, costCapPausedUntil: () => cost.pausedUntil() },
    });
    stops = [startMonthlyReview({ database: bank.database, ai }).stop];
    await connectAi();
    // October's calls reach a $1 cap late on Oct 31, Household time.
    at(new Date("2026-10-31T23:00:00.000-04:00"));
    await cost.setCap(100);
    await cost.record({
      use: "category fix",
      provider: "anthropic",
      model: "quick-model",
      costNanos: 2_000_000_000,
      noCacheTokens: 1_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 100,
    });
    expect(await cost.pausedUntil()).toBe("2026-11-01");

    at(NOON);
    expect(await cost.pausedUntil()).toBeUndefined();
    expect(await checkMonthlyReview()).toBe("written");
    expect(writerCalls()).toBe(1);
  });

  it("at the AI cost cap, makes no call, and writes the review at the next look once a Member raises the cap", async () => {
    await connectAi();
    pausedUntil = "2026-12-01";

    expect(await check(NOON)).toBe("waits");
    expect(await check(new Date(NOON.getTime() + REVIEW_WAIT_MS))).toBe("waits");
    expect(writerCalls()).toBe(0);

    // A Member raises the cap: background AI starts again, and the review is written at the next
    // look.
    pausedUntil = undefined;
    expect(await check(new Date(NOON.getTime() + REVIEW_WAIT_MS + 30 * MINUTE))).toBe("waits");
    expect(await check(new Date(NOON.getTime() + 2 * REVIEW_WAIT_MS))).toBe("written");
    expect(writerCalls()).toBe(1);
  });

  it("writes no review that month with no AI provider, and ends its AI retry", async () => {
    // Failures from an earlier try: November's first AI error then waits 1 minute, not 6 hours.
    await storeAiFailure(
      bank.database,
      "monthly review",
      4,
      new Date("2026-10-31T12:00:00.000-04:00"),
    );
    expect(await check(NOON)).toBe("no AI provider");
    expect(await readAiRetry(bank.database, "monthly review")).toBeUndefined();
    expect(await check(ON_THE_1ST("13:00"))).toBe("nothing due");

    await connectAi();
    expect(await check(ON_THE_1ST("14:00"))).toBe("nothing due");
    expect(writerCalls()).toBe(0);
    expect(await readReview(bank.database, "2026-10")).toBeUndefined();
    expect(
      (await listOpenNotices(bank.database)).filter(
        (notice) => notice.condition === REVIEW_STOPPED,
      ),
    ).toEqual([]);
  });

  it("keeps a run's first reply and its end: a second store or end changes nothing", async () => {
    const month = "2026-10";
    expect(await storeMonthlyReviewReply(bank.database, month, { answer: 1, goalIds: [] })).toBe(
      true,
    );
    expect(await storeMonthlyReviewReply(bank.database, month, { answer: 2, goalIds: [] })).toBe(
      false,
    );
    expect(await endMonthlyReviewRun(bank.database, month, "written", NOON)).toBe(true);
    expect(await endMonthlyReviewRun(bank.database, month, "stopped", ON_THE_1ST("13:00"))).toBe(
      false,
    );
    await storeMonthlyReviewRetry(bank.database, month, ON_THE_1ST("14:00"));
    expect(await readMonthlyReviewRun(bank.database, month)).toMatchObject({
      reply: { answer: 1, goalIds: [] },
      outcome: "written",
      endedAt: NOON,
      retryAt: null,
    });
  });
});
