import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { FakeBankAdapter, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { startBank, syncConnection } from "../bank/index.ts";
import { startCategorization } from "../categorization/index.ts";
import { addConnection, markSetupStep } from "../db/index.ts";
import { runFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import { createLogger } from "../log.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import { startRecurringCharges } from "../recurring/index.ts";
import { createApp } from "./app.ts";
import type { PaydayView, SteadyIncomeView } from "./recurring-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// Steady Income and paydays through the app's HTTP interface, on Income the fake adapter synced.
// The routes read today's date, so the paychecks are dated from it.

const APP_URL = "http://nas.local:8080";
const BANK = "fake-first-bank";

// The date `days` days from today, in UTC: the Household time zone until the wizard's step 4.
const daysFromToday = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-steady-income-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the Steady Income and payday routes", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;
  let stops: (() => void)[];

  beforeEach(async () => {
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
      // The follow-up job runs at once.
      startFollowUpPipeline({ database: test.database, startJob: () => runFollowUp() }).stop,
      startMoneyMovement({ database: test.database }).stop,
      startCategorization({ database: test.database }).stop,
      startRecurringCharges({ database: test.database }).stop,
    ];
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);

    const checking = fakeAccount({ id: "acc-checking" });
    const paycheck = (id: string, daysAgo: number) =>
      fakeTxn({
        id,
        accountId: checking.id,
        amount: 200_000,
        postedDate: daysFromToday(-daysAgo),
        merchantName: "Acme Corp",
        description: "ACME CORP PAYROLL",
      });
    fake.addPages(BANK, {
      accounts: [checking],
      added: [paycheck("a1", 31), paycheck("a2", 17), paycheck("a3", 3)],
      historyLoaded: true,
    });
    const connectionId = await addConnection(test.database, {
      provider: "fake",
      bankId: BANK,
      bankName: "First Fake Bank",
      origin: "linked",
      syncMinute: 7,
    });
    await syncConnection(connectionId);
    await runFollowUp();
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    test.close();
  });

  const steadyIncome = async () =>
    ((await (await browser.get("/api/steady-income")).json()) as { steadyIncome: SteadyIncomeView })
      .steadyIncome;
  const type = (body: unknown, headers: Record<string, string | undefined> = {}) =>
    browser.send("PUT", "/api/steady-income", body, headers);
  // $2,000 every 2 weeks: × 26 ÷ 12 is $4,333.
  const DETECTED: SteadyIncomeView = {
    amount: 433_300,
    detected: 433_300,
    detectedFrom: "Income series",
    typed: null,
  };

  it("lists each counted series' next payday", async () => {
    const res = await browser.get("/api/paydays");

    expect(res.status).toBe(200);
    expect(((await res.json()) as { paydays: PaydayView[] }).paydays).toEqual([
      {
        payerName: "Acme Corp",
        schedule: "every 2 weeks",
        date: daysFromToday(11),
        amount: 200_000,
      },
    ]);
  });

  it("answers the detected Steady Income, and a typed figure until a Member clears it", async () => {
    expect(await steadyIncome()).toEqual(DETECTED);

    const typed = await type({ typed: 500_000 });
    expect(typed.status).toBe(200);
    const withTyped = { ...DETECTED, amount: 500_000, typed: 500_000 };
    expect(await typed.json()).toEqual({ steadyIncome: withTyped });
    expect(await steadyIncome()).toEqual(withTyped);

    const cleared = await type({ typed: null });
    expect(cleared.status).toBe(200);
    expect(await steadyIncome()).toEqual(DETECTED);
  });

  it("answers 400 to a figure that is not whole cents from $0, and changes nothing", async () => {
    for (const body of [
      { typed: -1 },
      { typed: 12.5 },
      { typed: "500000" },
      { typed: 10_000_000_001 },
      {},
      { typed: 500_000, by: "someone" },
    ]) {
      expect((await type(body)).status).toBe(400);
    }

    expect(await steadyIncome()).toEqual(DETECTED);
  });

  it("answers 401 with no session, 403 from another site, and 415 to a body that is not JSON, and changes nothing", async () => {
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");

    expect((await signedOut.send("PUT", "/api/steady-income", { typed: 500_000 })).status).toBe(
      401,
    );
    expect((await signedOut.get("/api/steady-income")).status).toBe(401);
    expect((await signedOut.get("/api/paydays")).status).toBe(401);
    for (const origin of ["http://evil.example", undefined]) {
      expect((await type({ typed: 500_000 }, { origin })).status).toBe(403);
    }
    expect((await type({ typed: 500_000 }, { "content-type": "text/plain" })).status).toBe(415);

    expect(await steadyIncome()).toEqual(DETECTED);
  });
});
