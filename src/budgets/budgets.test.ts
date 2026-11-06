import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { runFirstRun, syncConnection } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { benchmarkSnapshot, categoryBenchmarks } from "../benchmarks/index.ts";
import type { Category } from "../categories/index.ts";
import {
  addManualLoan,
  claimHistoryWaitEnd,
  type NewPart,
  replaceRecurringCharges,
  type StoredRecurringCharge,
  storeDecisions,
  storeOtherLink,
  storeProposal,
} from "../db/index.ts";
import { saveHouseholdFacts } from "../household/index.ts";
import { acceptProposal, undoProposal } from "../proposals/index.ts";
import { findRecurringCharges, typeSteadyIncome } from "../recurring/index.ts";
import {
  budgetsForMonth,
  draftBudgets,
  draftFirstBudgets,
  editBudget,
  FIXED_COSTS_PASS_INCOME,
  followBills,
  historyWindow,
  readDraftTerms,
  runMonthStart,
  startBudgets,
} from "./index.ts";

// The formula terms read from app.db (spec 05, Formula terms), the first draft (When the app
// drafts, Stored Budgets), and each month's Budgets. Transactions arrive through the fake adapter;
// each test then stores the parts, links, and Recurring charges it needs, as the follow-up steps
// would.

const BANK = "fake-budget-bank";
const MEMBER = "member-1";
const CHECKING = fakeAccount({ id: "acc-checking" });
const CARD = fakeAccount({ id: "acc-card", type: "credit", subtype: "credit card" });
const LOAN = fakeAccount({ id: "acc-loan", type: "loan", subtype: "personal" });

const $ = (dollars: number) => dollars * 100;

// The last item marks a linked Refund or Reimbursement part, as the decision stores it.
type PartSpec = [NewPart["type"], number, Category | null, "linked"?];
type TxnSpec = {
  id: string;
  account: { id: string };
  date: string;
  authorized?: string;
  pending?: boolean;
  // The clean Merchant name, as Merchant cleanup would store it.
  merchant?: string;
  // With the Transaction's sign: Spending is negative.
  parts: PartSpec[];
};

const spend = (id: string, date: string, dollars: number, category: Category): TxnSpec => ({
  id,
  account: CHECKING,
  date,
  parts: [["Spending", -$(dollars), category]],
});

// The 1st through the 12th month from `first`, written YYYY-MM-DD on day `day`.
const monthly = (first: string, count: number, day: string) =>
  Array.from({ length: count }, (_, index) => {
    const date = new Date(`${first}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + index);
    return `${date.toISOString().slice(0, 7)}-${day}`;
  });

describe("Budget drafts", () => {
  let bank: TestBank;
  let connectionId: string;
  let ids: Map<string, string>;
  let accounts: Map<string, string>;
  let now: Date;

  const load = async (txns: TxnSpec[]) => {
    bank.fake.addPages(BANK, {
      accounts: [CHECKING, CARD, LOAN],
      added: txns.map((txn) =>
        fakeTxn({
          id: txn.id,
          accountId: txn.account.id,
          amount: txn.parts.reduce((sum, [, amount]) => sum + amount, 0),
          postedDate: txn.date,
          authorizedDate: txn.authorized ?? null,
          pending: txn.pending ?? false,
        }),
      ),
    });
    await syncConnection(connectionId, () => now);
    const rows = await bank.database.$client.execute(
      "SELECT id, provider_transaction_id FROM transactions",
    );
    ids = new Map(rows.rows.map((row) => [String(row.provider_transaction_id), String(row.id)]));
    const accountRows = await bank.database.$client.execute(
      "SELECT id, provider_account_id FROM household_accounts WHERE provider_account_id IS NOT NULL",
    );
    accounts = new Map(
      accountRows.rows.map((row) => [String(row.provider_account_id), String(row.id)]),
    );
    for (const txn of txns) {
      if (txn.merchant === undefined) continue;
      await bank.database.$client.execute({
        sql: "UPDATE transactions SET merchant_clean_name = ? WHERE id = ?",
        args: [txn.merchant, id(txn.id)],
      });
    }
    await storeDecisions(
      bank.database,
      txns
        .filter((txn) => txn.pending !== true)
        .map((txn) => ({
          transactionId: id(txn.id),
          step: "5.7",
          provisionalUntil: null,
          decidedAt: now,
          parts: txn.parts.map(([type, amount, category, linked]) => ({
            type,
            amount,
            category,
            ...(linked === undefined ? {} : { linked: true }),
          })),
        })),
    );
  };
  const id = (provider: string) => {
    const found = ids.get(provider);
    if (found === undefined) throw new Error(`No Transaction ${provider}`);
    return found;
  };
  // Hides a posted Transaction, as a re-link that brought it again does.
  const hide = async (provider: string) => {
    await bank.database.$client.execute({
      sql: "UPDATE transactions SET hidden_reason = 'replaced by re-link', hidden_at = ? WHERE id = ?",
      args: [now.toISOString(), id(provider)],
    });
  };
  const pair = async (out: string, into: string) => {
    await bank.database.$client.execute({
      sql: `INSERT INTO transfer_links (id, out_transaction_id, in_transaction_id, tier, signals, made_by, created_at)
            VALUES (?, ?, ?, 'Strong', '[]', 'app', ?)`,
      args: [`pair-${out}`, id(out), id(into), now.toISOString()],
    });
  };
  const evidence = () => ({
    tier: "Strong" as const,
    signals: [],
    aiAnswer: null,
    aiConfidence: null,
    madeBy: "app" as const,
    memberId: null,
    createdAt: now,
  });
  const charge = (
    name: string,
    fields: Pick<StoredRecurringCharge, "category" | "schedule" | "nextExpectedDate"> & {
      paid: [string, string, number][];
      status?: StoredRecurringCharge["status"];
    },
  ): StoredRecurringCharge => ({
    id: `charge-${name}`,
    merchantId: null,
    merchantName: name,
    category: fields.category,
    schedule: fields.schedule,
    nextExpectedDate: fields.nextExpectedDate,
    latestAmount: fields.paid.at(-1)?.[2] ?? 0,
    priceHistory: fields.paid.map(([txn, date, amount]) => ({
      transactionId: id(txn),
      date,
      amount,
    })),
    accountId: accounts.get(CHECKING.id) ?? "",
    status: fields.status ?? "active",
    foundAt: now,
    endedAt: null,
    endedBy: null,
  });
  const terms = (month = "2026-11") => readDraftTerms(bank.database, month, now);

  beforeEach(async () => {
    now = new Date("2026-11-04T14:00:00.000Z");
    bank = await newTestBank();
    connectionId = await bank.connect(BANK);
    await bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('${MEMBER}', 'Jamie', 'jamie@example.com', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    );
  });

  afterEach(() => {
    bank.close();
  });

  describe("the history window", () => {
    it("holds the last 12 complete months before m, or every complete month there is", () => {
      expect(historyWindow("2026-11", "2025-03-01")).toEqual(
        monthly("2025-11", 12, "01").map((date) => date.slice(0, 7)),
      );
      expect(historyWindow("2026-11", "2026-03-15")).toEqual([
        "2026-04",
        "2026-05",
        "2026-06",
        "2026-07",
        "2026-08",
        "2026-09",
        "2026-10",
      ]);
      expect(historyWindow("2026-11", "2026-10-01")).toEqual(["2026-10"]);
      expect(historyWindow("2026-11", "2026-10-02")).toEqual([]);
      expect(historyWindow("2026-11", undefined)).toEqual([]);
    });

    it("starts at the earliest posted Transaction on any Account, and gives n", async () => {
      await load([
        { ...spend("early", "2026-06-20", 10, "Restaurants"), account: CARD },
        spend("late", "2026-09-03", 10, "Restaurants"),
        { ...spend("pending", "2026-01-05", 10, "Restaurants"), pending: true },
        spend("relinked", "2026-01-05", 10, "Restaurants"),
      ]);
      await hide("relinked");

      // History starts at the shown, posted June 20: July to October.
      expect((await terms()).n).toBe(4);
    });
  });

  describe("Spending", () => {
    it("counts posted Spending in its purchase month, net of linked Refunds in the Spending's month", async () => {
      await load([
        spend("start", "2025-10-01", 1, "Miscellaneous"),
        // Bought Oct 31, 2025, posted Nov 1: October, before the window.
        { ...spend("dinner", "2025-11-01", 45, "Restaurants"), authorized: "2025-10-31" },
        spend("lunch", "2026-10-12", 30, "Restaurants"),
        { ...spend("pending", "2026-10-20", 999, "Restaurants"), pending: true },
        spend("coat", "2026-10-10", 80, "Clothing"),
        // Linked to the coat, posted in m: it reduces October.
        {
          id: "coat-refund",
          account: CHECKING,
          date: "2026-11-02",
          parts: [["Refund", $(20), null, "linked"]],
        },
        // Unlinked: it reduces its own month, m, outside the window.
        {
          id: "shoe-refund",
          account: CHECKING,
          date: "2026-11-03",
          parts: [["Refund", $(15), "Clothing"]],
        },
      ]);
      await storeOtherLink(
        bank.database,
        { kind: "Refund", transactionId: id("coat-refund"), spendingTransactionId: id("coat") },
        evidence(),
      );

      const { n, categories } = await terms();
      expect(n).toBe(12);
      expect(categories.Restaurants).toMatchObject({ spent: $(30), a: $(30) / 12 });
      expect(categories.Clothing).toMatchObject({ spent: $(60), a: $(5) });
    });

    it("leaves out posted Spending that a re-link hid", async () => {
      await load([
        spend("start", "2025-10-01", 1, "Miscellaneous"),
        spend("lunch", "2026-10-12", 30, "Restaurants"),
        spend("lunch-again", "2026-10-12", 30, "Restaurants"),
      ]);
      await hide("lunch-again");

      expect((await terms()).categories.Restaurants).toMatchObject({
        spent: $(30),
        a: $(30) / 12,
        aOther: $(30) / 12,
        aFlex: $(30) / 12,
      });
    });
  });

  // n = 0: A, A_other, and A_flex are all Spending loaded so far × the days in m ÷ the days of
  // history (spec 05, Formula terms), as of the day m's figure is set. Today is Nov 4, and November
  // has 30 days.
  describe("history shorter than one complete month", () => {
    // The terms as the first draft reads them: on the day it runs.
    const asFirstDraft = (month = "2026-11") =>
      readDraftTerms(bank.database, month, now, now.toISOString().slice(0, 10));
    const budgetOf = async (category: Category) =>
      (await budgetsForMonth(bank.database, "2026-11")).budgets.find(
        (budget) => budget.category === category,
      )?.amount;
    const withBenchmarks = async () => {
      await saveHouseholdFacts(
        bank.database,
        { zipCode: "99501", ages: [40, 38], rentOrOwn: "rent" },
        MEMBER,
      );
      await typeSteadyIncome(bank.database, $(6_000), MEMBER);
    };
    const draft = async (month = "2026-11") =>
      draftBudgets(await asFirstDraft(month)).map(
        ({ category, amount, period }) => `${category}: ${amount / 100} ${period}`,
      );

    it("drafts Groceries and Superstores by the split rule from 10 days: T = B_GS, r = 2/3", async () => {
      await withBenchmarks();
      // History starts Oct 26: Oct 26 to Nov 4 is 10 days.
      await load([
        spend("market", "2026-10-26", 120, "Groceries"),
        spend("market-again", "2026-11-03", 80, "Groceries"),
        spend("superstore", "2026-10-30", 100, "Superstores"),
      ]);

      const drafted = await asFirstDraft();
      expect(drafted.n).toBe(0);
      expect(drafted.split).toEqual({ groceries: $(200), superstores: $(100) });
      expect(drafted.categories.Groceries).toMatchObject({ spent: $(200), a: $(600) });
      expect(drafted.categories.Groceries.aFlex).toBe($(600));
      expect(drafted.categories.Superstores).toMatchObject({ spent: $(100), aFlex: $(300) });
      const bGs = drafted.benchmarks.Groceries ?? 0;
      expect(bGs).toBeGreaterThan(0);
      expect(drafted.benchmarks.Superstores).toBe(bGs);
      expect((await draft()).filter((line) => /^(Groceries|Superstores)/.test(line))).toEqual([
        `Groceries: ${Math.round((bGs * 2) / 3 / 100)} monthly`,
        `Superstores: ${Math.round(bGs / 3 / 100)} monthly`,
      ]);
    });

    it("drafts a Bills Category from A_other scaled to the days in m", async () => {
      await load([
        spend("start", "2026-10-26", 1, "Miscellaneous"),
        spend("water", "2026-10-29", 50, "Utilities"),
      ]);

      // $50 × 30 ÷ 10.
      expect((await asFirstDraft()).categories.Utilities).toMatchObject({
        spent: $(50),
        a: $(150),
        aOther: $(150),
        aFlex: $(150),
      });
      expect(await draft()).toContain("Utilities: 150 monthly");
    });

    it("takes the days in m: 31 in December", async () => {
      now = new Date("2026-12-04T14:00:00.000Z");
      // Nov 25 to Dec 4 is 10 days.
      await load([spend("water", "2026-11-25", 50, "Utilities")]);

      // $50 × 31 ÷ 10.
      expect((await asFirstDraft("2026-12")).categories.Utilities.aOther).toBe($(155));
    });

    it("counts the days of history to the Household's day", async () => {
      // Anchorage: 03:00 UTC on Nov 5 is still Nov 4 there.
      await saveHouseholdFacts(
        bank.database,
        { zipCode: "99501", ages: [40, 38], rentOrOwn: "rent" },
        MEMBER,
      );
      now = new Date("2026-11-05T03:00:00.000Z");
      await load([spend("water", "2026-10-26", 50, "Utilities")]);

      await draftFirstBudgets(bank.database, now);

      // $50 × 30 ÷ 10, where Nov 5 would give 11 days and $136.
      expect(await budgetOf("Utilities")).toBe($(150));
    });

    // Fewer than 7 days of history count as 7.
    it.each([
      { start: "2026-11-04", days: 1, dollars: 7, aOther: 30 },
      { start: "2026-10-30", days: 6, dollars: 7, aOther: 30 },
      { start: "2026-10-29", days: 7, dollars: 7, aOther: 30 },
      { start: "2026-10-28", days: 8, dollars: 8, aOther: 30 },
      { start: "2026-10-26", days: 10, dollars: 7, aOther: 21 },
    ])(
      "counts $days days of history: $dollars dollars give an A_other of $aOther dollars",
      async ({ start, dollars, aOther }) => {
        await load([spend("water", start, dollars, "Utilities")]);

        const { n, categories } = await asFirstDraft();
        expect(n).toBe(0);
        expect(categories.Utilities).toMatchObject({ spent: $(dollars), aOther: $(aOther) });
        expect(await draft()).toContain(`Utilities: ${aOther} monthly`);
      },
    );

    it("counts nothing yet from history that starts tomorrow", async () => {
      await load([spend("water", "2026-11-05", 5, "Utilities")]);

      const { n, categories } = await asFirstDraft();
      expect(n).toBe(0);
      expect(categories.Utilities).toMatchObject({ spent: 0, a: 0, aOther: 0, aFlex: 0 });
      expect((await draft()).filter((line) => line.startsWith("Utilities"))).toEqual([]);
    });

    it("stands as of the day before the 1st of m when no day is given, as the Month start reads", async () => {
      await load([
        spend("water", "2026-10-24", 16, "Utilities"),
        spend("water-again", "2026-11-03", 50, "Utilities"),
      ]);

      // Oct 24 to Oct 31 is 8 days: $16 × 30 ÷ 8. The Nov 3 bill is after that day.
      expect((await terms()).categories.Utilities).toMatchObject({ spent: $(16), aOther: $(60) });
    });

    it("keeps a Bills Budget as the first draft set it while m's Transactions post", async () => {
      await typeSteadyIncome(bank.database, $(6_000), MEMBER);
      await load([
        spend("start", "2026-10-26", 1, "Miscellaneous"),
        spend("water", "2026-11-03", 50, "Utilities"),
      ]);
      await draftFirstBudgets(bank.database, now);
      expect(await budgetOf("Utilities")).toBe($(150));

      // Nothing new by Nov 30.
      now = new Date("2026-11-30T14:00:00.000Z");
      await followBills(bank.database, now);
      expect(await budgetOf("Utilities")).toBe($(150));

      // A $500 repair posts on Nov 20: it is Spending against the Budget, not part of it.
      await load([spend("repair", "2026-11-20", 500, "Utilities")]);
      await followBills(bank.database, now);
      expect(await budgetOf("Utilities")).toBe($(150));
    });

    it("drafts B(c) for a Category with a Benchmark, and nothing for one with no Spending so far", async () => {
      await withBenchmarks();
      await load([
        spend("market", "2026-10-26", 200, "Groceries"),
        spend("dinner", "2026-10-28", 40, "Restaurants"),
        spend("hardware", "2026-10-29", 90, "General goods"),
        spend("flight", "2026-10-30", 400, "Travel"),
      ]);
      const { benchmarks } = await asFirstDraft();

      const drafted = await draft();
      // Groceries takes all of T; Superstores has no Spending so far and no known amounts.
      expect(drafted).toContain(
        `Groceries: ${Math.round((benchmarks.Groceries ?? 0) / 100)} monthly`,
      );
      expect(drafted).toContain(
        `Restaurants: ${Math.round((benchmarks.Restaurants ?? 0) / 100)} monthly`,
      );
      // No Spending so far and no known amounts: no Budget.
      expect(drafted.filter((line) => /^(Superstores|Clothing|Utilities):/.test(line))).toEqual([]);
      // No Benchmark, and yearly: each still waits for n ≥ 3.
      expect(drafted.filter((line) => /^(General goods|Travel):/.test(line))).toEqual([]);
    });

    it("keeps n = 1 as before: the one complete month ÷ 1, with nothing scaled", async () => {
      await load([
        spend("water", "2026-10-01", 50, "Utilities"),
        // In m, outside the window.
        spend("water-again", "2026-11-02", 40, "Utilities"),
        spend("market", "2026-10-12", 300, "Groceries"),
        spend("superstore", "2026-10-20", 100, "Superstores"),
        spend("superstore-again", "2026-11-03", 500, "Superstores"),
      ]);

      const { n, categories, split } = await terms();
      expect(n).toBe(1);
      expect(categories.Utilities).toMatchObject({ spent: $(50), a: $(50), aOther: $(50) });
      expect(split).toEqual({ groceries: $(300), superstores: $(100) });
      expect(await draft()).toContain("Utilities: 50 monthly");
    });
  });

  // Groceries and Superstores share one figure, T (spec 05, Shopping: Groceries and Superstores).
  // History starts Nov 2, so the first draft on Nov 4 and December's Month start both have n = 0,
  // and T = B_GS. Household time is Anchorage time.
  describe("Groceries and Superstores sharing T", () => {
    const december = new Date("2026-12-01T14:00:00.000Z");
    let bGs: number;
    const dollars = (cents: number) => Math.round(cents / 100);
    // The Groceries and Superstores Budgets for a month as "amount source", in dollars.
    const shared = async (month: string) =>
      Object.fromEntries(
        (await budgetsForMonth(bank.database, month)).budgets
          .filter(({ category }) => category === "Groceries" || category === "Superstores")
          .map((budget) => [budget.category, `${budget.amount / 100} ${budget.source}`]),
      );

    // The first draft gives `holder` all of T. By Nov 30, `holder` has $300 of Spending,
    // `newcomer` its first $100 (or `newcomerDollars`), and Restaurants its first $60.
    const draftThenSpend = async (holder: Category, newcomer: Category, newcomerDollars = 100) => {
      await saveHouseholdFacts(
        bank.database,
        { zipCode: "99501", ages: [40, 38], rentOrOwn: "rent" },
        MEMBER,
      );
      await typeSteadyIncome(bank.database, $(6_000), MEMBER);
      await load([spend("first", "2026-11-02", 200, holder)]);
      expect(await draftFirstBudgets(bank.database, now)).toBe(true);
      bGs = (await terms()).benchmarks.Groceries ?? 0;
      expect(bGs).toBeGreaterThan(0);
      expect(await shared("2026-11")).toEqual({ [holder]: `${dollars(bGs)} formula` });
      now = new Date("2026-11-30T14:00:00.000Z");
      await load([
        spend("again", "2026-11-15", 100, holder),
        spend("newcomer", "2026-11-20", newcomerDollars, newcomer),
        spend("dinner", "2026-11-22", 60, "Restaurants"),
      ]);
    };

    it.each([
      { holder: "Groceries" as const, newcomer: "Superstores" as const },
      { holder: "Superstores" as const, newcomer: "Groceries" as const },
    ])(
      "splits T by r when $newcomer gets its first Budget while $holder holds all of T",
      async ({ holder, newcomer }) => {
        await draftThenSpend(holder, newcomer);
        // $500 more posts Dec 1, before the Month start runs. December's figure stands as of Nov 30,
        // so it is left out: the holder's share is $300 ÷ $400.
        now = december;
        await load([spend("newcomer-again", "2026-12-01", 500, newcomer)]);

        expect(await runMonthStart(bank.database, december)).toBe("done");

        const inDecember = await shared("2026-12");
        expect(inDecember).toEqual({
          [holder]: `${dollars((bGs * 3) / 4)} formula`,
          [newcomer]: `${dollars(bGs / 4)} formula`,
        });
        // Their total stays T, to within the rounding of each Budget, not T + T × (1 − r).
        const total = (await budgetsForMonth(bank.database, "2026-12")).budgets
          .filter(({ category }) => category === holder || category === newcomer)
          .reduce((sum, budget) => sum + budget.amount, 0);
        expect(Math.abs(total / 100 - dollars(bGs))).toBeLessThanOrEqual(1);
        // A past month keeps its Budget.
        expect(await shared("2026-11")).toEqual({ [holder]: `${dollars(bGs)} formula` });
        // Restaurants gets its first Budget in the same write, from its own formula, not a share
        // of T.
        const own = draftBudgets(await readDraftTerms(bank.database, "2026-12", december)).find(
          (budget) => budget.category === "Restaurants",
        );
        expect(own?.amount).toBeGreaterThan(0);
        expect(
          (await budgetsForMonth(bank.database, "2026-12")).budgets.find(
            (budget) => budget.category === "Restaurants",
          )?.amount,
        ).toBe(own?.amount);

        // Once both have a Budget, the rule is done. In January the window is December, where only
        // the newcomer has Spending, so r moves to 0 for the holder, and neither Budget changes.
        now = new Date("2027-01-01T14:00:00.000Z");
        expect(await runMonthStart(bank.database, now)).toBe("done");
        expect(await shared("2027-01")).toEqual(inDecember);
      },
    );

    it("never changes a Budget a Member set", async () => {
      await draftThenSpend("Groceries", "Superstores");
      await editBudget(
        bank.database,
        { category: "Groceries", amount: $(700), memberId: MEMBER },
        now,
      );

      expect(await runMonthStart(bank.database, december)).toBe("done");

      expect(await shared("2026-12")).toEqual({
        Groceries: "700 Member edit",
        Superstores: `${dollars(bGs / 4)} formula`,
      });
    });

    it.each(["AI draft", "Proposal"])("never changes an %s Budget", async (kind) => {
      await draftThenSpend("Groceries", "Superstores");
      await bank.database.$client.execute({
        sql: "UPDATE budgets SET source = ? WHERE category = 'Groceries'",
        args: [kind],
      });

      expect(await runMonthStart(bank.database, december)).toBe("done");

      expect(await shared("2026-12")).toEqual({
        Groceries: `${dollars(bGs)} ${kind}`,
        Superstores: `${dollars(bGs / 4)} formula`,
      });
    });

    // Spec 05, Which Categories get a Budget: never a $0 Budget this way.
    it("keeps the holder's Budget when the formula gives it none this month", async () => {
      await draftThenSpend("Groceries", "Superstores");
      // Every Groceries part moves to Superstores, as a Member's recategorization would.
      await bank.database.$client.execute(
        "UPDATE transaction_parts SET category = 'Superstores' WHERE category = 'Groceries'",
      );

      expect(await runMonthStart(bank.database, december)).toBe("done");

      // Superstores takes all of T as its first Budget. Groceries keeps all of T, not $0.
      expect(await shared("2026-12")).toEqual({
        Groceries: `${dollars(bGs)} formula`,
        Superstores: `${dollars(bGs)} formula`,
      });
    });

    it("keeps the holder's Budget with no Spending when neither has Spending and T splits evenly", async () => {
      await draftThenSpend("Groceries", "Superstores");
      // Every Groceries and Superstores part moves to Miscellaneous, so r = 1/2. Superstores
      // qualifies only through a monthly Recurring charge expected in December.
      await bank.database.$client.execute(
        "UPDATE transaction_parts SET category = 'Miscellaneous' WHERE category IN ('Groceries', 'Superstores')",
      );
      await replaceRecurringCharges(bank.database, [
        charge("warehouse-club", {
          category: "Superstores",
          schedule: "monthly",
          nextExpectedDate: "2026-12-20",
          paid: [["newcomer", "2026-11-20", $(100)]],
        }),
      ]);

      expect(await runMonthStart(bank.database, december)).toBe("done");

      // Superstores: max(K, T × 1/2). Groceries keeps all of T, not T × 1/2.
      expect(await shared("2026-12")).toEqual({
        Groceries: `${dollars(bGs)} formula`,
        Superstores: `${dollars(Math.max($(100), bGs / 2))} formula`,
      });
    });

    it("keeps the holder's Budget when its share rounds to $0", async () => {
      // r = $300 ÷ $1,000,300: the holder's share is under 50 cents.
      await draftThenSpend("Groceries", "Superstores", 1_000_000);

      expect(await runMonthStart(bank.database, december)).toBe("done");

      expect(await shared("2026-12")).toEqual({
        Groceries: `${dollars(bGs)} formula`,
        Superstores: `${dollars((bGs * 1_000_000) / 1_000_300)} formula`,
      });
    });

    it("gives the newcomer no first Budget when its own share rounds to $0, and the holder keeps all of T", async () => {
      // r = $300 ÷ $300.10: the newcomer's share, $0.10 ÷ $300.10 of T, is under 50 cents.
      await draftThenSpend("Groceries", "Superstores", 0.1);
      expect((bGs * 0.1) / 300.1).toBeLessThan(50);

      expect(await runMonthStart(bank.database, december)).toBe("done");

      expect(await shared("2026-12")).toEqual({ Groceries: `${dollars(bGs)} formula` });
    });

    // Spec 05, When the app drafts: an undone first Budget. Spec 08, Lifecycle: Undo.
    it.each([
      { undone: "the same month", setBy: "an edit" },
      { undone: "a month later", setBy: "a later Proposal" },
    ])(
      "keeps a first Budget a Member undid $undone off on each later 1st, until $setBy sets one",
      async ({ undone, setBy }) => {
        await draftThenSpend("Groceries", "Superstores");
        // A Budget change for Superstores, stored as a run would leave it, and accepted.
        const runs = { count: 0 };
        const proposeSuperstores = async (amount: number) => {
          runs.count += 1;
          const stored = await storeProposal(
            bank.database,
            {
              kind: "Budget change",
              source: "Budget tailoring",
              runId: `run-${runs.count}`,
              reason: "Superstores has steady Spending now.",
              goalId: null,
              goalAmount: null,
              words: null,
              createdAt: now,
              budgets: [{ category: "Superstores", amount }],
            },
            2,
          );
          if (stored === "run full") throw new Error("The run is full.");
          expect(
            await acceptProposal(bank.database, { id: stored.id, memberId: MEMBER }, now),
          ).toBe("accepted");
          return stored.id;
        };
        // A Proposal gives Superstores its first Budget on Nov 30.
        const first = await proposeSuperstores($(40));
        expect(await shared("2026-11")).toEqual({
          Groceries: `${dollars(bGs)} formula`,
          Superstores: "40 Proposal",
        });
        if (undone === "a month later") {
          expect(await runMonthStart(bank.database, december)).toBe("done");
          now = new Date("2026-12-02T14:00:00.000Z");
        }
        expect(await undoProposal(bank.database, { id: first, memberId: MEMBER }, now)).toBe(
          "undone",
        );

        // Two Month starts give it no Budget, and Groceries keeps all of T.
        const january = new Date("2027-01-01T14:00:00.000Z");
        if (undone === "the same month") {
          expect(await runMonthStart(bank.database, december)).toBe("done");
        }
        expect(await shared("2026-12")).toEqual({ Groceries: `${dollars(bGs)} formula` });
        // December's Superstores Spending would give it a first Budget in January.
        await load([spend("newcomer-december", "2026-12-10", 100, "Superstores")]);
        now = january;
        expect(await runMonthStart(bank.database, january)).toBe("done");
        expect(await shared("2027-01")).toEqual({ Groceries: `${dollars(bGs)} formula` });

        // A Member sets one, and the normal rules apply from then on.
        if (setBy === "an edit") {
          expect(
            await editBudget(
              bank.database,
              { category: "Superstores", amount: $(45), memberId: MEMBER },
              now,
            ),
          ).toMatchObject({ amount: $(45), period: "monthly", pinned: null });
        } else {
          await proposeSuperstores($(45));
        }
        const set = setBy === "an edit" ? "45 Member edit" : "45 Proposal";
        expect(await shared("2027-01")).toEqual({
          Groceries: `${dollars(bGs)} formula`,
          Superstores: set,
        });
        now = new Date("2027-02-01T14:00:00.000Z");
        expect(await runMonthStart(bank.database, now)).toBe("done");
        expect(await shared("2027-02")).toEqual({
          Groceries: `${dollars(bGs)} formula`,
          Superstores: set,
        });
      },
    );
  });

  describe("a Household with bills, loans, and Recurring charges", () => {
    beforeEach(async () => {
      const electric = monthly("2025-11", 12, "05");
      const phone = monthly("2025-11", 6, "12");
      const internet = monthly("2025-11", 12, "18");
      await load([
        spend("start", "2025-10-15", 1, "Miscellaneous"),
        ...electric.map((date, index) => spend(`electric-${index}`, date, 120, "Utilities")),
        // Water every 2 months is not a Recurring charge schedule.
        ...["2025-12-20", "2026-02-20", "2026-04-20", "2026-06-20", "2026-08-20", "2026-10-20"].map(
          (date, index) => spend(`water-${index}`, date, 60, "Utilities"),
        ),
        ...phone.map((date, index) => spend(`phone-${index}`, date, 50, "Phone and internet")),
        ...internet.map((date, index) =>
          spend(`internet-${index}`, date, 70, "Phone and internet"),
        ),
        spend("car-insurance", "2026-06-10", 1_200, "Insurance"),
        spend("costco", "2026-03-01", 60, "Superstores"),
        spend("target", "2026-05-01", 240, "Superstores"),
        { ...spend("late-fee", "2026-10-25", 35, "Interest and fees"), account: CARD },
        // Larkspur: each payment lands on the loan from checking, a Transfer pair. The interest
        // is Spending in Interest and fees.
        ...["2026-09-15", "2026-10-15"].flatMap((date, index): TxnSpec[] => [
          {
            id: `larkspur-${index}`,
            account: CHECKING,
            date,
            parts: [
              ["Spending", -$(index === 0 ? 102 : 100), "Interest and fees"],
              ["Transfer", -$(index === 0 ? 398 : 400), null],
            ],
          },
          {
            id: `larkspur-in-${index}`,
            account: LOAN,
            date,
            parts: [["Transfer", $(500), null]],
          },
        ]),
        // A Manual loan mortgage payment: interest, escrow, and principal.
        {
          id: "mortgage",
          account: CHECKING,
          date: "2026-10-01",
          parts: [
            ["Spending", -$(900), "Interest and fees"],
            ["Spending", -$(300), "Housing"],
            ["Spending", -$(800), "Housing"],
          ],
        },
      ]);
      for (const index of [0, 1]) {
        await bank.database.$client.execute({
          sql: `INSERT INTO transfer_links (id, out_transaction_id, in_transaction_id, tier, signals, made_by, created_at)
                VALUES (?, ?, ?, 'Strong', '[]', 'app', ?)`,
          args: [
            `link-${index}`,
            id(`larkspur-${index}`),
            id(`larkspur-in-${index}`),
            now.toISOString(),
          ],
        });
      }
      const mortgageId = await addManualLoan(
        bank.database,
        {
          lender: "Hometown Mortgage",
          subtype: "mortgage",
          apr: 6,
          regularPayment: $(2_000),
          escrow: $(300),
          loanType: null,
        },
        { date: "2026-09-01", balance: -$(180_000), typedAt: now, typedBy: MEMBER },
      );
      await storeOtherLink(
        bank.database,
        { kind: "loan", transactionId: id("mortgage"), loanAccountId: mortgageId },
        evidence(),
      );
      await replaceRecurringCharges(bank.database, [
        charge("Electric", {
          category: "Utilities",
          schedule: "monthly",
          nextExpectedDate: "2026-11-05",
          paid: electric.map((date, index) => [`electric-${index}`, date, $(120)]),
        }),
        charge("Old phone", {
          category: "Phone and internet",
          schedule: "monthly",
          nextExpectedDate: "2026-05-12",
          status: "ended",
          paid: phone.map((date, index) => [`phone-${index}`, date, $(50)]),
        }),
        charge("Internet", {
          category: "Phone and internet",
          schedule: "monthly",
          nextExpectedDate: "2026-11-18",
          paid: internet.map((date, index) => [`internet-${index}`, date, $(70)]),
        }),
        charge("Car insurance", {
          category: "Insurance",
          schedule: "yearly",
          nextExpectedDate: "2027-06-10",
          paid: [["car-insurance", "2026-06-10", $(1_200)]],
        }),
        charge("Costco", {
          category: "Superstores",
          schedule: "yearly",
          nextExpectedDate: "2027-03-01",
          paid: [["costco", "2026-03-01", $(60)]],
        }),
        // Larkspur's payments repeat too. The loan's parts count in K instead.
        charge("Larkspur", {
          category: "Interest and fees",
          schedule: "monthly",
          nextExpectedDate: "2026-11-15",
          paid: [
            ["larkspur-0", "2026-09-15", $(500)],
            ["larkspur-1", "2026-10-15", $(500)],
          ],
        }),
      ]);
    });

    it("drafts Utilities at $150: the $120 electric Recurring charge, plus water at $360 ÷ 12", async () => {
      const { Utilities } = (await terms()).categories;

      expect(Utilities).toMatchObject({ k: $(120), aOther: $(30), y: 0 });
    });

    it("leaves every Recurring charge out of A_other, active or not", async () => {
      expect((await terms()).categories["Phone and internet"]).toMatchObject({
        spent: $(300 + 840),
        aOther: 0,
        // Only the active Internet charge is a known amount.
        k: $(70),
      });
    });

    it("counts a yearly Recurring charge only in its expected month, and leaves it out of A_flex", async () => {
      expect((await terms("2026-11")).categories.Insurance).toMatchObject({
        k: 0,
        y: 0,
        aOther: 0,
      });
      expect((await terms("2027-06")).categories.Insurance).toMatchObject({
        k: $(1_200),
        y: $(1_200),
        aOther: 0,
      });
      expect((await terms()).categories.Superstores).toMatchObject({
        a: $(300) / 12,
        aFlex: $(240) / 12,
      });
    });

    it("counts each tracked loan's next payment, one month after its last, at that payment's parts", async () => {
      const { categories } = await terms();

      // Larkspur's $100 interest on Nov 15, and the mortgage's $900 on Nov 1. The card's late fee
      // never counts, nor Larkspur as a Recurring charge.
      expect(categories["Interest and fees"]).toMatchObject({ k: $(1_000), kLoans: $(1_000) });
      expect(categories.Housing).toMatchObject({ k: $(1_100), kLoans: $(1_100), aOther: 0 });
      // A_other leaves the loan payments out: only the card fee is left.
      expect(categories["Interest and fees"].aOther).toBe($(35) / 12);
      // A month with no payment expected has none.
      expect((await terms("2026-12")).categories["Interest and fees"].kLoans).toBe(0);
    });

    it("counts a payment already made in m at its own parts, and expects the next one after", async () => {
      await load([
        {
          id: "larkspur-2",
          account: CHECKING,
          date: "2026-11-03",
          parts: [
            ["Spending", -$(98), "Interest and fees"],
            ["Transfer", -$(402), null],
          ],
        },
        {
          id: "larkspur-in-2",
          account: LOAN,
          date: "2026-11-03",
          parts: [["Transfer", $(500), null]],
        },
      ]);
      await bank.database.$client.execute({
        sql: `INSERT INTO transfer_links (id, out_transaction_id, in_transaction_id, tier, signals, made_by, created_at)
              VALUES ('link-2', ?, ?, 'Strong', '[]', 'app', ?)`,
        args: [id("larkspur-2"), id("larkspur-in-2"), now.toISOString()],
      });

      expect((await terms()).categories["Interest and fees"].kLoans).toBe($(98 + 900));
      expect((await terms("2026-12")).categories["Interest and fees"].kLoans).toBe($(98));
    });

    it("expects the last known parts while a payment's paying side is hidden and its pair is still live", async () => {
      // The re-link hid October's paying side; its Transfer pair stays until Matching ends it.
      await hide("larkspur-1");

      // September's $102, not $0, until the pair ends; and the mortgage's $900.
      expect((await terms()).categories["Interest and fees"].kLoans).toBe($(102 + 900));
    });

    it("leaves out a loan payment that a re-link hid", async () => {
      await load([
        {
          id: "larkspur-2",
          account: CHECKING,
          date: "2026-11-03",
          parts: [
            ["Spending", -$(98), "Interest and fees"],
            ["Transfer", -$(402), null],
          ],
        },
        {
          id: "larkspur-in-2",
          account: LOAN,
          date: "2026-11-03",
          parts: [["Transfer", $(500), null]],
        },
      ]);
      await pair("larkspur-2", "larkspur-in-2");
      await hide("larkspur-in-2");

      // Still Larkspur's $100 expected on Nov 15, not the hidden $98.
      expect((await terms()).categories["Interest and fees"].kLoans).toBe($(1_000));
    });

    it("never takes a Manual loan's payout as its last payment", async () => {
      await load([
        {
          id: "mortgage-payout",
          account: CHECKING,
          date: "2026-10-20",
          parts: [["Transfer", $(5_000), null]],
        },
      ]);
      const [mortgage] = (
        await bank.database.$client.execute({
          sql: "SELECT loan_account_id FROM loan_links WHERE transaction_id = ?",
          args: [id("mortgage")],
        })
      ).rows;
      await storeOtherLink(
        bank.database,
        {
          kind: "loan",
          transactionId: id("mortgage-payout"),
          loanAccountId: String(mortgage?.loan_account_id),
        },
        evidence(),
      );

      // The mortgage's $900 and $1,100 still come on Nov 1, after the Oct 1 payment.
      const { categories } = await terms();
      expect(categories["Interest and fees"].kLoans).toBe($(1_000));
      expect(categories.Housing.kLoans).toBe($(1_100));
    });

    it("never takes money out of a connected loan as its last payment", async () => {
      await load([
        {
          id: "larkspur-draw",
          account: LOAN,
          date: "2026-10-25",
          parts: [["Transfer", -$(250), null]],
        },
      ]);

      // Larkspur's $100 still comes on Nov 15, after the Oct 15 payment.
      expect((await terms()).categories["Interest and fees"].kLoans).toBe($(1_000));
    });

    it("expects nothing from a Closed loan", async () => {
      await bank.database.$client.execute({
        sql: "UPDATE household_accounts SET closed_at = ?, closed_reason = 'paid off' WHERE provider_account_id = ?",
        args: [now.toISOString(), LOAN.id],
      });

      expect((await terms()).categories["Interest and fees"].kLoans).toBe($(900));
    });

    it("stores the first draft once, active from its month, with its inputs", async () => {
      await typeSteadyIncome(bank.database, $(6_000), MEMBER);

      expect(await draftFirstBudgets(bank.database, now)).toBe(true);
      expect(await draftFirstBudgets(bank.database, now)).toBe(false);

      const { budgets, groups, notice } = await budgetsForMonth(bank.database, "2026-11");
      expect(notice).toBe(benchmarkSnapshot().sample ? "Sample numbers, not real data" : undefined);
      expect(
        budgets.map(({ category, amount, period }) => [category, amount / 100, period]),
      ).toEqual([
        ["Housing", 1_100, "monthly"],
        ["Utilities", 150, "monthly"],
        ["Phone and internet", 70, "monthly"],
        ["Insurance", 0, "monthly"],
        ["Interest and fees", 1_000, "monthly"],
        // $20 × 1.10.
        ["Superstores", 22, "monthly"],
      ]);
      expect(budgets[0]).toEqual({
        category: "Housing",
        categoryGroup: "Bills",
        amount: $(1_100),
        period: "monthly",
        takesEffect: "2026-11",
        source: "formula",
        setBy: null,
        pinned: false,
        reason: null,
      });
      expect(budgets.find((budget) => budget.category === "Superstores")?.pinned).toBeNull();
      expect(groups.find((group) => group.categoryGroup === "Bills")).toEqual({
        categoryGroup: "Bills",
        monthly: $(1_100 + 150 + 70 + 0 + 1_000),
        yearly: 0,
      });
      const inputs = await bank.database.$client.execute("SELECT * FROM budget_inputs");
      expect(inputs.rows[0]).toMatchObject({
        steady_income: $(6_000),
        ce_data_year: benchmarkSnapshot().ce.dataYear,
        first_draft_month: "2026-11",
      });
      // Months before the first draft have no Budget; later months keep it.
      expect((await budgetsForMonth(bank.database, "2026-10")).budgets).toEqual([]);
      expect((await budgetsForMonth(bank.database, "2027-02")).budgets).toHaveLength(6);
      expect((await budgetsForMonth(bank.database, "2026-11")).fitNote).toBeUndefined();
    });

    it("keeps the draft as cut, with its note, when the fixed costs pass Steady Income", async () => {
      // Bills alone pass $1,000, and only Superstores is left, which is never cut.
      await typeSteadyIncome(bank.database, $(1_000), MEMBER);

      await draftFirstBudgets(bank.database, now);

      const { budgets, fitNote } = await budgetsForMonth(bank.database, "2026-11");
      expect(fitNote).toBe(FIXED_COSTS_PASS_INCOME);
      expect(fitNote).toBe("The fixed costs pass Steady Income.");
      expect(budgets.find((budget) => budget.category === "Superstores")?.amount).toBe($(22));
      const inputs = await bank.database.$client.execute("SELECT * FROM budget_inputs");
      expect(inputs.rows[0]).toMatchObject({ fixed_costs_pass_income: 1 });
    });
  });

  it("drafts flexible Budgets from the Benchmarks, and yearly Budgets for the year", async () => {
    await saveHouseholdFacts(
      bank.database,
      { zipCode: "99501", ages: [40, 38], rentOrOwn: "rent" },
      MEMBER,
    );
    await typeSteadyIncome(bank.database, $(6_000), MEMBER);
    await load([
      spend("start", "2025-10-01", 1, "Miscellaneous"),
      ...monthly("2025-10", 12, "08").map((date, index) =>
        spend(`dinner-${index}`, date, 5_000, "Restaurants"),
      ),
      spend("flight", "2026-07-08", 4_800, "Travel"),
    ]);
    const benchmarks = await categoryBenchmarks(bank.database, now);
    const restaurants = benchmarks?.categories.find((each) => each.category === "Restaurants");

    await draftFirstBudgets(bank.database, now);

    const { budgets } = await budgetsForMonth(bank.database, "2026-11");
    expect(budgets.find((budget) => budget.category === "Restaurants")?.amount).toBe(
      Math.round((restaurants?.amount ?? 0) / 100) * 100,
    );
    // $4,800 × 1.10.
    expect(budgets.find((budget) => budget.category === "Travel")).toMatchObject({
      amount: $(5_280),
      period: "yearly",
      takesEffect: "2026",
    });
    expect((await budgetsForMonth(bank.database, "2027-01")).budgets).toContainEqual(
      expect.objectContaining({ category: "Travel", amount: $(5_280) }),
    );
  });

  // The review's hand check: every figure below was worked out by hand from spec 05, with the
  // Recurring charges found by the real rules.
  it("drafts a whole Household as worked by hand", async () => {
    now = new Date("2026-11-17T15:00:00.000Z");
    await saveHouseholdFacts(
      bank.database,
      { zipCode: "10001", ages: [40, 38], rentOrOwn: "rent" },
      MEMBER,
    );
    await typeSteadyIncome(bank.database, $(6_000), MEMBER);
    const named = (txn: TxnSpec, merchant: string): TxnSpec => ({ ...txn, merchant });
    await load([
      // History starts on Jun 1, 2025: the window is Nov 2025 to Oct 2026, and n = 12.
      spend("start", "2025-06-01", 1, "Miscellaneous"),
      // Electric rose to $130 and is already paid in m: K = $130, once.
      ...monthly("2025-06", 17, "05").map((date, index) =>
        named(spend(`electric-${index}`, date, 120, "Utilities"), "City Power"),
      ),
      named(spend("electric-nov", "2026-11-05", 130, "Utilities"), "City Power"),
      // Water every 2 months: A_other = $360 ÷ 12.
      ...["2025-12-20", "2026-02-20", "2026-04-20", "2026-06-20", "2026-08-20", "2026-10-20"].map(
        (date, index) => spend(`water-${index}`, date, 60, "Utilities"),
      ),
      // Yearly, expected next June: $0 now, and out of A_other.
      named(spend("insurance-0", "2025-06-10", 1_200, "Insurance"), "Geico"),
      named(spend("insurance-1", "2026-06-10", 1_200, "Insurance"), "Geico"),
      spend("gift-0", "2025-12-15", 300, "Gifts and donations"),
      spend("gift-1", "2026-05-01", 500, "Gifts and donations"),
      ...monthly("2025-11", 12, "20").map((date, index) =>
        spend(`dinner-${index}`, date, 450, "Restaurants"),
      ),
      ...monthly("2025-06", 17, "25").map((date, index) =>
        named(spend(`streaming-${index}`, date, 20, "Entertainment"), "Streamy"),
      ),
      ...monthly("2025-11", 12, "08").map((date, index) =>
        spend(`groceries-${index}`, date, 500, "Groceries"),
      ),
      ...monthly("2025-11", 12, "09").map((date, index) =>
        spend(`superstore-${index}`, date, 250, "Superstores"),
      ),
      // The linked Refund posts in m and reduces October's coat: Clothing A_flex = $120 ÷ 12.
      spend("coat", "2026-10-28", 200, "Clothing"),
      {
        id: "coat-refund",
        account: CHECKING,
        date: "2026-11-02",
        parts: [["Refund", $(200), null, "linked"]],
      },
      spend("shirt", "2026-03-03", 120, "Clothing"),
      { ...spend("late-fee", "2026-10-25", 35, "Interest and fees"), account: CARD },
      // A Manual loan: its next payment on Nov 15 at the last one's $100 interest.
      ...["2026-07-15", "2026-08-15", "2026-09-15", "2026-10-15"].map(
        (date, index): TxnSpec => ({
          id: `larkspur-${index}`,
          account: CHECKING,
          date,
          merchant: "Larkspur",
          parts: [
            ["Spending", -$(103 - index), "Interest and fees"],
            ["Transfer", -$(397 + index), null],
          ],
        }),
      ),
    ]);
    const loanId = await addManualLoan(
      bank.database,
      {
        lender: "Larkspur",
        subtype: "personal",
        apr: 8,
        regularPayment: $(500),
        escrow: null,
        loanType: null,
      },
      { date: "2026-06-01", balance: -$(20_000), typedAt: now, typedBy: MEMBER },
    );
    for (const index of [0, 1, 2, 3]) {
      await storeOtherLink(
        bank.database,
        { kind: "loan", transactionId: id(`larkspur-${index}`), loanAccountId: loanId },
        evidence(),
      );
    }
    await storeOtherLink(
      bank.database,
      { kind: "Refund", transactionId: id("coat-refund"), spendingTransactionId: id("coat") },
      evidence(),
    );
    await findRecurringCharges(bank.database, now);

    expect(await draftFirstBudgets(bank.database, now)).toBe(true);

    const { budgets, groups } = await budgetsForMonth(bank.database, "2026-11");
    // Groceries and Superstores: A_flex $750 × 1.10 is below B_GS, so T = $825 and r = 2/3.
    // Clothing: $10 × 1.10. Restaurants: B = $296 is below A_flex $450 × 1.10. Entertainment:
    // A_flex $20 × 1.10 passes K = $20. Gifts and donations: $800 × 1.10. Miscellaneous: none in
    // the window.
    expect(budgets.map(({ category, amount, period }) => [category, amount / 100, period])).toEqual(
      [
        ["Utilities", 160, "monthly"],
        ["Insurance", 0, "monthly"],
        ["Interest and fees", 100, "monthly"],
        ["Groceries", 550, "monthly"],
        ["Superstores", 275, "monthly"],
        ["Clothing", 11, "monthly"],
        ["Restaurants", 296, "monthly"],
        ["Entertainment", 22, "monthly"],
        ["Gifts and donations", 880, "yearly"],
      ],
    );
    expect(
      groups.map(({ categoryGroup, monthly, yearly }) => [
        categoryGroup,
        monthly / 100,
        yearly / 100,
      ]),
    ).toEqual([
      ["Bills", 260, 0],
      ["Shopping", 836, 0],
      ["Transportation", 0, 0],
      ["Health and care", 0, 0],
      ["Leisure", 318, 0],
      ["Other", 0, 880],
    ]);
  });

  it("runs as the First run's budget draft step, once the wait for the first history load ends", async () => {
    await load([spend("start", "2026-10-01", 25, "Utilities")]);
    const budgets = startBudgets({ database: bank.database, now: () => now });
    try {
      await runFirstRun(() => now);
      expect((await budgetsForMonth(bank.database, "2026-11")).budgets).toEqual([]);

      await claimHistoryWaitEnd(bank.database, now);
      await runFirstRun(() => now);
    } finally {
      budgets.stop();
    }

    expect(
      (await budgetsForMonth(bank.database, "2026-11")).budgets.map(({ category, amount }) => [
        category,
        amount,
      ]),
    ).toEqual([
      ["Utilities", $(25)],
      ["Interest and fees", 0],
    ]);
  });
});
