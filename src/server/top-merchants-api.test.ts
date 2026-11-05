import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { FakeBankAdapter, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { startBank, syncConnection } from "../bank/index.ts";
import { startCategorization } from "../categorization/index.ts";
import { addConnection, markSetupStep } from "../db/index.ts";
import { runFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import { createLogger } from "../log.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import { createApp } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";
import type { TopMerchantsView } from "./top-merchants-views.ts";

// Top Merchants (spec 07, Top Merchants) through the app's HTTP interface, on Transactions the fake
// adapter synced, on a fake clock: Nov 7, 2026. With no Household time zone yet, the date is UTC's.

const APP_URL = "http://nas.local:8080";
const BANK = "fake-first-bank";
const NOW = new Date("2026-11-07T17:00:00.000Z");

const GROCERIES = { name: "FOOD_AND_DRINK_GROCERIES", confidence: "VERY_HIGH", version: "v2" };
const RESTAURANT = { name: "FOOD_AND_DRINK_RESTAURANT", confidence: "VERY_HIGH", version: "v2" };
const STREAMING = { name: "ENTERTAINMENT_TV_AND_MOVIES", confidence: "VERY_HIGH", version: "v2" };

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-top-merchants-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the Top Merchants route", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;
  let stops: (() => void)[];

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
    const fake = new FakeBankAdapter();
    stops = [
      startBank({ database: test.database, secrets: test.secrets, adapters: [fake] }).stop,
      startFollowUpPipeline({ database: test.database, startJob: () => runFollowUp() }).stop,
      startMoneyMovement({ database: test.database }).stop,
      startCategorization({ database: test.database }).stop,
    ];
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);

    const checking = fakeAccount({ id: "acc-checking" });
    const card = fakeAccount({ id: "acc-card", type: "credit", subtype: "credit card" });
    const spend = (
      id: string,
      accountId: string,
      amount: number,
      postedDate: string,
      merchantName: string | null,
      category: { name: string; confidence: string; version: string } | null,
    ) =>
      fakeTxn({
        id,
        accountId,
        amount,
        postedDate,
        merchantName,
        description: merchantName === null ? `CHECK ${id.length}` : merchantName.toUpperCase(),
        category: category === null ? null : { ...category, mcc: null },
      });
    fake.addPages(BANK, {
      accounts: [checking, card],
      added: [
        // This month: Corner Grocer $80 in 2 Transactions less a $10 Refund, Streamly $15.49, and
        // Harbor Grill $30 with $30 refunded, so it has no Spending left.
        spend("g1", checking.id, -5_000, "2026-11-02", "Corner Grocer", GROCERIES),
        spend("g2", checking.id, -3_000, "2026-11-05", "Corner Grocer", GROCERIES),
        spend("g5", checking.id, 1_000, "2026-11-06", "Corner Grocer", GROCERIES),
        spend("s1", card.id, -1_549, "2026-11-03", "Streamly", STREAMING),
        spend("h1", card.id, -3_000, "2026-11-01", "Harbor Grill", RESTAURANT),
        spend("h2", card.id, 3_000, "2026-11-04", "Harbor Grill", RESTAURANT),
        // Earlier in the last 12 months: Streamly 11 more times, and Corner Grocer once, the day
        // the window opens. A meal at Corner Grocer's deli is Restaurants: its Spending is mostly
        // Groceries.
        ...Array.from({ length: 11 }, (_, month) =>
          spend(
            `s${month + 2}`,
            card.id,
            -1_549,
            `${month === 0 ? "2025" : "2026"}-${String(((month + 11) % 12) + 1).padStart(2, "0")}-03`,
            "Streamly",
            STREAMING,
          ),
        ),
        spend("g3", checking.id, -2_000, "2025-12-01", "Corner Grocer", RESTAURANT),
        // Before the window: not counted.
        spend("g4", checking.id, -90_000, "2025-11-30", "Corner Grocer", GROCERIES),
        // A paper check has no Merchant, so it is in no row.
        spend("check", checking.id, -50_000, "2026-11-02", null, null),
      ],
      historyLoaded: true,
    });
    const connectionId = await addConnection(test.database, {
      provider: "fake",
      bankId: BANK,
      bankName: "First Fake Bank",
      origin: "linked",
      syncMinute: 7,
    });
    await syncConnection(connectionId, () => NOW);
    await runFollowUp();
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    test.close();
    vi.useRealTimers();
  });

  const view = async (period: string) => {
    const res = await browser.get(`/api/top-merchants?period=${encodeURIComponent(period)}`);
    expect(res.status).toBe(200);
    return (await res.json()) as TopMerchantsView;
  };
  const rows = (found: TopMerchantsView) =>
    found.merchants.map(({ merchantName, spending, transactions, category }) => ({
      merchantName,
      spending,
      transactions,
      category,
    }));

  it('ranks Merchants by Spending this month, net of Refunds, for "This month"', async () => {
    const found = await view("This month");

    expect(found.from).toBe("2026-11-01");
    expect(rows(found)).toEqual([
      { merchantName: "Corner Grocer", spending: 7_000, transactions: 2, category: "Groceries" },
      { merchantName: "Streamly", spending: 1_549, transactions: 1, category: expect.any(String) },
    ]);
  });

  it('ranks the Spending of this month and the 11 before for "Last 12 months"', async () => {
    const found = await view("Last 12 months");

    expect(found.from).toBe("2025-12-01");
    expect(rows(found)).toEqual([
      {
        merchantName: "Streamly",
        spending: 12 * 1_549,
        transactions: 12,
        category: expect.any(String),
      },
      { merchantName: "Corner Grocer", spending: 9_000, transactions: 3, category: "Groceries" },
    ]);
  });

  it("refuses another period, and answers only a signed-in Member", async () => {
    for (const query of ["", "?period=This%20year", "?period=this%20month"]) {
      expect((await browser.get(`/api/top-merchants${query}`)).status, query).toBe(400);
    }
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");
    expect((await signedOut.get("/api/top-merchants?period=This%20month")).status).toBe(401);
  });
});
