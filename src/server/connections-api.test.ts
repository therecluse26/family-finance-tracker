import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import {
  FakePlaid,
  newAccessToken,
  newItemId,
  newLinkToken,
  newPublicToken,
  plaidFailure,
  RECORDED,
} from "../bank/fake-plaid.ts";
import { plaidAdapter, plaidSettings, startBank } from "../bank/index.ts";
import { newPlaidKeys } from "../bank/testing.ts";
import {
  addConnection,
  markSetupStep,
  PLAID_SETTINGS_ROW,
  saveSyncState,
  storeItemsUsed,
  storePlaidKeys,
} from "../db/index.ts";
import { startFollowUpPipeline } from "../follow-up/index.ts";
import { createLogger } from "../log.ts";
import { startNotify } from "../notify/index.ts";
import { createApp } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// Settings → Banks' Connection routes, through the app's HTTP interface, on Plaid's real client
// pointed at a fake Plaid server (spec 02, Linking a new bank). No test calls Plaid. Every token is
// made when the test runs.

const APP_URL = "http://nas.local:8080";
const TOTP_STEP_MS = 30_000;
const LINK_TOKEN = "/link/token/create";
const EXCHANGE = "/item/public_token/exchange";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-connections-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the Connection routes", () => {
  let test: TestAuth;
  let app: App;
  let plaid: FakePlaid;
  let stopBank: () => void;
  let lines: string[];
  let alice: TestMember;
  let syncsStarted: string[];
  let followUpsAsked: number;
  let stopOthers: () => void;
  let clients = 0;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    lines = [];
    // The bank module writes through the global log, to stdout; the server through its logger.
    // Both go into `lines`.
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => lines.push(String(chunk)) > 0);
    const logger = createLogger((line) => lines.push(line), { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, logger);
    plaid = new FakePlaid();
    await plaid.start();
    syncsStarted = [];
    stopBank = startBank({
      database: test.database,
      secrets: test.secrets,
      adapters: [
        plaidAdapter({
          database: test.database,
          secrets: test.secrets,
          clientFor: plaid.clientFor,
        }),
      ],
      startSync: async (connectionId) => {
        syncsStarted.push(connectionId);
      },
    }).stop;
    followUpsAsked = 0;
    const others = [
      startNotify({ database: test.database }),
      startFollowUpPipeline({
        database: test.database,
        startJob: async () => {
          followUpsAsked += 1;
        },
      }),
    ];
    stopOthers = () => {
      for (const started of others) started.stop();
    };
    app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger }),
      test.auth,
      test.database,
      test.secrets,
      { plaid: plaidSettings({ database: test.database, secrets: test.secrets, logger }) },
    );
    alice = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    const keys = newPlaidKeys();
    await storePlaidKeys(test.database, {
      clientId: keys.clientId,
      secret: test.secrets.encrypt(keys.secret, {
        rowId: PLAID_SETTINGS_ROW,
        column: "plaid_settings.secret",
      }),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    stopOthers();
    stopBank();
    test.close();
    await plaid.close();
  });

  async function finishWizard(): Promise<void> {
    await markSetupStep(test.database, "master key", "done");
    await markSetupStep(test.database, "household facts", "done");
  }

  // Signed in, with the clock moved on one TOTP step, so the next code is fresh.
  async function signedIn(): Promise<TestBrowser> {
    clients += 1;
    const tab = new TestBrowser(app, APP_URL, `192.168.1.${clients}`);
    await tab.signIn(alice);
    vi.setSystemTime(Date.now() + TOTP_STEP_MS);
    return tab;
  }

  const rows = async (sql: string) => (await test.database.$client.execute(sql)).rows;

  // Link's onSuccess, as the browser sends it.
  const linked = (fields: Record<string, unknown> = {}) => ({
    publicToken: newPublicToken(),
    bankId: "ins_new",
    bankName: "New Bank",
    accounts: [{ name: "Checking", type: "depository", subtype: "checking", mask: "1111" }],
    ...fields,
  });

  describe("linking a new bank", () => {
    it("answers 401 with no session, 403 from another origin, 409 before the wizard, and 415 to a body that is not JSON", async () => {
      const stranger = new TestBrowser(app, APP_URL, "192.168.1.200");
      expect((await stranger.post("/api/plaid/link-token", {})).status).toBe(401);
      expect((await stranger.post("/api/plaid/link", linked())).status).toBe(401);

      const tab = await signedIn();
      await markSetupStep(test.database, "master key", "done");
      expect((await tab.post("/api/plaid/link-token", {})).status).toBe(409);

      await finishWizard();
      const elsewhere = { origin: "http://evil.example" };
      expect((await tab.send("POST", "/api/plaid/link-token", {}, elsewhere)).status).toBe(403);
      expect((await tab.send("POST", "/api/plaid/link", linked(), elsewhere)).status).toBe(403);
      const plain = { "content-type": "text/plain" };
      expect((await tab.send("POST", "/api/plaid/link", linked(), plain)).status).toBe(415);
      expect(plaid.requests).toEqual([]);
    });

    it("hands out a link token that is not cached, and asks for a second confirmation at N of 8", async () => {
      await finishWizard();
      const tab = await signedIn();
      const linkToken = newLinkToken();
      plaid.answer(LINK_TOKEN, { body: { link_token: linkToken } });

      const first = await tab.post("/api/plaid/link-token", {});
      expect(first.status).toBe(200);
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(await first.json()).toEqual({ linkToken, itemsUsed: 0 });

      await storeItemsUsed(test.database, 8);
      const unconfirmed = await tab.post("/api/plaid/link-token", {});
      expect(unconfirmed.status).toBe(409);
      expect(await unconfirmed.json()).toMatchObject({ confirm: true, itemsUsed: 8 });
      expect((await tab.post("/api/plaid/link-token", { confirmed: true })).status).toBe(200);

      await storeItemsUsed(test.database, 10);
      const blocked = await tab.post("/api/plaid/link-token", { confirmed: true });
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({ itemsUsed: 10 });
      expect(plaid.to(LINK_TOKEN)).toHaveLength(2);
    });

    it("links the bank, starts its first sync, and answers with no token", async () => {
      await finishWizard();
      const tab = await signedIn();
      const accessToken = newAccessToken();
      const itemId = newItemId();
      plaid.answer(EXCHANGE, { body: { access_token: accessToken, item_id: itemId } });
      plaid.answer("/item/get", {
        body: {
          item: { item_id: itemId, institution_id: "ins_new", institution_name: "New Bank" },
        },
      });
      const body = linked();

      const res = await tab.post("/api/plaid/link", body);

      expect(res.status).toBe(200);
      const text = await res.text();
      const [connection] = await rows("SELECT id, origin FROM connections");
      expect(JSON.parse(text)).toEqual({
        connection: { id: connection?.id, bankName: "New Bank" },
      });
      expect(connection?.origin).toBe("linked");
      expect(syncsStarted).toEqual([connection?.id]);
      for (const secret of [body.publicToken, accessToken, itemId]) {
        expect(text).not.toContain(secret);
        expect(lines.join("")).not.toContain(secret);
      }
    });

    it("blocks a duplicate bank before the exchange, and names the Connection that covers it", async () => {
      await finishWizard();
      const tab = await signedIn();
      const covering = await addConnection(test.database, {
        provider: "plaid",
        bankId: "ins_new",
        bankName: "New Bank",
        origin: "imported",
      });

      const res = await tab.post("/api/plaid/link", linked());

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        coveredBy: { connectionId: covering, bankName: "New Bank" },
        error:
          "This bank is already connected as New Bank. A bank has one Connection, so the app did not link it again.",
      });
      expect(plaid.to(EXCHANGE)).toEqual([]);
    });

    // The browser's bank ID is the Broken Connection's; Plaid's /item/get names another bank.
    it("says Link again replaced nothing when Plaid names another bank, with no token in the answer", async () => {
      await finishWizard();
      const tab = await signedIn();
      const broken = await addConnection(test.database, {
        provider: "plaid",
        bankId: "ins_new",
        bankName: "New Bank",
        origin: "linked",
      });
      await saveSyncState(test.database, broken, { health: "broken" });
      const accessToken = newAccessToken();
      const itemId = newItemId();
      plaid.answer(EXCHANGE, { body: { access_token: accessToken, item_id: itemId } });
      plaid.answer("/item/get", {
        body: {
          item: { item_id: itemId, institution_id: "ins_other", institution_name: "Other Bank" },
        },
      });

      const res = await tab.post("/api/plaid/link", linked({ replaces: broken }));

      expect(res.status).toBe(409);
      const text = await res.text();
      const added = (await rows("SELECT id FROM connections WHERE bank_id = 'ins_other'"))[0]?.id;
      expect(JSON.parse(text)).toEqual({
        connection: { id: added, bankName: "Other Bank" },
        error:
          "Plaid linked Other Bank, not the Broken Connection's bank. It was added as a new Connection, and nothing was replaced.",
      });
      expect(await rows(`SELECT removed_at FROM connections WHERE id = '${broken}'`)).toEqual([
        { removed_at: null },
      ]);
      for (const secret of [accessToken, itemId]) {
        expect(text).not.toContain(secret);
        expect(lines.join("")).not.toContain(secret);
      }
    });

    it("says Link again replaced nothing when Plaid does not confirm the bank", async () => {
      await finishWizard();
      const tab = await signedIn();
      const broken = await addConnection(test.database, {
        provider: "plaid",
        bankId: "ins_new",
        bankName: "New Bank",
        origin: "linked",
      });
      await saveSyncState(test.database, broken, { health: "broken" });
      plaid.answer(EXCHANGE, { body: { access_token: newAccessToken(), item_id: newItemId() } });
      plaid.answer("/item/get", {
        status: 500,
        body: plaidFailure("API_ERROR", "INTERNAL_SERVER_ERROR"),
      });

      const res = await tab.post("/api/plaid/link", linked({ replaces: broken }));

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error:
          "Plaid did not confirm which bank was linked, so it was added as a new Connection, and nothing was replaced. If it is the Broken Connection's bank, Remove the Broken Connection.",
      });
      expect(await rows(`SELECT removed_at FROM connections WHERE id = '${broken}'`)).toEqual([
        { removed_at: null },
      ]);
    });

    it("refuses a public token or metadata the browser's link screen does not send", async () => {
      await finishWizard();
      const tab = await signedIn();

      for (const body of [
        linked({ publicToken: "not-a-token" }),
        linked({ bankId: "ins new; drop" }),
        linked({ accounts: [{ name: "X", type: "depository", subtype: null, mask: "12 34" }] }),
        { ...linked(), publicToken: undefined },
      ]) {
        expect((await tab.post("/api/plaid/link", body)).status).toBe(400);
      }
      expect(plaid.requests).toEqual([]);
    });
  });

  describe("importing a Plaid Connection", () => {
    // Plaid's recorded /item/get and /accounts/get answers for a new token.
    function knownToken() {
      const item = { ...RECORDED.itemGet.item, item_id: newItemId() };
      plaid.answer("/item/get", { body: { ...RECORDED.itemGet, item } });
      plaid.answer("/accounts/get", { body: { ...RECORDED.accountsGet, item } });
      return { accessToken: newAccessToken(), itemId: String(item.item_id) };
    }

    it("answers 401 with no session, 403 from another origin, and 400 to a body that is not an access token", async () => {
      const stranger = new TestBrowser(app, APP_URL, "192.168.1.201");
      const body = { accessToken: newAccessToken() };
      expect((await stranger.post("/api/plaid/import/preview", body)).status).toBe(401);
      expect((await stranger.post("/api/plaid/import", body)).status).toBe(401);

      await finishWizard();
      const tab = await signedIn();
      const elsewhere = { origin: "http://evil.example" };
      expect((await tab.send("POST", "/api/plaid/import", body, elsewhere)).status).toBe(403);
      for (const accessToken of ["", "public-production-abcdefgh", "access-production-a b c d e"]) {
        expect((await tab.post("/api/plaid/import/preview", { accessToken })).status).toBe(400);
      }
      expect(plaid.requests).toEqual([]);
    });

    it("previews the bank and its Accounts, then saves it, and never answers with the token", async () => {
      await finishWizard();
      const tab = await signedIn();
      const { accessToken, itemId } = knownToken();
      knownToken();

      const preview = await tab.post("/api/plaid/import/preview", { accessToken });
      expect(preview.status).toBe(200);
      const previewText = await preview.text();
      expect(JSON.parse(previewText)).toMatchObject({
        bankName: "Fake Plaid Bank",
        accounts: expect.arrayContaining([
          { name: "Plaid Checking", type: "depository", subtype: "checking", mask: "0000" },
        ]),
      });
      expect(await rows("SELECT count(*) AS n FROM connections")).toEqual([{ n: 0 }]);

      const saved = await tab.post("/api/plaid/import", { accessToken });
      expect(saved.status).toBe(200);
      const savedText = await saved.text();
      const [connection] = await rows("SELECT id, origin FROM connections");
      expect(JSON.parse(savedText)).toEqual({
        connection: { id: connection?.id, bankName: "Fake Plaid Bank" },
      });
      expect(connection?.origin).toBe("imported");
      expect(syncsStarted).toEqual([connection?.id]);
      for (const secret of [accessToken, itemId]) {
        expect(previewText).not.toContain(secret);
        expect(savedText).not.toContain(secret);
        expect(lines.join("")).not.toContain(secret);
      }
    });

    it("says Plaid rejected the token, names no token, and saves nothing", async () => {
      await finishWizard();
      const tab = await signedIn();
      const accessToken = newAccessToken();
      plaid.answer("/item/get", {
        status: 400,
        body: plaidFailure("INVALID_INPUT", "INVALID_ACCESS_TOKEN"),
      });

      const res = await tab.post("/api/plaid/import", { accessToken });

      expect(res.status).toBe(502);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({
        error: "Plaid answered INVALID_ACCESS_TOKEN (INVALID_INPUT). Nothing was saved.",
      });
      expect(text).not.toContain(accessToken);
      expect(lines.join("")).not.toContain(accessToken);
      expect(await rows("SELECT count(*) AS n FROM connections")).toEqual([{ n: 0 }]);
    });
  });

  describe("removing a Connection", () => {
    let connectionId: string;
    let accessToken: string;

    beforeEach(async () => {
      await finishWizard();
      accessToken = newAccessToken();
      connectionId = await addConnection(test.database, {
        provider: "plaid",
        bankId: "ins_fake",
        bankName: "Fake Plaid Bank",
        origin: "linked",
        sealCredential: (rowId) =>
          test.secrets.encrypt(accessToken, { rowId, column: "connections.credential" }),
      });
    });

    const remove = (tab: TestBrowser, body: unknown, headers?: Record<string, string>) =>
      tab.send("POST", `/api/connections/${connectionId}/remove`, body, headers);
    const removedAt = async () =>
      (await rows("SELECT removed_at FROM connections"))[0]?.removed_at ?? null;
    const wrongCode = async () =>
      (await alice.totpCode()).replace(/\d/g, (digit) => String((Number(digit) + 1) % 10));

    it("answers 401 with no session, 403 from another origin, and 415 to a body that is not JSON, and removes nothing", async () => {
      const stranger = new TestBrowser(app, APP_URL, "192.168.1.202");
      expect((await remove(stranger, { code: "000000" })).status).toBe(401);
      const tab = await signedIn();
      const code = await alice.totpCode();
      expect((await remove(tab, { code }, { origin: "http://evil.example" })).status).toBe(403);
      expect(
        (
          await tab.send(
            "POST",
            `/api/connections/${connectionId}/delete-history`,
            { confirmed: true },
            { origin: "http://evil.example" },
          )
        ).status,
      ).toBe(403);
      const plain = { "content-type": "text/plain" };
      expect((await remove(tab, { code }, plain)).status).toBe(415);
      expect(
        (
          await tab.send(
            "POST",
            `/api/connections/${connectionId}/delete-history`,
            { confirmed: true },
            plain,
          )
        ).status,
      ).toBe(415);
      expect(plaid.requests).toEqual([]);
      expect(await removedAt()).toBeNull();
    });

    it("asks for a fresh TOTP code before it calls Plaid, and refuses after 5 wrong ones", async () => {
      const tab = await signedIn();

      expect((await remove(tab, {})).status).toBe(400);
      const wrong = await wrongCode();
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await remove(tab, { code: wrong })).status);
      const refused = await remove(tab, { code: await alice.totpCode() });

      expect(statuses).toEqual([401, 401, 401, 401, 401]);
      expect(refused.status).toBe(429);
      expect(plaid.requests).toEqual([]);
      expect(await removedAt()).toBeNull();
    });

    it("removes the Connection with a fresh code, and answers with no token", async () => {
      const tab = await signedIn();
      plaid.answer("/item/remove", { body: RECORDED.itemRemove });

      const res = await remove(tab, { code: await alice.totpCode() });

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ removed: true });
      expect(await removedAt()).not.toBeNull();
      expect(text).not.toContain(accessToken);
      expect(lines.join("")).not.toContain(accessToken);
      const listed = await (await tab.get("/api/connections")).json();
      expect(listed).toMatchObject({ connections: [{ id: connectionId, removed: true }] });
    });

    it("says so when Plaid does not answer, and removes nothing", async () => {
      const tab = await signedIn();
      plaid.answer("/item/remove", {
        status: 500,
        body: plaidFailure("API_ERROR", "INTERNAL_SERVER_ERROR"),
      });

      const res = await remove(tab, { code: await alice.totpCode() });

      expect(res.status).toBe(502);
      expect(await removedAt()).toBeNull();
    });

    it("deletes history only with its own confirmation, and only after Remove", async () => {
      const tab = await signedIn();
      const deleteHistory = (body: unknown) =>
        tab.post(`/api/connections/${connectionId}/delete-history`, body);

      expect((await deleteHistory({ confirmed: true })).status).toBe(409);
      plaid.answer("/item/remove", { body: RECORDED.itemRemove });
      expect((await remove(tab, { code: await alice.totpCode() })).status).toBe(200);
      for (const body of [{}, { confirmed: false }, { confirmed: "true" }]) {
        expect((await deleteHistory(body)).status).toBe(400);
      }
      const deleted = await deleteHistory({ confirmed: true });

      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ accounts: 0, transactions: 0 });
      expect(followUpsAsked).toBe(1);
      expect(await rows("SELECT count(*) AS n FROM connections")).toEqual([{ n: 0 }]);
      expect((await deleteHistory({ confirmed: true })).status).toBe(404);
    });
  });

  // Spec 02, Repair and New accounts at a bank: Plaid Link in update mode.
  describe("Repair and Add accounts", () => {
    let connectionId: string;
    let accessToken: string;

    beforeEach(async () => {
      await finishWizard();
      accessToken = newAccessToken();
      connectionId = await addConnection(test.database, {
        provider: "plaid",
        bankId: "ins_fake",
        bankName: "Fake Plaid Bank",
        origin: "linked",
        sealCredential: (rowId) =>
          test.secrets.encrypt(accessToken, { rowId, column: "connections.credential" }),
      });
    });

    const paths = () =>
      ["repair", "add-accounts", "update-finished"].map(
        (action) => `/api/connections/${connectionId}/${action}`,
      );

    it("answers 401 with no session, 403 from another origin, and 415 to a body that is not JSON", async () => {
      const stranger = new TestBrowser(app, APP_URL, "192.168.1.203");
      const tab = await signedIn();
      for (const path of paths()) {
        expect((await stranger.post(path, {})).status).toBe(401);
        expect((await tab.send("POST", path, {}, { origin: "http://evil.example" })).status).toBe(
          403,
        );
        expect((await tab.send("POST", path, {}, { origin: undefined })).status).toBe(403);
        expect((await tab.send("POST", path, {}, { "content-type": "text/plain" })).status).toBe(
          415,
        );
      }
      expect(plaid.requests).toEqual([]);
      expect(syncsStarted).toEqual([]);
    });

    it("hands out an update-mode link token that is not cached, with no access token in any answer or log line", async () => {
      await saveSyncState(test.database, connectionId, { health: "needs a member" });
      const tab = await signedIn();
      const linkToken = newLinkToken();
      plaid.answer(LINK_TOKEN, { body: { link_token: linkToken } });

      const repair = await tab.post(`/api/connections/${connectionId}/repair`, {});
      const added = await tab.post(`/api/connections/${connectionId}/add-accounts`, {});

      for (const res of [repair, added]) {
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        const text = await res.text();
        expect(JSON.parse(text)).toEqual({ linkToken });
        expect(text).not.toContain(accessToken);
      }
      const [repairRequest, addRequest] = plaid.to(LINK_TOKEN);
      expect(repairRequest?.body).toMatchObject({ access_token: accessToken });
      expect(repairRequest?.body).not.toHaveProperty("products");
      expect(repairRequest?.body).not.toHaveProperty("update");
      expect(addRequest?.body).toMatchObject({
        access_token: accessToken,
        update: { account_selection_enabled: true },
      });
      // The bank module's own log lines are captured too.
      expect(lines.join("")).toContain("Opened Repair");
      for (const secret of [accessToken, linkToken]) {
        expect(lines.join("")).not.toContain(secret);
      }
      expect(await rows("SELECT count(*) AS n FROM connections")).toEqual([{ n: 1 }]);
    });

    it("refuses Repair for a Healthy Connection, and offers Link again for a Broken one", async () => {
      const tab = await signedIn();

      expect((await tab.post(`/api/connections/${connectionId}/repair`, {})).status).toBe(409);
      await saveSyncState(test.database, connectionId, { health: "broken" });
      for (const path of paths()) {
        const res = await tab.post(path, {});
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ linkAgain: true });
      }
      expect((await tab.post("/api/connections/no-such-connection/repair", {})).status).toBe(404);
      expect(plaid.requests).toEqual([]);
    });

    it("refuses every update-mode route for a held Connection, and starts no sync", async () => {
      const held = await addConnection(test.database, {
        provider: "plaid",
        bankId: "ins_fake",
        bankName: "Fake Plaid Bank",
        origin: "linked",
        syncHeld: true,
      });
      const tab = await signedIn();

      for (const action of ["repair", "add-accounts", "update-finished"]) {
        const res = await tab.post(`/api/connections/${held}/${action}`, {});
        expect(res.status).toBe(409);
        expect(await res.json()).toEqual({
          error:
            "This Connection is not in use: it is a second Connection to a bank another Connection covers, so it never syncs. Remove it.",
        });
      }
      expect(syncsStarted).toEqual([]);
      expect(plaid.requests).toEqual([]);
    });

    it("starts the Connection's sync at once when update mode finishes", async () => {
      await saveSyncState(test.database, connectionId, { health: "needs a member" });
      const tab = await signedIn();

      const res = await tab.post(`/api/connections/${connectionId}/update-finished`, {});

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ syncing: true });
      expect(syncsStarted).toEqual([connectionId]);
      // Asking again at once starts no second sync.
      const again = await tab.post(`/api/connections/${connectionId}/update-finished`, {});
      expect(await again.json()).toEqual({ syncing: false });
      expect(syncsStarted).toEqual([connectionId]);
    });

    it("says what Plaid answered when it refuses, with no token, and changes nothing", async () => {
      await saveSyncState(test.database, connectionId, { health: "needs a member" });
      const tab = await signedIn();
      plaid.answer(LINK_TOKEN, {
        status: 400,
        body: plaidFailure("INVALID_INPUT", "INVALID_ACCESS_TOKEN"),
      });

      const res = await tab.post(`/api/connections/${connectionId}/repair`, {});

      expect(res.status).toBe(502);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({
        error: "Plaid answered INVALID_ACCESS_TOKEN (INVALID_INPUT). Nothing changed.",
      });
      expect(text).not.toContain(accessToken);
      expect(lines.join("")).not.toContain(accessToken);
    });
  });
});
