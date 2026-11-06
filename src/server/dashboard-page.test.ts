import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import { seedDemoHousehold } from "../bank/demo.ts";
import { FakeBankAdapter, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { startBank, syncConnection } from "../bank/index.ts";
import { draftFirstBudgets, YEARLY_CATEGORIES } from "../budgets/index.ts";
import { CATEGORY_GROUPS, type Category } from "../categories/index.ts";
import { startCategorization } from "../categorization/index.ts";
import {
  addConnection,
  listDailyBalances,
  listPostedDayTotals,
  markSetupStep,
} from "../db/index.ts";
import { runFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import { percent, wholeDollars } from "../format.ts";
import { saveHouseholdFacts } from "../household/index.ts";
import { createLogger } from "../log.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import {
  type DashboardData,
  directionOf,
  groupBars,
  groupBudgetRows,
  groupStatus,
  headerLine,
  leftText,
  leftToSpend,
  loadDashboard,
  meterLine,
  numberTiles,
  paceLine,
  projectedSpending,
  rowNote,
  usualMonthLine,
  yearlyLine,
} from "../web/dashboard.ts";
import { transactionRequests } from "../web/transactions.ts";
import { createApp } from "./app.ts";
import type { AccountView, TransactionListView } from "./bank-views.ts";
import type { MonthTotalsView } from "./money-movement-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { TestBrowser } from "./testing.ts";

// End to end on the demo household (spec 07, Header and status lines; 2. Left to spend; 4. Number
// tiles; 5. "A usual month"): the dashboard's own requests, sent through the app's HTTP interface
// on Oct 20, 2026, and the words the dashboard draws from their answers. The demo history has no
// Travel or Gifts and donations Spending, so a few of its Transactions get those Categories by
// hand.

const APP_URL = "http://nas.local:8080";
// Noon in New York, the demo Household's time zone. Its history runs to Oct 31.
const NOW = new Date("2026-10-20T16:00:00.000Z");

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-dashboard-page-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the dashboard on the demo household", () => {
  let test: TestAuth;
  let browser: TestBrowser;
  let member: TestMember;
  let app: ReturnType<typeof createApp>;
  let fake: FakeBankAdapter;
  let stops: (() => void)[] = [];

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const quiet = createLogger(() => {}, { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, quiet);
    app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger: quiet }),
      test.auth,
      test.database,
      test.secrets,
    );
    fake = new FakeBankAdapter();
    stops = [
      startBank({ database: test.database, secrets: test.secrets, adapters: [fake] }).stop,
      startFollowUpPipeline({ database: test.database, startJob: () => runFollowUp() }).stop,
      startMoneyMovement({ database: test.database }).stop,
      startCategorization({ database: test.database }).stop,
    ];
    member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    await saveHouseholdFacts(
      test.database,
      { zipCode: "10001", ages: [40, 38, 7], rentOrOwn: "rent" },
      member.id,
    );
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);
    await seedDemoHousehold(test.database, fake);
    await runFollowUp();

    // The page's requests go to the app as the signed-in browser.
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), APP_URL);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      return browser.send(init?.method ?? "GET", `${url.pathname}${url.search}`, body);
    });
  });

  afterEach(() => {
    for (const stop of stops) stop();
    stops = [];
    test.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // Gives one General goods Transaction in `month` the Category by hand, only that one.
  async function setCategoryIn(month: string, category: string) {
    const { transactions } = (await (
      await transactionRequests.list({ month, category: "General goods", type: "Spending" })
    ).json()) as TransactionListView;
    const row = transactions.find((txn) => txn.parts.length === 1);
    if (row === undefined) throw new Error(`No demo General goods Transaction in ${month}.`);
    expect((await transactionRequests.setCategory(row.id, category, true)).status).toBe(200);
  }

  // Travel and Gifts and donations Spending before and in October, and October Spending in
  // Hobbies, which has no Budget. Then the first draft.
  async function draft() {
    await setCategoryIn("2026-07", "Gifts and donations");
    await setCategoryIn("2026-08", "Travel");
    await setCategoryIn("2026-10", "Travel");
    await setCategoryIn("2026-10", "Hobbies");
    await draftFirstBudgets(test.database);
  }

  const setBudget = async (category: string, amount: number) =>
    expect(
      (await browser.send("PUT", `/api/budgets/${encodeURIComponent(category)}`, { amount }))
        .status,
    ).toBe(200);

  const drafted = (data: DashboardData) => {
    const left = leftToSpend(data.budgets);
    if (!left.drafted) throw new Error("The first draft has not run.");
    return left;
  };

  it("answers 401 with no session on the dashboard's own routes", async () => {
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");
    for (const path of ["/api/number-tiles", "/api/usual-month?month=2026-10"]) {
      const answer = await signedOut.get(path);
      expect(answer.status, path).toBe(401);
      expect(await answer.text(), path).not.toContain("amount");
    }
  });

  it("names the month and the last sync, and has no Left to spend before the first draft", async () => {
    const data = await loadDashboard();

    expect(data.month).toMatchObject({ month: "2026-10", name: "October", day: 20, days: 31 });
    // The demo banks synced at noon, Household time.
    expect(headerLine(data.month, data.connections, data.timeZone)).toBe(
      "Day 20 of 31 · synced 12:00 PM",
    );
    expect(leftToSpend(data.budgets)).toEqual({ drafted: false });
  });

  it('lists the skipped wizard steps under "Finish setup" until each is done', async () => {
    const before = (await loadDashboard()).setup;
    expect(before.finishSetup).toEqual([]);
    expect(before.connections).toBe((await loadDashboard()).connections.length);

    for (const step of ["ai", "invite%20members"]) {
      expect((await browser.send("POST", `/api/setup/steps/${step}/skip`, {})).status).toBe(200);
    }
    // The demo banks made step 5 done.
    expect((await loadDashboard()).setup).toMatchObject({
      steps: { banks: "done", ai: "skipped", alerts: null, "invite members": "skipped" },
      finishSetup: ["ai", "invite members"],
    });
    expect(
      (await browser.send("POST", "/api/invites", { code: member.backupCodes[0] })).status,
    ).toBe(200);
    expect((await loadDashboard()).setup.finishSetup).toEqual(["ai"]);
  });

  it("counts every monthly Budget against the month's Spending, Travel and Gifts and donations left out", async () => {
    await draft();
    const data = await loadDashboard();
    // The month's Spending by Category, from the Totals.
    const totals = (await (await browser.get("/api/totals")).json()) as {
      months: MonthTotalsView[];
    };
    const october = totals.months.find((each) => each.month === "2026-10")?.byCategory ?? {};
    const monthly = data.budgets.budgets.filter((each) => each.period === "monthly");
    const budgeted = new Set(monthly.map((each) => each.category));
    const counted = Object.entries(october).filter(
      ([category, spent]) =>
        !YEARLY_CATEGORIES.includes(category as Category) && (budgeted.has(category) || spent > 0),
    );
    expect(budgeted.has("Hobbies")).toBe(false);
    expect(october.Hobbies).toBeGreaterThan(0);
    expect(october.Travel).toBeGreaterThan(0);
    const budget = monthly.reduce((sum, each) => sum + each.amount, 0);
    const spent = counted.reduce((sum, [, amount]) => sum + amount, 0);

    const left = drafted(data);

    expect(left).toMatchObject({ budget, spending: spent, left: budget - spent });
    expect(meterLine(left.spending, left.budget, data.month)).toBe(
      `${wholeDollars(spent)} of ${wholeDollars(budget)} · 11 days to go`,
    );
    // The projection adds each Category's: from day 1, it is at least the month's Spending.
    expect(left.projected).not.toBeNull();
    expect(left.projected ?? 0).toBeGreaterThanOrEqual(spent);
  });

  it("shows the under state, then the over state with the pace line", async () => {
    await draft();
    const first = await loadDashboard();
    const housing = first.budgets.budgets.find((each) => each.category === "Housing")?.amount ?? 0;
    await setBudget("Housing", 10_000_000);

    // The Housing Budget's rise all goes to Left to spend.
    const under = drafted(await loadDashboard());
    expect(under.left).toBe(drafted(first).left + 10_000_000 - housing);
    expect(leftText(under.left)).toEqual({ text: wholeDollars(under.left), over: false });
    expect(paceLine(under.budget, under.projected ?? 0)).toEqual({
      tone: "good",
      text: `On pace to end ${wholeDollars(under.budget - (under.projected ?? 0))} under Budget`,
    });

    // Every monthly Budget at $1: the month is over Budget.
    const data = await loadDashboard();
    for (const each of data.budgets.budgets.filter((budget) => budget.period === "monthly")) {
      await setBudget(each.category, 100);
    }
    const over = drafted(await loadDashboard());
    expect(over.left).toBeLessThan(0);
    expect(leftText(over.left)).toEqual({ text: `${wholeDollars(-over.left)} over`, over: true });
    expect(paceLine(over.budget, over.projected ?? 0)).toEqual({
      tone: "serious",
      text: `On pace to end ${wholeDollars((over.projected ?? 0) - over.budget)} over Budget`,
    });
  });

  it("shows one row each for Travel and Gifts and donations, with Over Budget as its only status", async () => {
    await draft();
    // Oct 20 is day 293 of 365.
    const gone = percent(293 / 365);

    const before = drafted(await loadDashboard()).yearly;
    expect(before.map((row) => row.category)).toEqual(["Travel", "Gifts and donations"]);
    for (const row of before) {
      expect(yearlyLine(row)).toBe(
        `${wholeDollars(row.spending)} of ${wholeDollars(row.amount)} · ${gone} of the year gone`,
      );
    }
    // A yearly row is Over Budget only once the year's Spending passes its Budget.
    await setBudget("Travel", 100_000_00);
    const roomy = drafted(await loadDashboard()).yearly.find((row) => row.category === "Travel");
    expect(roomy).toMatchObject({ amount: 100_000_00, overBudget: false });

    await setBudget("Travel", 100);
    const after = drafted(await loadDashboard()).yearly.find((row) => row.category === "Travel");
    if (after === undefined) throw new Error("Travel has no yearly Budget.");
    expect(after).toMatchObject({ amount: 100, overBudget: true });
    expect(yearlyLine(after)).toBe(
      `${wholeDollars(after.spending)} of $1 · ${gone} of the year gone`,
    );
  });

  // --- 4. Number tiles -------------------------------------------------------------------------

  // The 12 complete months before October, and their median, worked out apart from the app.
  const YEAR = [
    "2025-10",
    "2025-11",
    "2025-12",
    "2026-01",
    "2026-02",
    "2026-03",
    "2026-04",
    "2026-05",
    "2026-06",
    "2026-07",
    "2026-08",
    "2026-09",
  ];
  const middle = (amounts: number[]) => {
    const sorted = [...amounts].sort((a, b) => a - b);
    return Math.round(((sorted[5] ?? 0) + (sorted[6] ?? 0)) / 2);
  };

  const totals = async () =>
    ((await (await browser.get("/api/totals")).json()) as { months: MonthTotalsView[] }).months;
  const accounts = async () =>
    ((await (await browser.get("/api/accounts")).json()) as { accounts: AccountView[] }).accounts;

  // A synced Account's balance at the end of `day`, worked out by hand from app.db (spec 02,
  // Balance history): its last saved balance on or before that day, or else its first saved balance
  // with each posted Transaction after that day, up to the first saved day, undone. With no
  // Transaction to undo, the first saved balance holds.
  async function balanceAt(accountId: string, day: string): Promise<number> {
    const saved = await listDailyBalances(test.database, accountId);
    const known = saved.filter((row) => row.date <= day).at(-1);
    if (known !== undefined) return known.currentBalance ?? 0;
    const first = saved[0];
    if (first === undefined) throw new Error("The Account has no saved balance.");
    const undone = (await listPostedDayTotals(test.database, accountId, first.date))
      .filter((each) => each.date > day)
      .reduce((sum, each) => sum + each.total, 0);
    return (first.currentBalance ?? 0) - undone;
  }

  const lastDayOf = (month: string) => {
    const [year = 0, number = 0] = month.split("-").map(Number);
    return new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10);
  };

  // Cash on hand or Debt worked out by hand: today's current balances from the Account list, and
  // the sum of each Account's balance at each of the 12 month-ends. The demo history starts in May
  // 2025, so every Account counts at every month-end.
  async function balanceTile(ids: readonly string[], owed: boolean) {
    const flip = (cents: number) => (owed ? 0 - cents : cents);
    const listed = (await accounts()).filter((account) => ids.includes(account.id));
    const monthEnds: { at: string; amount: number }[] = [];
    for (const month of YEAR) {
      let sum = 0;
      for (const id of ids) sum += await balanceAt(id, lastDayOf(month));
      monthEnds.push({ at: month, amount: flip(sum) });
    }
    const amount = flip(listed.reduce((sum, account) => sum + (account.currentBalance ?? 0), 0));
    return {
      amount,
      usual: middle(monthEnds.map((point) => point.amount)),
      trend: [...monthEnds.filter((point) => point.at >= "2025-11"), { at: "2026-10-20", amount }],
    };
  }

  it("shows September's Spending and Income against the median of the 12 complete months", async () => {
    const { numberTiles: view } = await loadDashboard();
    const months = (await totals()).filter((each) => YEAR.includes(each.month));
    expect(months.map((each) => each.month)).toEqual(YEAR);
    const september = months.at(-1);

    expect(view.lastMonth).toBe("2026-09");
    expect(view.spending).toEqual({
      amount: september?.spending,
      usual: middle(months.map((each) => each.spending)),
      trend: months.map((each) => ({ at: each.month, amount: each.spending })),
    });
    expect(view.income).toEqual({
      amount: september?.income,
      usual: middle(months.map((each) => each.income)),
      trend: months.map((each) => ({ at: each.month, amount: each.income })),
    });
    expect(view.spending.amount).toBeGreaterThan(0);
    expect(view.income.amount).toBeGreaterThan(0);
    expect(numberTiles(view).map(({ label, moreIs, to }) => ({ label, moreIs, to }))).toEqual([
      { label: "Spending in September", moreIs: "bad", to: "/top-merchants" },
      {
        label: "Income in September",
        moreIs: "good",
        to: "/transactions?type=Income&month=2026-09",
      },
      { label: "Cash on hand", moreIs: "good", to: "/accounts" },
      { label: "Debt", moreIs: "bad", to: "/accounts" },
    ]);
  });

  it("counts today's checking and savings in Cash on hand, and cards and loans in Debt, but no Excluded, Closed, or Unconnected account", async () => {
    // An Unconnected savings account with a typed balance is not in Cash on hand.
    const unconnected = await browser.post("/api/unconnected-accounts", {
      name: "Credit union savings",
      kind: "savings",
      institutionName: "",
      mask: "",
      balance: 500_000,
    });
    expect(unconnected.status).toBe(200);
    const listed = await accounts();
    const idsOf = (kinds: string[]) =>
      listed
        .filter((account) => kinds.includes(account.kind) && account.connectionId !== null)
        .map((account) => account.id);
    const cash = idsOf(["depository"]);
    const debts = idsOf(["credit", "loan"]);
    expect(cash).toHaveLength(2);
    expect(debts).toHaveLength(4);

    const first = (await loadDashboard()).numberTiles;
    expect(first.cashOnHand).toEqual(await balanceTile(cash, false));
    expect(first.debt).toEqual({ ...(await balanceTile(debts, true)), estimatedLoans: 0 });
    expect(first.cashOnHand.amount).toBeGreaterThan(0);
    expect(first.debt.amount).toBeGreaterThan(0);
    expect(first.cashOnHand.trend).toHaveLength(12);
    expect(first.debt.trend.at(-1)).toEqual({ at: "2026-10-20", amount: first.debt.amount });
    // The demo Personal Loan has no Transactions, so its one saved balance counts at every
    // month-end, and the Debt is a little above usual, not by the whole loan.
    expect(directionOf(first.debt.amount, first.debt.usual, "bad")).toEqual({
      tone: "serious",
      text: "▲ $566 above usual",
    });

    // An excluded card and a Closed savings Account drop out of every balance, then and now.
    const [checking, savings] = cash;
    const card = listed.find((account) => account.name === "Chase Card")?.id ?? "";
    expect(
      (await browser.send("PUT", `/api/accounts/${card}/exclude`, { excluded: true })).status,
    ).toBe(200);
    expect((await browser.post(`/api/accounts/${savings}/close`)).status).toBe(200);
    const after = (await loadDashboard()).numberTiles;

    expect(after.cashOnHand).toEqual(await balanceTile([checking ?? ""], false));
    expect(after.debt).toEqual({
      ...(await balanceTile(
        debts.filter((id) => id !== card),
        true,
      )),
      estimatedLoans: 0,
    });
    expect(after.cashOnHand.amount).toBeLessThan(first.cashOnHand.amount);
    expect(after.debt.amount).toBeLessThan(first.debt.amount);
  });

  it("counts an Account at month-ends before its first balance, with that day's Transactions undone", async () => {
    const before = (await loadDashboard()).numberTiles;

    // A savings Account at a new bank whose history starts on Mar 15 with an $800 deposit, then a
    // $200 deposit on Jun 10: $1,000 today. Worked back by hand: $0 at each month-end before
    // March, $800 at the ends of March to May, and $1,000 from June on.
    fake.addPages("lakeside-bank", {
      accounts: [
        fakeAccount({
          id: "lakeside-savings",
          name: "Lakeside Savings",
          subtype: "savings",
          mask: "4321",
          currentBalance: 100_000,
          availableBalance: 100_000,
        }),
      ],
      added: [
        fakeTxn({
          id: "lakeside-1",
          accountId: "lakeside-savings",
          amount: 80_000,
          postedDate: "2026-03-15",
          description: "DEPOSIT",
        }),
        fakeTxn({
          id: "lakeside-2",
          accountId: "lakeside-savings",
          amount: 20_000,
          postedDate: "2026-06-10",
          description: "DEPOSIT",
        }),
      ],
      historyLoaded: true,
    });
    const connectionId = await addConnection(test.database, {
      provider: "fake",
      bankId: "lakeside-bank",
      bankName: "Lakeside Bank",
      origin: "linked",
      syncMinute: 17,
    });
    await syncConnection(connectionId);
    await runFollowUp();
    const after = (await loadDashboard()).numberTiles;

    const added = (month: string) => (month < "2026-03" ? 0 : month < "2026-06" ? 80_000 : 100_000);
    expect(
      after.cashOnHand.trend.map((point, index) => ({
        at: point.at,
        added: point.amount - (before.cashOnHand.trend[index]?.amount ?? 0),
      })),
    ).toEqual([
      ...YEAR.slice(1).map((month) => ({ at: month, added: added(month) })),
      { at: "2026-10-20", added: 100_000 },
    ]);
    // The usual too, with Oct 2025, which is not on the trend line, worked out by hand.
    const cash = (await accounts())
      .filter((account) => account.kind === "depository" && account.connectionId !== null)
      .map((account) => account.id);
    expect(cash).toHaveLength(3);
    expect(after.cashOnHand).toEqual(await balanceTile(cash, false));
  });

  it("counts each Manual loan in Debt and says how many estimated loans the Debt includes", async () => {
    const before = (await loadDashboard()).numberTiles;
    expect(numberTiles(before).find((tile) => tile.key === "debt")?.note).toBeUndefined();

    // A loan typed today, with today's balance.
    const loan = {
      lender: "Lakeside Auto",
      kind: "car",
      balance: 1_000_000,
      balanceDate: "2026-10-20",
      apr: 7.3,
      regularPayment: 40_000,
    };
    expect((await browser.post("/api/manual-loans", loan)).status).toBe(200);
    const owed = async () =>
      (await accounts())
        .filter((account) => account.kind === "loan" && account.connectionId === null)
        .reduce((sum, account) => sum - (account.currentBalance ?? 0), 0);
    const one = (await loadDashboard()).numberTiles;

    expect(await owed()).toBeGreaterThan(0);
    expect(one.debt.amount).toBe(before.debt.amount + (await owed()));
    expect(one.debt.estimatedLoans).toBe(1);
    expect(numberTiles(one).find((tile) => tile.key === "debt")?.note).toBe(
      "Debt includes 1 estimated loan",
    );
    // Its typed balance holds back to the start of the history, so it counts at every month-end
    // and the loan alone does not read as Debt above usual.
    expect(await owed()).toBe(1_000_000);
    expect(one.debt.trend.map((point) => point.amount - 1_000_000)).toEqual(
      before.debt.trend.map((point) => point.amount),
    );
    expect(one.debt.usual).toBe((before.debt.usual ?? 0) + 1_000_000);
    expect(directionOf(one.debt.amount, one.debt.usual, "bad")?.tone).toBe(
      directionOf(before.debt.amount, before.debt.usual, "bad")?.tone,
    );

    expect(
      (await browser.post("/api/manual-loans", { ...loan, lender: "Riverside Credit" })).status,
    ).toBe(200);
    const two = (await loadDashboard()).numberTiles;
    expect(two.debt.estimatedLoans).toBe(2);
    expect(numberTiles(two).find((tile) => tile.key === "debt")?.note).toBe(
      "Debt includes 2 estimated loans",
    );
  });

  it("says about usual within 2% of the usual, and the direction and amount past it", async () => {
    const { numberTiles: view } = await loadDashboard();
    const usual = view.spending.usual ?? 0;
    const band = Math.floor(usual * 0.02);
    const about = { tone: "muted", text: "● about usual" };

    expect(usual).toBeGreaterThan(10_000);
    expect(directionOf(usual + band, usual, "bad")).toEqual(about);
    expect(directionOf(usual - band, usual, "bad")).toEqual(about);
    expect(directionOf(usual + band + 100, usual, "bad")).toEqual({
      tone: "serious",
      text: `▲ ${wholeDollars(band + 100)} above usual`,
    });
    expect(directionOf(usual - band - 100, usual, "bad")).toEqual({
      tone: "good",
      text: `▼ ${wholeDollars(band + 100)} below usual`,
    });
    // More Income or Cash on hand is good.
    expect(directionOf(usual + band + 100, usual, "good")?.tone).toBe("good");
    expect(directionOf(usual - band - 100, usual, "good")?.tone).toBe("serious");
    // The tile's own direction.
    const change = view.spending.amount - usual;
    expect(directionOf(view.spending.amount, usual, "bad")).toEqual(
      Math.abs(change) <= usual * 0.02
        ? about
        : {
            tone: change > 0 ? "serious" : "good",
            text: `${change > 0 ? "▲" : "▼"} ${wholeDollars(Math.abs(change))} ${change > 0 ? "above" : "below"} usual`,
          },
    );
  });

  // --- 5. "A usual month" ----------------------------------------------------------------------

  // The Spending the box counts in a month: every Category but Travel, and Gifts and donations.
  const counted = (byCategory: Record<string, number>) =>
    Object.entries(byCategory)
      .filter(([category]) => !YEARLY_CATEGORIES.includes(category as Category))
      .reduce((sum, [, cents]) => sum + cents, 0);

  it("shows the usual monthly Spending and October's pace, Travel and Gifts and donations left out", async () => {
    for (const path of ["/api/usual-month", "/api/usual-month?month=2026-13"]) {
      expect((await browser.get(path)).status).toBe(400);
    }
    await draft();
    const data = await loadDashboard();
    const months = await totals();
    const usual = middle(
      YEAR.map((month) => counted(months.find((each) => each.month === month)?.byCategory ?? {})),
    );
    const { groups } = data.usualMonth;

    expect(data.usualMonth.usual).toBe(usual);
    expect(groups.map((group) => group.categoryGroup)).toEqual(
      CATEGORY_GROUPS.map((group) => group.name),
    );
    expect(groups.find((group) => group.categoryGroup === "Leisure")?.categories).not.toContain(
      "Travel",
    );
    expect(groups.find((group) => group.categoryGroup === "Other")?.categories).not.toContain(
      "Gifts and donations",
    );
    for (const group of groups) {
      expect(group.bars.map((bar) => bar.month)).toEqual([...YEAR, "2026-10"]);
      const box = data.budgets.groups.find((each) => each.categoryGroup === group.categoryGroup);
      expect(group.bars.at(-1)?.spending).toBe(box?.spending ?? 0);
    }
    // Every month's bars add up to the Spending the box counts.
    for (const month of [...YEAR, "2026-10"]) {
      const sum = groups.reduce(
        (total, group) => total + (group.bars.find((bar) => bar.month === month)?.spending ?? 0),
        0,
      );
      expect(sum).toBe(counted(months.find((each) => each.month === month)?.byCategory ?? {}));
    }

    const projected = projectedSpending(data.budgets.groups);
    if (projected === null) throw new Error("October has no projection.");
    const change = projected - usual;
    const tail =
      Math.abs(change) <= usual * 0.02
        ? "about usual"
        : `${wholeDollars(Math.abs(change))} ${change > 0 ? "above" : "below"} usual`;
    expect(usualMonthLine(data.month, projected, usual).text).toBe(
      `October is on pace for ${wholeDollars(projected)}, ${tail}`,
    );
  });

  it("draws no Budget line before the first draft, and each month's Budget in effect after it", async () => {
    const before = (await loadDashboard()).usualMonth;
    for (const group of before.groups) {
      expect(group.bars.every((bar) => bar.budget === null)).toBe(true);
    }

    await draft();
    const october = await loadDashboard();
    const monthlyIn = (data: DashboardData, group: string) => {
      const budgets = data.budgets.budgets.filter(
        (each) => each.categoryGroup === group && each.period === "monthly",
      );
      return budgets.length === 0 ? null : budgets.reduce((sum, each) => sum + each.amount, 0);
    };
    for (const group of october.usualMonth.groups) {
      const bars = groupBars(group, october.month);
      expect(bars.filter((bar) => bar.budget !== null).map((bar) => bar.month)).toEqual(
        monthlyIn(october, group.categoryGroup) === null ? [] : ["2026-10"],
      );
      expect(bars.at(-1)).toMatchObject({
        label: "Oct 2026",
        current: true,
        budget: monthlyIn(october, group.categoryGroup),
      });
      expect(bars.filter((bar) => bar.current)).toHaveLength(1);
    }
    const bills = monthlyIn(october, "Bills") ?? 0;
    expect(bills).toBeGreaterThan(0);

    // In November, a new Housing Budget is November's line; October keeps the Budget it had.
    vi.setSystemTime(new Date("2026-11-05T17:00:00.000Z"));
    const housing = october.budgets.budgets.find((each) => each.category === "Housing");
    await setBudget("Housing", 250_000);
    const november = await loadDashboard();
    const billsBars = november.usualMonth.groups.find((group) => group.categoryGroup === "Bills");
    expect(billsBars?.bars.slice(-2)).toEqual([
      expect.objectContaining({ month: "2026-10", budget: bills }),
      expect.objectContaining({
        month: "2026-11",
        budget: bills - (housing?.amount ?? 0) + 250_000,
      }),
    ]);
    expect(billsBars?.bars.filter((bar) => bar.budget !== null)).toHaveLength(2);
  });

  it("counts each group's Categories Over Budget and On pace, and lists its Budgets worst first", async () => {
    await draft();
    const shoppingOf = (data: DashboardData) =>
      data.budgets.budgets.filter(
        (each) => each.categoryGroup === "Shopping" && each.period === "monthly",
      );
    const boxOf = (data: DashboardData, group: string) =>
      data.budgets.groups.find((each) => each.categoryGroup === group);
    for (const each of shoppingOf(await loadDashboard())) {
      await setBudget(each.category, 100_000_000);
    }
    const roomy = await loadDashboard();
    expect(groupStatus(boxOf(roomy, "Shopping"))).toEqual({ tone: "good", word: "on track" });

    // One Category On pace: its Budget is its Spending so far, below its projection.
    const busy = shoppingOf(roomy).filter(
      (each) => each.spending > 100 && each.projected !== null && each.projected > each.spending,
    );
    const [onPace, over] = busy.slice(-2);
    if (onPace === undefined || over === undefined) throw new Error("Too few busy Categories.");
    await setBudget(onPace.category, onPace.spending);
    const pacing = await loadDashboard();
    expect(boxOf(pacing, "Shopping")).toMatchObject({ overBudget: 0, onPace: 1 });
    expect(groupStatus(boxOf(pacing, "Shopping"))).toEqual({
      tone: "serious",
      word: "1 on pace to go over",
    });

    // One Category Over Budget too: Over Budget wins.
    await setBudget(over.category, 100);
    const data = await loadDashboard();
    expect(boxOf(data, "Shopping")).toMatchObject({ overBudget: 1, onPace: 1 });
    expect(groupStatus(boxOf(data, "Shopping"))).toEqual({ tone: "critical", word: "1 over" });

    // "Shopping Budgets": Over Budget, then On pace, then the rest in Category list order.
    const shopping = data.usualMonth.groups.find((group) => group.categoryGroup === "Shopping");
    if (shopping === undefined) throw new Error("No Shopping group.");
    const rows = groupBudgetRows(shopping, data.budgets);
    expect(rows.map((row) => row.category)).toEqual([
      over.category,
      onPace.category,
      ...shopping.categories.filter((each) => each !== over.category && each !== onPace.category),
    ]);
    expect(rows.every((row) => row.flexible)).toBe(true);
    const [first, second] = rows;
    if (first === undefined || second === undefined) throw new Error("Too few rows.");
    expect(rowNote(first)).toEqual({
      tone: "critical",
      word: `${wholeDollars(over.spending - 100)} over`,
    });
    expect(rowNote(second)).toEqual({
      tone: "serious",
      word: `on pace for ${wholeDollars(onPace.projected ?? 0)}`,
    });

    // A Bills row has no "today" tick, and shows its Benchmark context. Bills Over Budget or On
    // pace come first; the other Bills follow in Category list order.
    const billsGroup = data.usualMonth.groups.find((group) => group.categoryGroup === "Bills");
    if (billsGroup === undefined) throw new Error("No Bills group.");
    const bills = groupBudgetRows(billsGroup, data.budgets);
    const statusOf = (category: string) =>
      data.budgets.budgets.find((each) => each.category === category)?.status;
    expect(bills.every((row) => !row.flexible)).toBe(true);
    expect(bills.map((row) => row.category)).toEqual([
      ...billsGroup.categories.filter((each) => statusOf(each) === "Over Budget"),
      ...billsGroup.categories.filter((each) => statusOf(each) === "On pace"),
      ...billsGroup.categories.filter(
        (each) => statusOf(each) !== "Over Budget" && statusOf(each) !== "On pace",
      ),
    ]);
    for (const row of bills) {
      const budget = data.budgets.budgets.find((each) => each.category === row.category);
      expect(row.budget?.context ?? null).toBe(budget?.context ?? null);
    }
  });
});
