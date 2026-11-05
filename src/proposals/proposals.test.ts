import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { budgetsForMonth, editBudget } from "../budgets/index.ts";
import type * as Db from "../db/index.ts";
import {
  addGoal,
  claimGoalAmount,
  expireProposals,
  listBudgetsInEffect,
  type NewBudget,
  readGoal,
  storeBudgetChangeAccept,
  storeDecisions,
  storeFirstDraft,
  storeGoalAmountApplied,
  storeNewGoalAccept,
} from "../db/index.ts";
import { readEveryTable } from "../db/testing.ts";
import type * as Goals from "../goals/index.ts";
import { markGoal, startGoal } from "../goals/index.ts";
import {
  acceptProposal,
  GUARDRAIL,
  namedCompany,
  openProposals,
  type ProposalInput,
  propose,
  skipProposal,
  US_BANKS_AND_LENDERS,
  undoableProposals,
  undoProposal,
} from "./index.ts";

// Spies that pass through, so a test can count the expiry writes or make one step of an Accept
// fail.
vi.mock("../db/index.ts", async (original) => {
  const actual = await original<typeof Db>();
  return {
    ...actual,
    expireProposals: vi.fn(actual.expireProposals),
    storeGoalAmountApplied: vi.fn(actual.storeGoalAmountApplied),
  };
});
vi.mock("../goals/index.ts", async (original) => {
  const actual = await original<typeof Goals>();
  return { ...actual, startGoal: vi.fn(actual.startGoal) };
});

// Proposals (spec 08, Proposals; Guardrails; Lifecycle; spec 05, What accepting a Proposal
// changes). Every Proposal is written by code, as a run would send it, with no AI call. The
// Household time zone is unset, so Household time is UTC.

const $ = (dollars: number) => Math.round(dollars * 100);
const at = (date: string) => new Date(`${date}T15:00:00.000Z`);
const NOW = at("2026-10-20");
const HOUSEHOLD_BANK = "Pinecrest Credit Union";

const PROPOSAL_TABLES = new Set(["proposals", "proposal_budgets"]);

describe("Proposals", () => {
  let bank: TestBank;
  let connectionId: string;
  let runs = 0;

  beforeEach(async () => {
    bank = await newTestBank();
    connectionId = await bank.connect("bank-1", HOUSEHOLD_BANK);
    for (const id of ["member-a", "member-b"]) {
      await bank.database.$client.execute({
        sql: `INSERT INTO members (id, name, email, created_at, updated_at)
              VALUES (?, ?, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
        args: [id, id, `${id}@example.com`],
      });
    }
    const budget = (category: string, amount: number, fields: Partial<NewBudget> = {}) => ({
      category,
      amount,
      period: "monthly" as const,
      takesEffect: "2026-10",
      source: "formula" as const,
      setBy: null,
      pinned: null,
      setAt: at("2026-10-01"),
      ...fields,
    });
    await storeFirstDraft(bank.database, {
      inputs: {
        steadyIncome: $(6000),
        ceDataYear: 2024,
        sampleBenchmarks: false,
        firstDraftMonth: "2026-10",
        fixedCostsPassIncome: false,
        recordedAt: at("2026-10-01"),
      },
      budgets: [
        budget("Housing", $(2000), { pinned: false }),
        budget("Restaurants", $(600)),
        budget("Clothing", $(200)),
        budget("Travel", $(4800), { period: "yearly", takesEffect: "2026" }),
      ],
    });
  });

  afterEach(() => {
    bank.close();
  });

  // A new run's ID each time, so the per-run cap only counts where a test means it to.
  const run = () => {
    runs += 1;
    return `run-${runs}`;
  };

  const budgetChange = (
    budgets: { category: string; amount: number; reason?: string }[],
    fields: Partial<ProposalInput> = {},
  ): ProposalInput =>
    ({
      kind: "Budget change",
      source: "Budget tailoring",
      runId: run(),
      reason: "Takeout has been steady, so a lower Budget fits.",
      budgets,
      ...fields,
    }) as ProposalInput;

  const shown = async (input: ProposalInput, now = NOW) => {
    const result = await propose(bank.database, input, now);
    if (result.outcome !== "shown") throw new Error(`Refused: ${result.guardrail}`);
    return result.id;
  };

  const refusedWith = async (input: unknown, guardrail: string) => {
    const before = await readEveryTable(bank.database);
    expect(await propose(bank.database, input as ProposalInput, NOW)).toEqual({
      outcome: "refused",
      guardrail,
    });
    expect(await readEveryTable(bank.database)).toEqual(before);
  };

  // Every table but the Proposals' own, for a test that a step changes only what it should.
  const otherTables = async (except: readonly string[] = []) => {
    const all = await readEveryTable(bank.database);
    return Object.fromEntries(
      Object.entries(all).filter(([name]) => !PROPOSAL_TABLES.has(name) && !except.includes(name)),
    );
  };

  const proposal = async (id: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT status, closed_by, closed_at, undone_by FROM proposals WHERE id = ?",
      args: [id],
    });
    return rows.rows[0];
  };

  const lines = async (id: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT category FROM proposal_budgets WHERE proposal_id = ? ORDER BY rowid",
      args: [id],
    });
    return rows.rows.map((row) => row.category);
  };

  const budgetIn = async (month: string, category: string) =>
    (await listBudgetsInEffect(bank.database, month)).find((row) => row.category === category);

  // Spending in Groceries, which has no Budget: $300 in each of July, August and September.
  const groceryHistory = async () => {
    const days = ["2026-07-10", "2026-08-10", "2026-09-10"];
    bank.fake.addPages("bank-1", {
      accounts: [fakeAccount({ id: "acc-checking" })],
      added: days.map((day, n) =>
        fakeTxn({ id: `g-${n}`, accountId: "acc-checking", amount: -$(300), postedDate: day }),
      ),
    });
    await syncConnection(connectionId, () => at("2026-10-01"));
    const rows = await bank.database.$client.execute("SELECT id FROM transactions");
    await storeDecisions(
      bank.database,
      rows.rows.map((row) => ({
        transactionId: String(row.id),
        step: "5.7",
        provisionalUntil: null,
        decidedAt: at("2026-10-01"),
        parts: [{ type: "Spending", amount: -$(300), category: "Groceries", linked: false }],
      })),
    );
  };

  const spendLessGoal = () =>
    addGoal(bank.database, {
      words: "Spend 20% less on restaurants",
      authorId: "member-a",
      date: "2026-10-01",
      target: { kind: "Category", category: "Restaurants" },
      change: { percent: 20 },
      deadline: null,
    });

  describe("a new Proposal", () => {
    it("shows at once, with its change and reason, and changes nothing else", async () => {
      const before = await otherTables();
      const id = await shown(budgetChange([{ category: "Restaurants", amount: $(480) }]));

      expect(await openProposals(bank.database, NOW)).toEqual([
        expect.objectContaining({
          id,
          kind: "Budget change",
          source: "Budget tailoring",
          reason: "Takeout has been steady, so a lower Budget fits.",
          changes: ["Restaurants Budget: $600 → $480"],
          budgets: [{ category: "Restaurants", from: $(600), to: $(480), period: "monthly" }],
        }),
      ]);
      expect(await otherTables()).toEqual(before);
      expect(await proposal(id)).toMatchObject({ status: "open", closed_by: null });
    });

    it("shows each kind's change, a yearly Budget and a Category with no Budget among them", async () => {
      const goalId = await spendLessGoal();
      await shown(
        budgetChange([
          { category: "Travel", amount: $(4000) },
          { category: "Groceries", amount: $(0) },
        ]),
      );
      await shown({
        kind: "Goal amount",
        source: "Budget tailoring",
        runId: run(),
        reason: "Twenty percent off the usual $600 is $480.",
        goalId,
        goalAmount: $(480),
      });
      await shown({
        kind: "new Goal",
        source: "Chat",
        runId: run(),
        reason: "You asked to cook at home more.",
        words: "Cook at home four nights a week",
      });

      expect((await openProposals(bank.database, NOW)).map((each) => each.changes)).toEqual([
        ['New Goal: "Cook at home four nights a week"'],
        ['Goal amount for "Spend 20% less on restaurants": $480'],
        ["Travel Budget: $4,800 a year → $4,000 a year", "Groceries Budget: no Budget → $0"],
      ]);
    });
  });

  describe("the guardrails", () => {
    it("allows at most 2 Proposals in one answer, review, or tailoring run", async () => {
      const runId = run();
      const input = (category: string, amount: number) =>
        budgetChange([{ category, amount }], { runId, source: "Monthly review" });
      await shown(input("Clothing", $(150)));
      await shown(input("Restaurants", $(500)));

      await refusedWith(
        budgetChange([{ category: "Clothing", amount: $(160) }], {
          runId,
          source: "Monthly review",
        }),
        GUARDRAIL.perRun,
      );
      // Another run, or another source's run of the same ID, has its own 2.
      await shown(budgetChange([{ category: "Clothing", amount: $(160) }]));
      await shown(budgetChange([{ category: "Clothing", amount: $(170) }], { runId }));
    });

    it("never proposes a Bills Budget", async () => {
      for (const category of ["Housing", "Utilities", "Interest and fees"]) {
        await refusedWith(budgetChange([{ category, amount: $(2000) }]), GUARDRAIL.bills);
      }
      await refusedWith(
        budgetChange([
          { category: "Clothing", amount: $(200) },
          { category: "Housing", amount: $(2000) },
        ]),
        GUARDRAIL.bills,
      );
    });

    it("keeps a Budget change from 50% to 150% of the current Budget", async () => {
      for (const amount of [$(300) - 1, $(900) + 1]) {
        await refusedWith(budgetChange([{ category: "Restaurants", amount }]), GUARDRAIL.range);
      }
      // A yearly Budget measures from its yearly amount.
      await refusedWith(budgetChange([{ category: "Travel", amount: $(2399) }]), GUARDRAIL.range);
      await shown(budgetChange([{ category: "Restaurants", amount: $(300) }]));
      await shown(budgetChange([{ category: "Restaurants", amount: $(900) }]));
      await shown(budgetChange([{ category: "Travel", amount: $(2400) }]));
    });

    it("measures a Category with no Budget from its 3-month average Spending", async () => {
      await groceryHistory();
      for (const amount of [$(150) - 1, $(450) + 1]) {
        await refusedWith(budgetChange([{ category: "Groceries", amount }]), GUARDRAIL.range);
      }
      await shown(budgetChange([{ category: "Groceries", amount: $(150) }]));
      await shown(budgetChange([{ category: "Groceries", amount: $(450) }]));
      // With no Spending, the average is $0.
      await refusedWith(budgetChange([{ category: "Pets", amount: $(1) }]), GUARDRAIL.range);
    });

    it("names each Category exactly, once, and one from Chat", async () => {
      for (const category of ["restaurants", "Dining", ""]) {
        await refusedWith(budgetChange([{ category, amount: $(500) }]), GUARDRAIL.category);
      }
      await refusedWith(
        budgetChange([
          { category: "Clothing", amount: $(150) },
          { category: "Clothing", amount: $(160) },
        ]),
        GUARDRAIL.category,
      );
      await refusedWith(
        budgetChange(
          [
            { category: "Clothing", amount: $(150) },
            { category: "Restaurants", amount: $(500) },
          ],
          { source: "Chat" },
        ),
        GUARDRAIL.chatOneCategory,
      );
    });

    it("never edits or deletes a Goal: a Goal amount only for an active Goal with none", async () => {
      const goalId = await spendLessGoal();
      const goalAmount = (id: string) => ({
        kind: "Goal amount",
        source: "Budget tailoring",
        runId: run(),
        reason: "Twenty percent off.",
        goalId: id,
        goalAmount: $(480),
      });
      await refusedWith(goalAmount("no-such-goal"), GUARDRAIL.goal);
      await bank.database.$client.execute({
        sql: "UPDATE goals SET goal_amount = 50000 WHERE id = ?",
        args: [goalId],
      });
      await refusedWith(goalAmount(goalId), GUARDRAIL.goal);
      const dropped = await spendLessGoal();
      await markGoal(bank.database, dropped, "dropped", "member-a", NOW);
      await refusedWith(goalAmount(dropped), GUARDRAIL.goal);
    });

    it("refuses any other change, such as moving money or deleting a Goal", async () => {
      const common = { source: "Chat", runId: run(), reason: "Because." };
      for (const input of [
        { ...common, kind: "Transfer", from: "acc-1", to: "acc-2", amount: $(100) },
        { ...common, kind: "delete Goal", goalId: "g-1" },
        { ...common, kind: "Goal edit", goalId: "g-1", words: "Spend more" },
        { ...common, kind: "new Goal", words: "Save more", accountId: "acc-1" },
        { ...common, kind: "Budget change", budgets: [] },
        { ...common, kind: "Budget change", budgets: [{ category: "Clothing", amount: 1.5 }] },
        { ...common, kind: "new Goal", words: "Save more", reason: "  " },
        { ...common, source: "Alert advice", kind: "new Goal", words: "Save more" },
      ]) {
        await refusedWith(input, GUARDRAIL.shape);
      }
    });

    it("keeps a new Goal under 15 words", async () => {
      const words = (count: number) =>
        Array.from({ length: count }, (_, n) => `word${n}`).join(" ");
      const goal = (count: number) => ({
        kind: "new Goal" as const,
        source: "Chat" as const,
        runId: run(),
        reason: "You asked.",
        words: words(count),
      });
      await refusedWith(goal(15), GUARDRAIL.goalWords);
      await shown(goal(14));
    });

    it("refuses text that names the Household's bank, or a bank, card issuer, or lender on the list", async () => {
      const reason = (text: string) =>
        budgetChange([{ category: "Clothing", amount: $(150) }], { reason: text });
      for (const text of [
        "Move the savings to Wells Fargo.",
        "Pay down the WELLS-FARGO card first.",
        "A wellsfargo card has no fee.",
        // Fullwidth letters, a zero-width space, an accent, and a soft hyphen.
        "Ｗｅｌｌｓ Ｆａｒｇｏ has a better rate.",
        "Wells​Fargo has a better rate.",
        "Wélls Fargo has a better rate.",
        "Ch­ase has a better card.",
        "Open a US Bank account.",
        "A card from american   express pays back more.",
        "Your Pinecrest Credit Union loan costs the most.",
        "PINECREST-CREDIT-UNION charges a fee.",
      ]) {
        await refusedWith(reason(text), GUARDRAIL.company);
      }
      await refusedWith(
        {
          kind: "new Goal",
          source: "Chat",
          runId: run(),
          reason: "You asked.",
          words: "Pay off the Chase card",
        },
        GUARDRAIL.company,
      );
      // A word that only holds a name passes.
      await shown(reason("Clothes purchased this fall were mostly one-offs."));
    });

    it("shows a Budget tailoring line's own reason after its change, and refuses one that names a company", async () => {
      await refusedWith(
        budgetChange([
          { category: "Clothing", amount: $(150), reason: "Clothes cost less at Wells Fargo." },
        ]),
        GUARDRAIL.company,
      );
      const id = await shown(
        budgetChange([
          { category: "Restaurants", amount: $(480), reason: "Takeout is steady." },
          { category: "Clothing", amount: $(150) },
        ]),
      );

      expect(
        (await openProposals(bank.database, NOW)).find((each) => each.id === id),
      ).toMatchObject({
        changes: [
          "Restaurants Budget: $600 → $480. Takeout is steady.",
          "Clothing Budget: $200 → $150",
        ],
      });
    });

    it("matches each shipped name in its own words", () => {
      for (const name of US_BANKS_AND_LENDERS) {
        expect(namedCompany(`A card from ${name}.`, US_BANKS_AND_LENDERS)).toBe(name);
      }
      expect(namedCompany("Restaurants and groceries", US_BANKS_AND_LENDERS)).toBeUndefined();
    });
  });

  describe("replacement and expiry", () => {
    it("drops a Category from an older open Proposal when a newer one changes it, and closes one left empty as replaced", async () => {
      const accepted = await shown(budgetChange([{ category: "Clothing", amount: $(180) }]));
      expect(await acceptProposal(bank.database, { id: accepted, memberId: "member-a" }, NOW)).toBe(
        "accepted",
      );
      const older = await shown(
        budgetChange([
          { category: "Restaurants", amount: $(500) },
          { category: "Clothing", amount: $(150) },
        ]),
      );

      const newer = await shown(budgetChange([{ category: "Restaurants", amount: $(450) }]));
      expect(await lines(older)).toEqual(["Clothing"]);
      expect(await proposal(older)).toMatchObject({ status: "open" });

      await shown(budgetChange([{ category: "Clothing", amount: $(160) }]));
      expect(await lines(older)).toEqual([]);
      expect(await proposal(older)).toMatchObject({ status: "replaced", closed_by: null });
      expect(await proposal(newer)).toMatchObject({ status: "open" });
      // An accepted Proposal keeps its Categories.
      expect(await lines(accepted)).toEqual(["Clothing"]);
    });

    it("never replaces one Goal Proposal with another", async () => {
      const goalId = await spendLessGoal();
      const goalAmount = (amount: number) => ({
        kind: "Goal amount" as const,
        source: "Budget tailoring" as const,
        runId: run(),
        reason: "Twenty percent off.",
        goalId,
        goalAmount: amount,
      });
      const newGoal = () => ({
        kind: "new Goal" as const,
        source: "Chat" as const,
        runId: run(),
        reason: "You asked.",
        words: "Spend less on takeout",
      });
      const ids = [
        await shown(goalAmount($(480))),
        await shown(goalAmount($(500))),
        await shown(newGoal()),
        await shown(newGoal()),
      ];
      expect((await openProposals(bank.database, NOW)).map((each) => each.id).sort()).toEqual(
        ids.sort(),
      );
    });

    it("leaves open Goal Proposals open when a Budget change is stored", async () => {
      const goalId = await spendLessGoal();
      const goalAmount = await shown({
        kind: "Goal amount",
        source: "Monthly review",
        runId: run(),
        reason: "Twenty percent off.",
        goalId,
        goalAmount: $(480),
      });
      const newGoal = await shown({
        kind: "new Goal",
        source: "Chat",
        runId: run(),
        reason: "You asked.",
        words: "Spend less on takeout",
      });

      const budget = await shown(budgetChange([{ category: "Clothing", amount: $(150) }]));
      expect(await proposal(goalAmount)).toMatchObject({ status: "open", closed_at: null });
      expect(await proposal(newGoal)).toMatchObject({ status: "open", closed_at: null });
      expect((await openProposals(bank.database, NOW)).map((each) => each.id).sort()).toEqual(
        [goalAmount, newGoal, budget].sort(),
      );
    });

    it("closes an open Proposal as expired after 60 days", async () => {
      const id = await shown(budgetChange([{ category: "Clothing", amount: $(150) }]), NOW);
      const sixtyDays = new Date(NOW.getTime() + 60 * 24 * 60 * 60 * 1000);

      // Reading takes no write while none is due.
      vi.mocked(expireProposals).mockClear();
      expect(await openProposals(bank.database, new Date(sixtyDays.getTime() - 1))).toHaveLength(1);
      expect(await undoableProposals(bank.database, NOW)).toEqual([]);
      expect(vi.mocked(expireProposals)).not.toHaveBeenCalled();
      expect(await openProposals(bank.database, sixtyDays)).toEqual([]);
      expect(vi.mocked(expireProposals)).toHaveBeenCalledTimes(1);
      expect(await proposal(id)).toMatchObject({ status: "expired", closed_by: null });
      expect(await acceptProposal(bank.database, { id, memberId: "member-a" }, sixtyDays)).toBe(
        "not open",
      );
      expect((await budgetIn("2026-12", "Clothing"))?.amount).toBe($(200));
    });

    it("expires an open Proposal before a late Accept can apply it", async () => {
      const id = await shown(budgetChange([{ category: "Clothing", amount: $(150) }]), NOW);
      const late = new Date(NOW.getTime() + 61 * 24 * 60 * 60 * 1000);
      expect(await acceptProposal(bank.database, { id, memberId: "member-a" }, late)).toBe(
        "not open",
      );
      expect(await proposal(id)).toMatchObject({ status: "expired" });
    });
  });

  describe("Accept", () => {
    it("applies a Budget change in the current month with the source Proposal, and records who and when", async () => {
      const id = await shown(
        budgetChange([
          { category: "Restaurants", amount: $(480) },
          { category: "Travel", amount: $(4000) },
        ]),
      );
      const before = await otherTables(["budgets"]);
      expect(await acceptProposal(bank.database, { id, memberId: "member-b" }, NOW)).toBe(
        "accepted",
      );

      expect(await budgetIn("2026-10", "Restaurants")).toMatchObject({
        amount: $(480),
        period: "monthly",
        takesEffect: "2026-10",
        source: "Proposal",
        setBy: "member-b",
        pinned: null,
      });
      // A yearly Budget changes for the whole current year.
      expect(await budgetIn("2026-01", "Travel")).toMatchObject({
        amount: $(4000),
        period: "yearly",
        takesEffect: "2026",
        source: "Proposal",
      });
      expect(await proposal(id)).toMatchObject({
        status: "accepted",
        closed_by: "member-b",
        closed_at: NOW.toISOString(),
      });
      // Nothing else changes: nothing moves money.
      expect(await otherTables(["budgets"])).toEqual(before);
      expect(await openProposals(bank.database, NOW)).toEqual([]);
    });

    it("gives a Category with no Budget a new monthly Budget", async () => {
      await groceryHistory();
      const id = await shown(budgetChange([{ category: "Groceries", amount: $(250) }]));
      await acceptProposal(bank.database, { id, memberId: "member-a" }, NOW);
      expect(await budgetIn("2026-10", "Groceries")).toMatchObject({
        amount: $(250),
        period: "monthly",
        source: "Proposal",
      });
    });

    it("takes a Member's Edit, which the 50% rule does not bind", async () => {
      const id = await shown(
        budgetChange([
          { category: "Restaurants", amount: $(480) },
          { category: "Clothing", amount: $(150) },
        ]),
      );
      const edit = { budgets: { Restaurants: $(50) } };
      expect(await acceptProposal(bank.database, { id, memberId: "member-a", edit }, NOW)).toBe(
        "accepted",
      );
      expect((await budgetIn("2026-10", "Restaurants"))?.amount).toBe($(50));
      expect((await budgetIn("2026-10", "Clothing"))?.amount).toBe($(150));
    });

    it("sets a Goal amount, and progress starts that day", async () => {
      const goalId = await spendLessGoal();
      const id = await shown({
        kind: "Goal amount",
        source: "Budget tailoring",
        runId: run(),
        reason: "Twenty percent off.",
        goalId,
        goalAmount: $(480),
      });
      const before = await otherTables(["goals"]);
      const edit = { goalAmount: $(450) };
      expect(await acceptProposal(bank.database, { id, memberId: "member-a", edit }, NOW)).toBe(
        "accepted",
      );
      expect(await readGoal(bank.database, goalId)).toMatchObject({
        goalAmount: $(450),
        startsOn: "2026-10-20",
        status: "active",
      });
      expect(await otherTables(["goals"])).toEqual(before);
    });

    it("leaves a Goal amount open when the Goal cannot take one", async () => {
      const goalId = await addGoal(bank.database, {
        words: "Be careful",
        authorId: null,
        date: "2026-10-01",
        target: null,
        change: null,
        deadline: null,
      });
      const id = await shown({
        kind: "Goal amount",
        source: "Budget tailoring",
        runId: run(),
        reason: "A start.",
        goalId,
        goalAmount: $(100),
      });
      const before = await readEveryTable(bank.database);
      expect(await acceptProposal(bank.database, { id, memberId: "member-a" }, NOW)).toEqual({
        refused: "This Goal cannot take a Goal amount now.",
      });
      expect(await readEveryTable(bank.database)).toEqual(before);
    });

    it("accepts nothing when a step of a Goal amount's Accept fails, and can be accepted again", async () => {
      const goalId = await spendLessGoal();
      const id = await shown({
        kind: "Goal amount",
        source: "Budget tailoring",
        runId: run(),
        reason: "Twenty percent off.",
        goalId,
        goalAmount: $(480),
      });
      const before = await readEveryTable(bank.database);
      const accept = () => acceptProposal(bank.database, { id, memberId: "member-a" }, NOW);

      vi.mocked(startGoal).mockRejectedValueOnce(new Error("The Goal start failed."));
      await expect(accept()).rejects.toThrow("The Goal start failed.");
      expect(await readEveryTable(bank.database)).toEqual(before);

      // The Goal amount is set, then recording it fails: the Goal gets back what it held.
      vi.mocked(storeGoalAmountApplied).mockRejectedValueOnce(new Error("The write failed."));
      await expect(accept()).rejects.toThrow("The write failed.");
      expect(await readEveryTable(bank.database)).toEqual(before);

      expect(await accept()).toBe("accepted");
      expect(await readGoal(bank.database, goalId)).toMatchObject({ goalAmount: $(480) });
    });

    it("creates an active new Goal, with the accepting Member as its author", async () => {
      const id = await shown({
        kind: "new Goal",
        source: "Chat",
        runId: run(),
        reason: "You asked to cook more.",
        words: "Cook at home more",
      });
      const edit = { words: "Cook at home four nights a week" };
      expect(await acceptProposal(bank.database, { id, memberId: "member-b", edit }, NOW)).toBe(
        "accepted",
      );
      const rows = await bank.database.$client.execute("SELECT * FROM goals");
      expect(rows.rows).toEqual([
        expect.objectContaining({
          words: "Cook at home four nights a week",
          author_id: "member-b",
          date: "2026-10-20",
          status: "active",
          target: null,
          goal_amount: null,
        }),
      ]);
    });

    it("changes nothing for a Proposal that is not open, or an Edit of the wrong kind", async () => {
      const budgetId = await shown(budgetChange([{ category: "Clothing", amount: $(150) }]));
      const goalId = await shown({
        kind: "new Goal",
        source: "Chat",
        runId: run(),
        reason: "You asked.",
        words: "Spend less on takeout",
      });
      const before = await readEveryTable(bank.database);
      const wrong = { refused: "This Edit does not fit this Proposal." };
      const accept = (id: string, edit: object) =>
        acceptProposal(bank.database, { id, memberId: "member-a", edit }, NOW);

      expect(await accept(budgetId, { words: "Save more" })).toEqual(wrong);
      expect(await accept(budgetId, { goalAmount: $(100) })).toEqual(wrong);
      // Only the Proposal's own Categories: never a Bills Budget through an Edit.
      expect(await accept(budgetId, { budgets: { Housing: $(1) } })).toEqual(wrong);
      expect(await accept(goalId, { budgets: { Clothing: $(1) } })).toEqual(wrong);
      expect(await accept("no-such-proposal", {})).toBeUndefined();
      expect(await readEveryTable(bank.database)).toEqual(before);

      await skipProposal(bank.database, { id: budgetId, memberId: "member-a" }, NOW);
      const skipped = await readEveryTable(bank.database);
      expect(await accept(budgetId, {})).toBe("not open");
      expect(await readEveryTable(bank.database)).toEqual(skipped);
    });

    it("applies a Proposal once when it is accepted twice", async () => {
      const id = await shown(budgetChange([{ category: "Clothing", amount: $(150) }]));
      expect(await acceptProposal(bank.database, { id, memberId: "member-a" }, NOW)).toBe(
        "accepted",
      );
      const before = await readEveryTable(bank.database);
      expect(await acceptProposal(bank.database, { id, memberId: "member-b" }, NOW)).toBe(
        "not open",
      );
      expect(await readEveryTable(bank.database)).toEqual(before);
    });

    // A second Accept can read the Proposal open before the first one's write lands: the write
    // itself takes only an open Proposal of its own kind.
    it("writes an Accept only through an open Proposal of its own kind", async () => {
      const budgetId = await shown(budgetChange([{ category: "Clothing", amount: $(150) }]));
      const goalId = await shown({
        kind: "new Goal",
        source: "Chat",
        runId: run(),
        reason: "You asked.",
        words: "Spend less on takeout",
      });
      const before = await readEveryTable(bank.database);
      const budgetAccept = (id: string) =>
        storeBudgetChangeAccept(bank.database, {
          id,
          month: "2026-10",
          amounts: new Map(),
          periods: new Map(),
          memberId: "member-a",
          at: NOW,
        });
      const goalAccept = (id: string) =>
        storeNewGoalAccept(bank.database, {
          id,
          goal: {
            authorId: "member-a",
            date: "2026-10-20",
            deadline: null,
            words: "Spend less on takeout",
            target: null,
            change: null,
          },
          at: NOW,
        });

      expect(await budgetAccept(goalId)).toBe(false);
      expect(await goalAccept(budgetId)).toBeUndefined();
      expect(
        await claimGoalAmount(bank.database, { id: budgetId, memberId: "member-a", at: NOW }),
      ).toBe(false);
      expect(await readEveryTable(bank.database)).toEqual(before);

      expect(await budgetAccept(budgetId)).toBe(true);
      expect(await goalAccept(goalId)).toEqual(expect.any(String));
      const accepted = await readEveryTable(bank.database);
      expect(await budgetAccept(budgetId)).toBe(false);
      expect(await goalAccept(goalId)).toBeUndefined();
      expect(await readEveryTable(bank.database)).toEqual(accepted);
    });
  });

  describe("Skip", () => {
    it("closes the Proposal with the Member, and changes nothing else", async () => {
      const id = await shown(budgetChange([{ category: "Clothing", amount: $(150) }]));
      const before = await otherTables();

      expect(await skipProposal(bank.database, { id, memberId: "member-a" }, NOW)).toBe(true);
      expect(await proposal(id)).toMatchObject({ status: "skipped", closed_by: "member-a" });
      expect(await skipProposal(bank.database, { id, memberId: "member-a" }, NOW)).toBe(false);
      expect(await otherTables()).toEqual(before);
      expect(await openProposals(bank.database, NOW)).toEqual([]);
    });
  });

  describe("Undo", () => {
    const accept = async (input: ProposalInput, now = NOW, memberId = "member-a") => {
      const id = await shown(input, now);
      expect(await acceptProposal(bank.database, { id, memberId }, now)).toBe("accepted");
      return id;
    };
    const undo = (id: string, now = NOW) =>
      undoProposal(bank.database, { id, memberId: "member-b" }, now);
    const undoable = async (now = NOW) =>
      (await undoableProposals(bank.database, now)).map((each) => each.id);

    it("puts back the Budget the Proposal replaced", async () => {
      const before = await readEveryTable(bank.database);
      const id = await accept(
        budgetChange([
          { category: "Restaurants", amount: $(480) },
          { category: "Travel", amount: $(4000) },
        ]),
      );
      expect(await undoableProposals(bank.database, NOW)).toEqual([
        expect.objectContaining({
          id,
          changes: [
            "Restaurants Budget: $600 → $480",
            "Travel Budget: $4,800 a year → $4,000 a year",
          ],
        }),
      ]);

      expect(await undo(id)).toBe("undone");
      expect(await budgetIn("2026-10", "Restaurants")).toMatchObject({
        amount: $(600),
        source: "formula",
      });
      expect((await budgetIn("2026-10", "Travel"))?.amount).toBe($(4800));
      expect(await proposal(id)).toMatchObject({ status: "accepted", undone_by: "member-b" });
      expect(await undoable()).toEqual([]);
      const undone = await readEveryTable(bank.database);
      expect(await undo(id)).toBe("already undone");
      expect(await readEveryTable(bank.database)).toEqual(undone);
      const after = await readEveryTable(bank.database);
      expect(after.budgets).toEqual(before.budgets);
    });

    it("keeps a past month's Budget when Undo comes in a later month", async () => {
      const id = await accept(budgetChange([{ category: "Restaurants", amount: $(480) }]));
      const november = at("2026-11-05");

      expect(await undo(id, november)).toBe("undone");
      expect((await budgetIn("2026-10", "Restaurants"))?.amount).toBe($(480));
      // The copy is the Member's: who undid it, and when.
      expect(await budgetIn("2026-11", "Restaurants")).toMatchObject({
        amount: $(600),
        takesEffect: "2026-11",
        source: "Member edit",
        setBy: "member-b",
        setAt: november,
      });
    });

    it("removes the Budget it gave a Category that had none", async () => {
      await groceryHistory();
      const id = await accept(budgetChange([{ category: "Groceries", amount: $(250) }]));
      expect(await undoableProposals(bank.database, NOW)).toEqual([
        expect.objectContaining({ changes: ["Groceries Budget: no Budget → $250"] }),
      ]);
      expect(await undo(id)).toBe("undone");
      expect(await budgetIn("2026-10", "Groceries")).toBeUndefined();
    });

    it("keeps a past month's Budget for a Category that had none when Undo comes in a later month", async () => {
      await groceryHistory();
      // The month's total Budget, every Category group's monthly Budgets added up.
      const total = async (month: string) =>
        (await budgetsForMonth(bank.database, month)).groups.reduce(
          (sum, group) => sum + group.monthly,
          0,
        );
      const withoutGroceries = await total("2026-10");
      const id = await accept(budgetChange([{ category: "Groceries", amount: $(250) }]));
      const october = await total("2026-10");
      expect(october).toBe(withoutGroceries + $(250));

      const november = at("2026-11-05");
      expect(await undo(id, november)).toBe("undone");
      expect(await total("2026-10")).toBe(october);
      expect((await budgetIn("2026-10", "Groceries"))?.amount).toBe($(250));
      expect(await budgetIn("2026-11", "Groceries")).toBeUndefined();
      expect(await budgetIn("2027-01", "Groceries")).toBeUndefined();
      expect(await total("2026-11")).toBe(withoutGroceries);
      const rows = await bank.database.$client.execute(
        "SELECT takes_effect, source, set_by, no_budget FROM budgets WHERE category = 'Groceries' ORDER BY id",
      );
      expect(rows.rows.map((row) => ({ ...row }))).toEqual([
        { takes_effect: "2026-10", source: "Proposal", set_by: "member-a", no_budget: 0 },
        { takes_effect: "2026-11", source: "Member edit", set_by: "member-b", no_budget: 1 },
      ]);
    });

    it("is offered until a later change touches the same Budget", async () => {
      const id = await accept(
        budgetChange([
          { category: "Restaurants", amount: $(480) },
          { category: "Clothing", amount: $(150) },
        ]),
      );
      // A later change to another Budget leaves it offered.
      await editBudget(
        bank.database,
        { category: "Travel", amount: $(3000), memberId: "member-a" },
        NOW,
      );
      expect(await undoable()).toEqual([id]);

      await editBudget(
        bank.database,
        { category: "Clothing", amount: $(170), memberId: "member-a" },
        NOW,
      );
      expect(await undoable()).toEqual([]);
      const before = await readEveryTable(bank.database);
      expect(await undo(id)).toBe("not offered");
      expect(await readEveryTable(bank.database)).toEqual(before);
    });

    it("ends an older Proposal's Undo when a newer accepted one changes the same Budget", async () => {
      const older = await accept(budgetChange([{ category: "Clothing", amount: $(150) }]));
      const newer = await accept(budgetChange([{ category: "Clothing", amount: $(120) }]));
      expect(await undoable()).toEqual([newer]);
      expect(await undo(older)).toBe("not offered");
    });

    it("puts back what a Goal held before its Goal amount, until a later change to the Goal", async () => {
      const goalId = await spendLessGoal();
      const goalAmount = () =>
        ({
          kind: "Goal amount",
          source: "Budget tailoring",
          runId: run(),
          reason: "Twenty percent off.",
          goalId,
          goalAmount: $(480),
        }) as const;
      const before = await readGoal(bank.database, goalId);
      const id = await accept(goalAmount());
      expect(await undo(id)).toBe("undone");
      expect(await readGoal(bank.database, goalId)).toEqual(before);

      const again = await accept(goalAmount());
      await markGoal(bank.database, goalId, "done", "member-a", NOW);
      expect(await undoable()).toEqual([]);
      expect(await undo(again)).toBe("not offered");
    });

    it("marks the new Goal dropped, until a later change to the Goal", async () => {
      const newGoal = () =>
        ({
          kind: "new Goal",
          source: "Chat",
          runId: run(),
          reason: "You asked.",
          words: "Spend less on restaurants",
        }) as const;
      const id = await accept(newGoal());
      expect(await undo(id)).toBe("undone");
      const [dropped] = (await bank.database.$client.execute("SELECT * FROM goals")).rows;
      expect(dropped).toMatchObject({
        status: "dropped",
        ended_by: "member-b",
        ended_on: "2026-10-20",
      });

      // A Goal amount accepted later is a later change to the new Goal.
      const second = await accept(newGoal());
      const [, created] = (
        await bank.database.$client.execute("SELECT id FROM goals ORDER BY rowid")
      ).rows;
      await bank.database.$client.execute({
        sql: "UPDATE goals SET target = ? WHERE id = ?",
        args: [JSON.stringify({ kind: "Category", category: "Restaurants" }), String(created?.id)],
      });
      const later = at("2026-10-21");
      await accept(
        {
          kind: "Goal amount",
          source: "Budget tailoring",
          runId: run(),
          reason: "Twenty percent off.",
          goalId: String(created?.id),
          goalAmount: $(480),
        },
        later,
      );
      expect(await undo(second, later)).toBe("not offered");
    });

    it("is not offered for an open, skipped, or unknown Proposal", async () => {
      const open = await shown(budgetChange([{ category: "Clothing", amount: $(150) }]));
      const skipped = await shown(budgetChange([{ category: "Restaurants", amount: $(500) }]));
      await skipProposal(bank.database, { id: skipped, memberId: "member-a" }, NOW);
      const before = await readEveryTable(bank.database);

      expect(await undo(open)).toBe("not offered");
      expect(await undo(skipped)).toBe("not offered");
      expect(await undo("no-such-proposal")).toBe("not found");
      expect(await readEveryTable(bank.database)).toEqual(before);
    });
  });

  it("makes no AI call: the proposals module imports nothing from the ai module", () => {
    const dir = new URL(".", import.meta.url);
    for (const file of readdirSync(dir).filter((name) => !name.endsWith(".test.ts"))) {
      const code = readFileSync(new URL(file, dir), "utf8");
      expect(code, file).not.toMatch(/from "\.\.\/ai\/|from "ai"|from "@ai-sdk\//);
    }
  });
});
