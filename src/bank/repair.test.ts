import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addConnection,
  markConnectionRemoved,
  PLAID_SETTINGS_ROW,
  readPlaidSettings,
  storePlaidKeys,
} from "../db/index.ts";
import { holdsSecretValue } from "../log.ts";
import {
  FakePlaid,
  newAccessToken,
  newItemId,
  newLinkToken,
  plaidAccount,
  plaidFailure,
  plaidSyncPage,
  RECORDED,
} from "./fake-plaid.ts";
import {
  type ConnectionRepairing,
  connectionRepairing,
  plaidAdapter,
  runSyncJob,
  syncConnection,
} from "./index.ts";
import { newPlaidKeys, newTestBank, type TestBank } from "./testing.ts";

// Repair and Add accounts (spec 02, Repair and New accounts at a bank): Plaid Link in update mode,
// on Plaid's real client pointed at a fake Plaid server. No test calls Plaid. Every token is made
// when the test runs.

const LINK_TOKEN = "/link/token/create";
const SYNC = "/transactions/sync";
const ITEM_GET = "/item/get";
const MINUTE_MS = 60_000;

describe("repairing a Plaid Connection in update mode", () => {
  let bank: TestBank;
  let plaid: FakePlaid;
  let repairing: ConnectionRepairing;
  let connectionId: string;
  let accessToken: string;

  beforeEach(async () => {
    plaid = new FakePlaid();
    await plaid.start();
    bank = await newTestBank({
      adapters: ({ database, secrets }) => [
        plaidAdapter({ database, secrets, clientFor: plaid.clientFor }),
      ],
    });
    const keys = newPlaidKeys();
    await storePlaidKeys(bank.database, {
      clientId: keys.clientId,
      secret: bank.secrets.encrypt(keys.secret, {
        rowId: PLAID_SETTINGS_ROW,
        column: "plaid_settings.secret",
      }),
    });
    accessToken = newAccessToken();
    connectionId = await addConnection(bank.database, {
      provider: "plaid",
      bankId: "ins_fake",
      bankName: "Fake Plaid Bank",
      origin: "linked",
      sealCredential: (rowId) =>
        bank.secrets.encrypt(accessToken, { rowId, column: "connections.credential" }),
    });
    plaid.answer(SYNC, { body: plaidSyncPage("cursor-1") });
    plaid.answer("/accounts/get", {
      body: { accounts: [plaidAccount({ account_id: "acct-checking", mask: "0000" })] },
    });
    await syncConnection(connectionId);
    repairing = connectionRepairing();
  });

  afterEach(async () => {
    bank.close();
    await plaid.close();
  });

  const rows = async (sql: string) => (await bank.database.$client.execute(sql)).rows;
  const openNotices = () =>
    rows("SELECT kind, condition FROM system_notices WHERE closed_at IS NULL ORDER BY rowid");

  // The next sync finds the Item's error, which sets the Connection's health.
  async function syncFails(type: string, code: string) {
    plaid.answer(SYNC, { status: 400, body: plaidFailure(type, code) });
    await expect(syncConnection(connectionId)).rejects.toThrow(code);
  }

  const needsAMember = () => syncFails("ITEM_ERROR", "ITEM_LOGIN_REQUIRED");

  it("asks for a link token in update mode: the Connection's access token, no products, and nothing about the Household", async () => {
    await needsAMember();
    const linkToken = newLinkToken();
    plaid.answer(LINK_TOKEN, { body: { link_token: linkToken, request_id: "req-link" } });
    const [before] = await rows("SELECT credential FROM connections");
    const itemsBefore = await readPlaidSettings(bank.database);

    expect(await repairing.startRepair(connectionId)).toEqual({ outcome: "ready", linkToken });

    const [request] = plaid.to(LINK_TOKEN);
    const { user, ...settings } = request?.body ?? {};
    expect(settings).toEqual({
      client_name: "Family Finance Tracker",
      country_codes: ["US"],
      language: "en",
      access_token: accessToken,
    });
    // An opaque ID made for this token: no name, email, or phone.
    expect(Object.keys(user as object)).toEqual(["client_user_id"]);
    expect((user as { client_user_id: string }).client_user_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(holdsSecretValue(linkToken)).toBe(true);
    expect(holdsSecretValue(accessToken)).toBe(true);
    // The same Connection and access token: nothing is exchanged, and no Item is spent.
    expect(plaid.to("/item/public_token/exchange")).toEqual([]);
    expect(await rows("SELECT credential FROM connections")).toEqual([before]);
    expect(await readPlaidSettings(bank.database)).toEqual(itemsBefore);
  });

  it("opens Add accounts in update mode with account selection, and spends no Item", async () => {
    const linkToken = newLinkToken();
    plaid.answer(LINK_TOKEN, { body: { link_token: linkToken } });
    const itemsBefore = await readPlaidSettings(bank.database);

    expect(await repairing.startAddAccounts(connectionId)).toEqual({ outcome: "ready", linkToken });

    const [request] = plaid.to(LINK_TOKEN);
    expect(request?.body).toMatchObject({
      access_token: accessToken,
      update: { account_selection_enabled: true },
    });
    expect(request?.body).not.toHaveProperty("products");
    expect(await rows("SELECT count(*) AS n FROM connections")).toEqual([{ n: 1 }]);
    expect(await readPlaidSettings(bank.database)).toEqual(itemsBefore);
  });

  it("offers Link again for a Broken Connection, and calls nothing", async () => {
    await syncFails("ITEM_ERROR", "ITEM_NOT_FOUND");
    plaid.requests.length = 0;

    expect(await repairing.startRepair(connectionId)).toEqual({ outcome: "link again" });
    expect(await repairing.startAddAccounts(connectionId)).toEqual({ outcome: "link again" });
    expect(await repairing.finishUpdate(connectionId)).toEqual({ outcome: "link again" });
    expect(plaid.requests).toEqual([]);
    expect(bank.syncsStarted).toEqual([]);
  });

  it("repairs only a Connection that needs a Member, and nothing removed or unknown", async () => {
    expect(await repairing.startRepair(connectionId)).toEqual({ outcome: "not needed" });
    await markConnectionRemoved(bank.database, connectionId);
    expect(await repairing.startAddAccounts(connectionId)).toEqual({ outcome: "not found" });
    expect(await repairing.finishUpdate(connectionId)).toEqual({ outcome: "not found" });
    expect(await repairing.startRepair("no-such-connection")).toEqual({ outcome: "not found" });
    expect(plaid.to(LINK_TOKEN)).toEqual([]);
  });

  it("answers Plaid's refusal, sorted, with no token in it", async () => {
    await needsAMember();
    plaid.answer(LINK_TOKEN, {
      status: 400,
      body: plaidFailure("INVALID_INPUT", "INVALID_ACCESS_TOKEN"),
    });

    const answer = await repairing.startRepair(connectionId);

    expect(answer).toEqual({
      outcome: "provider error",
      message: "Plaid answered INVALID_ACCESS_TOKEN (INVALID_INPUT).",
    });
    expect(JSON.stringify(answer)).not.toContain(accessToken);
  });

  it("syncs at once when Repair finishes; the successful sync makes the Connection Healthy and ends its notice", async () => {
    await needsAMember();
    expect(await rows("SELECT health FROM connections")).toEqual([{ health: "needs a member" }]);
    expect(await openNotices()).toEqual([
      { kind: "condition", condition: `connection needs a member:${connectionId}` },
    ]);

    const later = new Date(Date.now() + 10 * MINUTE_MS);
    expect(await repairing.finishUpdate(connectionId, later)).toEqual({ outcome: "syncing" });
    // The sync job gets the Connection's ID only.
    expect(bank.syncsStarted).toEqual([connectionId]);

    plaid.answer(ITEM_GET, {
      body: { ...RECORDED.itemGet, item: { ...RECORDED.itemGet.item, item_id: newItemId() } },
    });
    plaid.answer(SYNC, { body: plaidSyncPage("cursor-2") });
    expect(await runSyncJob(connectionId)).toBe("synced");

    expect(await rows("SELECT health FROM connections")).toEqual([{ health: "healthy" }]);
    expect(await openNotices()).toEqual([]);
    expect(plaid.to(SYNC).at(-1)?.body.access_token).toBe(accessToken);
  });

  it("starts no sync sooner than the gap after the last one started, and sets it for when the gap has passed", async () => {
    await needsAMember();
    const [times] = await rows("SELECT last_sync_attempt_at AS attempt FROM connections");
    const lastAttempt = new Date(String(times?.attempt)).getTime();

    // A sync started just now: none starts, however often the browser asks.
    for (let i = 0; i < 3; i++) {
      expect(await repairing.finishUpdate(connectionId, new Date(lastAttempt + MINUTE_MS))).toEqual(
        { outcome: "sync soon" },
      );
    }
    expect(bank.syncsStarted).toEqual([]);
    const [due] = await rows("SELECT next_sync_at AS next FROM connections");
    expect(new Date(String(due?.next)).getTime()).toBe(lastAttempt + 5 * MINUTE_MS);

    // Once the gap has passed, one sync starts, and a second call right after starts none.
    const after = lastAttempt + 6 * MINUTE_MS;
    expect(await repairing.finishUpdate(connectionId, new Date(after))).toEqual({
      outcome: "syncing",
    });
    expect(await repairing.finishUpdate(connectionId, new Date(after + MINUTE_MS))).toEqual({
      outcome: "sync soon",
    });
    expect(bank.syncsStarted).toEqual([connectionId]);
  });
});
