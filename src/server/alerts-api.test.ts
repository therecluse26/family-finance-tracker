import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startAnomalyChecks } from "../anomalies/index.ts";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { FakeBankAdapter, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { startBank, syncConnection } from "../bank/index.ts";
import { startCategorization } from "../categorization/index.ts";
import { addConnection, markSetupStep } from "../db/index.ts";
import { runFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import { createLogger } from "../log.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import { startRecurringCharges } from "../recurring/index.ts";
import type { AlertView } from "./alerts-views.ts";
import { createApp } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// The Alert list through the app's HTTP interface, on Transactions the fake adapter synced.

const APP_URL = "http://nas.local:8080";
const BANK = "fake-first-bank";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-alerts-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the Alert list route", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;
  let stops: (() => void)[];
  let now: Date;
  const clock = () => now;

  beforeEach(async () => {
    now = new Date("2026-09-05T15:00:00.000Z");
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
      startFollowUpPipeline({ database: test.database, startJob: () => runFollowUp(clock) }).stop,
      startMoneyMovement({ database: test.database }).stop,
      startCategorization({ database: test.database }).stop,
      startRecurringCharges({ database: test.database, now: clock }).stop,
      startAnomalyChecks({ database: test.database, now: clock }).stop,
    ];
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);

    const card = fakeAccount({ id: "acc-card", type: "credit", subtype: "credit card" });
    const shell = (id: string, postedDate: string) =>
      fakeTxn({ id, accountId: card.id, amount: -4_250, postedDate, merchantName: "Shell" });
    fake.addPages(BANK, {
      accounts: [card],
      added: [shell("h1", "2026-09-01"), shell("h2", "2026-09-02")],
      historyLoaded: true,
    });
    const connectionId = await addConnection(test.database, {
      provider: "fake",
      bankId: BANK,
      bankName: "First Fake Bank",
      origin: "linked",
      syncMinute: 7,
    });
    await syncConnection(connectionId, clock);
    await runFollowUp(clock);

    now = new Date("2026-10-22T15:00:00.000Z");
    fake.addPages(BANK, { added: [shell("h3", "2026-10-20"), shell("h4", "2026-10-21")] });
    await syncConnection(connectionId, clock);
    await runFollowUp(clock);
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    test.close();
  });

  it("lists every Alert newest first, with its state and template text", async () => {
    const res = await browser.get("/api/alerts");
    expect(res.status).toBe(200);
    const { alerts } = (await res.json()) as { alerts: AlertView[] };
    expect(alerts).toEqual([
      expect.objectContaining({
        kind: "Duplicate charge",
        createdAt: "2026-10-22T15:00:00.000Z",
        text: expect.stringMatching(
          /^Possible duplicate charge: \$42\.50 at Shell on .+, on Oct 20 and Oct 21\.$/,
        ),
        transactionIds: [expect.any(String), expect.any(String)],
        advice: null,
        notAProblem: [],
        state: null,
      }),
      expect.objectContaining({
        kind: "Duplicate charge",
        createdAt: "2026-09-05T15:00:00.000Z",
        text: expect.stringMatching(/, on Sep 1 and Sep 2\.$/),
        state: "found in history",
      }),
    ]);
  });

  it("answers 401 with no session", async () => {
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");
    expect((await signedOut.get("/api/alerts")).status).toBe(401);
  });
});
