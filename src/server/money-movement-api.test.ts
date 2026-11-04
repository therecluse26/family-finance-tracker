import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { FakeBankAdapter, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { startBank, syncConnection } from "../bank/index.ts";
import { addConnection, markSetupStep } from "../db/index.ts";
import { runFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import { createLogger } from "../log.ts";
import { runMatching, startMoneyMovement } from "../money-movement/index.ts";
import { createApp } from "./app.ts";
import type {
  MonthTotalsView,
  TransactionDecisionView,
  TransactionDetailView,
} from "./money-movement-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// The Transaction, hand-set type, and totals routes, through the app's HTTP interface, on Transactions the fake
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
  let fake: FakeBankAdapter;
  let connectionId: string;

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
    fake = new FakeBankAdapter();
    stops = [
      startBank({ database: test.database, secrets: test.secrets, adapters: [fake] }).stop,
      // The follow-up job runs at once.
      startFollowUpPipeline({ database: test.database, startJob: () => runFollowUp() }).stop,
      startMoneyMovement({ database: test.database }).stop,
    ];
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);

    const checking = fakeAccount({ id: "acc-checking", name: "Everyday Checking" });
    const savings = fakeAccount({ id: "acc-savings", subtype: "savings", mask: "2222" });
    fake.addPages(BANK, {
      accounts: [checking, savings],
      added: [
        fakeTxn({ id: "pay", accountId: checking.id, amount: 320_000, postedDate: "2026-10-01" }),
        fakeTxn({ id: "rent", accountId: checking.id, amount: -150_000, postedDate: "2026-10-02" }),
        fakeTxn({ id: "gone", accountId: checking.id, amount: -999, postedDate: "2026-10-04" }),
        fakeTxn({
          id: "save-out",
          accountId: checking.id,
          amount: -50_000,
          postedDate: "2026-10-03",
          description: "TRANSFER TO SAVINGS 2222",
        }),
        fakeTxn({ id: "save-in", accountId: savings.id, amount: 50_000, postedDate: "2026-10-03" }),
      ],
    });
    fake.addPages(BANK, { removed: [{ id: "gone" }], historyLoaded: true });
    connectionId = await addConnection(test.database, {
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

  it("returns a Transaction with its type and its Transfer link's evidence", async () => {
    const res = await browser.get(`/api/transactions/${ids.get("save-in")}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      transaction: {
        id: ids.get("save-in") ?? "",
        accountId: expect.any(String),
        amount: 50_000,
        postedDate: "2026-10-03",
        authorizedDate: null,
        pending: false,
        description: "FAKE save-in",
        merchantName: null,
      },
      decision: {
        step: "3",
        provisionalUntil: null,
        parts: [{ type: "Transfer", amount: 50_000, category: null }],
      },
      transferLink: {
        id: expect.any(String),
        otherTransactionId: ids.get("save-out") ?? "",
        tier: "Strong",
        signals: ["last 4 digits"],
        aiAnswer: null,
        aiConfidence: null,
        madeBy: "app",
        uncertain: false,
      },
      otherLinks: [],
    } satisfies TransactionDetailView);
    const rent = (await (
      await browser.get(`/api/transactions/${ids.get("rent")}`)
    ).json()) as TransactionDetailView;
    expect(rent.transferLink).toBeNull();
    expect((await browser.get(`/api/transactions/${ids.get("gone")}`)).status).toBe(404);
    expect((await browser.get("/api/transactions/no-such-id")).status).toBe(404);
  });

  it("ties a one-sided Transfer to the Unconnected account a Member adds", async () => {
    fake.addPages(BANK, {
      added: [
        fakeTxn({
          id: "to-credit-union",
          accountId: "acc-checking",
          amount: -25_000,
          postedDate: "2026-10-04",
          description: "ONLINE TRANSFER TO CREDIT UNION XXXX1234",
        }),
      ],
    });
    await syncConnection(connectionId, () => new Date("2026-10-20T15:00:00.000Z"));
    await runFollowUp(() => new Date("2026-10-20T15:00:00.000Z"));

    const res = await browser.send("POST", "/api/unconnected-accounts", {
      name: "Credit union savings",
      kind: "savings",
      institutionName: "Credit union",
      mask: "1234",
    });

    expect(res.status).toBe(200);
    // The follow-up job decided the Transfer again, and it moved the new account's estimate.
    const { accounts } = (await (await browser.get("/api/unconnected-accounts")).json()) as {
      accounts: { estimate: { balance: number; state: string } }[];
    };
    expect(accounts.map((account) => account.estimate)).toEqual([
      { balance: 25_000, state: "estimated", typedOn: null },
    ]);
  });

  it("reads and sets a connected loan's type and the APR a Member typed", async () => {
    fake.addPages(BANK, {
      accounts: [
        fakeAccount({ id: "acc-car", type: "loan", subtype: "auto", currentBalance: -900_000 }),
      ],
    });
    await syncConnection(connectionId, () => new Date("2026-10-20T15:00:00.000Z"));
    const rows = await test.database.$client.execute(
      "SELECT id FROM household_accounts WHERE provider_account_id = 'acc-car'",
    );
    const car = String(rows.rows[0]?.id);
    const loanRoute = `/api/accounts/${car}/loan`;

    expect(await (await browser.get(loanRoute)).json()).toEqual({
      loan: { accountId: car, loanType: "purchase loan", setBy: "app", apr: null },
    });
    const set = await browser.send("PUT", loanRoute, { loanType: "cash loan", apr: 5.25 });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({
      loan: { accountId: car, loanType: "cash loan", setBy: "Member", apr: 5.25 },
    });
    // Null hands the type back to the app. The APR keeps its value.
    expect(await (await browser.send("PUT", loanRoute, { loanType: null })).json()).toEqual({
      loan: { accountId: car, loanType: "purchase loan", setBy: "app", apr: 5.25 },
    });

    for (const body of [
      { apr: 101 },
      { apr: -1 },
      { apr: "5" },
      { loanType: "car loan" },
      { other: 1 },
    ]) {
      expect((await browser.send("PUT", loanRoute, body)).status).toBe(400);
    }
    // Checking is not a loan.
    const checking = await test.database.$client.execute(
      "SELECT id FROM household_accounts WHERE provider_account_id = 'acc-checking'",
    );
    expect((await browser.get(`/api/accounts/${checking.rows[0]?.id}/loan`)).status).toBe(404);
    expect(
      (
        await browser.send("PUT", `/api/accounts/${checking.rows[0]?.id}/loan`, {
          loanType: "cash loan",
          apr: 5,
        })
      ).status,
    ).toBe(404);
    // The refused PUT wrote nothing on the checking Account.
    const unchanged = await test.database.$client.execute({
      sql: "SELECT loan_type, member_apr FROM household_accounts WHERE id = ?",
      args: [String(checking.rows[0]?.id)],
    });
    expect({ ...unchanged.rows[0] }).toEqual({ loan_type: null, member_apr: null });
    expect((await browser.send("PUT", "/api/accounts/no-such-id/loan", { apr: 5 })).status).toBe(
      404,
    );
  });

  it("answers no one who is signed out", async () => {
    expect(
      (
        await new TestBrowser(app, APP_URL, "192.168.1.21").get(
          `/api/transactions/${ids.get("rent")}`,
        )
      ).status,
    ).toBe(401);
    const stranger = new TestBrowser(app, APP_URL, "192.168.1.21");

    expect((await stranger.get("/api/totals")).status).toBe(401);
    const res = await stranger.send("PUT", `/api/transactions/${ids.get("rent")}/type`, {
      type: "Income",
    });
    expect(res.status).toBe(401);
  });
});
