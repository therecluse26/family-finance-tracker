import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { seedDemoHousehold } from "../bank/demo.ts";
import { FakeBankAdapter } from "../bank/fake.ts";
import { startBank } from "../bank/index.ts";
import { draftFirstBudgets, YEARLY_CATEGORIES } from "../budgets/index.ts";
import type { Category } from "../categories/index.ts";
import { startCategorization } from "../categorization/index.ts";
import { markSetupStep } from "../db/index.ts";
import { runFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import { percent, wholeDollars } from "../format.ts";
import { saveHouseholdFacts } from "../household/index.ts";
import { createLogger } from "../log.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import {
  type DashboardData,
  headerLine,
  leftText,
  leftToSpend,
  loadDashboard,
  meterLine,
  paceLine,
  yearlyLine,
} from "../web/dashboard.ts";
import { transactionRequests } from "../web/transactions.ts";
import { createApp } from "./app.ts";
import type { TransactionListView } from "./bank-views.ts";
import type { MonthTotalsView } from "./money-movement-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { TestBrowser } from "./testing.ts";

// End to end on the demo household (spec 07, Header and status lines; 2. Left to spend): the
// dashboard's own requests, sent through the app's HTTP interface on Oct 20, 2026, and the words
// the dashboard draws from their answers. The demo history has no Travel or Gifts and donations
// Spending, so a few of its Transactions get those Categories by hand.

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
  let stops: (() => void)[] = [];

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const quiet = createLogger(() => {}, { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, quiet);
    const app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger: quiet }),
      test.auth,
      test.database,
      test.secrets,
    );
    const fake = new FakeBankAdapter();
    stops = [
      startBank({ database: test.database, secrets: test.secrets, adapters: [fake] }).stop,
      startFollowUpPipeline({ database: test.database, startJob: () => runFollowUp() }).stop,
      startMoneyMovement({ database: test.database }).stop,
      startCategorization({ database: test.database }).stop,
    ];
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
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

  it("names the month and the last sync, and has no Left to spend before the first draft", async () => {
    const data = await loadDashboard();

    expect(data.month).toMatchObject({ month: "2026-10", name: "October", day: 20, days: 31 });
    // The demo banks synced at noon, Household time.
    expect(headerLine(data.month, data.connections, data.timeZone)).toBe(
      "Day 20 of 31 · synced 12:00 PM",
    );
    expect(leftToSpend(data.budgets)).toEqual({ drafted: false });
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
});
