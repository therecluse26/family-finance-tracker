import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { FakeBankAdapter, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { startBank, syncConnection } from "../bank/index.ts";
import { addConnection, markSetupStep } from "../db/index.ts";
import { createLogger } from "../log.ts";
import { createApp } from "./app.ts";
import { reportRoutes } from "./reports.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// The Reports routes (spec 07, Reports) through the app's HTTP interface, on a fake clock: Nov 7,
// 2026. With no Household time zone yet, the date is UTC's. A report that is not built yet answers
// a good query with 501.

const APP_URL = "http://nas.local:8080";
const NOW = new Date("2026-11-07T17:00:00.000Z");
const ROUTES = [
  "/api/reports/spending",
  "/api/reports/cash-flow",
  "/api/reports/balances",
  "/api/reports/merchants",
  "/api/reports/recurring",
];

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-reports-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the Reports routes", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;

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
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);
  });

  afterEach(() => {
    test.close();
    vi.useRealTimers();
  });

  it("answers 401 with no session", async () => {
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");
    for (const route of ROUTES) expect((await signedOut.get(route)).status).toBe(401);
  });

  it("answers 400 to a range that is not one of the presets", async () => {
    for (const route of ROUTES) {
      for (const range of ["6m", "", "12M", "all "]) {
        const res = await browser.get(`${route}?range=${encodeURIComponent(range)}`);
        expect(res.status).toBe(400);
      }
    }
  });

  it("answers 400 to a group that is not a Category group", async () => {
    for (const group of ["Groceries", "bills", "Everything", ""]) {
      const res = await browser.get(`/api/reports/spending?group=${encodeURIComponent(group)}`);
      expect(res.status).toBe(400);
    }
  });

  it("answers 501 to a good query, with or without a range", async () => {
    const built = ["/api/reports/spending", "/api/reports/cash-flow", "/api/reports/balances"];
    const unbuilt = ROUTES.filter((route) => !built.includes(route));
    const good = [
      ...unbuilt,
      ...unbuilt.map((route) => `${route}?range=3m`),
      "/api/reports/merchants?range=12m&merchant=streamly",
    ];
    for (const route of good) {
      const res = await browser.get(route);
      expect(res.status).toBe(501);
      expect(await res.json()).toEqual({ error: "This report is not built yet." });
    }
  });

  it("answers Spending over time and Cash flow with their views, with or without a range", async () => {
    for (const route of [
      "/api/reports/spending",
      "/api/reports/spending?range=all&group=Health%20and%20care",
      "/api/reports/cash-flow?range=3m",
    ]) {
      const res = await browser.get(route);
      expect(res.status).toBe(200);
      // No posted Transaction yet: no months.
      expect(await res.json()).toMatchObject({ months: [], bars: [] });
    }
    const spending = await (await browser.get("/api/reports/spending?group=Leisure")).json();
    expect(spending).toMatchObject({ range: "12m", group: "Leisure", usual: null, rows: [] });
  });

  it("gives an empty Balances and debt report with no history, and 404 for an unknown Account", async () => {
    const res = await browser.get("/api/reports/balances?range=all");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      range: "all",
      months: [],
      today: "2026-11-07",
      accounts: [],
      account: null,
      cashOnHand: [],
      debt: [],
      creditUse: { cards: [], all: [] },
      loans: [],
    });
    expect((await browser.get("/api/reports/balances?range=24m&account=acc-checking")).status).toBe(
      404,
    );
  });

  it("covers the months of a range from the first posted Transaction to the Household's month", async () => {
    const reports = reportRoutes(test.database);
    expect(await reports.months("12m", NOW)).toEqual([]);

    const fake = new FakeBankAdapter();
    const bank = startBank({ database: test.database, secrets: test.secrets, adapters: [fake] });
    try {
      const checking = fakeAccount({ id: "acc-checking" });
      fake.addPages("fake-first-bank", {
        accounts: [checking],
        added: [
          fakeTxn({ id: "t1", accountId: checking.id, amount: -1_000, postedDate: "2026-08-14" }),
          fakeTxn({ id: "t2", accountId: checking.id, amount: -2_000, postedDate: "2026-11-02" }),
        ],
        historyLoaded: true,
      });
      const connectionId = await addConnection(test.database, {
        provider: "fake",
        bankId: "fake-first-bank",
        bankName: "First Fake Bank",
        origin: "linked",
        syncMinute: 7,
      });
      await syncConnection(connectionId, () => NOW);
    } finally {
      bank.stop();
    }

    expect(await reports.months("3m", NOW)).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(await reports.months("12m", NOW)).toEqual(["2026-08", "2026-09", "2026-10", "2026-11"]);
    expect(await reports.months("all", NOW)).toEqual(["2026-08", "2026-09", "2026-10", "2026-11"]);
  });
});
