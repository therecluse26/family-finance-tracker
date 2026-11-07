import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import { DEMO_BANKS, offerDemoBanks } from "../bank/demo.ts";
import { FakeBankAdapter } from "../bank/fake.ts";
import { startBank, syncConnection } from "../bank/index.ts";
import { addConnection, markConnectionRemoved, markSetupStep } from "../db/index.ts";
import { startFollowUpPipeline } from "../follow-up/index.ts";
import { createLogger } from "../log.ts";
import { startNotify } from "../notify/index.ts";
import { createApp } from "./app.ts";
import { devRoutes } from "./dev-routes.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// `pnpm dev`'s fake bank route, through the app's HTTP interface: it links the next demo bank
// through the fake adapter, by the normal link path. The built app has no such route. No test
// uses a real Bank-data provider or real bank data.

const APP_URL = "http://localhost:5173";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-dev-routes-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the fake bank route", () => {
  let test: TestAuth;
  // createDevApp's app, with the dev routes, and the built app's, without them.
  let devApp: App;
  let builtApp: App;
  let stopModules: () => void;
  let member: TestMember;
  let syncsStarted: string[];
  let lines: string[];
  let clients = 0;

  beforeEach(async () => {
    lines = [];
    // The bank module writes through the global log, to stdout; the server through its logger.
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => lines.push(String(chunk)) > 0);
    const logger = createLogger((line) => lines.push(line), { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, logger);
    const fake = new FakeBankAdapter();
    offerDemoBanks(fake);
    syncsStarted = [];
    const started = [
      startBank({
        database: test.database,
        secrets: test.secrets,
        adapters: [fake],
        startSync: async (connectionId) => {
          syncsStarted.push(connectionId);
        },
      }),
      startNotify({ database: test.database }),
      startFollowUpPipeline({ database: test.database, startJob: async () => {} }),
    ];
    stopModules = () => {
      for (const module of started) module.stop();
    };
    const security = await loadSecurity({ APP_URL }, { logger });
    devApp = createApp(webRoot, security, test.auth, test.database, test.secrets, {
      devRoutes: devRoutes(test.database),
    });
    builtApp = createApp(webRoot, security, test.auth, test.database, test.secrets);
    member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    // Every write waits for the wizard's step 3.
    await markSetupStep(test.database, "master key", "done");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    stopModules();
    test.close();
  });

  async function signedIn(app: App = devApp): Promise<TestBrowser> {
    clients += 1;
    const tab = new TestBrowser(app, APP_URL, `192.168.1.${clients}`);
    await tab.signIn(member);
    return tab;
  }

  const rows = async (sql: string) => (await test.database.$client.execute(sql)).rows;
  const linkFakeBank = (tab: TestBrowser) => tab.post("/api/dev/fake-bank", {});

  it("answers 401 with no session, 403 from another origin or with no Origin, and 415 to a body that is not JSON, and links nothing", async () => {
    const stranger = new TestBrowser(devApp, APP_URL, "192.168.1.200");
    expect((await linkFakeBank(stranger)).status).toBe(401);

    const tab = await signedIn();
    const fakeBank = "/api/dev/fake-bank";
    expect((await tab.send("POST", fakeBank, {}, { origin: "http://evil.example" })).status).toBe(
      403,
    );
    expect((await tab.send("POST", fakeBank, {}, { origin: undefined })).status).toBe(403);
    expect((await tab.send("POST", fakeBank, {}, { "content-type": "text/plain" })).status).toBe(
      415,
    );

    expect(await rows("SELECT id FROM connections")).toEqual([]);
    expect(syncsStarted).toEqual([]);
  });

  it("links the first demo bank as a Plaid bank links: a sealed credential, then its first sync", async () => {
    const tab = await signedIn();

    const res = await linkFakeBank(tab);

    expect(res.status).toBe(200);
    const first = DEMO_BANKS[0];
    const body = (await res.json()) as { connection: { id: string; bankName: string } };
    expect(body.connection.bankName).toBe(first?.bankName);
    const [connection] = await rows(
      "SELECT id, provider, bank_id, origin, credential, sync_held, next_sync_at FROM connections",
    );
    expect(connection).toMatchObject({
      id: body.connection.id,
      provider: "fake",
      bank_id: first?.bankId,
      origin: "linked",
      sync_held: 0,
    });
    // Sealed, so its plain text is nowhere in app.db or the log.
    expect(String(connection?.credential)).not.toContain("fake-credential-");
    expect(lines.join("\n")).not.toContain("fake-credential-");
    // As the schedule does for a due sync, so its next tick does not start a second one.
    expect(connection?.next_sync_at).not.toBeNull();
    expect(syncsStarted).toEqual([body.connection.id]);
  });

  it("starts a first sync that reads the demo bank's script: its Accounts and its whole history", async () => {
    const tab = await signedIn();
    const { connection } = (await (await linkFakeBank(tab)).json()) as {
      connection: { id: string };
    };
    const first = DEMO_BANKS[0];
    const records = new Set(first?.pages.flatMap((page) => page.added ?? []).map((txn) => txn.id));

    await syncConnection(connection.id);

    const accounts = await rows("SELECT provider_account_id FROM household_accounts");
    expect(accounts.map((row) => row.provider_account_id).sort()).toEqual(
      first?.accounts.map((account) => account.id).sort(),
    );
    const [stored] = await rows("SELECT history_loaded FROM connections");
    expect(stored?.history_loaded).toBe(1);
    const [count] = await rows("SELECT count(*) AS n FROM transactions");
    expect(Number(count?.n)).toBeGreaterThan(0);
    expect(Number(count?.n)).toBeLessThanOrEqual(records.size);
  });

  it("links the next demo bank each time, then refuses once every demo bank is linked", async () => {
    const tab = await signedIn();

    const linked: string[] = [];
    for (const _demo of DEMO_BANKS) {
      const res = await linkFakeBank(tab);
      expect(res.status).toBe(200);
      linked.push(((await res.json()) as { connection: { bankName: string } }).connection.bankName);
    }
    const refused = await linkFakeBank(tab);

    expect(linked).toEqual(DEMO_BANKS.map((demo) => demo.bankName));
    expect(refused.status).toBe(409);
    expect(await rows("SELECT id FROM connections")).toHaveLength(DEMO_BANKS.length);
    expect(syncsStarted).toHaveLength(DEMO_BANKS.length);
  });

  it("links a removed demo bank again, since a removed Connection covers no bank", async () => {
    const tab = await signedIn();
    const first = DEMO_BANKS[0];
    const removed = await addConnection(test.database, {
      provider: "fake",
      bankId: first?.bankId ?? "",
      bankName: first?.bankName ?? "",
      origin: "linked",
    });
    await markConnectionRemoved(test.database, removed);

    const res = await linkFakeBank(tab);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { connection: { bankName: string } }).connection.bankName).toBe(
      first?.bankName,
    );
  });

  it("never starts a sync of a held Connection: only the new Connection's first sync starts", async () => {
    const tab = await signedIn();
    const first = DEMO_BANKS[0];
    // A held Connection at the first demo bank, as after a duplicate found after a link.
    const held = await addConnection(test.database, {
      provider: "fake",
      bankId: first?.bankId ?? "",
      bankName: first?.bankName ?? "",
      origin: "linked",
      syncHeld: true,
    });

    const res = await linkFakeBank(tab);

    expect(res.status).toBe(200);
    const { connection } = (await res.json()) as { connection: { id: string; bankName: string } };
    // The held Connection covers its bank, so the route links the next one.
    expect(connection.bankName).toBe(DEMO_BANKS[1]?.bankName);
    expect(syncsStarted).toEqual([connection.id]);
    expect(syncsStarted).not.toContain(held);
  });

  it("is not in the built app, which answers 404 and links nothing", async () => {
    const tab = await signedIn(builtApp);

    const res = await linkFakeBank(tab);

    expect(res.status).toBe(404);
    expect(await rows("SELECT id FROM connections")).toEqual([]);
    expect(syncsStarted).toEqual([]);
  });

  it("tells Settings that the fake adapter runs, so it offers the fake bank", async () => {
    const tab = await signedIn();

    const body = (await (await tab.get("/api/connections")).json()) as { fakeBank: boolean };

    expect(body.fakeBank).toBe(true);
  });
});

describe("the Connection list without the fake adapter", () => {
  it("tells Settings that the fake adapter does not run, as in the built app", async () => {
    const logger = createLogger(() => {}, { throwOnSecretField: true });
    const test = await newTestAuth(APP_URL, logger);
    const bank = startBank({ database: test.database, secrets: test.secrets, adapters: [] });
    try {
      const app = createApp(
        webRoot,
        await loadSecurity({ APP_URL }, { logger }),
        test.auth,
        test.database,
        test.secrets,
      );
      const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
      const tab = new TestBrowser(app, APP_URL, "192.168.1.250");
      await tab.signIn(member);

      const body = (await (await tab.get("/api/connections")).json()) as { fakeBank: boolean };

      expect(body.fakeBank).toBe(false);
    } finally {
      bank.stop();
      test.close();
    }
  });
});
