import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { FakeBankAdapter, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { startBank, syncConnection, type TxnRecord } from "../bank/index.ts";
import { startCategorization } from "../categorization/index.ts";
import { addConnection, markSetupStep } from "../db/index.ts";
import { runFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import { createLogger } from "../log.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import { startRecurringCharges } from "../recurring/index.ts";
import { merchantMonthHref } from "../web/pages/reports/merchant-words.ts";
import { createApp } from "./app.ts";
import type { MerchantsReportView, RecurringReportView } from "./reports-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";
import type { TopMerchantsView } from "./top-merchants-views.ts";

// The Merchants and Recurring charges reports (spec 07, Reports) through the app's HTTP interface,
// on Transactions the fake adapter synced and the real cleanup rules named, on a fake clock: Nov 7,
// 2026. With no Household time zone yet, the date is UTC's. 12 months run from Dec 2025.

const APP_URL = "http://nas.local:8080";
const BANK = "fake-first-bank";
const NOW = new Date("2026-11-07T17:00:00.000Z");
const GROCERIES = { name: "FOOD_AND_DRINK_GROCERIES", confidence: "VERY_HIGH", version: "v2" };
const MONTHS_12 = [
  "2025-12",
  ...Array.from({ length: 11 }, (_, n) => `2026-${String(n + 1).padStart(2, "0")}`),
];

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-reports-merchants-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the Merchants and Recurring charges reports", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;
  let fake: FakeBankAdapter;
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
    fake = new FakeBankAdapter();
    stops = [
      startBank({ database: test.database, secrets: test.secrets, adapters: [fake] }).stop,
      startFollowUpPipeline({ database: test.database, startJob: () => runFollowUp() }).stop,
      startMoneyMovement({ database: test.database }).stop,
      startCategorization({ database: test.database }).stop,
      startRecurringCharges({ database: test.database }).stop,
    ];
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    test.close();
    vi.useRealTimers();
  });

  const checking = fakeAccount({ id: "acc-checking" });
  const card = fakeAccount({ id: "acc-card", type: "credit", subtype: "credit card" });
  const line = (id: string, amount: number, postedDate: string, description: string) =>
    fakeTxn({ id, accountId: card.id, amount, postedDate, description });
  const named = (
    id: string,
    amount: number,
    postedDate: string,
    merchantName: string,
    fields: Partial<TxnRecord> = {},
  ) =>
    fakeTxn({
      id,
      accountId: checking.id,
      amount,
      postedDate,
      merchantName,
      description: merchantName.toUpperCase(),
      category: merchantName === "Corner Grocer" ? { ...GROCERIES, mcc: null } : null,
      ...fields,
    });
  const monthsFrom = (first: string, count: number) =>
    Array.from({ length: count }, (_, n) => {
      const at = new Date(`${first}T00:00:00.000Z`);
      at.setUTCMonth(at.getUTCMonth() + n);
      return at.toISOString().slice(0, 10);
    });

  // Syncs the history: the K7 lines with no provider Merchant name, so the cleanup rules name
  // them; Corner Grocer with a Refund; two Recurring charges, Streamly with a price change on
  // Jun 3 and Brightwave from May; and any `extra` Transactions.
  async function syncHistory(extra: TxnRecord[] = []) {
    fake.addPages(BANK, {
      accounts: [checking, card],
      added: [
        line("bb1", -4_000, "2026-09-10", "PURCHASE 1005 BLUEBIRD BOOKS"),
        line("bb2", -2_500, "2026-10-12", "BLUEBIRD BOOKS"),
        // Not Bluebird Books, though a word search for "Bluebird Books" finds it.
        line("bc1", -1_200, "2026-09-20", "BLUEBIRD BOOKSHOP CAFE"),
        line("ml1", -3_000, "2026-08-05", "VENMO *MORGAN LEE"),
        line("ml2", -2_000, "2026-10-05", "VENMO *MORGAN LEE"),
        line("et1", -1_800, "2026-10-20", "PAYPAL *ETSY SHOP"),
        line("js1", -5_000, "2026-09-15", "ZELLE PAYMENT TO JOHN SMITH"),
        named("cg1", -6_000, "2026-09-02", "Corner Grocer"),
        named("cg2", -4_000, "2026-10-02", "Corner Grocer"),
        // A Refund in a month with no other Spending there.
        named("cg3", 1_500, "2026-11-03", "Corner Grocer"),
        ...monthsFrom("2025-09-03", 15).map((date) =>
          named(`st-${date}`, date >= "2026-06-03" ? -1_799 : -1_549, date, "Streamly"),
        ),
        ...monthsFrom("2026-05-20", 6).map((date) =>
          named(`bw-${date}`, -6_500, date, "Brightwave"),
        ),
        ...extra,
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
    return connectionId;
  }

  const merchants = async (query: string) => {
    const res = await browser.get(`/api/reports/merchants${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as MerchantsReportView;
  };
  const recurring = async (query: string) => {
    const res = await browser.get(`/api/reports/recurring${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as RecurringReportView;
  };
  const totals = (view: MerchantsReportView) =>
    Object.fromEntries(view.series.map((each) => [each.merchantName, each.total]));

  it("groups the K7 lines by the Merchants the cleanup rules name", async () => {
    await syncHistory();
    const view = await merchants("?range=12m");

    expect(view.months).toEqual(MONTHS_12);
    expect(view.merchant).toBeNull();
    expect(totals(view)).toMatchObject({
      "Bluebird Books": 6_500,
      "Bluebird Bookshop Cafe": 1_200,
      "Morgan Lee": 5_000,
      "Etsy Shop": 1_800,
      "John Smith": 5_000,
    });
    const bluebird = view.series.find((each) => each.merchantName === "Bluebird Books");
    expect(bluebird?.byMonth[MONTHS_12.indexOf("2026-09")]).toBe(4_000);
    expect(bluebird?.byMonth[MONTHS_12.indexOf("2026-10")]).toBe(2_500);
    // Most Spending first, and the filter offers the same Merchants.
    const ranked = view.series.map((each) => each.total);
    expect(ranked).toEqual([...ranked].sort((a, b) => b - a));
    expect(view.choices).toEqual(
      view.series.map(({ key, merchantName }) => ({ key, merchantName })),
    );
  });

  it("nets Refunds the way Top Merchants does, over the same months", async () => {
    await syncHistory();
    const view = await merchants("?range=12m");
    const top = (await (
      await browser.get("/api/top-merchants?period=Last%2012%20months")
    ).json()) as TopMerchantsView;

    expect(view.series.map(({ key, total }) => ({ id: key, total }))).toEqual(
      top.merchants.map(({ id, spending }) => ({ id, total: spending })),
    );
    expect(totals(view)["Corner Grocer"]).toBe(8_500);
    // Each month sums the series.
    for (const each of view.series) {
      expect(each.byMonth.reduce((sum, cents) => sum + cents, 0)).toBe(each.total);
    }
  });

  it("shows one Merchant's months and its usual month", async () => {
    await syncHistory();
    const top = await merchants("?range=12m");
    const streamly = top.series.find((each) => each.merchantName === "Streamly");
    if (streamly === undefined) throw new Error("No Streamly series.");

    const view = await merchants(`?range=12m&merchant=${encodeURIComponent(streamly.key)}`);
    expect(view.merchant).toBe(streamly.key);
    expect(view.series).toEqual([streamly]);
    expect(streamly.byMonth).toEqual([...Array(6).fill(1_549), ...Array(6).fill(1_799)]);
    // The median of the 12 months.
    expect(view.usual).toBe(1_674);
    expect(view.choices).toEqual(top.choices);
  });

  it("gives an empty series for a key that names no Merchant group", async () => {
    await syncHistory();
    for (const key of ["name nosuchshop", "id m-unknown", "name x' OR 1=1 --", "%", "*"]) {
      const view = await merchants(`?range=all&merchant=${encodeURIComponent(key)}`);
      expect(view).toMatchObject({ merchant: key, series: [], usual: null });
      expect(view.choices.length).toBeGreaterThan(0);
    }
  });

  // Groups by the provider's Merchant ID: one Merchant under two clean names, a name inside
  // another Merchant's, and a name with no word.
  const BY_ID = [
    named("tj1", -1_012, "2026-10-06", "Trader Joe's", { merchantId: "m-tj" }),
    named("tj2", -1_013, "2026-10-14", "Trader Joes", { merchantId: "m-tj" }),
    named("tg1", -3_300, "2026-10-08", "Target", { merchantId: "m-target" }),
    named("to1", -2_200, "2026-10-09", "Target Optical", { merchantId: "m-target-optical" }),
    named("q1", -900, "2026-10-11", '"', { merchantId: "m-quote" }),
  ];
  const listed = async (query: string) => {
    const res = await browser.get(`/api/transactions${query}`);
    expect(res.status).toBe(200);
    const found = (await res.json()) as {
      transactions: { merchant: string | null; amount: number }[];
    };
    return found.transactions
      .map(({ merchant, amount }) => ({ merchant, amount }))
      .sort((a, b) => a.amount - b.amount);
  };
  const drilled = (href: string | null) => {
    if (href === null) throw new Error("No drill-down link.");
    return listed(new URL(href, APP_URL).search);
  };

  it("drills down from each month of each Merchant to the Transactions it sums", async () => {
    await syncHistory(BY_ID);
    const { series, months } = await merchants("?range=all");
    expect(series).toHaveLength(10);
    expect(series.map((each) => each.merchantName)).toEqual(
      expect.arrayContaining(["Trader Joes", "Target", "Target Optical", "Bluebird Books"]),
    );
    for (const each of series) {
      for (const [index, month] of months.entries()) {
        const rows = await drilled(merchantMonthHref(each, month));
        const spending = rows.reduce((sum, row) => sum - row.amount, 0);
        expect([each.merchantName, month, spending]).toEqual([
          each.merchantName,
          month,
          each.byMonth[index],
        ]);
      }
    }
  });

  it("drills down to one Merchant by its ID, and to a Merchant with none by its exact words", async () => {
    await syncHistory(BY_ID);
    const href = (merchantId: string | null, merchantName: string, month = "2026-10") =>
      drilled(merchantMonthHref({ merchantId, merchantName }, month));

    // Both of the Merchant's names, and not a name that holds another Merchant's.
    expect(await href("m-tj", "Trader Joes")).toEqual([
      { merchant: "Trader Joes", amount: -1_013 },
      { merchant: "Trader Joe's", amount: -1_012 },
    ]);
    expect(await href("m-target", "Target")).toEqual([{ merchant: "Target", amount: -3_300 }]);
    expect(await href("m-quote", '"')).toEqual([{ merchant: '"', amount: -900 }]);
    // An ID no Merchant has lists nothing, with or without a month.
    expect(await listed("?merchantId=m-unknown")).toEqual([]);
    expect(await listed("?merchantId=m-unknown&month=2026-10")).toEqual([]);
    expect(await listed("?merchantId=m-target")).toEqual([{ merchant: "Target", amount: -3_300 }]);

    // With no ID, the quotes keep Bluebird Bookshop Cafe out; without them, it is found too.
    expect(await href(null, "Bluebird Books", "2026-09")).toEqual([
      { merchant: "Bluebird Books", amount: -4_000 },
    ]);
    expect(await listed("?merchant=Bluebird+Books&month=2026-09")).toHaveLength(2);
    expect(await href(null, "Morgan Lee")).toEqual([{ merchant: "Morgan Lee", amount: -2_000 }]);
    // A name with no word gives no link, rather than one that lists every Merchant.
    expect(merchantMonthHref({ merchantId: null, merchantName: '"' }, "2026-10")).toBeNull();
    expect(merchantMonthHref({ merchantId: null, merchantName: ' " " ' }, "2026-10")).toBeNull();
  });

  // A charge on the 1st, each bought the day before, so each payment counts in the month before
  // the one it posted in.
  const NORTHWIND = monthsFrom("2026-06-01", 6).map((date) =>
    named(`nw-${date}`, -4_200, date, "Northwind Phone", {
      authorizedDate: new Date(Date.parse(`${date}T00:00:00.000Z`) - 86_400_000)
        .toISOString()
        .slice(0, 10),
    }),
  );

  it("counts a payment in its purchase month, and only payments that are posted, shown, and kept", async () => {
    const connectionId = await syncHistory(NORTHWIND);
    const chargeOf = async (name: string) => {
      const view = await recurring("?range=12m");
      const found = view.charges.find((each) => each.merchantName === name);
      if (found === undefined) throw new Error(`No ${name} charge.`);
      return found;
    };
    const at = (month: string) => MONTHS_12.indexOf(month);

    const northwind = await chargeOf("Northwind Phone");
    expect(northwind.byMonth.slice(at("2026-05"))).toEqual([
      4_200, 4_200, 4_200, 4_200, 4_200, 4_200, 0,
    ]);

    // Brightwave pays on the 20th, May to Oct. A Member removes May's; the bank sends June's back
    // to pending and removes July's.
    const brightwave = await chargeOf("Brightwave");
    const ids = new Map(
      (
        (await (await browser.get("/api/recurring-charges")).json()) as {
          charges: { id: string; priceHistory: { transactionId: string; date: string }[] }[];
        }
      ).charges
        .find((charge) => charge.id === brightwave.id)
        ?.priceHistory.map((entry) => [entry.date, entry.transactionId]) ?? [],
    );
    const removed = await browser.send(
      "DELETE",
      `/api/recurring-charges/${brightwave.id}/transactions/${ids.get("2026-05-20")}`,
    );
    expect(removed.status).toBe(200);
    fake.addPages(BANK, {
      changed: [named("bw-2026-06-20", -6_500, "2026-06-20", "Brightwave", { pending: true })],
      removed: [{ id: "bw-2026-07-20", reason: "removed by provider" }],
      historyLoaded: true,
    });
    await syncConnection(connectionId, () => NOW);
    const kept = [0, 0, 0, 6_500, 6_500, 6_500, 0];

    // Before the follow-up work runs, the hidden payment is still in its charge.
    expect((await chargeOf("Brightwave")).byMonth.slice(at("2026-05"))).toEqual(kept);
    await runFollowUp();
    expect((await chargeOf("Brightwave")).byMonth.slice(at("2026-05"))).toEqual(kept);
  });

  it("stacks the Recurring charges' payments by month, with each price change once", async () => {
    await syncHistory();
    const view = await recurring("?range=12m");

    expect(view.months).toEqual(MONTHS_12);
    expect(view.charges.map(({ name, total }) => ({ name, total }))).toEqual([
      { name: "Brightwave", total: 6 * 6_500 },
      { name: "Streamly", total: 6 * 1_549 + 6 * 1_799 },
    ]);
    expect(view.other).toEqual({ count: 0, byMonth: MONTHS_12.map(() => 0) });
    expect(view.totals[MONTHS_12.indexOf("2026-06")]).toBe(6_500 + 1_799);
    expect(view.totals[MONTHS_12.indexOf("2026-04")]).toBe(1_549);
    expect(view.priceChanges).toEqual([
      {
        chargeId: view.charges[1]?.id,
        name: "Streamly",
        merchantName: "Streamly",
        month: "2026-06",
        fromDate: "2026-06-03",
        amount: 1_799,
        before: 1_549,
      },
    ]);
    expect(view.changes).toEqual([
      expect.objectContaining({ name: "Brightwave", now: 6_500, yearAgo: null, change: null }),
      expect.objectContaining({ name: "Streamly", now: 1_799, yearAgo: 1_549, change: 250 }),
    ]);

    // A price change before the range has no marker.
    expect((await recurring("?range=3m")).priceChanges).toEqual([]);
    expect((await recurring("?range=all")).priceChanges).toHaveLength(1);
  });

  it("covers no months with no history", async () => {
    expect(await merchants("?range=12m")).toEqual({
      range: "12m",
      months: [],
      merchant: null,
      choices: [],
      series: [],
      usual: null,
    });
    expect(await recurring("")).toEqual({
      range: "12m",
      months: [],
      charges: [],
      other: { count: 0, byMonth: [] },
      totals: [],
      priceChanges: [],
      changes: [],
    });
  });

  it("answers only a signed-in Member, and refuses a bad query", async () => {
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");
    expect((await signedOut.get("/api/reports/merchants")).status).toBe(401);
    expect((await signedOut.get("/api/reports/recurring")).status).toBe(401);
    expect((await browser.get("/api/reports/merchants?merchant=")).status).toBe(400);
    expect((await browser.get(`/api/reports/merchants?merchant=${"x".repeat(201)}`)).status).toBe(
      400,
    );
  });
});
