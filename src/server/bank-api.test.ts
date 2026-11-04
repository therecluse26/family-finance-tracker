import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import { FakeBankAdapter, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { startBank, syncConnection } from "../bank/index.ts";
import { TEST_BANK_JOB_LIST } from "../bank/testing.ts";
import { addConnection, markSetupStep, readHistoryWait, saveSyncState } from "../db/index.ts";
import { startJobs } from "../jobs/index.ts";
import { waitFor } from "../jobs/testing.ts";
import { createLogger } from "../log.ts";
import { startNotify } from "../notify/index.ts";
import { createApp } from "./app.ts";
import type {
  AccountView,
  BalancesView,
  ConnectionView,
  HistoryStatusView,
  SyncNowView,
  TransactionView,
} from "./bank-views.ts";
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
    fake.actions = { repairInApp: true, importExisting: false, refresh: false };
    stopBank = startBank({ database: test.database, secrets: test.secrets, adapters: [fake] }).stop;
    member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    // Every write waits for the wizard's step 3 (T10).
    await markSetupStep(test.database, "master key", "done");

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
    connectionId = await addConnection(test.database, {
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
      "/api/history-status",
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

  describe("the Exclude switch", () => {
    const exclude = (tab: TestBrowser, body: unknown, headers = {}, id = checkingId) =>
      tab.send("PUT", `/api/accounts/${id}/exclude`, body, headers);
    async function excluded(tab: TestBrowser) {
      const { accounts } = (await (await tab.get("/api/accounts")).json()) as {
        accounts: AccountView[];
      };
      return accounts.find((account) => account.id === checkingId)?.excluded;
    }

    it("is off by default, and a Member turns it on and off; an excluded Account's balances drop out", async () => {
      const tab = await signedIn();
      expect(await excluded(tab)).toBe(false);

      const on = await exclude(tab, { excluded: true });
      expect(on.status).toBe(200);
      expect(((await on.json()) as { account: AccountView }).account).toMatchObject({
        excluded: true,
        closed: false,
        currentBalance: null,
        availableBalance: null,
      });

      const off = await exclude(tab, { excluded: false });
      expect(((await off.json()) as { account: AccountView }).account).toMatchObject({
        excluded: false,
        currentBalance: 248_000,
      });
    });

    it("answers 401 with no session, 403 from another origin, 415 to a body that is not JSON, and 400 to a bad body, and changes nothing", async () => {
      const stranger = new TestBrowser(app, APP_URL, "192.168.1.21");
      const refused = await exclude(stranger, { excluded: true });
      expect(refused.status).toBe(401);
      expect(await refused.text()).not.toContain("Everyday Checking");

      const tab = await signedIn();
      for (const origin of WRONG_ORIGINS) {
        expect((await exclude(tab, { excluded: true }, { origin })).status, `${origin}`).toBe(403);
      }
      expect(
        (await exclude(tab, { excluded: true }, { "content-type": "text/plain" })).status,
      ).toBe(415);
      for (const body of [{}, { excluded: "yes" }, { excluded: 1 }, { excluded: true, extra: 1 }]) {
        expect((await exclude(tab, body)).status, JSON.stringify(body)).toBe(400);
      }
      expect(await excluded(tab)).toBe(false);
    });

    it("answers 404 for an Account that does not exist", async () => {
      const tab = await signedIn();

      expect((await exclude(tab, { excluded: true }, {}, "no-such-account")).status).toBe(404);
    });
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
        // Synced at 15:00 UTC, with no Household time zone yet: the next slot is 18:07.
        lastSyncedAt: "2026-10-05T15:00:00.000Z",
        nextSyncAt: "2026-10-05T18:07:00.000Z",
        actions: { repairInApp: true, importExisting: false, refresh: false },
      }),
    ]);
    expect(Object.keys(body.connections[0] ?? {})).not.toContain("credential");
  });

  it("returns the history load's progress for each Connection still loading", async () => {
    const loading = await addConnection(test.database, {
      provider: "fake",
      bankId: "fake-second-bank",
      bankName: "Second Fake Bank",
      origin: "linked",
      syncMinute: 7,
    });
    const savings = fakeAccount({ id: "acc-savings" });
    fake.addPages("fake-second-bank", {
      accounts: [savings],
      added: [
        fakeTxn({ id: "s1", accountId: savings.id, amount: 1_000, postedDate: "2025-07-01" }),
        fakeTxn({ id: "s2", accountId: savings.id, amount: 2_000, postedDate: "2025-08-01" }),
      ],
      historyLoaded: false,
    });
    await syncConnection(loading);

    const res = await (await signedIn()).get("/api/history-status");

    expect(res.status).toBe(200);
    expect((await res.json()) as HistoryStatusView).toEqual({
      waitEnded: false,
      aiMayRun: false,
      loading: [
        {
          connectionId: loading,
          bankName: "Second Fake Bank",
          transactions: 2,
          oldestDate: "2025-07-01",
          holdsBackAi: true,
        },
      ],
    });
  });

  it("gives no next sync time for a Connection that does not poll", async () => {
    const nextSyncAt = new Date("2026-10-06T15:00:00.000Z");
    const tab = await signedIn();
    for (const health of ["needs a member", "broken"] as const) {
      await saveSyncState(test.database, connectionId, { health, nextSyncAt });

      const body = (await (await tab.get("/api/connections")).json()) as {
        connections: ConnectionView[];
      };

      expect(body.connections).toEqual([
        expect.objectContaining({
          health,
          lastSyncedAt: "2026-10-05T15:00:00.000Z",
          nextSyncAt: null,
        }),
      ]);
    }
  });
});

describe("Sync now", () => {
  let test: TestAuth;
  let app: App;
  let fake: FakeBankAdapter;
  let stopBank: () => void;
  let stopJobs: () => Promise<void>;
  let dir: string;
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
    fake.addPages(BANK, { accounts: [fakeAccount({ id: "acc-checking" })], historyLoaded: true });
    stopBank = startBank({ database: test.database, secrets: test.secrets, adapters: [fake] }).stop;
    dir = mkdtempSync(join(tmpdir(), "fft-sync-now-"));
    const jobs = await startJobs({
      jobsDb: join(dir, "jobs.db"),
      jobList: TEST_BANK_JOB_LIST,
      tasks: [],
      database: test.database,
    });
    stopJobs = jobs.stop;
    await markSetupStep(test.database, "master key", "done");
    connectionId = await addConnection(test.database, {
      provider: "fake",
      bankId: BANK,
      bankName: "First Fake Bank",
      origin: "linked",
      syncMinute: 7,
    });
  });

  afterEach(async () => {
    await stopJobs();
    stopBank();
    test.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lets any Member sync every Connection through its sync job", async () => {
    const member = await addMember(test.auth, { name: "Bob", email: "bob@example.com" });
    const tab = new TestBrowser(app, APP_URL, "192.168.1.22");
    await tab.signIn(member);

    const res = await tab.post("/api/sync-now");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { connections: SyncNowView[] };
    expect(body.connections).toEqual([
      { connectionId, bankName: "First Fake Bank", outcome: "syncing", refreshed: false },
    ]);
    await waitFor(() => fake.calls.length > 0);
  });

  it("lets any Member retry a stopped First run job, which then runs", async () => {
    const notify = startNotify({ database: test.database });
    try {
      // The First run started again twice, then stopped.
      await test.database.$client.execute(
        "INSERT INTO history_wait (id, ended_at, first_run_started_at, first_run_restarts) " +
          "VALUES (1, '2026-11-01T12:00:00.000Z', '2026-11-01T14:00:00.000Z', 3)",
      );
      const member = await addMember(test.auth, { name: "Bob", email: "bob@example.com" });
      const tab = new TestBrowser(app, APP_URL, "192.168.1.22");
      await tab.signIn(member);

      const res = await tab.post("/api/history-jobs/retry");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ firstRun: true, banksAddedLater: false });
      let done = false;
      for (let tries = 0; tries < 500 && !done; tries += 1) {
        done = (await readHistoryWait(test.database)).firstRunDoneAt !== null;
        if (!done) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(done).toBe(true);
      // Nothing is stopped now, so a second press starts nothing.
      expect(await (await tab.post("/api/history-jobs/retry")).json()).toEqual({
        firstRun: false,
        banksAddedLater: false,
      });
    } finally {
      notify.stop();
    }
  });

  it("answers 403 to Sync now and Retry from another origin or none, and changes nothing", async () => {
    // A stopped First run job, which a Retry would start again.
    await test.database.$client.execute(
      "INSERT INTO history_wait (id, ended_at, first_run_started_at, first_run_restarts) " +
        "VALUES (1, '2026-11-01T12:00:00.000Z', '2026-11-01T14:00:00.000Z', 3)",
    );
    const member = await addMember(test.auth, { name: "Bob", email: "bob@example.com" });
    const tab = new TestBrowser(app, APP_URL, "192.168.1.22");
    await tab.signIn(member);

    for (const path of ["/api/sync-now", "/api/history-jobs/retry"]) {
      expect((await tab.send("POST", path, {}, { origin: "http://evil.example" })).status).toBe(
        403,
      );
      expect((await tab.send("POST", path, {}, { origin: undefined })).status).toBe(403);
    }

    // Sidequest polls for jobs on real timers: give a started job time to run.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fake.calls).toEqual([]);
    const [wait] = (
      await test.database.$client.execute("SELECT first_run_restarts FROM history_wait")
    ).rows;
    expect(wait?.first_run_restarts).toBe(3);
  });

  it("answers 401 to a Retry with no session", async () => {
    const res = await new TestBrowser(app, APP_URL, "192.168.1.23").post("/api/history-jobs/retry");

    expect(res.status).toBe(401);
  });

  it("answers 401 to a browser with no session, and syncs nothing", async () => {
    const res = await new TestBrowser(app, APP_URL, "192.168.1.23").post("/api/sync-now");

    expect(res.status).toBe(401);
    // Sidequest polls for jobs on real timers: give a started job time to run.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fake.calls).toEqual([]);
  });
});
