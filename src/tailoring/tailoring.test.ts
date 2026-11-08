import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AiOptions, aiCost, aiSettings, householdAi } from "../ai/index.ts";
import { newAiKey, type StubMessage, StubModels } from "../ai/testing.ts";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import {
  budgetsForMonth,
  draftBudgets,
  draftFirstBudgets,
  editBudget,
  fitToIncome,
  readDraftTerms,
} from "../budgets/index.ts";
import type { Category } from "../categories/index.ts";
import {
  addGoal,
  listOpenNotices,
  listWaitingTailoringRuns,
  storeDecisions,
  storeGoalWords,
} from "../db/index.ts";
import type * as Goals from "../goals/index.ts";
import { markGoal } from "../goals/index.ts";
import { saveHouseholdFacts } from "../household/index.ts";
import { typeSteadyIncome } from "../recurring/index.ts";
import {
  requestGoalTailoring,
  runWaitingTailoring,
  startBudgetTailoring,
  TAILORING_RUN_CAP,
  TAILORING_STOPPED_TEXT,
  type TailoringReply,
  tailorFirstDraft,
} from "./index.ts";

// Budget tailoring (spec 05, The AI's part in a draft; Which Proposals exist; spec 08, Budget
// tailoring) on a small Household: 3 months of Spending through the fake adapter, Steady Income,
// and Household facts. AI SDK test models only: no test calls an AI provider. Each prompt is read
// as the Writer model got it.

// The Goals whose start a test reads as not known, so a Goal run's limits cannot lean on it.
const unknownStarts = vi.hoisted(() => new Set<string>());
vi.mock("../goals/index.ts", async (importOriginal) => {
  const goals = await importOriginal<typeof Goals>();
  return {
    ...goals,
    goalStartToday: async (...args: Parameters<typeof goals.goalStartToday>) =>
      unknownStarts.has(args[1]) ? undefined : goals.goalStartToday(...args),
  };
});

const BANK = "fake-tailoring-bank";
const MEMBER = "member-1";
const NOW = new Date("2026-11-04T14:00:00.000Z");
const MONTH = "2026-11";
const PRICE = { input: 1_000_000, output: 2_000_000 };
const ZIP_CODE = "18950";
const AGES = [37, 41];
const CHECKING = fakeAccount({ id: "acc-checking" });

const $ = (dollars: number) => dollars * 100;

// Each month's Spending, by Category: Utilities is a Bills Category.
const SPENDING: [Category, number][] = [
  ["Groceries", 400],
  ["Restaurants", 300],
  ["Clothing", 120],
  ["Hobbies", 40],
  ["Utilities", 150],
];

// A reply as Budget tailoring's output, with each amount in whole dollars.
const reply = (
  budgets: { category: Category; amount: number; reason?: string }[],
  goal: { goalAmount?: number | null; goalReason?: string | null } = {},
): string =>
  JSON.stringify({
    reason: "Restaurant Spending has room to come down for the Goal.",
    budgets: budgets.map((line) => ({ reason: `${line.category} fits the Goal.`, ...line })),
    goalAmount: goal.goalAmount ?? null,
    goalReason: goal.goalReason ?? null,
  } satisfies TailoringReply);

// Every user message of the last call, as the model read it.
function promptTheModelRead(stub: StubModels): string {
  return (stub.prompts.at(-1) ?? [])
    .filter((message: StubMessage) => message.role === "user")
    .map(({ content }) =>
      typeof content === "string" ? content : content.map((part) => part.text ?? "").join(""),
    )
    .join("\n");
}

describe("Budget tailoring", () => {
  let bank: TestBank;
  let stub: StubModels;
  let options: AiOptions;
  let tailoring: ReturnType<typeof startBudgetTailoring>;
  let jobsStarted: number;
  let clockBroken: boolean;

  const sql = async (text: string, args: (string | number | null)[] = []) =>
    (await bank.database.$client.execute({ sql: text, args })).rows;

  // Connects the AI provider through the AI settings, as the settings page does.
  const connectAi = async () => {
    const saved = await aiSettings(options).save({
      provider: "anthropic",
      apiKey: newAiKey(),
      baseUrl: null,
      quickModel: "quick-model",
      writerModel: "writer-model",
      prices: { quick: PRICE, writer: PRICE },
    });
    expect(saved).toMatchObject({ saved: true });
    // Only the calls after the key check count.
    stub.calls.splice(0);
    stub.prompts.splice(0);
  };

  // The formula's figure for each Category this month, in whole cents.
  const formula = async () => {
    const terms = await readDraftTerms(bank.database, MONTH, NOW);
    const drafted = fitToIncome(draftBudgets(terms), terms).budgets;
    return new Map(drafted.map((each) => [each.category, each.amount]));
  };
  const figureOf = async (category: Category) => {
    const found = (await formula()).get(category);
    if (found === undefined) throw new Error(`No formula figure for ${category}`);
    return found;
  };
  const budgetOf = async (category: Category) =>
    (await budgetsForMonth(bank.database, MONTH)).budgets.find(
      (budget) => budget.category === category,
    );
  const proposals = () => sql("SELECT kind, source, reason, goal_id, goal_amount FROM proposals");
  const proposalLines = () =>
    sql("SELECT category, amount, reason FROM proposal_budgets ORDER BY category");

  beforeEach(async () => {
    bank = await newTestBank();
    const connectionId = await bank.connect(BANK);
    await sql(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES (?, 'Jamie Rivera', 'jamie@example.com', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
      [MEMBER],
    );
    const txns = ["2026-08-12", "2026-09-12", "2026-10-12"].flatMap((date, month) =>
      SPENDING.map(([category, dollars]) => ({
        id: `${category}-${month}`,
        category,
        record: fakeTxn({
          id: `${category}-${month}`,
          accountId: CHECKING.id,
          amount: -$(dollars),
          postedDate: date,
        }),
      })),
    );
    bank.fake.addPages(BANK, { accounts: [CHECKING], added: txns.map((txn) => txn.record) });
    await syncConnection(connectionId, () => NOW);
    const ids = new Map(
      (await sql("SELECT id, provider_transaction_id FROM transactions")).map((row) => [
        String(row.provider_transaction_id),
        String(row.id),
      ]),
    );
    await storeDecisions(
      bank.database,
      txns.map((txn) => ({
        transactionId: ids.get(txn.id) ?? "",
        step: "5.7",
        provisionalUntil: null,
        decidedAt: NOW,
        parts: [
          {
            type: "Spending" as const,
            amount: txn.record.amount,
            category: txn.category,
            linked: false,
          },
        ],
      })),
    );
    await typeSteadyIncome(bank.database, $(6_000), MEMBER, NOW);
    await saveHouseholdFacts(
      bank.database,
      { zipCode: ZIP_CODE, ages: AGES, rentOrOwn: "rent" },
      MEMBER,
      NOW,
    );

    stub = new StubModels();
    jobsStarted = 0;
    clockBroken = false;
    const cost = aiCost({ database: bank.database });
    const base: AiOptions = {
      database: bank.database,
      secrets: bank.secrets,
      makeModels: stub.makeModels,
      cost,
      // The fake Connection's history counts as loaded.
      gates: { historyLoaded: async () => true, costCapPausedUntil: () => cost.pausedUntil() },
      notices: { raise: async () => {}, end: async () => {} },
    };
    const ai = householdAi(base);
    tailoring = startBudgetTailoring({
      database: bank.database,
      ai,
      now: () => {
        if (clockBroken) throw new Error("The clock broke.");
        return NOW;
      },
      startJob: async () => {
        jobsStarted += 1;
      },
    });
    options = { ...base, afterChange: tailoring.afterAiChange };
  });

  afterEach(() => {
    unknownStarts.clear();
    tailoring.stop();
    bank.close();
  });

  describe("the first draft", () => {
    it("takes the AI's figures at once, with the source AI draft and their reasons, in one call and no Proposal", async () => {
      await connectAi();
      const restaurants = await figureOf("Restaurants");
      stub.reply = reply([
        {
          category: "Restaurants",
          amount: (restaurants * 0.8) / 100,
          reason: "Eating out can drop a little to make room for the trip.",
        },
      ]);

      expect(await draftFirstBudgets(bank.database, NOW, tailorFirstDraft)).toBe(true);

      expect(stub.calls).toEqual([
        { tier: "writer", modelId: "writer-model", maxOutputTokens: 8_000 },
      ]);
      expect(await budgetOf("Restaurants")).toMatchObject({
        amount: Math.round((restaurants * 0.8) / 100) * 100,
        source: "AI draft",
        reason: "Eating out can drop a little to make room for the trip.",
      });
      // A Category the AI kept stays the formula's, with no reason.
      expect(await budgetOf("Groceries")).toMatchObject({
        amount: await figureOf("Groceries"),
        source: "formula",
        reason: null,
      });
      expect(await proposals()).toEqual([]);
      // The draft took the AI's figures, so connecting AI again makes no Tailoring run.
      await connectAi();
      expect(await listWaitingTailoringRuns(bank.database)).toEqual([]);
      expect(jobsStarted).toBe(0);
    });

    it("moves a figure beyond 50% of the formula's to the nearer end", async () => {
      await connectAi();
      const [restaurants, clothing] = [await figureOf("Restaurants"), await figureOf("Clothing")];
      stub.reply = reply([
        { category: "Restaurants", amount: 1 },
        { category: "Clothing", amount: (clothing * 10) / 100 },
      ]);

      await draftFirstBudgets(bank.database, NOW, tailorFirstDraft);

      expect(await budgetOf("Restaurants")).toMatchObject({
        amount: Math.ceil(restaurants / 200) * 100,
        source: "AI draft",
      });
      expect(await budgetOf("Clothing")).toMatchObject({
        amount: Math.floor((clothing * 3) / 200) * 100,
        source: "AI draft",
      });
    });

    it("keeps the formula's figure, with no reason, for a Category whose reason names a company", async () => {
      await connectAi();
      const [restaurants, clothing] = [await figureOf("Restaurants"), await figureOf("Clothing")];
      stub.reply = reply([
        {
          category: "Restaurants",
          amount: (restaurants * 0.8) / 100,
          reason: "Pay with a Wells Fargo card to earn back more.",
        },
        { category: "Clothing", amount: (clothing * 0.8) / 100, reason: "Clothes were one-offs." },
      ]);

      await draftFirstBudgets(bank.database, NOW, tailorFirstDraft);

      expect(await budgetOf("Restaurants")).toMatchObject({
        amount: restaurants,
        source: "formula",
        reason: null,
      });
      expect(await budgetOf("Clothing")).toMatchObject({
        source: "AI draft",
        reason: "Clothes were one-offs.",
      });
    });

    it("stores one Tailoring run when a retried first-run step takes the AI's figures", async () => {
      await connectAi();
      const month = { month: MONTH, budgets: [] };
      // The step's first try: the AI fails, so a Tailoring run waits, and the try fails before the
      // draft is stored.
      stub.answers.writer = "fail";
      expect(await tailorFirstDraft(month)).toBeUndefined();
      expect(await listWaitingTailoringRuns(bank.database)).toHaveLength(1);
      // The retry: the AI answers, and the draft takes its figures.
      await sql("DELETE FROM ai_retries");
      stub.answers.writer = "work";
      stub.reply = reply([{ category: "Restaurants", amount: 250 }]);

      expect(await draftFirstBudgets(bank.database, NOW, tailorFirstDraft)).toBe(true);

      expect(await budgetOf("Restaurants")).toMatchObject({ source: "AI draft" });
      expect(await sql("SELECT kind, ended_at FROM budget_tailoring_runs")).toEqual([
        { kind: "Tailoring", ended_at: NOW.toISOString() },
      ]);
      expect(await listWaitingTailoringRuns(bank.database)).toEqual([]);
      // The unique index holds it to one row.
      await expect(
        sql("INSERT INTO budget_tailoring_runs (kind, requested_at) VALUES ('Tailoring', ?)", [
          NOW.toISOString(),
        ]),
      ).rejects.toThrow();
    });

    it("never changes a Bills Budget or the Interest and fees Budget", async () => {
      await connectAi();
      const utilities = await figureOf("Utilities");
      const fees = await figureOf("Interest and fees");
      stub.reply = reply([
        { category: "Utilities", amount: (utilities * 1.2) / 100 },
        { category: "Interest and fees", amount: 50 },
      ]);

      await draftFirstBudgets(bank.database, NOW, tailorFirstDraft);

      expect(await budgetOf("Utilities")).toMatchObject({
        amount: utilities,
        source: "formula",
        reason: null,
      });
      expect(await budgetOf("Interest and fees")).toMatchObject({
        amount: fees,
        source: "formula",
        reason: null,
      });
    });

    it("sends the formula's figures and Benchmarks as the app made them, with no cache mark, and never the ZIP code or ages", async () => {
      await connectAi();
      const hobbies = await figureOf("Hobbies");
      const typed = `${Math.floor(hobbies / 100)}.${String(hobbies % 100).padStart(2, "0")}`;
      // An Account last 4 with the same digits as the Hobbies figure, as 4999 is 49.99: the filter
      // takes no number the app made for one.
      expect(typed).toMatch(/^\d{2}\.\d{2}$/);
      await sql("UPDATE household_accounts SET mask = ?", [typed.replace(".", "")]);
      stub.reply = reply([]);

      await draftFirstBudgets(bank.database, NOW, tailorFirstDraft);

      const read = promptTheModelRead(stub);
      expect(read).toContain("## This run: the first draft.");
      expect(read).toContain(`- Hobbies: the formula's figure ${typed}`);
      expect(read).toMatch(
        /- Utilities: the formula's figure [\d.]+; Benchmark|- Utilities: the formula's figure [\d.]+\n/,
      );
      expect(read).toContain("## Bills Budgets, never changed");
      expect(read).toContain("Task: Budget tailoring.");
      expect(read).not.toContain(ZIP_CODE);
      for (const age of AGES) expect(read).not.toMatch(new RegExp(`(?<![\\d.])${age}(?![\\d.])`));
      expect(read).not.toMatch(/\\\p{L}/u);
      expect(JSON.stringify(stub.prompts.at(-1))).not.toMatch(/cache/i);
    });

    it("is the formula's figures with no reasons and no call with no AI provider", async () => {
      await draftFirstBudgets(bank.database, NOW, tailorFirstDraft);

      expect(stub.calls).toEqual([]);
      const { budgets } = await budgetsForMonth(bank.database, MONTH);
      const figures = await formula();
      expect(budgets.length).toBeGreaterThan(0);
      for (const budget of budgets) {
        expect(budget).toMatchObject({
          amount: figures.get(budget.category as Category),
          source: "formula",
          reason: null,
        });
      }
      expect(await listWaitingTailoringRuns(bank.database)).toEqual([]);
    });

    it("is the formula's figures at the AI cost cap, and the Tailoring run proposes once AI runs again", async () => {
      await connectAi();
      await aiSettings(options).setCostCap(0);
      jobsStarted = 0;

      await draftFirstBudgets(bank.database, NOW, tailorFirstDraft);

      expect(stub.calls).toEqual([]);
      expect(await budgetOf("Restaurants")).toMatchObject({ source: "formula", reason: null });
      expect(await listWaitingTailoringRuns(bank.database)).toHaveLength(1);
      const restaurants = await figureOf("Restaurants");
      stub.reply = reply([{ category: "Restaurants", amount: (restaurants * 0.8) / 100 }]);

      await aiSettings(options).setCostCap(10_000);
      expect(jobsStarted).toBe(1);
      expect(await runWaitingTailoring()).toBe(1);

      expect(stub.calls).toHaveLength(1);
      expect(await proposals()).toEqual([expect.objectContaining({ kind: "Budget change" })]);
    });

    it("is the formula's figures when the AI fails, and its retries end with no Proposal", async () => {
      await connectAi();
      stub.answers.writer = "fail";

      await draftFirstBudgets(bank.database, NOW, tailorFirstDraft);

      const { budgets } = await budgetsForMonth(bank.database, MONTH);
      expect(budgets.every((budget) => budget.source === "formula")).toBe(true);
      expect(await listWaitingTailoringRuns(bank.database)).toHaveLength(1);
      // Each AI retry (1, 5 and 30 minutes) runs the waiting run once; the last takes the no-AI
      // path. One call each.
      for (const _retry of [1, 2, 3]) {
        await sql("UPDATE ai_retries SET retry_at = ?", ["2026-11-04T13:00:00.000Z"]);
        await runWaitingTailoring();
      }
      expect(stub.calls).toHaveLength(4);
      expect(await listWaitingTailoringRuns(bank.database)).toEqual([]);
      expect(await proposals()).toEqual([]);
    });
  });

  describe("the Tailoring run", () => {
    it("makes one Budget change Proposal with a reason per Category when AI is set up after the first draft", async () => {
      await draftFirstBudgets(bank.database, NOW, tailorFirstDraft);
      const [restaurants, clothing] = [await figureOf("Restaurants"), await figureOf("Clothing")];

      await connectAi();
      expect(jobsStarted).toBe(1);
      stub.reply = reply([
        { category: "Restaurants", amount: (restaurants * 0.8) / 100, reason: "Eat out less." },
        { category: "Clothing", amount: (clothing * 9) / 100, reason: "New school clothes." },
        { category: "Utilities", amount: 1, reason: "Bills drop." },
        { category: "Interest and fees", amount: 25, reason: "Fees drop." },
      ]);

      expect(await runWaitingTailoring()).toBe(1);

      expect(stub.calls).toHaveLength(1);
      expect(await proposals()).toEqual([
        {
          kind: "Budget change",
          source: "Budget tailoring",
          reason: "Restaurant Spending has room to come down for the Goal.",
          goal_id: null,
          goal_amount: null,
        },
      ]);
      // Clothing moves to 150% of the formula's figure, in whole dollars; Bills never appear.
      expect(await proposalLines()).toEqual([
        {
          category: "Clothing",
          amount: Math.floor((clothing * 3) / 200) * 100,
          reason: "New school clothes.",
        },
        {
          category: "Restaurants",
          amount: Math.round((restaurants * 0.8) / 100) * 100,
          reason: "Eat out less.",
        },
      ]);
      // Budgets stay as they are until a Member accepts.
      expect(await budgetOf("Restaurants")).toMatchObject({
        amount: restaurants,
        source: "formula",
      });

      // It runs once ever: another change to the AI settings asks for no new run, and no call.
      await connectAi();
      expect(await runWaitingTailoring()).toBe(0);
      expect(stub.calls).toEqual([]);
      expect(await proposals()).toHaveLength(1);
    });

    // Spec 05, Context for Bills Budgets: the CE mean for rented dwellings misleads a renter.
    it.each(["rent", "own"] as const)(
      "gives the AI a Housing Benchmark and its CE note only for a Household that owns (%s)",
      async (rentOrOwn) => {
        await saveHouseholdFacts(
          bank.database,
          { zipCode: ZIP_CODE, ages: AGES, rentOrOwn },
          MEMBER,
          NOW,
        );
        await draftFirstBudgets(bank.database, NOW, tailorFirstDraft);
        // A Member's pinned Housing Budget: the fake history has no Housing Spending.
        await sql(
          `INSERT INTO budgets (category, amount, period, takes_effect, source, set_by, pinned, set_at)
           VALUES ('Housing', ?, 'monthly', ?, 'Member edit', ?, 1, ?)`,
          [$(2_000), MONTH, MEMBER, NOW.toISOString()],
        );
        await connectAi();
        stub.reply = reply([]);

        await runWaitingTailoring();

        expect(stub.calls).toHaveLength(1);
        const housing = promptTheModelRead(stub)
          .split("\n")
          .filter((line) => line.startsWith("- Housing:"));
        expect(housing).toEqual([
          rentOrOwn === "rent"
            ? "- Housing: Budget 2000.00"
            : expect.stringMatching(
                /^- Housing: Budget 2000\.00; Benchmark \d+\.\d{2} a month\. CE leaves mortgage principal out/,
              ),
        ]);
      },
    );

    it("keeps each line within 50% of the current Budget too, and drops a line no figure can meet", async () => {
      await draftFirstBudgets(bank.database, NOW, tailorFirstDraft);
      const [restaurants, clothing, hobbies] = [
        await figureOf("Restaurants"),
        await figureOf("Clothing"),
        await figureOf("Hobbies"),
      ];
      // A Member moved two Budgets off the formula's figures.
      await editBudget(
        bank.database,
        { category: "Restaurants", amount: restaurants * 3, memberId: MEMBER },
        NOW,
      );
      await editBudget(
        bank.database,
        { category: "Hobbies", amount: hobbies * 4, memberId: MEMBER },
        NOW,
      );
      await connectAi();
      stub.reply = reply([
        // Within the formula's range, but under half of the current Budget: it moves up to half.
        { category: "Restaurants", amount: (restaurants * 1.4) / 100, reason: "Eat out less." },
        // No figure is within both the formula's range and the current Budget's: it is dropped.
        { category: "Hobbies", amount: (hobbies * 1.2) / 100, reason: "Fewer kits." },
        { category: "Clothing", amount: (clothing * 0.8) / 100, reason: "Clothes were one-offs." },
      ]);

      expect(await runWaitingTailoring()).toBe(1);

      expect(await proposals()).toEqual([
        expect.objectContaining({ kind: "Budget change", source: "Budget tailoring" }),
      ]);
      expect(await proposalLines()).toEqual([
        {
          category: "Clothing",
          amount: Math.round((clothing * 0.8) / 100) * 100,
          reason: "Clothes were one-offs.",
        },
        { category: "Restaurants", amount: (restaurants * 3) / 2, reason: "Eat out less." },
      ]);
    });

    it("waits at the AI cost cap, and with no AI provider ends with no call", async () => {
      await draftFirstBudgets(bank.database, NOW, tailorFirstDraft);
      await connectAi();
      await aiSettings(options).setCostCap(0);

      expect(await runWaitingTailoring()).toBe(0);
      expect(await listWaitingTailoringRuns(bank.database)).toHaveLength(1);

      await aiSettings(options).remove();
      expect(await runWaitingTailoring()).toBe(1);

      expect(stub.calls).toEqual([]);
      expect(await listWaitingTailoringRuns(bank.database)).toEqual([]);
      expect(await proposals()).toEqual([]);
    });

    it(`ends a run that keeps throwing after ${TAILORING_RUN_CAP} tries, with one System notice`, async () => {
      await draftFirstBudgets(bank.database, NOW, tailorFirstDraft);
      await connectAi();
      clockBroken = true;

      for (let tries = 1; tries < TAILORING_RUN_CAP; tries += 1) {
        expect(await runWaitingTailoring()).toBe(0);
        expect(await listWaitingTailoringRuns(bank.database)).toMatchObject([
          { failedTries: tries },
        ]);
      }
      expect(await runWaitingTailoring()).toBe(1);
      expect(await runWaitingTailoring()).toBe(0);

      expect(await listWaitingTailoringRuns(bank.database)).toEqual([]);
      const notices = (await listOpenNotices(bank.database)).filter(
        (notice) => notice.text === TAILORING_STOPPED_TEXT,
      );
      expect(notices).toHaveLength(1);
      expect(stub.calls).toEqual([]);
    });
  });

  describe("a Goal run", () => {
    beforeEach(async () => {
      await draftFirstBudgets(bank.database, NOW, tailorFirstDraft);
      // Connected without the settings hook: no Tailoring run.
      await aiSettings({ ...options, afterChange: undefined }).save({
        provider: "anthropic",
        apiKey: newAiKey(),
        baseUrl: null,
        quickModel: "quick-model",
        writerModel: "writer-model",
        prices: { quick: PRICE, writer: PRICE },
      });
      stub.calls.splice(0);
    });

    const spendLess = (words = "Spend less at restaurants") =>
      addGoal(bank.database, {
        words,
        authorId: MEMBER,
        date: "2026-11-04",
        target: { kind: "Category", category: "Restaurants" },
        change: null,
        deadline: null,
      });

    it("makes a Goal Budget change Proposal and a Goal amount Proposal for a spend less Goal", async () => {
      const restaurants = await figureOf("Restaurants");
      const goalId = await spendLess("Spend less\non restaurants\tthis year");
      stub.reply = reply(
        [
          { category: "Restaurants", amount: (restaurants * 0.8) / 100, reason: "Eat out less." },
          // A Category the Goal does not touch is left out.
          { category: "Groceries", amount: 1, reason: "Cook more." },
        ],
        { goalAmount: 200, goalReason: "Aim for $200 a month at restaurants." },
      );

      expect(await requestGoalTailoring(goalId)).toBe(true);
      expect(jobsStarted).toBe(1);
      expect(await runWaitingTailoring()).toBe(1);

      expect(stub.calls).toHaveLength(1);
      const read = promptTheModelRead(stub);
      expect(read).toContain(
        '- "Spend less on restaurants this year": spend less; baseline 300.00',
      );
      expect(read).toContain("Give its goalAmount.");
      expect(read).not.toMatch(/\\\p{L}/u);
      expect(await proposals()).toEqual([
        expect.objectContaining({ kind: "Budget change", source: "Budget tailoring" }),
        {
          kind: "Goal amount",
          source: "Budget tailoring",
          reason: "Aim for $200 a month at restaurants.",
          goal_id: goalId,
          goal_amount: $(200),
        },
      ]);
      expect(await proposalLines()).toEqual([
        {
          category: "Restaurants",
          amount: Math.round((restaurants * 0.8) / 100) * 100,
          reason: "Eat out less.",
        },
      ]);
      expect(await listWaitingTailoringRuns(bank.database)).toEqual([]);
    });

    it("holds a Category Goal's run to its Category from the Goal's reading, even with no known start", async () => {
      const restaurants = await figureOf("Restaurants");
      const goalId = await spendLess();
      unknownStarts.add(goalId);
      stub.reply = reply(
        [
          { category: "Restaurants", amount: (restaurants * 0.8) / 100, reason: "Eat out less." },
          { category: "Groceries", amount: 1, reason: "Cook more." },
        ],
        { goalAmount: 200, goalReason: "Aim for $200 a month at restaurants." },
      );

      await requestGoalTailoring(goalId);
      expect(await runWaitingTailoring()).toBe(1);

      // With no start, no Goal amount Proposal.
      expect(await proposals()).toEqual([expect.objectContaining({ kind: "Budget change" })]);
      expect(await proposalLines()).toEqual([expect.objectContaining({ category: "Restaurants" })]);
    });

    it("makes a Goal amount Proposal for a save Goal whose reading has no change", async () => {
      const goalId = await addGoal(bank.database, {
        words: "Save for a trip",
        authorId: MEMBER,
        date: "2026-11-04",
        target: { kind: "Saving" },
        change: null,
        deadline: null,
      });
      const restaurants = await figureOf("Restaurants");
      stub.reply = reply(
        [{ category: "Restaurants", amount: (restaurants * 0.9) / 100, reason: "Eat out less." }],
        { goalAmount: 1_500, goalReason: "Put $1500 away for the trip." },
      );

      await requestGoalTailoring(goalId);
      await runWaitingTailoring();

      expect(await proposals()).toEqual([
        expect.objectContaining({ kind: "Budget change" }),
        expect.objectContaining({ kind: "Goal amount", goal_id: goalId, goal_amount: $(1_500) }),
      ]);
    });

    it("makes no Goal amount Proposal from an AI amount at or above a spend less Goal's baseline", async () => {
      const goalId = await spendLess();
      stub.reply = reply([], { goalAmount: 300, goalReason: "Keep it as it is." });

      await requestGoalTailoring(goalId);
      await runWaitingTailoring();

      expect(await proposals()).toEqual([]);
    });

    it("proposes nothing from words a Member changed during its AI call, and runs again with the new words", async () => {
      const restaurants = await figureOf("Restaurants");
      const goalId = await spendLess();
      stub.reply = reply(
        [{ category: "Restaurants", amount: (restaurants * 0.8) / 100, reason: "Eat out less." }],
        { goalAmount: 200, goalReason: "Aim for $200 a month at restaurants." },
      );
      await requestGoalTailoring(goalId);
      // "Edit the words" lands while the run's Writer call is out, and asks for the Goal's run.
      let edited = false;
      stub.beforeAnswer = async () => {
        if (edited) return;
        edited = true;
        const words = {
          words: "Spend less at restaurants and bars",
          target: { kind: "Category", category: "Restaurants" },
          change: null,
          deadline: null,
        } as const;
        expect(await storeGoalWords(bank.database, goalId, words, NOW)).toBe(true);
        expect(await requestGoalTailoring(goalId)).toBe(false);
      };

      await runWaitingTailoring();

      expect(stub.calls).toHaveLength(1);
      expect(await proposals()).toEqual([]);
      expect(await listWaitingTailoringRuns(bank.database)).toEqual([
        expect.objectContaining({ kind: "Goal", goalId }),
      ]);

      // The job the edit started runs it with the new words.
      expect(await runWaitingTailoring()).toBe(1);
      expect(stub.calls).toHaveLength(2);
      expect(promptTheModelRead(stub)).toContain('"Spend less at restaurants and bars"');
      expect(await proposals()).toEqual([
        expect.objectContaining({ kind: "Budget change" }),
        expect.objectContaining({ kind: "Goal amount", goal_id: goalId, goal_amount: $(200) }),
      ]);
      expect(await listWaitingTailoringRuns(bank.database)).toEqual([]);
    });

    it("drops the run of a Goal marked done before it runs, with no call", async () => {
      const goalId = await spendLess();
      await requestGoalTailoring(goalId);
      expect(await markGoal(bank.database, goalId, "dropped", MEMBER, NOW)).toBe("marked");

      expect(await runWaitingTailoring()).toBe(1);

      expect(stub.calls).toEqual([]);
      expect(await proposals()).toEqual([]);
      expect(await listWaitingTailoringRuns(bank.database)).toEqual([]);
    });

    it("deletes a Goal's waiting run with the Goal", async () => {
      const goalId = await spendLess();
      await requestGoalTailoring(goalId);
      expect(await listWaitingTailoringRuns(bank.database)).toHaveLength(1);

      await sql("DELETE FROM goals WHERE id = ?", [goalId]);

      expect(await listWaitingTailoringRuns(bank.database)).toEqual([]);
    });
  });
});
