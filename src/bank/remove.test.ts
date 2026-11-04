import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addConnection,
  listDueConnections,
  PLAID_SETTINGS_ROW,
  readPlaidSettings,
  storePlaidKeys,
} from "../db/index.ts";
import { holdsSecretValue } from "../log.ts";
import { coveringConnection } from "./connect.ts";
import { fakeAccount, fakeTxn } from "./fake.ts";
import { FakePlaid, newAccessToken, plaidFailure, RECORDED } from "./fake-plaid.ts";
import {
  type ConnectionRemoving,
  connectionRemoving,
  plaidAdapter,
  runSyncJob,
  syncConnection,
} from "./index.ts";
import { newPlaidKeys, newTestBank, type TestBank } from "./testing.ts";

// Removing a Connection and deleting its history (spec 02, Removing a Connection), on Plaid's real
// client pointed at a fake Plaid server. No test calls Plaid. Every token is made when the test
// runs.

const ITEM_REMOVE = "/item/remove";

describe("removing a Connection", () => {
  let bank: TestBank;
  let plaid: FakePlaid;
  let removing: ConnectionRemoving;
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
      syncMinute: 7,
      sealCredential: (rowId) =>
        bank.secrets.encrypt(accessToken, { rowId, column: "connections.credential" }),
    });
    // Plaid's recorded sync, then a page with no changes.
    plaid.answer("/transactions/sync", ...RECORDED.transactionsSync.map((body) => ({ body })), {
      body: {
        added: [],
        modified: [],
        removed: [],
        next_cursor: "cursor-3",
        has_more: false,
        transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
        accounts: [],
      },
    });
    plaid.answer("/accounts/get", { body: RECORDED.accountsGet });
    plaid.answer("/liabilities/get", { body: RECORDED.liabilitiesGet });
    await syncConnection(connectionId);
    removing = connectionRemoving();
  });

  afterEach(async () => {
    bank.close();
    await plaid.close();
  });

  const rows = async (sql: string, args: string[] = []) =>
    (await bank.database.$client.execute({ sql, args })).rows;
  const count = async (sql: string, args: string[] = []) => Number((await rows(sql, args))[0]?.n);

  describe("Remove", () => {
    it("calls /item/remove, deletes the token, closes the Accounts, keeps their history, and keeps N", async () => {
      plaid.answer(ITEM_REMOVE, { body: RECORDED.itemRemove });
      const transactions = await count("SELECT count(*) AS n FROM transactions");
      expect(transactions).toBeGreaterThan(0);
      const itemsBefore = await readPlaidSettings(bank.database);

      expect(await removing.remove(connectionId)).toEqual({ outcome: "removed" });

      expect(plaid.to(ITEM_REMOVE).map((request) => request.body.access_token)).toEqual([
        accessToken,
      ]);
      const [connection] = await rows(
        "SELECT credential, removed_at, next_sync_at FROM connections WHERE id = ?",
        [connectionId],
      );
      expect(connection).toMatchObject({ credential: null, next_sync_at: null });
      expect(connection?.removed_at).not.toBeNull();
      expect(
        await rows(
          "SELECT DISTINCT closed_reason FROM household_accounts WHERE connection_id = ?",
          [connectionId],
        ),
      ).toEqual([{ closed_reason: "connection removed" }]);
      expect(
        await count("SELECT count(*) AS n FROM household_accounts WHERE closed_at IS NULL"),
      ).toBe(0);
      expect(await count("SELECT count(*) AS n FROM transactions")).toBe(transactions);
      expect(await readPlaidSettings(bank.database)).toEqual(itemsBefore);
      expect(holdsSecretValue(accessToken)).toBe(true);
    });

    it("stops the Connection's syncs, and lets the bank be linked again", async () => {
      plaid.answer(ITEM_REMOVE, { body: RECORDED.itemRemove });

      await removing.remove(connectionId);

      expect(await listDueConnections(bank.database, new Date(Date.now() + 86_400_000))).toEqual(
        [],
      );
      const synced = plaid.to("/transactions/sync").length;
      expect(await runSyncJob(connectionId)).toBe("not polled");
      expect(await syncConnection(connectionId)).toMatchObject({ changedTransactions: false });
      expect(plaid.to("/transactions/sync")).toHaveLength(synced);
      expect(
        await coveringConnection({
          bankId: "ins_fake",
          accounts: [{ type: "depository", mask: "0000" }],
        }),
      ).toBeUndefined();
    });

    it("goes on when Plaid says the Item is already gone", async () => {
      plaid.answer(ITEM_REMOVE, {
        status: 400,
        body: plaidFailure("ITEM_ERROR", "ITEM_NOT_FOUND"),
      });

      expect(await removing.remove(connectionId)).toEqual({ outcome: "removed" });
      expect(await rows("SELECT credential FROM connections WHERE id = ?", [connectionId])).toEqual(
        [{ credential: null }],
      );
    });

    it("changes nothing, and keeps the token for a retry, when Plaid does not answer", async () => {
      plaid.answer(ITEM_REMOVE, {
        status: 500,
        body: plaidFailure("API_ERROR", "INTERNAL_SERVER_ERROR"),
      });

      expect(await removing.remove(connectionId)).toEqual({
        outcome: "provider error",
        message: "Plaid answered INTERNAL_SERVER_ERROR (API_ERROR).",
      });
      const [connection] = await rows(
        "SELECT credential, removed_at FROM connections WHERE id = ?",
        [connectionId],
      );
      expect(connection?.credential).not.toBeNull();
      expect(connection?.removed_at).toBeNull();
      expect(
        await count("SELECT count(*) AS n FROM household_accounts WHERE closed_at IS NOT NULL"),
      ).toBe(0);
    });

    it("answers not found for an unknown Connection, and removes a removed one only once", async () => {
      plaid.answer(ITEM_REMOVE, { body: RECORDED.itemRemove });

      expect(await removing.remove("no-such-connection")).toEqual({ outcome: "not found" });
      await removing.remove(connectionId);
      expect(await removing.remove(connectionId)).toEqual({ outcome: "removed" });
      expect(plaid.to(ITEM_REMOVE)).toHaveLength(1);
    });
  });

  describe("Delete history", () => {
    it("works only on a removed Connection", async () => {
      expect(await removing.deleteHistory(connectionId)).toEqual({ outcome: "not removed" });
      expect(await removing.deleteHistory("no-such-connection")).toEqual({
        outcome: "not found",
      });
      expect(bank.followUpsAsked()).toBe(0);
    });

    it("deletes the daily balances, the Transactions, the Accounts, and the Connection, then starts a follow-up job", async () => {
      plaid.answer(ITEM_REMOVE, { body: RECORDED.itemRemove });
      await removing.remove(connectionId);
      const accounts = await count("SELECT count(*) AS n FROM household_accounts");
      const transactions = await count("SELECT count(*) AS n FROM transactions");
      expect(await count("SELECT count(*) AS n FROM daily_balances")).toBeGreaterThan(0);
      const asked = bank.followUpsAsked();

      expect(await removing.deleteHistory(connectionId)).toEqual({
        outcome: "deleted",
        accounts,
        transactions,
      });

      for (const table of ["daily_balances", "transactions", "household_accounts", "connections"]) {
        expect(await count(`SELECT count(*) AS n FROM ${table}`)).toBe(0);
      }
      expect(bank.followUpsAsked()).toBe(asked + 1);
      expect((await readPlaidSettings(bank.database)).appItems).toBe(1);
    });

    it("undoes the Transfer links to another Connection, and marks the other side for matching again", async () => {
      const other = await bank.connect("fake-other", "Other Bank");
      bank.fake.addPages("fake-other", {
        accounts: [fakeAccount({ id: "other-checking" })],
        added: [fakeTxn({ id: "other-in", accountId: "other-checking", amount: 5000 })],
        historyLoaded: true,
      });
      await syncConnection(other);
      const [plaidOut] = await rows("SELECT id FROM transactions WHERE connection_id = ? LIMIT 1", [
        connectionId,
      ]);
      const [otherIn] = await rows("SELECT id FROM transactions WHERE connection_id = ?", [other]);
      await bank.database.$client.execute({
        sql: "INSERT INTO transfer_links (id, out_transaction_id, in_transaction_id, tier, signals, made_by, created_at) VALUES ('link-1', ?, ?, 'strong', '[]', 'app', ?)",
        args: [String(plaidOut?.id), String(otherIn?.id), new Date().toISOString()],
      });
      await bank.database.$client.execute({
        sql: "INSERT INTO follow_up_marks (step, transaction_id, handled_at) VALUES ('match', ?, ?)",
        args: [String(otherIn?.id), new Date().toISOString()],
      });
      await bank.database.$client.execute({
        sql: "INSERT INTO review_items (id, kind, subject_type, subject_ids, decided, best_answer, created_at) VALUES ('review-1', 'category guess', 'transactions', ?, 'x', '{\"value\":\"a\",\"label\":\"a\"}', ?)",
        args: [JSON.stringify([String(plaidOut?.id)]), new Date().toISOString()],
      });
      plaid.answer(ITEM_REMOVE, { body: RECORDED.itemRemove });
      await removing.remove(connectionId);

      await removing.deleteHistory(connectionId);

      expect(await count("SELECT count(*) AS n FROM transfer_links")).toBe(0);
      expect(await count("SELECT count(*) AS n FROM follow_up_marks")).toBe(0);
      expect(await rows("SELECT closed_reason FROM review_items")).toEqual([
        { closed_reason: "history deleted" },
      ]);
      expect(await rows("SELECT id FROM transactions")).toEqual([{ id: otherIn?.id }]);
    });
  });
});
