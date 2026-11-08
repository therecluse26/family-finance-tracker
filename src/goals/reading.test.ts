import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AiGates, aiCost, aiSettings, type HouseholdAi, householdAi } from "../ai/index.ts";
import { newAiKey, type StubMessage, StubModels } from "../ai/testing.ts";
import { fakeAccount } from "../bank/fake.ts";
import { syncConnection } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import {
  goalRunProposalsId,
  listGoals,
  listOpenProposals,
  listWaitingTailoringRuns,
  type NewProposal,
  readAiRetry,
  readGoal,
  readHouseholdSummary,
  storeHouseholdSummary,
  storeProposal,
} from "../db/index.ts";
import { acceptProposal } from "../proposals/index.ts";
import { startBudgetTailoring } from "../tailoring/index.ts";
import {
  GOAL_READING_TASK,
  type GoalWriting,
  goalWriting,
  markGoal,
  READINGS_PER_HOUR,
} from "./index.ts";

// Adding a Goal and editing its words (spec 05, Rules; spec 08, Every AI use, reading a Goal;
// Limits on each call; The AI cost cap; Failures), on Accounts the fake adapter synced. The AI is
// AI SDK test models behind the real cost gate. No test calls an AI provider.
// The Household time zone is unset, so Household time is UTC.

const NOW = new Date("2026-11-10T15:00:00.000Z");
const BANK = "fake-reading-bank";
const $ = (dollars: number) => Math.round(dollars * 100);
const PRICE = { input: 1_000_000, output: 2_000_000 };

// The savings Account's last 4 is in today's date, 2026-11-10: the date reaches the AI as it is.
const CHECKING = fakeAccount({ id: "acc-checking" });
const SAVINGS = fakeAccount({
  id: "acc-savings",
  name: "Whitlock Rainy Day Savings",
  subtype: "savings",
  mask: "1110",
  currentBalance: $(2_000),
});
const CAR_LOAN = fakeAccount({
  id: "acc-car",
  type: "loan",
  subtype: "auto",
  currentBalance: -$(12_000),
});

// A reading with every field null.
const NO_READING = { target: null, change: null, deadline: null };
const target = (fields: Record<string, unknown>) => ({
  category: null,
  merchant: null,
  accounts: null,
  ...fields,
});

// The user messages of one call, as the model read them.
const userTexts = (messages: StubMessage[]) =>
  messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => part.text ?? "").join(""),
    );

// The row number the facts give an Account whose label line ends with `ending`.
function rowOf(messages: StubMessage[], ending: string): number {
  const facts = userTexts(messages).find((text) => text.startsWith("Today is ")) ?? "";
  const line = facts.split("\n").find((each) => each.endsWith(ending)) ?? "";
  return Number(/^(\d+)\. /.exec(line)?.[1] ?? 0);
}

describe("reading a Goal", () => {
  let bank: TestBank;
  let stub: StubModels;
  let ai: HouseholdAi;
  let writing: GoalWriting;
  let pausedUntil: string | undefined;
  let historyLoaded: boolean;
  let goalRuns: string[];
  // The reply to each Goal's words, made from the call's messages.
  let replies: Map<string, (messages: StubMessage[]) => unknown>;
  let callsBefore: number;

  const gates: AiGates = {
    historyLoaded: async () => historyLoaded,
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
    const saved = await aiSettings(aiOptions()).save({
      provider: "anthropic",
      apiKey: newAiKey(),
      baseUrl: null,
      quickModel: "quick-model",
      writerModel: "writer-model",
      prices: { quick: PRICE, writer: PRICE },
    });
    expect(saved).toMatchObject({ saved: true });
    callsBefore = stub.calls.length;
  };
  // The reading calls since the AI settings were saved.
  const calls = () => stub.calls.slice(callsBefore);
  const prompts = () => stub.prompts.slice(callsBefore);

  beforeEach(async () => {
    bank = await newTestBank();
    stub = new StubModels();
    pausedUntil = undefined;
    historyLoaded = true;
    goalRuns = [];
    callsBefore = 0;
    replies = new Map();
    stub.replyTo = (messages) => {
      const words = userTexts(messages).at(-1) ?? "";
      return JSON.stringify(replies.get(words)?.(messages) ?? NO_READING);
    };
    for (const [id, name] of [
      ["member-a", "Dana Whitlock"],
      ["member-b", "Sam Okafor"],
    ] as const) {
      await bank.database.$client.execute({
        sql: `INSERT INTO members (id, name, email, created_at, updated_at)
              VALUES (?, ?, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
        args: [id, name, `${id}@example.com`],
      });
    }
    const connectionId = await bank.connect(BANK);
    bank.fake.addPages(BANK, { accounts: [CHECKING, SAVINGS, CAR_LOAN] });
    await syncConnection(connectionId, () => NOW);
    ai = householdAi(aiOptions());
    writing = goalWriting({
      database: bank.database,
      ai,
      requestGoalRun: async (goalId) => {
        goalRuns.push(goalId);
      },
      now: () => NOW,
    });
  });

  afterEach(() => {
    bank.close();
  });

  const add = (words: string, sendAnyway = false) => writing.add("member-a", { words, sendAnyway });
  const goalId = (saved: Awaited<ReturnType<typeof add>>) => {
    if (!("goalId" in saved)) throw new Error(`Not saved: ${JSON.stringify(saved)}`);
    return saved.goalId;
  };

  describe("with an AI provider", () => {
    beforeEach(connectAi);

    it("reads the spec's three Goal examples into their fields, with one Quick call each", async () => {
      replies.set("I want to spend 20% less on restaurants.", () => ({
        target: target({ kind: "Category", category: "Restaurants" }),
        change: { amount: null, percent: 20 },
        deadline: null,
      }));
      replies.set("Save $10,000 for a house by December 31, 2027.", () => ({
        target: target({ kind: "Saving" }),
        change: { amount: 10_000, percent: null },
        deadline: "2027-12-31",
      }));
      replies.set("Pay off the car loan by the end of 2027.", (messages) => ({
        target: target({ kind: "loan", accounts: [rowOf(messages, "(loan)")] }),
        change: null,
        deadline: "2027-12-31",
      }));

      const restaurants = goalId(await add("I want to spend 20% less on restaurants."));
      const house = goalId(await add("Save $10,000 for a house by December 31, 2027."));
      const car = goalId(await add("Pay off the car loan by the end of 2027."));

      expect(await readGoal(bank.database, restaurants)).toMatchObject({
        words: "I want to spend 20% less on restaurants.",
        authorId: "member-a",
        date: "2026-11-10",
        status: "active",
        target: { kind: "Category", category: "Restaurants" },
        change: { percent: 20 },
        deadline: null,
        // A spend less Goal's amount is always a Proposal.
        goalAmount: null,
      });
      expect(await readGoal(bank.database, house)).toMatchObject({
        target: { kind: "Saving" },
        change: { amount: $(10_000) },
        deadline: "2027-12-31",
        // Saving counts from $0: the change gives the Goal amount, from today.
        goalAmount: $(10_000),
        startsOn: "2026-11-10",
      });
      expect(await readGoal(bank.database, car)).toMatchObject({
        target: { kind: "loan", accountId: expect.any(String) },
        change: null,
        deadline: "2027-12-31",
        // With no change, the whole balance at the start.
        goalAmount: $(12_000),
      });
      // One Quick-tier call per save, at most 300 reply tokens, and the Goal's run at once.
      expect(calls()).toEqual([
        { tier: "quick", modelId: "quick-model", maxOutputTokens: 2_000 },
        { tier: "quick", modelId: "quick-model", maxOutputTokens: 2_000 },
        { tier: "quick", modelId: "quick-model", maxOutputTokens: 2_000 },
      ]);
      expect(goalRuns).toEqual([restaurants, house, car]);
    });

    it("reads a Merchant, Accounts, and words that say nothing of a target", async () => {
      replies.set("Spend less at Bluebird Books", () => ({
        target: target({ kind: "Merchant", merchant: "Bluebird Books" }),
        change: { amount: 25.5, percent: null },
        deadline: "2027-06-30",
      }));
      replies.set("Grow the savings to $5,000", (messages) => ({
        target: target({ kind: "Accounts", accounts: [rowOf(messages, "Savings ending 1110")] }),
        change: { amount: 3_000, percent: null },
        deadline: null,
      }));

      const books = goalId(await add("Spend less at Bluebird Books"));
      const grow = goalId(await add("Grow the savings to $5,000"));
      const careful = goalId(await add("Be careful with money"));

      expect(await readGoal(bank.database, books)).toMatchObject({
        target: { kind: "Merchant", merchant: { id: null, name: "Bluebird Books" } },
        change: { amount: 2_550 },
        deadline: "2027-06-30",
      });
      const saved = await readGoal(bank.database, grow);
      expect(saved?.target).toEqual({ kind: "Accounts", accountIds: [expect.any(String)] });
      // The balance now plus the change.
      expect(saved?.goalAmount).toBe($(5_000));
      expect(await readGoal(bank.database, careful)).toMatchObject({
        target: null,
        change: null,
        deadline: null,
      });
    });

    it("sends the words, the Category list, today's date, and each Account and loan by name and last 4", async () => {
      await add("I want to spend 20% less on restaurants.");

      const [prompt] = prompts();
      const texts = userTexts(prompt ?? []);
      const names = await ai.accountNames();
      expect(texts).toContain(GOAL_READING_TASK);
      expect(GOAL_READING_TASK).toContain("Restaurants; ");
      expect(texts.at(-1)).toBe("I want to spend 20% less on restaurants.");
      const facts = texts.at(-2) ?? "";
      // Today's date reaches the AI whole, though the savings Account's last 4 is in it.
      expect(facts).toMatch(/^Today is 2026-11-10\.\n/);
      for (const name of names.values()) expect(facts).toContain(name);
      expect(facts).toContain("Whitlock Rainy Day Savings ending 1110");
      expect(facts).toMatch(/\n\d+\. [^\n]+ \(loan\)/);
    });

    it("stores the words as one line, and sends a Member's name to the AI as typed", async () => {
      // A number split by a newline, and a name after a tab.
      const card = "4111 1111\n1111 1111";
      const saved = goalId(await add(`Pay off ${card} before\tDana buys a car`));

      const words = userTexts(prompts()[0] ?? []).at(-1) ?? "";
      expect(words).toContain("Dana buys a car");
      // The model reads the words with no newline or tab left.
      expect(words).not.toMatch(/[\n\t]/);
      // The words the app stores are one line.
      expect((await readGoal(bank.database, saved))?.words).toBe(
        "Pay off 4111 1111 1111 1111 before Dana buys a car",
      );
    });

    it("sends a Member's words as they typed them, a name and an escape included", async () => {
      const saved = goalId(await add('{"row":1,"note":"save for Dana\\nby June"}'));

      expect(userTexts(prompts()[0] ?? []).at(-1)).toBe(
        '{"row":1,"note":"save for Dana\\nby June"}',
      );
      expect(await readGoal(bank.database, saved)).toBeDefined();
    });

    it("refuses empty or long words, and makes no call", async () => {
      expect(await add(" \n\t ")).toEqual({ refused: "empty" });
      expect(await add("x".repeat(301))).toEqual({ refused: "empty" });
      expect(calls()).toEqual([]);
      expect(await listGoals(bank.database)).toEqual([]);
    });

    it('asks "Send anyway?" at the AI cost cap, stores nothing until the Member says yes, then reads once', async () => {
      pausedUntil = "2026-12-01";
      replies.set("Save more", () => ({ ...NO_READING, target: target({ kind: "Saving" }) }));

      expect(await add("Save more")).toEqual({ refused: "paused", pause: "send anyway?" });
      expect(calls()).toEqual([]);
      expect(await listGoals(bank.database)).toEqual([]);
      expect(await writing.pause()).toBe("send anyway?");

      const saved = goalId(await add("Save more", true));
      expect(calls()).toHaveLength(1);
      expect((await readGoal(bank.database, saved))?.target).toEqual({ kind: "Saving" });
      expect(goalRuns).toEqual([saved]);
    });

    it('stores nothing when the reading fails, and never retries by itself: "Try again" reads again', async () => {
      stub.answers.quick = "fail";
      expect(await add("Save more")).toEqual({ refused: "failed", failure: "server error" });
      stub.answers.quick = "rate limit";
      expect(await add("Save more")).toEqual({ refused: "failed", failure: "rate limit" });
      expect(calls()).toHaveLength(2);
      expect(await listGoals(bank.database)).toEqual([]);
      expect(await readAiRetry(bank.database, "reading a goal")).toBeUndefined();
      expect(goalRuns).toEqual([]);

      // "Try again".
      stub.answers.quick = "work";
      goalId(await add("Save more"));
      expect(calls()).toHaveLength(3);
      expect(await listGoals(bank.database)).toHaveLength(1);
    });

    it("takes a reply that fails its schema as a failed reading", async () => {
      const wrong = [
        // A Category target with no Category.
        { ...NO_READING, target: target({ kind: "Category" }) },
        // A loan target that names an Account that is not a loan.
        { ...NO_READING, target: target({ kind: "loan", accounts: [1, 2] }) },
        // A row the call did not list.
        { ...NO_READING, target: target({ kind: "Accounts", accounts: [99] }) },
        // Both an amount and a percent.
        { ...NO_READING, change: { amount: 10, percent: 10 } },
        // A percent under 1.
        { ...NO_READING, change: { amount: null, percent: 0.5 } },
        // A field the schema does not name, at the top or in the target or the change.
        { ...NO_READING, note: "Save more" },
        { ...NO_READING, target: { ...target({ kind: "Saving" }), words: "Save more" } },
        { ...NO_READING, change: { amount: 10, percent: null, per: "month" } },
        // A date that is not real.
        { ...NO_READING, deadline: "2027-02-30" },
        { ...NO_READING, deadline: "2027-12-31T00:00" },
      ];
      for (const reply of wrong) {
        replies.set("Save more", () => reply);
        expect(await add("Save more"), JSON.stringify(reply)).toEqual({
          refused: "failed",
          failure: "bad reply",
        });
      }
      expect(await listGoals(bank.database)).toEqual([]);
    });

    it("reads new words, clears the Goal amount, and asks for the Goal's run again; the same words make no call", async () => {
      replies.set("Save $10,000", () => ({
        target: target({ kind: "Saving" }),
        change: { amount: 10_000, percent: null },
        deadline: null,
      }));
      replies.set("Spend 10% less on restaurants", () => ({
        target: target({ kind: "Category", category: "Restaurants" }),
        change: { amount: null, percent: 10 },
        deadline: "2027-03-31",
      }));
      const saved = goalId(await add("Save $10,000"));
      expect((await readGoal(bank.database, saved))?.goalAmount).toBe($(10_000));

      expect(
        await writing.edit("member-b", saved, {
          words: "Spend 10% less on restaurants",
          sendAnyway: false,
        }),
      ).toEqual({ goalId: saved });
      expect(await readGoal(bank.database, saved)).toMatchObject({
        words: "Spend 10% less on restaurants",
        // The author and the Goal's date stay.
        authorId: "member-a",
        date: "2026-11-10",
        target: { kind: "Category", category: "Restaurants" },
        change: { percent: 10 },
        deadline: "2027-03-31",
        goalAmount: null,
        startsOn: null,
        startBalance: null,
        baseline: null,
      });
      expect(goalRuns).toEqual([saved, saved]);

      expect(
        await writing.edit("member-b", saved, {
          words: " Spend 10% less on restaurants ",
          sendAnyway: false,
        }),
      ).toEqual({ goalId: saved });
      expect(calls()).toHaveLength(2);
      expect(goalRuns).toHaveLength(2);
    });

    it("closes the Goal's open Proposals made for its old words as replaced, and only those (K2)", async () => {
      const goal = goalId(await add("Spend 20% less on restaurants"));
      const other = goalId(await add("Spend less on travel"));
      const proposal = async (fields: Partial<NewProposal>) => {
        const stored = await storeProposal(
          bank.database,
          {
            kind: "Goal amount",
            source: "Budget tailoring",
            runId: "run",
            reason: "Twenty percent off.",
            goalId: null,
            goalAmount: null,
            words: null,
            createdAt: NOW,
            budgets: [],
            ...fields,
          },
          10,
        );
        if (stored === "run full") throw new Error("Run full.");
        return stored.id;
      };
      const budgets = (category: string) => ({
        kind: "Budget change" as const,
        budgets: [{ category, amount: $(400) }],
      });
      // The Goal's Goal amount Proposal, and its Goal run's Budget change Proposal.
      const amount = await proposal({
        runId: goalRunProposalsId(1, goal),
        goalId: goal,
        goalAmount: $(480),
      });
      const change = await proposal({
        ...budgets("Restaurants"),
        runId: goalRunProposalsId(1, goal),
      });
      // Another Goal's, the Tailoring run's, and Chat's stay open, even a Chat run with a Goal
      // run's ID.
      const kept = [
        await proposal({ runId: goalRunProposalsId(2, other), goalId: other, goalAmount: $(90) }),
        await proposal({ ...budgets("Travel"), runId: goalRunProposalsId(2, other) }),
        await proposal({ ...budgets("Clothing"), runId: "Tailoring run 3" }),
        await proposal({
          ...budgets("Groceries"),
          source: "Chat",
          runId: goalRunProposalsId(1, goal),
        }),
      ];

      const later = new Date("2026-11-10T16:00:00.000Z");
      writing = goalWriting({
        database: bank.database,
        ai,
        requestGoalRun: async () => undefined,
        now: () => later,
      });
      await writing.edit("member-a", goal, { words: "Spend less on groceries", sendAnyway: false });

      expect((await listOpenProposals(bank.database)).map((row) => row.id).sort()).toEqual(
        kept.sort(),
      );
      const closed = await bank.database.$client.execute({
        sql: "SELECT id, status, closed_at, closed_by FROM proposals WHERE id IN (?, ?) ORDER BY id",
        args: [amount, change],
      });
      expect(closed.rows.map((row) => ({ ...row }))).toEqual(
        [amount, change].sort().map((id) => ({
          id,
          status: "replaced",
          closed_at: later.toISOString(),
          closed_by: null,
        })),
      );
      // Accepting the old Goal amount changes nothing.
      const before = await readGoal(bank.database, goal);
      expect(await acceptProposal(bank.database, { id: amount, memberId: "member-a" }, later)).toBe(
        "not open",
      );
      expect(await readGoal(bank.database, goal)).toEqual(before);
    });

    it("refuses a reading whose deadline has passed, and stores nothing, so the Member writes a later date", async () => {
      replies.set("Save $500 by March 1", () => ({
        ...NO_READING,
        target: target({ kind: "Saving" }),
        deadline: "2026-03-01",
      }));
      replies.set("Save $500 by today", () => ({
        ...NO_READING,
        target: target({ kind: "Saving" }),
        deadline: "2026-11-10",
      }));

      expect(await add("Save $500 by March 1")).toEqual({ refused: "past deadline" });
      expect(await listGoals(bank.database)).toEqual([]);
      expect(goalRuns).toEqual([]);
      const today = goalId(await add("Save $500 by today"));
      expect((await readGoal(bank.database, today))?.deadline).toBe("2026-11-10");
      expect(GOAL_READING_TASK).toContain("A date with no year means its next one");
    });

    it("gives the place back when no call went out: a key rejected before the save", async () => {
      // The provider rejects the key: that call took a place. Later saves send nothing.
      stub.answers.quick = "reject";
      expect(await add("Save more")).toEqual({ refused: "paused", pause: "key rejected" });
      const sent = calls().length;
      for (let count = 0; count < READINGS_PER_HOUR + 5; count += 1) {
        expect(await add("Save more")).toEqual({ refused: "paused", pause: "key rejected" });
      }
      expect(calls()).toHaveLength(sent);
      stub.answers.quick = "work";
      await connectAi();
      const results = [];
      for (let count = 0; count < READINGS_PER_HOUR; count += 1) results.push(await add("Save"));
      // One place went to the call the provider rejected.
      expect(results.filter((each) => "goalId" in each)).toHaveLength(READINGS_PER_HOUR - 1);
      expect(results.at(-1)).toEqual({ refused: "rate cap" });
    });

    it("edits only an active Goal, and changes nothing else (K2)", async () => {
      const kept = goalId(await add("Save more"));
      const dropped = goalId(await add("Be careful"));
      await markGoal(bank.database, dropped, "dropped", "member-a", NOW);
      const before = await listGoals(bank.database);
      const callsNow = calls().length;

      const edit = (id: string) =>
        writing.edit("member-a", id, { words: "Spend less", sendAnyway: false });
      expect(await edit(dropped)).toEqual({ refused: "not active" });
      expect(await edit("no-such-goal")).toEqual({ refused: "not found" });
      expect(calls()).toHaveLength(callsNow);

      // A Goal dropped while the AI reads keeps its words.
      stub.beforeAnswer = async () => {
        await markGoal(bank.database, kept, "dropped", "member-b", NOW);
      };
      expect(await edit(kept)).toEqual({ refused: "not active" });
      expect(calls()).toHaveLength(callsNow + 1);
      const after = await listGoals(bank.database);
      expect(after.map((goal) => [goal.id, goal.words])).toEqual(
        before.map((goal) => [goal.id, goal.words]),
      );
    });

    it("reads one Goal once when its new words are saved twice at once (K18)", async () => {
      const saved = goalId(await add("Save more"));
      const edit = (words: string) => writing.edit("member-a", saved, { words, sendAnyway: false });

      const results = await Promise.all([edit("Save a lot"), edit("Save a little")]);

      expect(results).toEqual([{ goalId: saved }, { refused: "busy" }]);
      expect(calls()).toHaveLength(2);
    });

    it("reads at most 20 Goals a Member saves in an hour, sent together or not (K18)", async () => {
      const results = await Promise.all(
        Array.from({ length: READINGS_PER_HOUR + 2 }, (_, index) => add(`Goal ${index}`)),
      );

      expect(results.filter((each) => "goalId" in each)).toHaveLength(READINGS_PER_HOUR);
      expect(results.filter((each) => "refused" in each)).toEqual([
        { refused: "rate cap" },
        { refused: "rate cap" },
      ]);
      expect(calls()).toHaveLength(READINGS_PER_HOUR);
      // Another Member still may.
      expect(await writing.add("member-b", { words: "Save", sendAnyway: false })).toHaveProperty(
        "goalId",
      );
    });

    it("gives the place back when a reading pauses, so pauses never use up the hour", async () => {
      pausedUntil = "2026-12-01";
      for (let count = 0; count < READINGS_PER_HOUR + 5; count += 1) {
        expect(await add("Save more")).toEqual({ refused: "paused", pause: "send anyway?" });
      }
      pausedUntil = undefined;
      expect(await add("Save more")).toHaveProperty("goalId");
    });

    it("puts a new or changed Goal in the next Writer use's summary at once, and a dropped one out", async () => {
      const day = { day: "2026-11-10", text: "[]" };
      await storeHouseholdSummary(bank.database, day, NOW);
      const saved = goalId(await add("Save more"));
      expect(await readHouseholdSummary(bank.database)).toBeUndefined();

      await storeHouseholdSummary(bank.database, day, NOW);
      await markGoal(bank.database, saved, "dropped", "member-a", NOW);
      expect(await readHouseholdSummary(bank.database)).toBeUndefined();
    });

    it("asks Budget tailoring for the Goal's run, which waits to make its Proposals", async () => {
      const tailoring = startBudgetTailoring({
        database: bank.database,
        ai,
        now: () => NOW,
        startJob: async () => undefined,
      });
      try {
        const { requestGoalTailoring } = await import("../tailoring/index.ts");
        const withRuns = goalWriting({
          database: bank.database,
          ai,
          requestGoalRun: requestGoalTailoring,
          now: () => NOW,
        });
        const saved = goalId(await withRuns.add("member-a", { words: "Save", sendAnyway: false }));

        expect(await listWaitingTailoringRuns(bank.database)).toEqual([
          expect.objectContaining({ kind: "Goal", goalId: saved }),
        ]);
      } finally {
        tailoring.stop();
      }
    });
  });

  it("stores no Goal and makes no call with no AI provider, or until history has loaded", async () => {
    expect(await writing.pause()).toBe("no AI provider");
    expect(await add("Save more")).toEqual({ refused: "paused", pause: "no AI provider" });

    await connectAi();
    historyLoaded = false;
    expect(await writing.pause()).toBe("waits for history");
    expect(await add("Save more")).toEqual({ refused: "paused", pause: "waits for history" });

    expect(stub.calls.slice(callsBefore)).toEqual([]);
    expect(await listGoals(bank.database)).toEqual([]);
    expect(goalRuns).toEqual([]);
  });
});
