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
import type { RecurringChargeView } from "./recurring-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// Recurring charges through the app's HTTP interface, on Transactions the fake adapter synced.

const APP_URL = "http://nas.local:8080";
const BANK = "fake-first-bank";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-recurring-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the Recurring charge routes", () => {
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

    const card = fakeAccount({ id: "acc-card", type: "credit", subtype: "credit card" });
    const streamly = (id: string, postedDate: string) =>
      fakeTxn({ id, accountId: card.id, amount: -1_549, postedDate, merchantName: "Streamly" });
    fake.addPages(BANK, {
      accounts: [card],
      added: [
        streamly("s1", "2026-07-03"),
        streamly("s2", "2026-08-03"),
        streamly("s3", "2026-09-03"),
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
    await syncConnection(connectionId, () => new Date("2026-09-05T15:00:00.000Z"));
    await runFollowUp();
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    test.close();
  });

  const list = async () =>
    (
      (await (await browser.get("/api/recurring-charges")).json()) as {
        charges: RecurringChargeView[];
      }
    ).charges;

  it("lists the Recurring charges a history load found", async () => {
    expect(await list()).toEqual([
      {
        id: expect.any(String),
        merchantName: "Streamly",
        category: expect.any(String),
        schedule: "monthly",
        nextExpectedDate: "2026-10-03",
        latestAmount: 1_549,
        priceHistory: [
          { date: "2026-07-03", amount: 1_549 },
          { date: "2026-08-03", amount: 1_549 },
          { date: "2026-09-03", amount: 1_549 },
        ],
        accountId: expect.any(String),
        // Its status depends on today.
        status: expect.stringMatching(/^(active|inactive)$/),
      },
    ]);
  });

  it("marks a Recurring charge ended, and answers 404 for an unknown ID", async () => {
    const [charge] = await list();

    const res = await browser.send("POST", `/api/recurring-charges/${charge?.id}/end`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ charge: { id: charge?.id, status: "ended" } });
    expect((await list()).map((each) => each.status)).toEqual(["ended"]);

    expect((await browser.send("POST", "/api/recurring-charges/no-such-id/end")).status).toBe(404);
  });

  it("answers 401 with no session and 403 from another site, and ends nothing", async () => {
    const [charge] = await list();
    const end = `/api/recurring-charges/${charge?.id}/end`;
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");

    expect((await signedOut.send("POST", end)).status).toBe(401);
    for (const origin of ["http://evil.example", undefined]) {
      expect((await browser.send("POST", end, undefined, { origin })).status).toBe(403);
    }

    expect((await list()).map((each) => each.status)).not.toContain("ended");
  });
});
