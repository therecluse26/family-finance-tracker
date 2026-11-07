import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AiOptions, aiCost, aiSettings, householdAi } from "../ai/index.ts";
import { newAiKey, type StubMessage, StubModels } from "../ai/testing.ts";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { runLaterHooks, syncConnection } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { benchmarkSnapshot } from "../benchmarks/index.ts";
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
  listOpenNotices,
  listWaitingTailoringRuns,
  recordRedraftInputs,
  storeDecisions,
} from "../db/index.ts";
import { registerFollowUpStep, runFollowUp } from "../follow-up/index.ts";
import { saveHouseholdFacts } from "../household/index.ts";
import { acceptProposal, openProposals, propose, skipProposal } from "../proposals/index.ts";
import { typeSteadyIncome } from "../recurring/index.ts";
import {
  afterSteadyIncomeTyped,
  checkBenchmarkRedraft,
  checkIncomeRedraft,
  checkNewBankRedraft,
  factsRedraft,
  REDRAFT_STOPPED_TEXT,
  runWaitingTailoring,
  startBudgetTailoring,
  startRedrafts,
  TAILORING_RUN_CAP,
  TAILORING_STOPPED_TEXT,
  type TailoringReply,
  tailorFirstDraft,
} from "./index.ts";

// Redraft Proposals (spec 05, Which Proposals exist; What accepting a Proposal changes) on a small
// Household: 3 months of Spending through the fake adapter, a typed Steady Income, and Household
// facts. AI SDK test models only: no test calls an AI provider.

const BANK = "fake-redraft-bank";
const MEMBER = "member-1";
const NOW = new Date("2026-11-04T14:00:00.000Z");
const MONTH = "2026-11";
const DAY_MS = 24 * 60 * 60 * 1000;
const PRICE = { input: 1_000_000, output: 2_000_000 };
const CHECKING = fakeAccount({ id: "acc-checking" });
const DATES = ["2026-08-12", "2026-09-12", "2026-10-12"];

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
const reply = (budgets: { category: Category; amount: number; reason?: string }[] = []): string =>
  JSON.stringify({
    reason: "The new figures leave room for the trip.",
    budgets: budgets.map((line) => ({ reason: `${line.category} fits the draft.`, ...line })),
    goalAmount: null,
    goalReason: null,
  } satisfies TailoringReply);

function promptTheModelRead(stub: StubModels): string {
  return (stub.prompts.at(-1) ?? [])
    .filter((message: StubMessage) => message.role === "user")
    .map(({ content }) =>
      typeof content === "string" ? content : content.map((part) => part.text ?? "").join(""),
    )
    .join("\n");
}

describe("Redraft Proposals", () => {
  let bank: TestBank;
  let stub: StubModels;
  let options: AiOptions;
  let tailoring: ReturnType<typeof startBudgetTailoring>;
  let redrafts: ReturnType<typeof startRedrafts>;
  let jobsStarted: number;
  let now: Date;
  // How many more clock reads throw, so a run fails before its AI call.
  let brokenReads: number;

  const sql = async (text: string, args: (string | number | null)[] = []) =>
    (await bank.database.$client.execute({ sql: text, args })).rows;

  // Spending on a Connection's Account, each line in one month, decided as Spending.
  const addSpending = async (
    connectionId: string,
    bankId: string,
    account: ReturnType<typeof fakeAccount>,
    lines: { id: string; category: Category; dollars: number; date: string }[],
  ) => {
    const records = lines.map((line) =>
      fakeTxn({
        id: line.id,
        accountId: account.id,
        amount: -$(line.dollars),
        postedDate: line.date,
      }),
    );
    bank.fake.addPages(bankId, { accounts: [account], added: records });
    await syncConnection(connectionId, () => NOW);
    const ids = new Map(
      (await sql("SELECT id, provider_transaction_id FROM transactions")).map((row) => [
        String(row.provider_transaction_id),
        String(row.id),
      ]),
    );
    await storeDecisions(
      bank.database,
      lines.map((line) => ({
        transactionId: ids.get(line.id) ?? "",
        step: "5.7",
        provisionalUntil: null,
        decidedAt: NOW,
        parts: [
          {
            type: "Spending" as const,
            amount: -$(line.dollars),
            category: line.category,
            linked: false,
          },
        ],
      })),
    );
  };

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
    stub.calls.splice(0);
    stub.prompts.splice(0);
  };

  // The first draft, with AI set up: the AI keeps every figure, so the Budgets are the formula's
  // and no Tailoring run follows.
  const firstDraft = async () => {
    await connectAi();
    stub.reply = reply();
    expect(await draftFirstBudgets(bank.database, NOW, tailorFirstDraft)).toBe(true);
    stub.calls.splice(0);
    stub.prompts.splice(0);
  };

  // The formula's figure for each Category this month, in whole cents.
  const formula = async () => {
    const terms = await readDraftTerms(bank.database, MONTH, now);
    return new Map(
      fitToIncome(draftBudgets(terms), terms).budgets.map((each) => [each.category, each.amount]),
    );
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
  const inputs = async () =>
    (await sql("SELECT steady_income, ce_data_year FROM budget_inputs"))[0] ?? {};
  const proposals = () => sql("SELECT id, status, reason FROM proposals ORDER BY created_at");
  const proposalLines = () =>
    sql("SELECT category, amount, reason FROM proposal_budgets ORDER BY category");
  const waiting = async () =>
    (await listWaitingTailoringRuns(bank.database)).filter((run) => run.kind === "Redraft");
  // A release whose CE data year is newer than the one behind the current Budgets.
  const olderCeYear = () =>
    sql("UPDATE budget_inputs SET ce_data_year = ?", [benchmarkSnapshot().ce.dataYear - 1]);

  beforeEach(async () => {
    bank = await newTestBank();
    const connectionId = await bank.connect(BANK);
    await sql(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES (?, 'Jamie Rivera', 'jamie@example.com', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
      [MEMBER],
    );
    await addSpending(
      connectionId,
      BANK,
      CHECKING,
      DATES.flatMap((date, month) =>
        SPENDING.map(([category, dollars]) => ({
          id: `${category}-${month}`,
          category,
          dollars,
          date,
        })),
      ),
    );
    await typeSteadyIncome(bank.database, $(6_000), MEMBER, NOW);
    await saveHouseholdFacts(
      bank.database,
      { zipCode: "18950", ages: [37, 41], rentOrOwn: "rent" },
      MEMBER,
      NOW,
    );

    stub = new StubModels();
    jobsStarted = 0;
    now = NOW;
    brokenReads = 0;
    const clock = () => {
      if (brokenReads > 0) {
        brokenReads -= 1;
        throw new Error("The clock broke.");
      }
      return now;
    };
    const cost = aiCost({ database: bank.database });
    const base: AiOptions = {
      database: bank.database,
      secrets: bank.secrets,
      makeModels: stub.makeModels,
      cost,
      gates: { historyLoaded: async () => true, costCapPausedUntil: () => cost.pausedUntil() },
      notices: { raise: async () => {}, end: async () => {} },
    };
    const ai = householdAi(base);
    tailoring = startBudgetTailoring({
      database: bank.database,
      ai,
      now: clock,
      startJob: async () => {
        jobsStarted += 1;
      },
    });
    redrafts = startRedrafts({ database: bank.database, ai, now: () => now });
    options = { ...base, afterChange: tailoring.afterAiChange };
  });

  afterEach(() => {
    redrafts.stop();
    tailoring.stop();
    bank.close();
  });

  describe("Income redraft", () => {
    it("asks for one redraft only when I moves more than 10%, and its Proposal holds the new I", async () => {
      await firstDraft();

      // 10% is not more than 10%.
      await typeSteadyIncome(bank.database, $(6_600), MEMBER, NOW);
      expect(await checkIncomeRedraft()).toBe(false);
      await typeSteadyIncome(bank.database, $(5_400), MEMBER, NOW);
      expect(await checkIncomeRedraft()).toBe(false);
      expect(await waiting()).toEqual([]);

      await typeSteadyIncome(bank.database, $(6_700), MEMBER, NOW);
      await afterSteadyIncomeTyped();
      expect(await waiting()).toHaveLength(1);
      expect(jobsStarted).toBe(1);
      // The run already waits: another check asks for none.
      expect(await checkIncomeRedraft()).toBe(false);
      expect(await waiting()).toHaveLength(1);

      stub.reply = reply();
      expect(await runWaitingTailoring()).toBe(1);
      expect(stub.calls).toEqual([
        { tier: "writer", modelId: "writer-model", maxOutputTokens: 1_500 },
      ]);
      expect(promptTheModelRead(stub)).toContain("This run: a redraft of the flexible Budgets.");
      const restaurants = await figureOf("Restaurants");
      expect(await proposals()).toEqual([
        expect.objectContaining({
          status: "open",
          reason: "The new figures leave room for the trip.",
        }),
      ]);
      expect(await proposalLines()).toContainEqual({
        category: "Restaurants",
        amount: restaurants,
        reason: null,
      });
      expect(await sql("SELECT steady_income FROM redraft_proposals")).toEqual([
        { steady_income: $(6_700) },
      ]);
      // While the Proposal is open, its I covers the move: no second redraft.
      expect(await checkIncomeRedraft()).toBe(false);
      expect(await waiting()).toEqual([]);
      expect(await inputs()).toMatchObject({ steady_income: $(6_000) });
    });

    it("runs in the follow-up job only after a sync brings Transactions, never on every run", async () => {
      await firstDraft();
      await typeSteadyIncome(bank.database, $(7_000), MEMBER, NOW);
      // The setup's Transactions are new to the redraft check step.
      await runFollowUp(() => now);
      expect(await waiting()).toHaveLength(1);
      stub.reply = reply();
      await runWaitingTailoring();
      const [proposal] = await proposals();
      await skipProposal(bank.database, { id: String(proposal?.id), memberId: MEMBER }, now);

      // Nothing new: the step does not run, and no redraft follows.
      await typeSteadyIncome(bank.database, $(9_000), MEMBER, NOW);
      await runFollowUp(() => now);
      expect(await waiting()).toEqual([]);
      // A sync brings a Transaction: the step runs, and the move is due.
      const connectionId = String((await sql("SELECT id FROM connections"))[0]?.id);
      await addSpending(connectionId, BANK, CHECKING, [
        { id: "late-1", category: "Hobbies", dollars: 5, date: "2026-11-02" },
      ]);
      await runFollowUp(() => now);
      expect(await waiting()).toHaveLength(1);
      expect(stub.calls).toHaveLength(1);
    });
  });

  describe("the redraft", () => {
    it("lists each flexible Category whose figure differs from its Budget by 5% or more", async () => {
      await firstDraft();
      const [restaurants, clothing, hobbies] = [
        await figureOf("Restaurants"),
        await figureOf("Clothing"),
        await figureOf("Hobbies"),
      ];
      // 3% off the formula: not listed. 25% off: listed, back at the formula's figure.
      await editBudget(
        bank.database,
        {
          category: "Restaurants",
          amount: Math.round((restaurants * 1.03) / 100) * 100,
          memberId: MEMBER,
        },
        NOW,
      );
      await editBudget(
        bank.database,
        { category: "Clothing", amount: (clothing * 5) / 4, memberId: MEMBER },
        NOW,
      );
      await editBudget(
        bank.database,
        { category: "Utilities", amount: $(900), memberId: MEMBER },
        NOW,
      );
      await olderCeYear();
      expect(await checkBenchmarkRedraft()).toBe(true);
      stub.reply = reply([
        // Within the formula's range, and 20% under the Budget: listed with the AI's reason.
        { category: "Hobbies", amount: (hobbies * 0.8) / 100, reason: "Fewer kits this season." },
        { category: "Utilities", amount: 10, reason: "Bills drop." },
      ]);

      expect(await runWaitingTailoring()).toBe(1);

      expect(stub.calls).toHaveLength(1);
      expect(await proposals()).toHaveLength(1);
      expect(await proposalLines()).toEqual([
        { category: "Clothing", amount: clothing, reason: null },
        {
          category: "Hobbies",
          amount: Math.round((hobbies * 0.8) / 100) * 100,
          reason: "Fewer kits this season.",
        },
      ]);
    });

    it("makes no Proposal when nothing differs, and records its inputs so the trigger does not repeat", async () => {
      await firstDraft();
      await olderCeYear();
      expect(await checkBenchmarkRedraft()).toBe(true);
      stub.reply = reply();

      expect(await runWaitingTailoring()).toBe(1);

      expect(await proposals()).toEqual([]);
      expect(await inputs()).toMatchObject({ ce_data_year: benchmarkSnapshot().ce.dataYear });
      now = new Date(NOW.getTime() + 400 * DAY_MS);
      expect(await checkBenchmarkRedraft()).toBe(false);
      expect(stub.calls).toHaveLength(1);
    });

    it("takes the formula's figure for a Category whose reason names a company", async () => {
      await firstDraft();
      const restaurants = await figureOf("Restaurants");
      await editBudget(
        bank.database,
        { category: "Restaurants", amount: restaurants * 2, memberId: MEMBER },
        NOW,
      );
      await factsRedraft();
      stub.reply = reply([
        { category: "Restaurants", amount: (restaurants * 1.4) / 100, reason: "Use a Chase card." },
      ]);

      await runWaitingTailoring();

      expect(await proposalLines()).toEqual([
        { category: "Restaurants", amount: restaurants, reason: null },
      ]);
    });
  });

  describe("handling a redraft", () => {
    // An Income redraft that proposes Clothing back at the formula's figure.
    const openRedraft = async () => {
      await firstDraft();
      const clothing = await figureOf("Clothing");
      await editBudget(
        bank.database,
        { category: "Clothing", amount: clothing * 2, memberId: MEMBER },
        NOW,
      );
      await typeSteadyIncome(bank.database, $(7_000), MEMBER, NOW);
      expect(await checkIncomeRedraft()).toBe(true);
      stub.reply = reply();
      await runWaitingTailoring();
      const [proposal] = await proposals();
      if (proposal === undefined) throw new Error("No redraft Proposal");
      return String(proposal.id);
    };

    it("records its inputs on accept, with the Budgets changed", async () => {
      const id = await openRedraft();
      const clothing = await figureOf("Clothing");

      expect(await acceptProposal(bank.database, { id, memberId: MEMBER }, now)).toBe("accepted");

      expect(await budgetOf("Clothing")).toMatchObject({ amount: clothing, source: "Proposal" });
      expect(await inputs()).toEqual({
        steady_income: $(7_000),
        ce_data_year: benchmarkSnapshot().ce.dataYear,
      });
      expect(await checkIncomeRedraft()).toBe(false);
    });

    it("records its inputs on skip, with no Budget changed, and the same trigger does not repeat", async () => {
      const id = await openRedraft();
      const before = await budgetOf("Clothing");

      expect(await skipProposal(bank.database, { id, memberId: MEMBER }, now)).toBe(true);

      expect(await budgetOf("Clothing")).toEqual(before);
      expect(await inputs()).toMatchObject({ steady_income: $(7_000) });
      expect(await checkIncomeRedraft()).toBe(false);
      expect(await waiting()).toEqual([]);
      expect(stub.calls).toHaveLength(1);
    });

    it("records its inputs on expiry", async () => {
      await openRedraft();
      now = new Date(NOW.getTime() + 61 * DAY_MS);

      expect(await openProposals(bank.database, now)).toEqual([]);

      expect(await inputs()).toMatchObject({ steady_income: $(7_000) });
      expect(await checkIncomeRedraft()).toBe(false);
    });

    it("records its inputs when a newer Proposal replaces it", async () => {
      // A Benchmark redraft whose only line is Clothing.
      await firstDraft();
      const clothing = await figureOf("Clothing");
      await editBudget(
        bank.database,
        { category: "Clothing", amount: clothing * 2, memberId: MEMBER },
        NOW,
      );
      await olderCeYear();
      expect(await checkBenchmarkRedraft()).toBe(true);
      stub.reply = reply();
      await runWaitingTailoring();
      expect(await proposalLines()).toEqual([
        { category: "Clothing", amount: clothing, reason: null },
      ]);
      const id = String((await proposals())[0]?.id);

      const chat = await propose(
        bank.database,
        {
          kind: "Budget change",
          source: "Chat",
          runId: "chat-answer-1",
          reason: "Clothes cost less now.",
          budgets: [{ category: "Clothing", amount: Math.round((clothing * 1.5) / 100) * 100 }],
        },
        now,
      );

      expect(chat.outcome).toBe("shown");
      expect(await sql("SELECT status FROM proposals WHERE id = ?", [id])).toEqual([
        { status: "replaced" },
      ]);
      expect(await inputs()).toMatchObject({ ce_data_year: benchmarkSnapshot().ce.dataYear });
    });

    it("records nothing when a Proposal that is no redraft closes", async () => {
      await firstDraft();
      const clothing = await figureOf("Clothing");
      const chat = await propose(
        bank.database,
        {
          kind: "Budget change",
          source: "Chat",
          runId: "chat-answer-1",
          reason: "Clothes cost less now.",
          budgets: [{ category: "Clothing", amount: Math.round((clothing * 0.8) / 100) * 100 }],
        },
        now,
      );
      if (chat.outcome !== "shown") throw new Error("The Chat Proposal was refused");
      // A newer redraft, closed some other way, whose inputs this close must not record.
      const later = new Date(NOW.getTime() + DAY_MS).toISOString();
      await sql(
        `INSERT INTO proposals (id, kind, source, run_id, reason, status, created_at, closed_at)
         VALUES ('other-redraft', 'Budget change', 'Budget tailoring', 'Redraft run 99', 'Redraft.', 'skipped', ?, ?)`,
        [later, later],
      );
      await sql(
        `INSERT INTO redraft_proposals (proposal_id, steady_income, ce_data_year, sample_benchmarks)
         VALUES ('other-redraft', ?, 2030, 0)`,
        [$(9_000)],
      );

      await skipProposal(bank.database, { id: chat.id, memberId: MEMBER }, now);

      expect(await inputs()).toMatchObject({ steady_income: $(6_000) });
    });

    it("never lets an older redraft's close replace a newer redraft's inputs", async () => {
      const older = await openRedraft();
      // A newer redraft, at a newer I, was handled a day later.
      const newer = { steadyIncome: $(8_000), ceDataYear: 2030, sampleBenchmarks: false };
      now = new Date(NOW.getTime() + DAY_MS);
      expect(await recordRedraftInputs(bank.database, newer, now)).toBe(true);

      expect(await skipProposal(bank.database, { id: older, memberId: MEMBER }, now)).toBe(true);

      expect(await inputs()).toEqual({ steady_income: $(8_000), ce_data_year: 2030 });
    });

    it("deletes a redraft's inputs with its Proposal", async () => {
      const id = await openRedraft();

      await sql("DELETE FROM proposals WHERE id = ?", [id]);

      expect(await sql("SELECT proposal_id FROM redraft_proposals")).toEqual([]);
    });

    it("refuses a redraft's inputs from any source but Budget tailoring", async () => {
      await firstDraft();
      const clothing = await figureOf("Clothing");

      const chat = await propose(
        bank.database,
        {
          kind: "Budget change",
          source: "Chat",
          runId: "chat-answer-1",
          reason: "Clothes cost less now.",
          budgets: [{ category: "Clothing", amount: clothing }],
          redraft: { steadyIncome: $(9_000), ceDataYear: 2030, sampleBenchmarks: false },
        },
        now,
      );

      expect(chat.outcome).toBe("refused");
      expect(await sql("SELECT * FROM redraft_proposals")).toEqual([]);
    });
  });

  describe("Benchmark redraft", () => {
    it("asks once when the CE data year is newer, and at most once a year", async () => {
      await firstDraft();
      expect(await checkBenchmarkRedraft()).toBe(false);

      await olderCeYear();
      expect(await checkBenchmarkRedraft()).toBe(true);
      // The next start finds the redraft waiting.
      expect(await checkBenchmarkRedraft()).toBe(false);
      expect(await waiting()).toHaveLength(1);
      stub.reply = reply();
      await runWaitingTailoring();
      expect(await inputs()).toMatchObject({ ce_data_year: benchmarkSnapshot().ce.dataYear });

      // A second release with newer data within the year waits for the year to pass.
      await olderCeYear();
      now = new Date(NOW.getTime() + 300 * DAY_MS);
      expect(await checkBenchmarkRedraft()).toBe(false);
      now = new Date(NOW.getTime() + 366 * DAY_MS);
      expect(await checkBenchmarkRedraft()).toBe(true);
    });
  });

  describe("New bank redraft", () => {
    it("asks for a redraft when a bank added later moves a Category's 12-month average more than 10%", async () => {
      await firstDraft();
      const small = await bank.connect("fake-small-bank");
      // $30 on top of $900 of Restaurants is not more than 10%.
      await addSpending(small, "fake-small-bank", fakeAccount({ id: "acc-small" }), [
        { id: "small-1", category: "Restaurants", dollars: 30, date: DATES[0] ?? "" },
      ]);
      expect(await checkNewBankRedraft(small)).toBe(false);
      expect(await waiting()).toEqual([]);

      const card = await bank.connect("fake-card-bank");
      await addSpending(card, "fake-card-bank", fakeAccount({ id: "acc-card" }), [
        { id: "card-1", category: "Restaurants", dollars: 200, date: DATES[1] ?? "" },
      ]);
      expect(await checkNewBankRedraft(card)).toBe(true);
      expect(await waiting()).toHaveLength(1);
    });

    it("asks for a redraft when a bank added later starts the history earlier, so n grows", async () => {
      await firstDraft();
      const card = await bank.connect("fake-card-bank");
      // One small Transaction, a year back: the history window grows from 2 months to 10, and
      // every average falls to a fifth.
      await addSpending(card, "fake-card-bank", fakeAccount({ id: "acc-card" }), [
        { id: "card-old", category: "Hobbies", dollars: 5, date: "2025-12-03" },
      ]);

      expect(await checkNewBankRedraft(card)).toBe(true);
      expect(await waiting()).toHaveLength(1);
    });

    it("runs from the bank-added-later hook, once its hooks are due", async () => {
      await firstDraft();
      const card = await bank.connect("fake-card-bank");
      await addSpending(card, "fake-card-bank", fakeAccount({ id: "acc-card" }), [
        { id: "card-1", category: "Restaurants", dollars: 200, date: DATES[1] ?? "" },
      ]);
      // The sync alone asks for nothing: the hook runs once the bank's history loaded.
      expect(await waiting()).toEqual([]);
      await sql("UPDATE connections SET later_hooks_started_at = ? WHERE id = ?", [
        NOW.toISOString(),
        card,
      ]);

      await runLaterHooks();

      expect(await waiting()).toHaveLength(1);
    });

    it("checks a bank of 2,500 Transactions within 2 seconds", async () => {
      await firstDraft();
      const card = await bank.connect("fake-card-bank");
      const categories: Category[] = ["Restaurants", "Clothing", "Hobbies", "Groceries"];
      await addSpending(
        card,
        "fake-card-bank",
        fakeAccount({ id: "acc-card" }),
        Array.from({ length: 2_500 }, (_, index) => ({
          id: `card-${index}`,
          category: categories[index % categories.length] ?? "Hobbies",
          dollars: 1,
          date: DATES[index % DATES.length] ?? "",
        })),
      );

      const started = performance.now();
      expect(await checkNewBankRedraft(card)).toBe(true);
      expect(performance.now() - started).toBeLessThan(2_000);
    }, 60_000);

    it("asks for none before the first draft, which takes every bank's history", async () => {
      const card = await bank.connect("fake-card-bank");
      await addSpending(card, "fake-card-bank", fakeAccount({ id: "acc-card" }), [
        { id: "card-1", category: "Restaurants", dollars: 500, date: DATES[1] ?? "" },
      ]);
      await connectAi();

      expect(await checkNewBankRedraft(card)).toBe(false);
      expect(await waiting()).toEqual([]);
    });
  });

  describe("Facts redraft", () => {
    it("asks for one redraft when a Member edits the Household facts", async () => {
      await firstDraft();

      await saveHouseholdFacts(
        bank.database,
        { zipCode: "18950", ages: [37, 41, 9], rentOrOwn: "rent" },
        MEMBER,
        NOW,
      );

      expect(await waiting()).toHaveLength(1);
      expect(jobsStarted).toBe(1);
    });
  });

  describe("every trigger", () => {
    it("makes one run for triggers close together, and one AI call", async () => {
      await firstDraft();
      await olderCeYear();
      await typeSteadyIncome(bank.database, $(7_000), MEMBER, NOW);

      const asked = await Promise.all([
        factsRedraft(),
        factsRedraft(),
        checkIncomeRedraft(),
        checkBenchmarkRedraft(),
        factsRedraft(),
      ]);

      expect(asked.filter((each) => each)).toHaveLength(1);
      expect(await waiting()).toHaveLength(1);
      stub.reply = reply();
      expect(await runWaitingTailoring()).toBe(1);
      expect(stub.calls).toHaveLength(1);
      expect(await runWaitingTailoring()).toBe(0);
      expect(stub.calls).toHaveLength(1);
    });

    it("runs once more when the Household facts change during its AI call", async () => {
      await firstDraft();
      expect(await factsRedraft()).toBe(true);
      stub.reply = reply();
      let edits = 0;
      stub.beforeAnswer = async () => {
        if (edits > 0) return;
        edits += 1;
        // A third person changes the household size, and so the Benchmarks the run already read.
        await saveHouseholdFacts(
          bank.database,
          { zipCode: "18950", ages: [37, 41, 9], rentOrOwn: "rent" },
          MEMBER,
          NOW,
        );
      };

      expect(await runWaitingTailoring()).toBe(1);
      const first = promptTheModelRead(stub);
      expect(await waiting()).toHaveLength(1);
      expect(jobsStarted).toBe(2);

      expect(await runWaitingTailoring()).toBe(1);
      expect(promptTheModelRead(stub)).not.toBe(first);
      expect(await waiting()).toEqual([]);
      expect(stub.calls).toHaveLength(2);
    });

    it("runs once more when a bank added later is checked during its AI call", async () => {
      await firstDraft();
      expect(await factsRedraft()).toBe(true);
      const card = await bank.connect("fake-card-bank");
      await addSpending(card, "fake-card-bank", fakeAccount({ id: "acc-card" }), [
        { id: "card-1", category: "Restaurants", dollars: 200, date: DATES[1] ?? "" },
      ]);
      stub.reply = reply();
      let checks = 0;
      stub.beforeAnswer = async () => {
        if (checks > 0) return;
        checks += 1;
        expect(await checkNewBankRedraft(card)).toBe(false);
      };

      expect(await runWaitingTailoring()).toBe(1);
      expect(await waiting()).toHaveLength(1);
      expect(await runWaitingTailoring()).toBe(1);
      expect(await waiting()).toEqual([]);
      expect(stub.calls).toHaveLength(2);
    });

    it("stores the Proposal of a third run after triggers during the first two", async () => {
      await firstDraft();
      const clothing = await figureOf("Clothing");
      await editBudget(
        bank.database,
        { category: "Clothing", amount: clothing * 2, memberId: MEMBER },
        NOW,
      );
      expect(await factsRedraft()).toBe(true);
      stub.reply = reply();
      const edits = [
        [37, 41, 9],
        [37, 41, 9, 6],
      ];
      stub.beforeAnswer = async () => {
        const ages = edits.shift();
        if (ages === undefined) return;
        await saveHouseholdFacts(
          bank.database,
          { zipCode: "18950", ages, rentOrOwn: "rent" },
          MEMBER,
          NOW,
        );
      };

      for (let run = 1; run <= 3; run += 1) expect(await runWaitingTailoring()).toBe(1);

      expect(await waiting()).toEqual([]);
      expect(stub.calls).toHaveLength(3);
      expect((await proposals()).map((row) => row.status).sort()).toEqual([
        "open",
        "replaced",
        "replaced",
      ]);
      expect(await listOpenNotices(bank.database)).toEqual([]);
    });

    it(`stops after ${TAILORING_RUN_CAP} runs when a trigger fires during every run`, async () => {
      await firstDraft();
      expect(await factsRedraft()).toBe(true);
      stub.reply = reply();
      stub.beforeAnswer = async () => {
        await factsRedraft();
      };

      for (let run = 1; run <= TAILORING_RUN_CAP + 1; run += 1) await runWaitingTailoring();

      expect(await waiting()).toEqual([]);
      expect(stub.calls).toHaveLength(TAILORING_RUN_CAP);
      const notices = (await listOpenNotices(bank.database)).filter(
        (notice) => notice.text === REDRAFT_STOPPED_TEXT,
      );
      expect(notices).toHaveLength(1);
    });

    it("asks for none, and makes no Proposal, with no AI provider", async () => {
      expect(await draftFirstBudgets(bank.database, NOW)).toBe(true);
      await olderCeYear();
      await typeSteadyIncome(bank.database, $(7_000), MEMBER, NOW);

      expect(await checkIncomeRedraft()).toBe(false);
      expect(await checkBenchmarkRedraft()).toBe(false);
      expect(await factsRedraft()).toBe(false);
      expect(await runWaitingTailoring()).toBe(0);

      expect(await waiting()).toEqual([]);
      expect(await proposals()).toEqual([]);
      expect(stub.calls).toEqual([]);
    });

    it("asks for none before the first draft", async () => {
      await connectAi();
      await typeSteadyIncome(bank.database, $(7_000), MEMBER, NOW);

      expect(await checkIncomeRedraft()).toBe(false);
      expect(await checkBenchmarkRedraft()).toBe(false);
      expect(await factsRedraft()).toBe(false);
      expect(await waiting()).toEqual([]);
    });

    it(`ends a redraft that keeps throwing after ${TAILORING_RUN_CAP} tries, and records its inputs`, async () => {
      await firstDraft();
      await typeSteadyIncome(bank.database, $(7_000), MEMBER, NOW);
      expect(await checkIncomeRedraft()).toBe(true);
      brokenReads = TAILORING_RUN_CAP;

      for (let tries = 1; tries < TAILORING_RUN_CAP; tries += 1) {
        expect(await runWaitingTailoring()).toBe(0);
      }
      expect(await runWaitingTailoring()).toBe(1);

      expect(await waiting()).toEqual([]);
      const notices = (await listOpenNotices(bank.database)).filter(
        (notice) => notice.text === TAILORING_STOPPED_TEXT,
      );
      expect(notices).toHaveLength(1);
      expect(stub.calls).toEqual([]);
      expect(await inputs()).toMatchObject({ steady_income: $(7_000) });
      expect(await checkIncomeRedraft()).toBe(false);
    });

    it("records its inputs when the AI fails, so a failing AI is not asked again on each sync", async () => {
      await firstDraft();
      await typeSteadyIncome(bank.database, $(7_000), MEMBER, NOW);
      await checkIncomeRedraft();
      stub.answers.writer = "fail";
      await runWaitingTailoring();
      // Each AI retry (1, 5 and 30 minutes) runs the waiting run once; the last takes the no-AI
      // path. One call each.
      for (const _retry of [1, 2, 3]) {
        await sql("UPDATE ai_retries SET retry_at = ?", ["2026-11-04T13:00:00.000Z"]);
        await runWaitingTailoring();
      }

      expect(stub.calls).toHaveLength(4);
      expect(await waiting()).toEqual([]);
      expect(await proposals()).toEqual([]);
      expect(await inputs()).toMatchObject({ steady_income: $(7_000) });
      expect(await checkIncomeRedraft()).toBe(false);
    });
  });

  it("the follow-up step is registered while redrafts run", () => {
    expect(() => registerFollowUpStep("redraft check", async () => undefined)).toThrow();
  });
});
