import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { benchmarkSnapshot } from "../benchmarks/index.ts";
import { budgetsForMonth, budgetsForMonths } from "../budgets/index.ts";
import { startCategorization } from "../categorization/index.ts";
import { type NewBudget, storeBudgetEdit, storeFirstDraft } from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { readTransactionDecision, startMoneyMovement } from "../money-movement/index.ts";
import { reportRoutes } from "./reports.ts";

// Spending over time and Cash flow (spec 07, Reports) on Transactions the fake adapter syncs,
// through the Matching and Categorization follow-up steps, so every money rule is the app's own.
// The Household has no time zone, so its date is UTC's: Nov 20, 2026.

const NOW = new Date("2026-11-20T14:00:00.000Z");
const BANK = "fake-first-bank";
const CARD = "acc-card";
const CHECKING = "acc-checking";
const MEMBER = "member-1";
const code = (name: string) => ({ name, confidence: "HIGH", version: "v2", mcc: null });
const CLOTHING = code("GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES");
const RESTAURANT = code("FOOD_AND_DRINK_RESTAURANT");
const CARD_PAYMENT = code("LOAN_PAYMENTS_CREDIT_CARD_PAYMENT");

const txn = (
  id: string,
  amount: number,
  postedDate: string,
  merchant: string,
  fields: Partial<TxnRecord> = {},
) =>
  fakeTxn({
    id,
    accountId: CARD,
    amount,
    postedDate,
    description: merchant.toUpperCase(),
    merchantName: merchant,
    category: CLOTHING,
    ...fields,
  });

const budget = (category: string, amount: number, fields: Partial<NewBudget> = {}): NewBudget => ({
  category,
  amount,
  period: "monthly",
  takesEffect: "2026-09",
  source: "formula",
  setBy: null,
  pinned: null,
  setAt: NOW,
  ...fields,
});

describe("Spending over time and Cash flow", () => {
  let bank: TestBank;
  let stops: (() => void)[];

  const idOf = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT id FROM transactions WHERE provider_transaction_id = ?",
      args: [providerId],
    });
    return String(rows.rows[0]?.id);
  };
  const typeOf = async (providerId: string) =>
    (await readTransactionDecision(bank.database, await idOf(providerId)))?.parts.map(
      (part) => part.type,
    );

  beforeEach(async () => {
    bank = await newTestBank();
    stops = [
      startMoneyMovement({ database: bank.database }).stop,
      startCategorization({ database: bank.database }).stop,
    ];
    const connectionId = await bank.connect(BANK);
    await bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('${MEMBER}', 'Jamie', 'jamie@example.com', '2026-10-01T00:00:00.000Z',
         '2026-10-01T00:00:00.000Z')`,
    );
    bank.fake.addPages(BANK, {
      accounts: [
        fakeAccount({ id: CARD, type: "credit", subtype: "credit card", mask: "1111" }),
        fakeAccount({ id: CHECKING, mask: "3333" }),
      ],
      added: [
        txn("august", -1_000, "2026-08-05", "Corner Bistro", { category: RESTAURANT }),
        txn("socks", -1_000, "2026-10-04", "Sock Shop"),
        // Bought on Oct 31, posted Nov 2: it counts in October.
        txn("boots", -4_000, "2026-11-02", "Shoe Barn", { authorizedDate: "2026-10-31" }),
        // A Refund linked to the boots lowers October's Clothing.
        txn("boots-refund", 1_000, "2026-11-05", "Shoe Barn"),
        // An unlinked Refund larger than October's Restaurants: the month goes no lower than $0.
        txn("dinner", -2_000, "2026-10-03", "Corner Bistro", { category: RESTAURANT }),
        txn("grill-refund", 5_000, "2026-10-06", "Harbor Grill", { category: RESTAURANT }),
        // Pending: it counts nowhere.
        txn("pending", -9_000, "2026-11-10", "Corner Bistro", {
          category: RESTAURANT,
          pending: true,
        }),
        // A card payment from checking: a Transfer, which counts nowhere.
        txn("payment-out", -20_000, "2026-11-09", "Payment to card", {
          accountId: CHECKING,
          merchantName: null,
          description: "PAYMENT TO CARD 1111",
          category: CARD_PAYMENT,
        }),
        txn("payment-in", 20_000, "2026-11-09", "Payment thank you", {
          merchantName: null,
          description: "PAYMENT THANK YOU",
          category: CARD_PAYMENT,
        }),
        txn("payroll", 300_000, "2026-10-15", "Acme payroll", {
          accountId: CHECKING,
          merchantName: null,
          description: "ACME CORP PAYROLL",
          category: code("INCOME_WAGES"),
        }),
      ],
      historyLoaded: true,
    });
    await syncConnection(connectionId, () => NOW);
    await runFollowUp(() => NOW);
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  it("counts posted Spending in its month of purchase, with Refunds, a $0 floor, and no Transfer", async () => {
    expect(await typeOf("payment-out")).toEqual(["Transfer"]);
    expect(await typeOf("payment-in")).toEqual(["Transfer"]);
    expect(await typeOf("boots-refund")).toEqual(["Refund"]);

    const view = await reportRoutes(bank.database).spending({ range: "12m" }, NOW);

    expect(view.months).toEqual(["2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(view.segments).toEqual([
      "Bills",
      "Shopping",
      "Transportation",
      "Health and care",
      "Leisure",
      "Other",
    ]);
    expect(view.bars.map((bar) => [bar.month, bar.spending])).toEqual([
      ["2026-08", 1_000],
      ["2026-09", 0],
      // Sock Shop and the boots, less their Refund; Restaurants go no lower than $0.
      ["2026-10", 4_000],
      // The pending dinner and the card payment count nowhere.
      ["2026-11", 0],
    ]);
    expect(view.bars[2]?.segments).toMatchObject({ Shopping: 4_000, Leisure: 0 });
    // The usual month: the median of August to October, the months from the history's first.
    expect(view.usual).toBe(1_000);
    expect(view.rows.find((row) => row.name === "Shopping")).toEqual({
      name: "Shopping",
      total: 4_000,
      average: 1_000,
      change: null,
    });
  });

  it("shows only the chosen group's Categories", async () => {
    const view = await reportRoutes(bank.database).spending(
      { range: "12m", group: "Leisure" },
      NOW,
    );

    expect(view.group).toBe("Leisure");
    expect(view.segments).toEqual([
      "Restaurants",
      "Entertainment",
      "Hobbies",
      "Travel",
      "Books and education",
    ]);
    expect(view.rows.map((row) => row.name)).toEqual(view.segments);
    expect(view.bars.map((bar) => bar.segments.Restaurants)).toEqual([1_000, 0, 0, 0]);
    expect(view.bars.every((bar) => bar.segments.Clothing === undefined)).toBe(true);
    expect(view.usual).toBe(0);
  });

  it("draws each month's Budget line from the Budgets in effect that month", async () => {
    await storeFirstDraft(bank.database, {
      inputs: {
        steadyIncome: 300_000,
        ceDataYear: benchmarkSnapshot().ce.dataYear,
        sampleBenchmarks: benchmarkSnapshot().sample,
        firstDraftMonth: "2026-09",
        fixedCostsPassIncome: false,
        recordedAt: NOW,
      },
      budgets: [
        budget("Restaurants", 30_000),
        budget("Clothing", 10_000),
        budget("Travel", 480_000, { period: "yearly", takesEffect: "2026" }),
      ],
    });
    await storeBudgetEdit(bank.database, "2026-11", {
      category: "Restaurants",
      amount: 50_000,
      setBy: MEMBER,
      setAt: NOW,
      bills: false,
      period: "monthly",
    });
    // Clothing's Budget ends in November.
    await bank.database.$client.execute(
      `INSERT INTO budgets (category, amount, period, takes_effect, source, set_at, no_budget)
       VALUES ('Clothing', 0, 'monthly', '2026-11', 'Proposal', '${NOW.toISOString()}', 1)`,
    );
    const reports = reportRoutes(bank.database);

    // Before the first draft there is no line. A past month keeps its own Budget, not today's,
    // and a yearly Budget is not on a monthly line.
    const all = await reports.spending({ range: "12m" }, NOW);
    expect(all.bars.map((bar) => bar.budget)).toEqual([null, 40_000, 40_000, 50_000]);
    const leisure = await reports.spending({ range: "12m", group: "Leisure" }, NOW);
    expect(leisure.bars.map((bar) => bar.budget)).toEqual([null, 30_000, 30_000, 50_000]);
    const bills = await reports.spending({ range: "12m", group: "Bills" }, NOW);
    expect(bills.bars.map((bar) => bar.budget)).toEqual([null, null, null, null]);

    // One read of every Budget version gives each month what the month's own read gives.
    const byMonth = await budgetsForMonths(bank.database, all.months);
    for (const month of all.months) {
      expect(byMonth.get(month)).toEqual((await budgetsForMonth(bank.database, month)).budgets);
    }
  });

  it("gives Cash flow's Income, Spending, Saving and Left over from the same totals", async () => {
    const view = await reportRoutes(bank.database).cashFlow({ range: "3m" }, NOW);

    expect(view.months).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(view.bars).toEqual([
      { month: "2026-09", income: 0, spending: 0, saving: 0, leftOver: 0 },
      { month: "2026-10", income: 300_000, spending: 4_000, saving: 0, leftOver: 296_000 },
      { month: "2026-11", income: 0, spending: 0, saving: 0, leftOver: 0 },
    ]);
    expect(view.total).toEqual({ income: 300_000, spending: 4_000, saving: 0, leftOver: 296_000 });
    expect(view.average).toEqual({ income: 100_000, spending: 1_333, saving: 0, leftOver: 98_667 });
  });
});
