import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { type Category, categoryGroupOf } from "../categories/index.ts";
import {
  addManualLoan,
  type NewPart,
  replaceRecurringCharges,
  storeDecisions,
  storeOtherLink,
} from "../db/index.ts";
import {
  type Budget,
  budgetSpending,
  isLargePurchase,
  type Purchase,
  projectedSpending,
  projectMerchant,
  purchasesFrom,
  shareOfYear,
} from "./index.ts";

// Month-end Spending and each Budget's status (spec 06, Overspending; The projection; Large
// purchase; spec 05, Yearly Budgets). The Household time zone is unset, so Household time is UTC.

const BANK = "fake-projection-bank";
const CHECKING = fakeAccount({ id: "acc-checking" });

const $ = (dollars: number) => Math.round(dollars * 100);
const at = (date: string) => new Date(`${date}T15:00:00.000Z`);

type TxnSpec = {
  id: string;
  date: string;
  parts: [NewPart["type"], number, Category | null][];
  merchant?: string;
  code?: string;
};

const spend = (
  id: string,
  date: string,
  dollars: number,
  category: Category,
  merchant?: string,
): TxnSpec => ({ id, date, parts: [["Spending", -$(dollars), category]], merchant });

const monthly = (category: Category, dollars: number): Budget => ({
  category,
  categoryGroup: categoryGroupOf(category),
  amount: $(dollars),
  period: "monthly",
  takesEffect: "2026-01",
  source: "formula",
  setBy: null,
  pinned: categoryGroupOf(category) === "Bills" ? false : null,
});

describe("the projection and status", () => {
  let bank: TestBank;
  let connectionId: string;
  let accountId: string;
  const ids = new Map<string, string>();

  const load = async (txns: TxnSpec[]) => {
    bank.fake.addPages(BANK, {
      accounts: [CHECKING],
      added: txns.map((txn) =>
        fakeTxn({
          id: txn.id,
          accountId: CHECKING.id,
          amount: txn.parts.reduce((sum, [, amount]) => sum + amount, 0),
          postedDate: txn.date,
          category:
            txn.code === undefined
              ? null
              : { name: txn.code, confidence: null, version: null, mcc: null },
        }),
      ),
    });
    await syncConnection(connectionId, () => at("2026-11-10"));
    const rows = await bank.database.$client.execute(
      "SELECT id, provider_transaction_id, account_id FROM transactions",
    );
    for (const row of rows.rows) {
      ids.set(String(row.provider_transaction_id), String(row.id));
      accountId = String(row.account_id);
    }
    for (const txn of txns) {
      if (txn.merchant === undefined) continue;
      await bank.database.$client.execute({
        sql: "UPDATE transactions SET merchant_clean_name = ? WHERE id = ?",
        args: [txn.merchant, ids.get(txn.id) ?? ""],
      });
    }
    await storeDecisions(
      bank.database,
      txns.map((txn) => ({
        transactionId: ids.get(txn.id) ?? "",
        step: "5.7",
        provisionalUntil: null,
        decidedAt: at("2026-11-10"),
        parts: txn.parts.map(([type, amount, category]) => ({ type, amount, category })),
      })),
    );
  };

  // A monthly Recurring charge, as the Recurring charge checks would store it, from the loaded
  // Transactions: each paid entry is [provider ID, date, dollars].
  const setCharges = async (
    charges: { name: string; category: Category; paid: [string, string, number][] }[],
  ) =>
    replaceRecurringCharges(
      bank.database,
      charges.map(({ name, category, paid }) => ({
        id: `charge-${name}`,
        merchantId: null,
        merchantName: name,
        category,
        schedule: "monthly" as const,
        nextExpectedDate: "2026-12-01",
        latestAmount: $(paid.at(-1)?.[2] ?? 0),
        priceHistory: paid.map(([id, date, dollars]) => ({
          transactionId: ids.get(id) ?? id,
          date,
          amount: $(dollars),
        })),
        accountId,
        status: "active" as const,
        foundAt: at("2026-11-10"),
        endedAt: null,
        endedBy: null,
      })),
    );

  // Each Budget's [spending, P, status] in dollars, in `month` on `today`.
  const statuses = async (budgets: Budget[], month: string, today: string) => {
    const found = await budgetSpending(bank.database, month, budgets, at(today));
    return Object.fromEntries(
      [...found.budgets].map(([category, each]) => [
        category,
        [each.spending / 100, each.projected === null ? null : each.projected / 100, each.status],
      ]),
    );
  };

  beforeEach(async () => {
    ids.clear();
    bank = await newTestBank();
    connectionId = await bank.connect(BANK);
  });

  afterEach(() => {
    bank.close();
  });

  it("projects Restaurants on October 12 at $620: F × 31 ÷ 12, On pace", async () => {
    await load([
      spend("dinner-1", "2026-10-02", 90, "Restaurants"),
      spend("dinner-2", "2026-10-06", 70, "Restaurants"),
      spend("lunch-1", "2026-10-11", 80, "Restaurants"),
    ]);

    expect(await statuses([monthly("Restaurants", 500)], "2026-10", "2026-10-12")).toEqual({
      Restaurants: [240, 620, "On pace"],
    });
  });

  it("projects Home and garden on day 10 of 30 at $160: the $100 one-off is not extrapolated", async () => {
    await load([
      spend("home-depot", "2026-11-04", 100, "Home and garden", "Home Depot"),
      spend("hooks", "2026-11-08", 20, "Home and garden"),
    ]);

    expect(await statuses([monthly("Home and garden", 150)], "2026-11", "2026-11-10")).toEqual({
      "Home and garden": [120, 160, "On pace"],
    });
    // Without the 50% test a straight line gives $360: a $74.99 purchase is not a one-off.
    expect(await statuses([monthly("Home and garden", 200.01)], "2026-11", "2026-11-10")).toEqual({
      "Home and garden": [120, 360, "On pace"],
    });
  });

  it("projects Fitness at $50 when its $50 gym Recurring charge posted on the 2nd: on track", async () => {
    await load([
      spend("gym-sep", "2026-09-02", 50, "Fitness"),
      spend("gym-oct", "2026-10-02", 50, "Fitness"),
      spend("gym-nov", "2026-11-02", 50, "Fitness"),
    ]);
    await setCharges([
      {
        name: "gym",
        category: "Fitness",
        paid: [
          ["gym-sep", "2026-09-02", 50],
          ["gym-oct", "2026-10-02", 50],
          ["gym-nov", "2026-11-02", 50],
        ],
      },
    ]);

    expect(await statuses([monthly("Fitness", 50)], "2026-11", "2026-11-10")).toEqual({
      Fitness: [50, 50, "on track"],
    });
  });

  it("adds each Recurring charge still due this month at its latest amount, and none that lapsed", async () => {
    await load([
      spend("stream-oct", "2026-10-20", 15, "Entertainment"),
      spend("old-oct", "2026-10-01", 40, "Entertainment"),
    ]);
    await setCharges([
      // Due Nov 20.
      { name: "stream", category: "Entertainment", paid: [["stream-oct", "2026-10-20", 15]] },
      // Expected Nov 1, and past its margin on Nov 10.
      { name: "old", category: "Entertainment", paid: [["old-oct", "2026-10-01", 40]] },
    ]);

    expect(await statuses([monthly("Entertainment", 10)], "2026-11", "2026-11-10")).toEqual({
      Entertainment: [0, 15, "On pace"],
    });
    // A past month has nothing still due.
    expect(await statuses([monthly("Entertainment", 100)], "2026-10", "2026-11-10")).toEqual({
      Entertainment: [55, 55, "on track"],
    });
  });

  it("does not extrapolate the Bills group, and gives Interest and fees no projection", async () => {
    await load([
      spend("electric-oct", "2026-10-20", 120, "Utilities"),
      spend("water", "2026-11-05", 30, "Utilities"),
      spend("card-interest", "2026-11-03", 25, "Interest and fees"),
    ]);
    await setCharges([
      { name: "electric", category: "Utilities", paid: [["electric-oct", "2026-10-20", 120]] },
    ]);

    expect(
      await statuses(
        [monthly("Utilities", 140), monthly("Interest and fees", 20)],
        "2026-11",
        "2026-11-10",
      ),
    ).toEqual({
      // R_due $120 + F $30, not $120 + $30 × 3.
      Utilities: [30, 150, "On pace"],
      "Interest and fees": [25, null, "Over Budget"],
    });
  });

  it("adds a tracked loan payment's escrow while it is due, and counts it as posted once it posts", async () => {
    const payment = (id: string, date: string): TxnSpec => ({
      id,
      date,
      parts: [
        ["Spending", -$(100), "Interest and fees"],
        ["Spending", -$(300), "Housing"],
        ["Transfer", -$(600), null],
      ],
    });
    await bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('member-1', 'Jamie', 'jamie@example.com', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    );
    const loanId = await addManualLoan(
      bank.database,
      {
        lender: "Fake Mortgage Co",
        subtype: "mortgage",
        apr: 6,
        regularPayment: $(1_000),
        escrow: $(300),
        loanType: null,
      },
      { date: "2026-09-01", balance: -$(200_000), typedAt: at("2026-11-10"), typedBy: "member-1" },
    );
    const link = (provider: string) =>
      storeOtherLink(
        bank.database,
        { kind: "loan", transactionId: ids.get(provider) ?? "", loanAccountId: loanId },
        {
          tier: "Strong",
          signals: [],
          aiAnswer: null,
          aiConfidence: null,
          madeBy: "app",
          memberId: null,
          createdAt: at("2026-11-10"),
        },
      );
    await load([payment("mortgage-oct", "2026-10-15"), spend("hoa", "2026-11-05", 50, "Housing")]);
    await link("mortgage-oct");

    // R_due $300 of escrow, and F $50, not extrapolated.
    expect(await statuses([monthly("Housing", 340)], "2026-11", "2026-11-10")).toEqual({
      Housing: [50, 350, "On pace"],
    });

    await load([payment("mortgage-nov", "2026-11-15")]);
    await link("mortgage-nov");

    // R_posted $300, nothing more due.
    expect(await statuses([monthly("Housing", 340)], "2026-11", "2026-11-16")).toEqual({
      Housing: [350, 350, "Over Budget"],
    });
  });

  it("is Over Budget once the Spending passes the Budget, and not at the Budget", async () => {
    await load([spend("shoes", "2026-11-05", 60, "Clothing")]);

    expect(await statuses([monthly("Clothing", 59.99)], "2026-11", "2026-11-30")).toEqual({
      Clothing: [60, 60, "Over Budget"],
    });
    expect(await statuses([monthly("Clothing", 60)], "2026-11", "2026-11-30")).toEqual({
      Clothing: [60, 60, "on track"],
    });
  });

  it("keeps F at $0 or more when Refunds pass the rest of the month's Spending", async () => {
    await load([
      spend("tv", "2026-11-03", 300, "General goods"),
      { id: "tv-refund", date: "2026-11-06", parts: [["Refund", $(300), "General goods"]] },
      spend("cable", "2026-11-07", 10, "General goods"),
    ]);

    // Spending $10 net; O is the $300 TV, at 50% or more of $400; F = max(0, $10 − $300) = $0.
    expect(await statuses([monthly("General goods", 400)], "2026-11", "2026-11-10")).toEqual({
      "General goods": [10, 300, "on track"],
    });
  });

  it("gives a yearly Budget only Over Budget, on the year's Spending, with the share of the year", async () => {
    await load([
      spend("flight", "2026-03-10", 2_000, "Travel"),
      spend("hotel", "2026-11-04", 1_200, "Travel"),
      spend("gift", "2026-11-02", 300, "Gifts and donations"),
    ]);
    const yearly = (category: Category, dollars: number): Budget => ({
      ...monthly(category, dollars),
      period: "yearly",
      takesEffect: "2026",
    });

    const found = await budgetSpending(
      bank.database,
      "2026-11",
      [yearly("Travel", 3_000), yearly("Gifts and donations", 1_200)],
      at("2026-11-10"),
    );

    expect(found.budgets.get("Travel")).toEqual({
      spending: $(3_200),
      projected: null,
      status: "Over Budget",
      shareOfYear: 314 / 365,
    });
    // $300 by Nov 10 on a straight line passes $1,200 by far; a yearly Budget is never On pace.
    expect(found.budgets.get("Gifts and donations")).toMatchObject({
      spending: $(300),
      status: "on track",
    });
    // A past month's share of the year is taken on its last day: Mar 31 is day 90.
    expect(
      (
        await budgetSpending(bank.database, "2026-03", [yearly("Travel", 3_000)], at("2026-11-10"))
      ).budgets.get("Travel"),
    ).toMatchObject({ spending: $(2_000), status: "on track", shareOfYear: 90 / 365 });
    expect(shareOfYear("2026", "2025-12-31")).toBe(0);
    expect(shareOfYear("2026", "2027-01-01")).toBe(1);
    expect(shareOfYear("2028", "2028-12-31")).toBe(1);
  });

  it("leaves a Category with no Budget without a status, and sums each group's monthly Budgets", async () => {
    await load([
      spend("dinner", "2026-11-05", 50, "Restaurants"),
      spend("movie", "2026-11-06", 30, "Entertainment"),
      spend("pet-food", "2026-11-07", 40, "Pets"),
    ]);

    const found = await budgetSpending(
      bank.database,
      "2026-11",
      [monthly("Restaurants", 120), monthly("Entertainment", 100)],
      at("2026-11-10"),
    );

    expect(found.budgets.has("Pets")).toBe(false);
    expect(found.unbudgeted).toEqual([{ category: "Pets", spending: $(40), projected: $(120) }]);
    // Leisure: $80 so far, P = $150 + $90, against $220.
    // Restaurants is On pace at $150 against $120.
    expect(found.groups.get("Leisure")).toEqual({
      spending: $(80),
      projected: $(240),
      overBudget: 0,
      onPace: 1,
      status: "On pace",
    });
    // Pets has no Budget: its Spending and P count in its group, with no status.
    expect(found.groups.get("Health and care")).toEqual({
      spending: $(40),
      projected: $(120),
      overBudget: 0,
      onPace: 0,
      status: "on track",
    });
    expect(found.groups.get("Transportation")).toBeNull();
  });

  it("counts a group's Categories by status, Over Budget winning, with its Categories with no Budget", async () => {
    await load([
      spend("tasting-menu", "2026-11-05", 150, "Restaurants"),
      spend("movie", "2026-11-06", 30, "Entertainment"),
      spend("concert", "2026-11-08", 20, "Entertainment"),
      spend("jeans", "2026-11-03", 40, "Clothing"),
      spend("rake", "2026-11-07", 25, "Home and garden"),
      spend("hotel", "2026-11-04", 400, "Travel"),
    ]);

    const found = await budgetSpending(
      bank.database,
      "2026-11",
      [monthly("Restaurants", 100), monthly("Entertainment", 200), monthly("Clothing", 200)],
      at("2026-11-10"),
    );

    // Restaurants is $50 over and Entertainment $100 under: together $200 of $300 and P = $300,
    // but the box shows 1 over. Travel, with no Budget, stays out.
    expect(found.groups.get("Leisure")).toEqual({
      spending: $(200),
      projected: $(300),
      overBudget: 1,
      onPace: 0,
      status: "Over Budget",
    });
    // Home and garden has no Budget: its $25 counts in Shopping's Spending and P.
    expect(found.groups.get("Shopping")).toEqual({
      spending: $(65),
      projected: $(195),
      overBudget: 0,
      onPace: 0,
      status: "on track",
    });
  });

  it("counts a Large purchase as a one-off, against purchases without the untracked loan payments", async () => {
    const loan = (id: string, date: string): TxnSpec => ({
      ...spend(id, date, 500, "Car"),
      code: "LOAN_PAYMENTS_CAR_PAYMENT",
    });
    await load([
      spend("socks", "2026-08-03", 20, "Clothing"),
      spend("shirt", "2026-09-03", 40, "Clothing"),
      loan("car-aug", "2026-08-05"),
      loan("car-sep", "2026-09-05"),
      loan("car-oct", "2026-10-05"),
      spend("desk", "2026-11-04", 400, "General goods"),
    ]);

    // $400 is under 50% of $1,000, but larger than every purchase before it: P = $400.
    expect(await statuses([monthly("General goods", 1_000)], "2026-11", "2026-11-10")).toEqual({
      "General goods": [400, 400, "on track"],
    });
  });

  it("projects a Merchant's Spending with its Large purchases as its only one-offs", async () => {
    await load([
      spend("books-1", "2026-11-02", 30, "Books and education", "Bluebird Books"),
      spend("books-2", "2026-11-09", 400, "Books and education", "Bluebird Books"),
      spend("other-shop", "2026-11-05", 99, "Books and education", "Other Books"),
    ]);

    // $400 is a Large purchase: P = $400 + $30 × 30 ÷ 10.
    expect(
      await projectMerchant(
        bank.database,
        { id: null, name: "BLUEBIRD BOOKS" },
        "2026-11",
        at("2026-11-10"),
      ),
    ).toEqual({ spending: $(430), projected: $(490) });
  });
});

describe("the Large purchase test", () => {
  const purchase = (day: number, dollars: number, id = `p-${day}-${dollars}`): Purchase => ({
    transactionId: id,
    date: new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10),
    amount: $(dollars),
  });
  // 100 purchases of $100 over the year before Dec 1, 2026.
  const year = Array.from({ length: 100 }, (_, index) => purchase(-30 + index * 3, 100));

  it("needs at least $250", () => {
    expect(isLargePurchase(purchase(335, 249.99), year)).toBe(false);
    expect(isLargePurchase(purchase(335, 250), year)).toBe(true);
  });

  it("needs at least 98% of the purchases in the 365 days before it to be smaller", () => {
    const larger = (count: number) =>
      [...Array.from({ length: count }, (_, index) => purchase(200 + index, 500)), ...year].sort(
        (a, b) => a.date.localeCompare(b.date),
      );
    // 2 of 102 are not smaller: 98.04% are.
    expect(isLargePurchase(purchase(335, 400), larger(2))).toBe(true);
    // 3 of 103: 97.09%.
    expect(isLargePurchase(purchase(335, 400), larger(3))).toBe(false);
    // An equal purchase is not smaller.
    expect(isLargePurchase(purchase(335, 500), larger(3))).toBe(false);
    expect(isLargePurchase(purchase(335, 501), larger(3))).toBe(true);
    // A larger purchase more than 365 days before does not count.
    const old = [purchase(-60, 900), purchase(-50, 900), purchase(-40, 900), ...year];
    expect(isLargePurchase(purchase(335, 400), old)).toBe(true);
    // A purchase after it does not count either.
    expect(isLargePurchase(purchase(1, 400), larger(3))).toBe(true);
  });

  it("leaves out Recurring charges, loan payments, the Bills group and Transfers", () => {
    const part = (
      transactionId: string,
      type: NewPart["type"],
      amount: number,
      category: Category | null,
    ) => ({
      transactionId,
      type,
      amount,
      category,
      linked: false,
      postedDate: "2026-11-02",
      authorizedDate: null,
      spendingTransactionId: null,
    });

    expect(
      purchasesFrom(
        [
          part("shop", "Spending", -$(80), "Clothing"),
          part("split", "Spending", -$(50), "Groceries"),
          part("split", "Spending", -$(70), "Utilities"),
          part("rent", "Spending", -$(1_800), "Housing"),
          part("netflix", "Spending", -$(15), "Entertainment"),
          part("loan", "Spending", -$(300), "Miscellaneous"),
          part("savings", "Transfer", -$(500), null),
          part("refund", "Refund", $(20), "Clothing"),
        ],
        (id) => id === "netflix" || id === "loan",
      ),
    ).toEqual([
      { transactionId: "shop", date: "2026-11-02", amount: $(80) },
      { transactionId: "split", date: "2026-11-02", amount: $(50) },
    ]);
  });
});

describe("P", () => {
  it("extrapolates F unless told not to", () => {
    const terms = { rPosted: $(50), rDue: $(15), oneOffs: $(100), rest: $(20) };

    expect(projectedSpending(terms, 10, 30, true)).toBe($(225));
    expect(projectedSpending(terms, 10, 30, false)).toBe($(185));
  });
});
