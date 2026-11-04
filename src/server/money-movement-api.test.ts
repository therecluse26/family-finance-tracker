import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { FakeBankAdapter, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { startBank, syncConnection } from "../bank/index.ts";
import { addConnection, markSetupStep } from "../db/index.ts";
import { startFollowUpPipeline } from "../follow-up/index.ts";
import { createLogger } from "../log.ts";
import { runMatching, startMoneyMovement } from "../money-movement/index.ts";
import { createApp } from "./app.ts";
import type { MonthTotalsView, TransactionDecisionView } from "./money-movement-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// The hand-set type and totals routes, through the app's HTTP interface, on Transactions the fake
// adapter synced.

const APP_URL = "http://nas.local:8080";
const BANK = "fake-first-bank";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-money-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the money-movement routes", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;
  let stops: (() => void)[];
  // Each Transaction's ID in app.db, by its provider ID.
  let ids: Map<string, string>;

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
      startFollowUpPipeline({ database: test.database }).stop,
      startMoneyMovement({ database: test.database }).stop,
    ];
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);

    const checking = fakeAccount({ id: "acc-checking", name: "Everyday Checking" });
    fake.addPages(BANK, {
      accounts: [checking],
      added: [
        fakeTxn({ id: "pay", accountId: checking.id, amount: 320_000, postedDate: "2026-10-01" }),
        fakeTxn({ id: "rent", accountId: checking.id, amount: -150_000, postedDate: "2026-10-02" }),
        fakeTxn({ id: "gone", accountId: checking.id, amount: -999, postedDate: "2026-10-04" }),
      ],
    });
    fake.addPages(BANK, { removed: [{ id: "gone" }], historyLoaded: true });
    const connectionId = await addConnection(test.database, {
      provider: "fake",
      bankId: BANK,
      bankName: "First Fake Bank",
      origin: "linked",
      syncMinute: 7,
    });
    await syncConnection(connectionId, () => new Date("2026-10-05T15:00:00.000Z"));
    const rows = await test.database.$client.execute(
      "SELECT id, provider_transaction_id FROM transactions",
    );
    ids = new Map(rows.rows.map((row) => [String(row.provider_transaction_id), String(row.id)]));
    await runMatching(test.database, [...ids.values()]);
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    test.close();
  });

  const setType = (providerId: string, body: unknown) =>
    browser.send("PUT", `/api/transactions/${ids.get(providerId) ?? "none"}/type`, body);

  it("sets a Transaction's type by hand", async () => {
    const res = await setType("rent", { type: "Transfer" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      decision: {
        step: "1",
        provisionalUntil: null,
        parts: [{ type: "Transfer", amount: -150_000, category: null }],
      } satisfies TransactionDecisionView,
    });
    // A Transfer counts in nothing.
    const totals = (await (await browser.get("/api/totals")).json()) as {
      months: MonthTotalsView[];
    };
    expect(totals.months).toEqual([
      {
        month: "2026-10",
        spending: 0,
        income: 320_000,
        saving: 0,
        byCategory: {},
        byCategoryGroup: expect.any(Object),
      },
    ]);
  });

  it.each([
    ["a Refund, which no Member sets by hand", { type: "Refund" }],
    ["a type that does not exist", { type: "Gift" }],
    ["no type", {}],
    ["a body that is not JSON", "Transfer"],
  ])("refuses %s", async (_case, body) => {
    const res = await setType("rent", body);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Pick Spending, Transfer, Income, or Saving." });
  });

  it("answers 404 for a Transaction that does not show", async () => {
    expect((await setType("gone", { type: "Income" })).status).toBe(404);
    expect((await setType("no-such-id", { type: "Income" })).status).toBe(404);
  });

  it("returns Spending, Income, and Saving by month", async () => {
    const res = await browser.get("/api/totals");

    expect(res.status).toBe(200);
    const { months } = (await res.json()) as { months: MonthTotalsView[] };
    expect(months).toMatchObject([
      { month: "2026-10", spending: 150_000, income: 320_000, saving: 0 },
    ]);
  });

  it("answers no one who is signed out", async () => {
    const stranger = new TestBrowser(app, APP_URL, "192.168.1.21");

    expect((await stranger.get("/api/totals")).status).toBe(401);
    const res = await stranger.send("PUT", `/api/transactions/${ids.get("rent")}/type`, {
      type: "Income",
    });
    expect(res.status).toBe(401);
  });
});
