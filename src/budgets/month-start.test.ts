import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import type { Category } from "../categories/index.ts";
import {
  addManualLoan,
  listOpenNotices,
  type NewPart,
  replaceRecurringCharges,
  storeDecisions,
  storeOtherLink,
} from "../db/index.ts";
import { typeSteadyIncome } from "../recurring/index.ts";
import {
  acceptDraft,
  budgetsForMonth,
  draftFirstBudgets,
  editBudget,
  followBills,
  followTheBill,
  MONTH_START_CAP,
  MONTH_START_STOPPED,
  runMonthStart,
} from "./index.ts";

// The month's Budgets after the first draft (spec 05, When the app drafts; Bills group; Yearly
// Budgets; Stored Budgets; Changing Budgets): the Month start job on the 1st, the Bills Budgets
// step as Transactions post, and a Member's edits. The clock is set by hand: the Household time
// zone is unset, so Household time is UTC.

const BANK = "fake-month-start-bank";
const MEMBER = "member-1";
const CHECKING = fakeAccount({ id: "acc-checking" });

const $ = (dollars: number) => dollars * 100;
const at = (date: string) => new Date(`${date}T00:10:00.000Z`);

type TxnSpec = { id: string; date: string; parts: [NewPart["type"], number, Category | null][] };

const spend = (id: string, date: string, dollars: number, category: Category): TxnSpec => ({
  id,
  date,
  parts: [["Spending", -$(dollars), category]],
});

// A Larkspur payment: its interest is Spending in Interest and fees.
const loanPayment = (id: string, date: string, interest: number): TxnSpec => ({
  id,
  date,
  parts: [
    ["Spending", -$(interest), "Interest and fees"],
    ["Transfer", -$(500 - interest), null],
  ],
});

// Monthly dates on `day` from `first` (YYYY-MM), `count` of them.
const monthly = (first: string, count: number, day: string) =>
  Array.from({ length: count }, (_, index) => {
    const date = new Date(`${first}-01T00:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + index);
    return `${date.toISOString().slice(0, 7)}-${day}`;
  });

describe("the month's Budgets", () => {
  let bank: TestBank;
  let connectionId: string;
  let accountId: string;
  let loanId: string;
  const ids = new Map<string, string>();

  const load = async (txns: TxnSpec[], now: Date) => {
    bank.fake.addPages(BANK, {
      accounts: [CHECKING],
      added: txns.map((txn) =>
        fakeTxn({
          id: txn.id,
          accountId: CHECKING.id,
          amount: txn.parts.reduce((sum, [, amount]) => sum + amount, 0),
          postedDate: txn.date,
        }),
      ),
    });
    await syncConnection(connectionId, () => now);
    const rows = await bank.database.$client.execute(
      "SELECT id, provider_transaction_id, account_id FROM transactions",
    );
    for (const row of rows.rows) {
      ids.set(String(row.provider_transaction_id), String(row.id));
      accountId = String(row.account_id);
    }
    await storeDecisions(
      bank.database,
      txns.map((txn) => ({
        transactionId: ids.get(txn.id) ?? "",
        step: "5.7",
        provisionalUntil: null,
        decidedAt: now,
        parts: txn.parts.map(([type, amount, category]) => ({ type, amount, category })),
      })),
    );
  };

  const linkToLoan = async (provider: string, now: Date) =>
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
        createdAt: now,
      },
    );

  // The electric bill on the 1st and the internet bill on the 30th, as the Recurring charge checks
  // would store them. Each paid entry is [date, dollars].
  const setCharges = async (
    electric: [string, number][],
    internet: [string, number][],
    now: Date,
  ) => {
    const charge = (name: string, category: Category, paid: [string, number][]) => ({
      id: `charge-${name}`,
      merchantId: null,
      merchantName: name,
      category,
      schedule: "monthly" as const,
      nextExpectedDate: monthly(paid.at(-1)?.[0].slice(0, 7) ?? "2026-01", 2, "01")[1] ?? "",
      latestAmount: $(paid.at(-1)?.[1] ?? 0),
      priceHistory: paid.map(([date, dollars]) => ({
        transactionId: `${name}-${date}`,
        date,
        amount: $(dollars),
      })),
      accountId,
      status: "active" as const,
      foundAt: now,
      endedAt: null,
      endedBy: null,
    });
    await replaceRecurringCharges(bank.database, [
      charge("electric", "Utilities", electric),
      charge("internet", "Phone and internet", internet),
    ]);
  };
  const electricTo = (last: string) =>
    monthly("2026-06", 6, "01")
      .filter((date) => date <= last)
      .map((date): [string, number] => [date, 120]);
  const internetTo = (last: string) =>
    monthly("2026-06", 6, "30")
      .filter((date) => date <= last)
      .map((date): [string, number] => [date, 70]);

  // Each Category's Budget for a month as "amount source pinned", in dollars.
  const budgets = async (month: string) =>
    Object.fromEntries(
      (await budgetsForMonth(bank.database, month)).budgets.map((budget) => [
        budget.category,
        `${budget.amount / 100} ${budget.source}${budget.pinned === true ? " pinned" : ""}`,
      ]),
    );

  beforeEach(async () => {
    const now = new Date("2026-11-04T14:00:00.000Z");
    ids.clear();
    bank = await newTestBank();
    connectionId = await bank.connect(BANK);
    await bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('${MEMBER}', 'Jamie', 'jamie@example.com', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    );
    // History starts on Jun 1, so November's window is June to October, n = 5.
    await load(
      [
        spend("start", "2026-06-01", 1, "Gifts and donations"),
        spend("odds", "2026-07-02", 250, "Miscellaneous"),
        spend("flight", "2026-07-20", 1_200, "Travel"),
        loanPayment("larkspur-0", "2026-09-15", 102),
        loanPayment("larkspur-1", "2026-10-15", 100),
      ],
      now,
    );
    loanId = await addManualLoan(
      bank.database,
      {
        lender: "Larkspur",
        subtype: "personal",
        apr: 8,
        regularPayment: $(500),
        escrow: null,
        loanType: null,
      },
      { date: "2026-08-01", balance: -$(20_000), typedAt: now, typedBy: MEMBER },
    );
    await linkToLoan("larkspur-0", now);
    await linkToLoan("larkspur-1", now);
    // Electric paid Nov 1; internet expected Nov 30.
    await setCharges(electricTo("2026-11-01"), internetTo("2026-10-30"), now);
    await typeSteadyIncome(bank.database, $(6_000), MEMBER);
    expect(await draftFirstBudgets(bank.database, now)).toBe(true);
  });

  afterEach(() => {
    bank.close();
  });

  const november = {
    Utilities: "120 formula",
    "Phone and internet": "70 formula",
    "Interest and fees": "100 formula",
    // Each flexible Budget is its average × 1.10: Travel $240 × 1.10 × 12, Gifts and donations
    // $0.20 × 1.10 × 12, and Miscellaneous $50 × 1.10.
    Travel: "3168 formula",
    "Gifts and donations": "3 formula",
    Miscellaneous: "55 formula",
  };

  it("sets each Bills Budget on the 1st, and gives a newly qualified Category its first Budget", async () => {
    expect(await budgets("2026-11")).toEqual(november);
    // The first draft did November's work.
    expect(await runMonthStart(bank.database, at("2026-11-20"))).toBe("not due");
    // Payments to people qualifies once November is in the window. The step adds no first Budget.
    await load([spend("sitter", "2026-11-08", 90, "Payments to people")], at("2026-11-09"));
    await followBills(bank.database, at("2026-11-09"));
    expect(await budgets("2026-11")).toEqual(november);

    expect(await runMonthStart(bank.database, at("2026-12-01"))).toBe("done");

    expect(await budgets("2026-12")).toEqual({
      Utilities: "120 formula",
      // Internet's Nov 30 bill is late, still within its margin: it moves into December, beside
      // December's own.
      "Phone and internet": "140 formula",
      // Larkspur's Nov 15 payment did not post, so none is expected in December.
      "Interest and fees": "0 formula",
      // $90 ÷ 6 × 1.10.
      "Payments to people": "17 formula",
      // Flexible Budgets change only by a Member's edit or a Proposal: Miscellaneous's formula now
      // gives $46, and stays $55.
      Miscellaneous: "55 formula",
      Travel: "3168 formula",
      "Gifts and donations": "3 formula",
    });
    // A past month keeps its Budget.
    expect(await budgets("2026-11")).toEqual(november);
    expect(await runMonthStart(bank.database, at("2026-12-02"))).toBe("not due");
    const rows = await bank.database.$client.execute(
      "SELECT count(*) AS n FROM budgets WHERE takes_effect = '2026-12'",
    );
    expect(Number(rows.rows[0]?.n)).toBe(4);
  });

  it("keeps the late bill's known amount when it posts, and a new amount waits for the next month", async () => {
    await runMonthStart(bank.database, at("2026-12-01"));
    // The late internet bill posts Dec 1. Electric posts Dec 1 at $130.
    await setCharges(
      [...electricTo("2026-11-01"), ["2026-12-01", 130]],
      [...internetTo("2026-10-30"), ["2026-12-01", 70]],
      at("2026-12-02"),
    );

    await followBills(bank.database, at("2026-12-02"));

    expect(await budgets("2026-12")).toMatchObject({
      Utilities: "120 formula",
      "Phone and internet": "140 formula",
    });
    await runMonthStart(bank.database, at("2027-01-01"));
    expect(await budgets("2027-01")).toMatchObject({
      Utilities: "130 formula",
      // Internet's fixed day is the 30th, so the late Dec 1 bill does not move it (spec 06, Monthly
      // series). Its Dec 30 bill has not posted by Jan 1 and can still post within its margin, so
      // January counts it beside its own Jan 30 bill.
      "Phone and internet": "140 formula",
    });
  });

  it("moves an early bill's known amount into the month it posted in", async () => {
    await runMonthStart(bank.database, at("2026-12-01"));
    // Electric's Jan 1 bill posts Dec 30, within its margin.
    await setCharges(
      [...electricTo("2026-11-01"), ["2026-12-01", 120], ["2026-12-30", 120]],
      internetTo("2026-10-30"),
      at("2026-12-31"),
    );

    await followBills(bank.database, at("2026-12-31"));

    expect((await budgets("2026-12")).Utilities).toBe("240 formula");
    await runMonthStart(bank.database, at("2027-01-01"));
    // The Dec 30 bill met Jan 1, so January expects none: the next is Feb 1 (spec 06, Monthly
    // series).
    expect((await budgets("2027-01")).Utilities).toBe("0 formula");
  });

  it("replaces a loan payment's expected interest with its actual interest when it posts: $100 to $98", async () => {
    expect((await budgets("2026-11"))["Interest and fees"]).toBe("100 formula");

    await load([loanPayment("larkspur-2", "2026-11-15", 98)], at("2026-11-16"));
    await linkToLoan("larkspur-2", at("2026-11-16"));
    await followBills(bank.database, at("2026-11-16"));

    expect((await budgets("2026-11"))["Interest and fees"]).toBe("98 formula");
    await runMonthStart(bank.database, at("2026-12-01"));
    expect((await budgets("2026-12"))["Interest and fees"]).toBe("98 formula");
  });

  it("pins an edited Bills Budget each month until Follow the bill puts it back on the formula from the next month", async () => {
    expect(
      await editBudget(
        bank.database,
        { category: "Utilities", amount: $(200), memberId: MEMBER },
        at("2026-11-10"),
      ),
    ).toMatchObject({
      category: "Utilities",
      categoryGroup: "Bills",
      amount: $(200),
      takesEffect: "2026-11",
      source: "Member edit",
      setBy: MEMBER,
      pinned: true,
    });
    // The step leaves a Bills Budget a Member set this month, and the 1st leaves a pinned one.
    await setCharges(
      [...electricTo("2026-11-01"), ["2026-11-30", 120]],
      internetTo("2026-10-30"),
      at("2026-11-30"),
    );
    await followBills(bank.database, at("2026-11-30"));
    expect((await budgets("2026-11")).Utilities).toBe("200 Member edit pinned");
    await runMonthStart(bank.database, at("2026-12-01"));
    expect((await budgets("2026-12")).Utilities).toBe("200 Member edit pinned");

    expect(
      await followTheBill(
        bank.database,
        { category: "Utilities", memberId: MEMBER },
        at("2026-12-05"),
      ),
    ).toMatchObject({ amount: $(200), takesEffect: "2026-12", pinned: false });
    await followBills(bank.database, at("2026-12-06"));
    expect((await budgets("2026-12")).Utilities).toBe("200 Member edit");

    // December's bill posted early on Nov 30, so January's Jan 1 bill is next.
    await setCharges(
      [...electricTo("2026-11-01"), ["2026-11-30", 120]],
      internetTo("2026-10-30"),
      at("2026-12-31"),
    );
    await runMonthStart(bank.database, at("2027-01-01"));
    expect((await budgets("2027-01")).Utilities).toBe("120 formula");
    expect((await budgets("2026-12")).Utilities).toBe("200 Member edit");
  });

  it("follows the bill only for a pinned Bills Budget, and edits only a Budget that exists", async () => {
    const before = await bank.database.$client.execute("SELECT * FROM budgets");
    const follow = (category: string) =>
      followTheBill(bank.database, { category, memberId: MEMBER }, at("2026-11-10"));

    expect(await follow("Utilities")).toBe("not pinned");
    expect(await follow("Miscellaneous")).toBe("not pinned");
    expect(await follow("Pets")).toBe("no Budget");
    expect(await follow("Not a Category")).toBe("no Budget");
    for (const category of ["Pets", "Not a Category"]) {
      expect(
        await editBudget(
          bank.database,
          { category, amount: $(10), memberId: MEMBER },
          at("2026-11-10"),
        ),
      ).toBeUndefined();
    }

    expect((await bank.database.$client.execute("SELECT * FROM budgets")).rows).toEqual(
      before.rows,
    );
  });

  it("applies a yearly edit to the whole current year, and keeps it on January 1", async () => {
    await editBudget(
      bank.database,
      { category: "Travel", amount: $(2_000), memberId: MEMBER },
      at("2026-11-10"),
    );

    expect((await budgetsForMonth(bank.database, "2026-11")).budgets).toContainEqual(
      expect.objectContaining({ category: "Travel", amount: $(2_000), takesEffect: "2026" }),
    );
    expect((await budgets("2026-12")).Travel).toBe("2000 Member edit");
    await runMonthStart(bank.database, at("2027-01-01"));
    expect((await budgets("2027-01")).Travel).toBe("2000 Member edit");
  });

  it("keeps a past month's Budget when a later edit changes it", async () => {
    await runMonthStart(bank.database, at("2026-12-01"));

    await editBudget(
      bank.database,
      { category: "Miscellaneous", amount: $(80), memberId: MEMBER },
      at("2026-12-10"),
    );

    expect((await budgets("2026-11")).Miscellaneous).toBe("55 formula");
    expect((await budgets("2026-12")).Miscellaneous).toBe("80 Member edit");
    expect((await budgets("2027-02")).Miscellaneous).toBe("80 Member edit");
    // A flexible Budget has no pinned flag.
    const misc = (await budgetsForMonth(bank.database, "2026-12")).budgets.find(
      (budget) => budget.category === "Miscellaneous",
    );
    expect(misc?.pinned).toBeNull();
  });

  it("accepts the whole draft once; a later Accept all changes nothing", async () => {
    expect((await budgetsForMonth(bank.database, "2026-11")).draftAccepted).toBe(false);

    const first = await acceptDraft(bank.database, MEMBER, at("2026-11-05"));
    const again = await acceptDraft(bank.database, MEMBER, at("2026-11-06"));

    expect(first).toEqual({ acceptedAt: at("2026-11-05"), acceptedBy: MEMBER });
    expect(again).toEqual(first);
    expect((await budgetsForMonth(bank.database, "2026-11")).draftAccepted).toBe(true);
    expect(await budgets("2026-11")).toEqual(november);
  });

  it("stops a month's Month start at its cap with one System notice, and the next month's success ends it", async () => {
    // A stored row the reads cannot parse makes every run throw.
    await bank.database.$client.execute("UPDATE recurring_charges SET price_history = 'broken'");

    const results: string[] = [];
    for (const day of ["01", "02", "03", "04", "05"]) {
      results.push(await runMonthStart(bank.database, at(`2026-12-${day}`)));
    }

    expect(MONTH_START_CAP).toBe(3);
    expect(results).toEqual(["failed", "failed", "stopped", "stopped", "stopped"]);
    const tries = await bank.database.$client.execute(
      "SELECT failed_tries FROM budget_month_starts WHERE month = '2026-12'",
    );
    expect(tries.rows[0]?.failed_tries).toBe(MONTH_START_CAP);
    const open = await listOpenNotices(bank.database);
    expect(open.filter((notice) => notice.condition === MONTH_START_STOPPED)).toHaveLength(1);
    // December keeps November's Budgets, even once the fault passes and a sync's Bills Budgets
    // step runs.
    await setCharges(electricTo("2026-12-01"), internetTo("2026-11-30"), at("2026-12-06"));
    await followBills(bank.database, at("2026-12-06"));
    expect(await budgets("2026-12")).toEqual(november);
    const december = await bank.database.$client.execute(
      "SELECT count(*) AS n FROM budgets WHERE takes_effect = '2026-12'",
    );
    expect(Number(december.rows[0]?.n)).toBe(0);

    await setCharges(electricTo("2026-12-01"), internetTo("2026-12-30"), at("2027-01-01"));
    expect(await runMonthStart(bank.database, at("2027-01-01"))).toBe("done");
    expect(
      (await listOpenNotices(bank.database)).filter(
        (notice) => notice.condition === MONTH_START_STOPPED,
      ),
    ).toHaveLength(0);
  });
});
