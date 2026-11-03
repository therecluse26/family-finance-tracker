import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import { FakeBankAdapter, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { startBank, syncConnection } from "../bank/index.ts";
import { addConnection } from "../db/index.ts";
import { createLogger } from "../log.ts";
import { createApp } from "./app.ts";
import type { AccountView, BalancesView, ConnectionView, TransactionView } from "./bank-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// The Account, Transaction, and Connection routes, through the app's HTTP interface, on data the
// fake adapter synced.

const APP_URL = "http://nas.local:8080";
const BANK = "fake-first-bank";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-bank-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the bank routes", () => {
  let test: TestAuth;
  let app: App;
  let fake: FakeBankAdapter;
  let stopBank: () => void;
  let member: TestMember;
  let checkingId: string;

  beforeEach(async () => {
    const quiet = createLogger(() => {}, { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, quiet);
    app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger: quiet }),
      test.auth,
      test.database,
    );
    fake = new FakeBankAdapter();
    fake.actions = { repairInApp: true, importExisting: false, refresh: false };
    stopBank = startBank({ database: test.database, secrets: test.secrets, adapters: [fake] }).stop;
    member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });

    const checking = fakeAccount({
      id: "acc-checking",
      name: "Everyday Checking",
      currentBalance: 248_000,
    });
    const card = fakeAccount({
      id: "acc-card",
      name: "Rewards Card",
      type: "credit",
      currentBalance: -61_250,
    });
    fake.addPages(BANK, {
      accounts: [checking, card],
      added: [
        fakeTxn({ id: "t1", accountId: checking.id, amount: 320_000, postedDate: "2026-10-01" }),
        fakeTxn({ id: "t2", accountId: card.id, amount: -1_599, postedDate: "2026-10-02" }),
        fakeTxn({ id: "t3", accountId: checking.id, amount: -4_500, postedDate: "2026-10-03" }),
        fakeTxn({
          id: "p1",
          accountId: card.id,
          amount: -2_500,
          postedDate: "2026-10-04",
          pending: true,
        }),
        fakeTxn({ id: "gone", accountId: card.id, amount: -999, postedDate: "2026-10-04" }),
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
    const [row] = (
      await test.database.$client.execute(
        "SELECT id FROM household_accounts WHERE provider_account_id = 'acc-checking'",
      )
    ).rows;
    checkingId = String(row?.id);
  });

  afterEach(() => {
    stopBank();
    test.close();
  });

  async function signedIn(): Promise<TestBrowser> {
    const tab = new TestBrowser(app, APP_URL, "192.168.1.20");
    await tab.signIn(member);
    return tab;
  }

  it("answers 401 to a browser with no session, on every route", async () => {
    const tab = new TestBrowser(app, APP_URL, "192.168.1.21");

    for (const path of [
      "/api/accounts",
      "/api/transactions",
      "/api/connections",
      `/api/accounts/${checkingId}/balances`,
    ]) {
      const res = await tab.get(path);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain("Everyday Checking");
    }
    // The routes that change data, from the app's own origin.
    for (const path of [
      `/api/accounts/${checkingId}/close`,
      `/api/accounts/${checkingId}/reopen`,
    ]) {
      const res = await tab.post(path);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain("Everyday Checking");
    }
  });

  it("lists the Accounts with their balances in whole cents", async () => {
    const res = await (await signedIn()).get("/api/accounts");

    expect(res.status).toBe(200);
    const { accounts } = (await res.json()) as { accounts: AccountView[] };
    expect(accounts.map((account) => [account.name, account.kind, account.currentBalance])).toEqual(
      [
        ["Everyday Checking", "depository", 248_000],
        ["Rewards Card", "credit", -61_250],
      ],
    );
    expect(accounts[0]).toMatchObject({
      institutionName: "First Fake Bank",
      excluded: false,
      closed: false,
    });
  });

  it("lists Transactions newest first, flags pending ones, and leaves hidden ones out", async () => {
    const res = await (await signedIn()).get("/api/transactions");

    expect(res.status).toBe(200);
    const { transactions } = (await res.json()) as { transactions: TransactionView[] };
    expect(transactions.map((txn) => [txn.description, txn.amount, txn.pending])).toEqual([
      ["FAKE p1", -2_500, true],
      ["FAKE t3", -4_500, false],
      ["FAKE t2", -1_599, false],
      ["FAKE t1", 320_000, false],
    ]);
  });

  it("filters Transactions by Account and by posted date", async () => {
    const tab = await signedIn();

    const byAccount = await tab.get(`/api/transactions?account=${checkingId}`);
    const inRange = await tab.get("/api/transactions?from=2026-10-02&to=2026-10-03");

    const descriptions = async (res: Response) =>
      ((await res.json()) as { transactions: TransactionView[] }).transactions.map(
        (txn) => txn.description,
      );
    expect(await descriptions(byAccount)).toEqual(["FAKE t3", "FAKE t1"]);
    expect(await descriptions(inRange)).toEqual(["FAKE t3", "FAKE t2"]);
  });

  it("refuses a date that is not YYYY-MM-DD", async () => {
    const res = await (await signedIn()).get("/api/transactions?from=October");

    expect(res.status).toBe(400);
  });

  it("returns an Account's daily balances, with estimated days marked, and month ends", async () => {
    const res = await (await signedIn()).get(
      `/api/accounts/${checkingId}/balances?from=2026-10-02&to=2026-10-05`,
    );

    expect(res.status).toBe(200);
    expect((await res.json()) as BalancesView).toEqual({
      points: [
        { date: "2026-10-02", currentBalance: 252_500, availableBalance: null, estimated: true },
        { date: "2026-10-03", currentBalance: 248_000, availableBalance: null, estimated: true },
        { date: "2026-10-04", currentBalance: 248_000, availableBalance: null, estimated: true },
        { date: "2026-10-05", currentBalance: 248_000, availableBalance: null, estimated: false },
      ],
      monthEnds: [
        { month: "2026-10", date: "2026-10-05", currentBalance: 248_000, estimated: false },
      ],
    });
  });

  it("answers 404 for an Account that does not exist, and 400 for a bad date", async () => {
    const tab = await signedIn();

    expect((await tab.get("/api/accounts/no-such-account/balances")).status).toBe(404);
    expect((await tab.get(`/api/accounts/${checkingId}/balances?to=soon`)).status).toBe(400);
  });

  it("lets a Member close an Account, which drops its balance but keeps its Transactions", async () => {
    const tab = await signedIn();

    const res = await tab.post(`/api/accounts/${checkingId}/close`);

    expect(res.status).toBe(200);
    const { account } = (await res.json()) as { account: AccountView };
    expect(account).toMatchObject({
      id: checkingId,
      closed: true,
      currentBalance: null,
      availableBalance: null,
    });
    expect(Date.parse(account.closedAt ?? "")).not.toBeNaN();
    const listed = await tab.get(`/api/transactions?account=${checkingId}`);
    expect(
      ((await listed.json()) as { transactions: TransactionView[] }).transactions,
    ).toHaveLength(2);
  });

  it("lets a Member reopen a Closed Account", async () => {
    const tab = await signedIn();
    await tab.post(`/api/accounts/${checkingId}/close`);

    const res = await tab.post(`/api/accounts/${checkingId}/reopen`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { account: AccountView }).account).toMatchObject({
      closed: false,
      closedAt: null,
      currentBalance: 248_000,
    });
  });

  it("answers 404 when closing an Account that does not exist", async () => {
    const tab = await signedIn();

    expect((await tab.post("/api/accounts/no-such-account/close")).status).toBe(404);
    expect((await tab.post("/api/accounts/no-such-account/reopen")).status).toBe(404);
  });

  // Origins that are not APP_URL's: another port, another site, a look-alike that starts with
  // APP_URL's origin, an empty one, and none at all.
  const WRONG_ORIGINS = [
    "http://nas.local:9090",
    "http://evil.example",
    `${APP_URL}.evil.example`,
    "",
    undefined,
  ];

  async function isClosed(tab: TestBrowser): Promise<boolean | undefined> {
    const { accounts } = (await (await tab.get("/api/accounts")).json()) as {
      accounts: AccountView[];
    };
    return accounts.find((account) => account.id === checkingId)?.closed;
  }

  it("refuses to close an Account from any origin but APP_URL's, and changes nothing", async () => {
    const tab = await signedIn();

    for (const origin of WRONG_ORIGINS) {
      const res = await tab.send("POST", `/api/accounts/${checkingId}/close`, {}, { origin });
      expect(res.status, `origin ${origin}`).toBe(403);
    }
    expect(await isClosed(tab)).toBe(false);
  });

  it("refuses to reopen an Account from any origin but APP_URL's, and changes nothing", async () => {
    const tab = await signedIn();
    await tab.post(`/api/accounts/${checkingId}/close`);

    for (const origin of WRONG_ORIGINS) {
      const res = await tab.send("POST", `/api/accounts/${checkingId}/reopen`, {}, { origin });
      expect(res.status, `origin ${origin}`).toBe(403);
    }
    expect(await isClosed(tab)).toBe(true);
  });

  it("lists the Connections with their adapter's actions, and never a credential", async () => {
    const res = await (await signedIn()).get("/api/connections");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { connections: ConnectionView[] };
    expect(body.connections).toEqual([
      expect.objectContaining({
        provider: "fake",
        bankName: "First Fake Bank",
        health: "healthy",
        historyLoaded: true,
        actions: { repairInApp: true, importExisting: false, refresh: false },
      }),
    ]);
    expect(Object.keys(body.connections[0] ?? {})).not.toContain("credential");
  });
});
