import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startCategorization } from "../categorization/index.ts";
import {
  addConnection,
  PLAID_SETTINGS_ROW,
  readPlaidSettings,
  saveSyncState,
  storeItemsUsed,
  storePlaidKeys,
} from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { holdsSecretValue } from "../log.ts";
import { linkByHand, startMoneyMovement, totalsByMonth } from "../money-movement/index.ts";
import {
  FakePlaid,
  newAccessToken,
  newItemId,
  newLinkToken,
  newPublicToken,
  plaidAccount,
  plaidFailure,
  plaidSyncPage,
  plaidTransaction,
  RECORDED,
} from "./fake-plaid.ts";
import {
  type BankConnecting,
  bankConnecting,
  catchUpSyncs,
  connectionRemoving,
  connectionRepairing,
  type LinkResult,
  plaidAdapter,
  runSyncJob,
  startDueSyncs,
  syncConnection,
} from "./index.ts";
import { newPlaidKeys, newTestBank, type TestBank } from "./testing.ts";

// Linking a new bank through Plaid (spec 02, Linking a new bank and The 10 lifetime Items), on
// Plaid's real client pointed at a fake Plaid server. No test calls Plaid. Every token is made
// when the test runs.

const LINK_TOKEN = "/link/token/create";
const EXCHANGE = "/item/public_token/exchange";
const ITEM_GET = "/item/get";

describe("linking a new bank through Plaid", () => {
  let bank: TestBank;
  let plaid: FakePlaid;
  let linking: BankConnecting;

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
    linking = bankConnecting("plaid");
  });

  afterEach(async () => {
    bank.close();
    await plaid.close();
  });

  const rows = async (sql: string) => (await bank.database.$client.execute(sql)).rows;

  // A Plaid Connection the app already has, with one Account.
  async function existing(
    bankId: string,
    bankName: string,
    account?: { kind: string; mask: string },
  ) {
    const id = await addConnection(bank.database, {
      provider: "plaid",
      bankId,
      bankName,
      origin: "linked",
    });
    if (account !== undefined) {
      await bank.database.$client.execute({
        sql: "INSERT INTO household_accounts (id, connection_id, provider_account_id, name, kind, mask) VALUES (?, ?, ?, 'Old account', ?, ?)",
        args: [crypto.randomUUID(), id, `acct-${id}`, account.kind, account.mask],
      });
    }
    return id;
  }

  // Link's onSuccess for a bank, with one checking Account ending 1111 unless others are given.
  const result = (fields: Partial<LinkResult> = {}): LinkResult => ({
    publicToken: newPublicToken(),
    bankId: "ins_new",
    bankName: "New Bank",
    accounts: [{ name: "Checking", type: "depository", subtype: "checking", mask: "1111" }],
    ...fields,
  });

  // The exchange, then Plaid's /item/get naming the bank `result()` names, unless a test answers
  // /item/get otherwise.
  function exchangeAnswers() {
    const answer = { access_token: newAccessToken(), item_id: newItemId() };
    plaid.answer(EXCHANGE, { body: { ...answer, request_id: "req-exchange" } });
    plaid.answer(ITEM_GET, {
      body: {
        ...RECORDED.itemGet,
        item: {
          ...RECORDED.itemGet.item,
          item_id: answer.item_id,
          institution_id: "ins_new",
          institution_name: "New Bank",
        },
      },
    });
    return answer;
  }

  describe("the Item count's gates before Link opens", () => {
    beforeEach(() => {
      plaid.answer(LINK_TOKEN, { body: { link_token: newLinkToken(), request_id: "req-link" } });
    });

    it("hands out a link token at N of 7, with no second confirmation", async () => {
      await storeItemsUsed(bank.database, 7);

      expect(await linking.startLink({})).toMatchObject({ outcome: "ready", itemsUsed: 7 });
      expect(plaid.to(LINK_TOKEN)).toHaveLength(1);
    });

    it("asks for a second confirmation at N of 8, and makes no link token until it comes", async () => {
      await storeItemsUsed(bank.database, 8);

      expect(await linking.startLink({})).toEqual({ outcome: "confirm", itemsUsed: 8 });
      expect(plaid.to(LINK_TOKEN)).toEqual([]);
      expect(await linking.startLink({ confirmed: true })).toMatchObject({
        outcome: "ready",
        itemsUsed: 8,
      });
      expect(plaid.to(LINK_TOKEN)).toHaveLength(1);
    });

    it("blocks linking a new bank at N of 10, confirmed or not", async () => {
      await storeItemsUsed(bank.database, 10);

      expect(await linking.startLink({ confirmed: true })).toEqual({
        outcome: "item limit",
        itemsUsed: 10,
      });
      expect(plaid.to(LINK_TOKEN)).toEqual([]);
    });

    it("asks for the link token with the spec's settings, and no detail about the Household", async () => {
      const started = await linking.startLink({});

      const [request] = plaid.to(LINK_TOKEN);
      const { user, ...settings } = request?.body ?? {};
      expect(settings).toEqual({
        client_name: "Family Finance Tracker",
        products: ["transactions"],
        required_if_supported_products: ["liabilities"],
        transactions: { days_requested: 730 },
        country_codes: ["US"],
        language: "en",
      });
      expect(settings).not.toHaveProperty("webhook");
      expect(settings).not.toHaveProperty("redirect_uri");
      // An opaque ID made for this token: no name, email, or phone.
      expect(Object.keys(user as object)).toEqual(["client_user_id"]);
      expect((user as { client_user_id: string }).client_user_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(started.outcome === "ready" && holdsSecretValue(started.linkToken)).toBe(true);
    });

    it("answers Plaid's refusal, sorted, and hands out no token", async () => {
      plaid.answer(LINK_TOKEN, {
        status: 400,
        body: plaidFailure("INVALID_INPUT", "INVALID_FIELD"),
      });

      expect(await linking.startLink({})).toEqual({
        outcome: "provider error",
        message: "Plaid answered INVALID_FIELD (INVALID_INPUT).",
      });
    });
  });

  describe("the duplicate-bank block before the token exchange", () => {
    it("blocks a bank whose institution ID matches a Connection, and names that Connection", async () => {
      const chase = await existing("ins_new", "New Bank (old)");
      exchangeAnswers();

      expect(await linking.finishLink(result(), {})).toEqual({
        outcome: "duplicate",
        coveredBy: { connectionId: chase, bankName: "New Bank (old)" },
      });
      expect(plaid.to(EXCHANGE)).toEqual([]);
      expect(await rows("SELECT count(*) AS n FROM connections")).toEqual([{ n: 1 }]);
    });

    it("blocks an Account that matches another Connection's Account by type and last 4 digits", async () => {
      const other = await existing("ins_other", "Other Bank", { kind: "depository", mask: "1111" });
      exchangeAnswers();

      expect(await linking.finishLink(result(), {})).toEqual({
        outcome: "duplicate",
        coveredBy: { connectionId: other, bankName: "Other Bank" },
      });
      expect(plaid.to(EXCHANGE)).toEqual([]);
    });

    it("lets through the same last 4 digits on an Account of another type", async () => {
      await existing("ins_other", "Other Bank", { kind: "credit", mask: "1111" });
      exchangeAnswers();

      expect(await linking.finishLink(result(), {})).toMatchObject({ outcome: "linked" });
    });

    it("lets Link again through the block for the one Broken Connection it replaces", async () => {
      const broken = await existing("ins_new", "New Bank", { kind: "depository", mask: "1111" });
      await saveSyncState(bank.database, broken, { health: "broken" });
      exchangeAnswers();

      expect(await linking.finishLink(result(), { replaces: broken })).toMatchObject({
        outcome: "linked",
      });
    });

    it("refuses `replaces` for a Connection that is not Broken, and exchanges nothing", async () => {
      const healthy = await existing("ins_new", "New Bank");
      exchangeAnswers();

      expect(await linking.finishLink(result(), { replaces: healthy })).toEqual({
        outcome: "not broken",
      });
      expect(await linking.startLink({ replaces: healthy })).toEqual({ outcome: "not broken" });
      expect(plaid.to(EXCHANGE)).toEqual([]);
      expect(plaid.to(LINK_TOKEN)).toEqual([]);
    });

    it("exchanges once when the same bank is finished twice at the same time", async () => {
      exchangeAnswers();

      const outcomes = await Promise.all([
        linking.finishLink(result(), {}),
        linking.finishLink(result(), {}),
      ]);

      expect(outcomes.map((outcome) => outcome.outcome).sort()).toEqual(["duplicate", "linked"]);
      expect(plaid.to(EXCHANGE)).toHaveLength(1);
    });
  });

  // The browser names a new bank; Plaid's own /item/get names one the app already has.
  describe("the duplicate-bank block after the token exchange", () => {
    const ITEM_REMOVE = "/item/remove";

    async function plaidNamesAKnownBank() {
      const known = await existing("ins_fake", "Fake Plaid Bank");
      const { access_token } = exchangeAnswers();
      plaid.answer(ITEM_GET, {
        body: { ...RECORDED.itemGet, item: { ...RECORDED.itemGet.item, item_id: newItemId() } },
      });
      return { known, access_token };
    }

    it("ends the new Item at Plaid and removes the new Connection, which counts in N and never syncs", async () => {
      const { known, access_token } = await plaidNamesAKnownBank();
      plaid.answer(ITEM_REMOVE, { body: RECORDED.itemRemove });

      const outcome = await linking.finishLink(result({ bankId: "ins_new" }), {});

      expect(outcome).toMatchObject({
        outcome: "duplicate after link",
        coveredBy: { connectionId: known, bankName: "Fake Plaid Bank" },
        removed: true,
      });
      expect(plaid.to(ITEM_REMOVE).map((request) => request.body.access_token)).toEqual([
        access_token,
      ]);
      expect(
        await rows(
          "SELECT bank_id, credential, removed_at IS NOT NULL AS removed FROM connections ORDER BY created_at, rowid",
        ),
      ).toEqual([
        { bank_id: "ins_fake", credential: null, removed: 0 },
        { bank_id: "ins_fake", credential: null, removed: 1 },
      ]);
      expect((await readPlaidSettings(bank.database)).appItems).toBe(2);
      expect(bank.syncsStarted).toEqual([]);
    });

    it("keeps the new Connection for the Member to Remove when Plaid does not end it, and starts no sync", async () => {
      await plaidNamesAKnownBank();
      plaid.answer(ITEM_REMOVE, {
        status: 500,
        body: plaidFailure("API_ERROR", "INTERNAL_SERVER_ERROR"),
      });

      expect(await linking.finishLink(result({ bankId: "ins_new" }), {})).toMatchObject({
        outcome: "duplicate after link",
        removed: false,
      });
      expect(
        await rows(
          "SELECT credential IS NOT NULL AS sealed, removed_at, sync_held FROM connections ORDER BY created_at, rowid",
        ),
      ).toEqual([
        { sealed: 0, removed_at: null, sync_held: 0 },
        { sealed: 1, removed_at: null, sync_held: 1 },
      ]);
      expect(bank.syncsStarted).toEqual([]);
    });

    // The duplicate Plaid did not end must never sync, or the bank's money counts twice.
    describe("the held duplicate", () => {
      const HOUR_MS = 3_600_000;
      let held: string;

      beforeEach(async () => {
        await plaidNamesAKnownBank();
        plaid.answer(ITEM_REMOVE, {
          status: 500,
          body: plaidFailure("API_ERROR", "INTERNAL_SERVER_ERROR"),
        });
        const outcome = await linking.finishLink(result({ bankId: "ins_new" }), {});
        held = outcome.outcome === "duplicate after link" ? outcome.connectionId : "";
        plaid.requests.length = 0;
      });

      it("is not started by the sync schedule, even 25 hours later", async () => {
        const started: string[] = [];
        const record = async (id: string) => {
          started.push(id);
        };
        for (const hours of [0, 25, 24 * 30]) {
          await startDueSyncs(new Date(Date.now() + hours * HOUR_MS), record);
        }
        expect(started).not.toContain(held);
      });

      it("is not started by the start-up catch-up", async () => {
        const started: string[] = [];
        await catchUpSyncs(new Date(Date.now() + 25 * HOUR_MS), async (id) => {
          started.push(id);
        });
        expect(started).not.toContain(held);
        // Nor does the catch-up mark it due.
        expect(await rows(`SELECT next_sync_at FROM connections WHERE id = '${held}'`)).toEqual([
          { next_sync_at: null },
        ]);
      });

      it("is not synced by its sync job or a direct sync, so Plaid is never asked", async () => {
        expect(await runSyncJob(held)).toBe("not polled");
        expect(await syncConnection(held)).toMatchObject({ added: 0, changedTransactions: false });
        expect(plaid.requests).toEqual([]);
        expect(await rows("SELECT count(*) AS n FROM household_accounts")).toEqual([{ n: 0 }]);
      });

      it("is refused by Repair, Add accounts and update-finished", async () => {
        const repairing = connectionRepairing();
        const later = new Date(Date.now() + 25 * HOUR_MS);
        expect(await repairing.startRepair(held)).toEqual({ outcome: "held" });
        expect(await repairing.startAddAccounts(held)).toEqual({ outcome: "held" });
        expect(await repairing.finishUpdate(held, later)).toEqual({ outcome: "held" });
        expect(bank.syncsStarted).toEqual([]);
        expect(plaid.requests).toEqual([]);
      });

      it("is cleared only by Remove, which ends the Item and deletes the token", async () => {
        plaid.answer(ITEM_REMOVE, { body: RECORDED.itemRemove });

        expect(await connectionRemoving().remove(held)).toEqual({ outcome: "removed" });

        expect(
          await rows(
            `SELECT credential, sync_held, removed_at IS NOT NULL AS removed FROM connections WHERE id = '${held}'`,
          ),
        ).toEqual([{ credential: null, sync_held: 0, removed: 1 }]);
        expect(plaid.to(ITEM_REMOVE)).toHaveLength(1);
      });
    });
  });

  describe("the token exchange", () => {
    it("stores the access token encrypted, marks the Connection linked, counts it in N, and starts the first sync", async () => {
      const { access_token, item_id } = exchangeAnswers();
      const linked = result();

      const outcome = await linking.finishLink(linked, {});

      expect(outcome).toMatchObject({ outcome: "linked", bankName: "New Bank" });
      const connectionId = outcome.outcome === "linked" ? outcome.connectionId : "";
      expect(plaid.to(EXCHANGE).map((request) => request.body.public_token)).toEqual([
        linked.publicToken,
      ]);
      const [stored] = await rows(
        "SELECT id, bank_id, bank_name, origin, credential, sync_cursor FROM connections",
      );
      expect(stored).toMatchObject({
        id: connectionId,
        bank_id: "ins_new",
        bank_name: "New Bank",
        origin: "linked",
        sync_cursor: null,
      });
      const credential = String(stored?.credential);
      expect(credential).not.toContain(access_token);
      expect(
        bank.secrets.decrypt(credential, { rowId: connectionId, column: "connections.credential" }),
      ).toBe(access_token);
      expect((await readPlaidSettings(bank.database)).appItems).toBe(1);
      expect(bank.syncsStarted).toEqual([connectionId]);
      for (const secret of [linked.publicToken, access_token, item_id]) {
        expect(holdsSecretValue(secret)).toBe(true);
      }
    });

    it("hands the stored token to the first sync, which starts from an empty cursor", async () => {
      const { access_token } = exchangeAnswers();
      const outcome = await linking.finishLink(result(), {});
      const connectionId = outcome.outcome === "linked" ? outcome.connectionId : "";
      plaid.answer("/transactions/sync", {
        body: {
          added: [],
          modified: [],
          removed: [],
          next_cursor: "cursor-1",
          has_more: false,
          transactions_update_status: "NOT_READY",
          accounts: [],
        },
      });
      plaid.answer("/accounts/get", { body: { accounts: [] } });

      await syncConnection(connectionId);

      const [first] = plaid.to("/transactions/sync");
      expect(first?.body.access_token).toBe(access_token);
      expect(first?.body).not.toHaveProperty("cursor");
    });

    it("saves nothing and keeps N when Plaid refuses the exchange", async () => {
      plaid.answer(EXCHANGE, {
        status: 400,
        body: plaidFailure("INVALID_INPUT", "INVALID_PUBLIC_TOKEN"),
      });

      expect(await linking.finishLink(result(), {})).toEqual({
        outcome: "provider error",
        message: "Plaid answered INVALID_PUBLIC_TOKEN (INVALID_INPUT).",
      });
      expect(await rows("SELECT count(*) AS n FROM connections")).toEqual([{ n: 0 }]);
      expect((await readPlaidSettings(bank.database)).appItems).toBe(0);
      expect(bank.syncsStarted).toEqual([]);
    });

    it("blocks the exchange once N reaches 10", async () => {
      await storeItemsUsed(bank.database, 10);
      exchangeAnswers();

      expect(await linking.finishLink(result(), {})).toEqual({
        outcome: "item limit",
        itemsUsed: 10,
      });
      expect(plaid.to(EXCHANGE)).toEqual([]);
    });

    it("confirms the bank with one /item/get after the exchange, and stores Plaid's ID", async () => {
      const { access_token } = exchangeAnswers();
      plaid.answer(ITEM_GET, {
        body: { ...RECORDED.itemGet, item: { ...RECORDED.itemGet.item, item_id: newItemId() } },
      });

      const outcome = await linking.finishLink(result({ bankId: "ins_new" }), {});

      expect(outcome).toMatchObject({ outcome: "linked", bankName: "Fake Plaid Bank" });
      expect(plaid.to(ITEM_GET).map((request) => request.body.access_token)).toEqual([
        access_token,
      ]);
      expect(await rows("SELECT bank_id, bank_name FROM connections")).toEqual([
        { bank_id: "ins_fake", bank_name: "Fake Plaid Bank" },
      ]);
    });

    it("adds the bank as unconfirmed when /item/get fails, since the Item is already spent", async () => {
      exchangeAnswers();
      plaid.answer(ITEM_GET, {
        status: 500,
        body: plaidFailure("API_ERROR", "INTERNAL_SERVER_ERROR"),
      });

      expect(await linking.finishLink(result(), {})).toMatchObject({
        outcome: "added unconfirmed",
        replacedNothing: false,
      });
      expect(await rows("SELECT bank_id FROM connections")).toEqual([{ bank_id: "ins_new" }]);
    });
  });

  // Link again (spec 02, Repair and Carrying Accounts over): a Broken Connection's access token no
  // longer works, so the bank is linked as a new Connection that replaces it.
  describe("Link again for a Broken Connection", () => {
    const SYNC = "/transactions/sync";
    const ACCOUNTS_GET = "/accounts/get";
    const on = (date: string) => () => new Date(`${date}T12:00:00Z`);
    const CHECKING_0000 = {
      name: "Plaid Checking",
      type: "depository",
      subtype: "checking",
      mask: "0000",
    };

    // A Plaid Connection to Fake Plaid Bank whose last successful sync, on 2026-10-05 (day D),
    // stored a checking Account ending 0000 and 2 Transactions. Its next sync finds the Item gone.
    async function brokenConnection(): Promise<string> {
      const accessToken = newAccessToken();
      const id = await addConnection(bank.database, {
        provider: "plaid",
        bankId: "ins_fake",
        bankName: "Fake Plaid Bank",
        origin: "linked",
        sealCredential: (rowId) =>
          bank.secrets.encrypt(accessToken, { rowId, column: "connections.credential" }),
      });
      plaid.answer(
        SYNC,
        {
          body: plaidSyncPage("old-1", [
            plaidTransaction({
              transaction_id: "old-before-d",
              account_id: "old-checking",
              date: "2026-10-01",
            }),
            plaidTransaction({
              transaction_id: "old-on-d",
              account_id: "old-checking",
              date: "2026-10-05",
            }),
          ]),
        },
        { body: plaidSyncPage("old-1") },
      );
      plaid.answer(ACCOUNTS_GET, {
        body: { accounts: [plaidAccount({ account_id: "old-checking", mask: "0000" })] },
      });
      await syncConnection(id, on("2026-10-05"));
      plaid.answer(SYNC, { status: 400, body: plaidFailure("ITEM_ERROR", "ITEM_NOT_FOUND") });
      await expect(syncConnection(id, on("2026-10-07"))).rejects.toThrow("ITEM_NOT_FOUND");
      return id;
    }

    it("refuses another bank than the Broken Connection's, and exchanges nothing", async () => {
      const broken = await brokenConnection();
      exchangeAnswers();

      expect(await linking.finishLink(result({ bankId: "ins_new" }), { replaces: broken })).toEqual(
        { outcome: "other bank" },
      );
      expect(plaid.to(EXCHANGE)).toEqual([]);
    });

    // The browser names the Broken Connection's bank; Plaid's own /item/get names another.
    it("replaces nothing when Plaid names another bank than the browser did, and adds that bank as a new Connection", async () => {
      const broken = await brokenConnection();
      exchangeAnswers();
      plaid.answer(ITEM_GET, {
        body: {
          ...RECORDED.itemGet,
          item: {
            ...RECORDED.itemGet.item,
            item_id: newItemId(),
            institution_id: "ins_other",
            institution_name: "Other Bank",
          },
        },
      });

      const outcome = await linking.finishLink(
        result({ bankId: "ins_fake", bankName: "Fake Plaid Bank", accounts: [CHECKING_0000] }),
        { replaces: broken },
      );

      expect(outcome).toMatchObject({ outcome: "added other bank", bankName: "Other Bank" });
      const connectionId = "connectionId" in outcome ? outcome.connectionId : "";
      // The Broken Connection is as it was: its token, its open Account, and its notice.
      expect(
        await rows(
          "SELECT bank_id, health, credential IS NOT NULL AS sealed, removed_at FROM connections ORDER BY created_at, rowid",
        ),
      ).toEqual([
        { bank_id: "ins_fake", health: "broken", sealed: 1, removed_at: null },
        { bank_id: "ins_other", health: "healthy", sealed: 1, removed_at: null },
      ]);
      expect(await rows("SELECT connection_id, closed_at FROM household_accounts")).toEqual([
        { connection_id: broken, closed_at: null },
      ]);
      expect(await rows("SELECT condition FROM system_notices WHERE closed_at IS NULL")).toEqual([
        { condition: `connection broken:${broken}` },
      ]);
      // The Item is spent, so the new bank counts in N and syncs.
      expect((await readPlaidSettings(bank.database)).appItems).toBe(2);
      expect(bank.syncsStarted).toEqual([connectionId]);
    });

    // The browser names the Broken Connection's bank, but Plaid does not confirm any bank.
    it("replaces nothing when /item/get fails, and adds the bank as a new Connection", async () => {
      const broken = await brokenConnection();
      exchangeAnswers();
      plaid.answer(ITEM_GET, {
        status: 500,
        body: plaidFailure("API_ERROR", "INTERNAL_SERVER_ERROR"),
      });

      const outcome = await linking.finishLink(
        result({ bankId: "ins_fake", bankName: "Fake Plaid Bank", accounts: [CHECKING_0000] }),
        { replaces: broken },
      );

      expect(outcome).toMatchObject({ outcome: "added unconfirmed", replacedNothing: true });
      expect(
        await rows(
          "SELECT health, credential IS NOT NULL AS sealed, removed_at FROM connections ORDER BY created_at, rowid",
        ),
      ).toEqual([
        { health: "broken", sealed: 1, removed_at: null },
        { health: "healthy", sealed: 1, removed_at: null },
      ]);
      expect(await rows("SELECT connection_id, closed_at FROM household_accounts")).toEqual([
        { connection_id: broken, closed_at: null },
      ]);
      expect(await rows("SELECT condition FROM system_notices WHERE closed_at IS NULL")).toEqual([
        { condition: `connection broken:${broken}` },
      ]);
    });

    it("replaces the Broken Connection, carries its Account over, and splits history at day D", async () => {
      const broken = await brokenConnection();
      const [account] = await rows("SELECT id FROM household_accounts");
      expect(await rows("SELECT health FROM connections")).toEqual([{ health: "broken" }]);
      expect(
        await rows("SELECT count(*) AS n FROM system_notices WHERE closed_at IS NULL"),
      ).toEqual([{ n: 1 }]);
      exchangeAnswers();
      plaid.answer(ITEM_GET, {
        body: { ...RECORDED.itemGet, item: { ...RECORDED.itemGet.item, item_id: newItemId() } },
      });

      const outcome = await linking.finishLink(
        result({ bankId: "ins_fake", bankName: "Fake Plaid Bank", accounts: [CHECKING_0000] }),
        { replaces: broken },
      );

      // Before the new Connection's first sync: the Broken one is removed, its Account Closed, and
      // its notice and banner ended. The new Connection spent a new Item.
      expect(outcome).toMatchObject({ outcome: "linked" });
      const connectionId = outcome.outcome === "linked" ? outcome.connectionId : "";
      const [old] = await rows(
        `SELECT credential, removed_at FROM connections WHERE id = '${broken}'`,
      );
      expect(old?.credential).toBeNull();
      expect(old?.removed_at).not.toBeNull();
      expect(await rows("SELECT connection_id, closed_reason FROM household_accounts")).toEqual([
        { connection_id: broken, closed_reason: "connection removed" },
      ]);
      expect(
        await rows("SELECT count(*) AS n FROM system_notices WHERE closed_at IS NULL"),
      ).toEqual([{ n: 0 }]);
      expect((await readPlaidSettings(bank.database)).appItems).toBe(2);
      expect(bank.syncsStarted).toEqual([connectionId]);

      plaid.answer(
        SYNC,
        {
          body: plaidSyncPage("new-1", [
            plaidTransaction({
              transaction_id: "new-before-d",
              account_id: "new-checking",
              date: "2026-10-01",
            }),
            plaidTransaction({
              transaction_id: "new-after-d",
              account_id: "new-checking",
              date: "2026-10-06",
            }),
          ]),
        },
        { body: plaidSyncPage("new-1") },
      );
      plaid.answer(ACCOUNTS_GET, {
        body: { accounts: [plaidAccount({ account_id: "new-checking", mask: "0000" })] },
      });
      await syncConnection(connectionId, on("2026-10-09"));

      expect(
        await rows(
          "SELECT id, connection_id, provider_account_id, closed_at, history_split_date FROM household_accounts",
        ),
      ).toEqual([
        {
          id: account?.id,
          connection_id: connectionId,
          provider_account_id: "new-checking",
          closed_at: null,
          history_split_date: "2026-10-05",
        },
      ]);
      expect(
        await rows(
          "SELECT provider_transaction_id AS id, hidden_reason FROM transactions ORDER BY provider_transaction_id",
        ),
      ).toEqual([
        { id: "new-after-d", hidden_reason: null },
        { id: "new-before-d", hidden_reason: "replaced by re-link" },
        { id: "old-before-d", hidden_reason: null },
        { id: "old-on-d", hidden_reason: "replaced by re-link" },
      ]);
      // The new Connection records the Broken one it carries the Account on from.
      expect(
        await rows("SELECT connection_id, old_connection_id FROM connection_carry_overs"),
      ).toEqual([{ connection_id: connectionId, old_connection_id: broken }]);
    });

    // Link carry-over (spec 02): a hand Refund on the Transaction dated D, money in on 2026-10-05
    // against the purchase on 2026-10-01, through the follow-up job.
    describe("with a hand-made link on a Transaction dated D", () => {
      let stops: (() => void)[];

      beforeEach(async () => {
        stops = [
          startMoneyMovement({ database: bank.database }).stop,
          startCategorization({ database: bank.database }).stop,
        ];
        await bank.database.$client.execute(
          `INSERT INTO members (id, name, email, created_at, updated_at)
           VALUES ('member-1', 'Jamie', 'jamie@example.com', '2026-10-01T00:00:00.000Z',
             '2026-10-01T00:00:00.000Z')`,
        );
      });

      afterEach(() => {
        for (const stop of stops.reverse()) stop();
      });

      const NOW = on("2026-10-09");
      const idOf = async (providerId: string) =>
        String(
          (
            await rows(
              `SELECT id FROM transactions WHERE provider_transaction_id = '${providerId}'`,
            )
          )[0]?.id,
        );
      const refunds = () =>
        rows(
          `SELECT l.id, m.provider_transaction_id AS money, s.provider_transaction_id AS spending,
             l.made_by, l.member_id
           FROM spending_links l
           JOIN transactions m ON m.id = l.transaction_id
           JOIN transactions s ON s.id = l.spending_transaction_id`,
        );
      const october = async () =>
        (await totalsByMonth(bank.database)).find((totals) => totals.month === "2026-10");

      // The Broken Connection, whose Transaction on day D is a $4 Refund of the $10 purchase.
      async function linkedBrokenConnection() {
        plaid.answer(
          SYNC,
          {
            body: plaidSyncPage("old-1", [
              plaidTransaction({
                transaction_id: "old-before-d",
                account_id: "old-checking",
                date: "2026-10-01",
              }),
              plaidTransaction({
                transaction_id: "old-on-d",
                account_id: "old-checking",
                date: "2026-10-05",
                amount: -4,
              }),
            ]),
          },
          { body: plaidSyncPage("old-1") },
        );
        const broken = await brokenConnectionWith();
        await runFollowUp(NOW);
        const made = await linkByHand(
          bank.database,
          {
            kind: "Refund",
            transactionId: await idOf("old-on-d"),
            spendingTransactionId: await idOf("old-before-d"),
          },
          "member-1",
          NOW(),
        );
        expect(made).toMatchObject({ outcome: "linked" });
        await runFollowUp(NOW);
        return { broken, linkId: made.outcome === "linked" ? made.linkId : "" };
      }

      // brokenConnection() answers its own first sync; this one takes the answer set above.
      async function brokenConnectionWith(): Promise<string> {
        const accessToken = newAccessToken();
        const id = await addConnection(bank.database, {
          provider: "plaid",
          bankId: "ins_fake",
          bankName: "Fake Plaid Bank",
          origin: "linked",
          sealCredential: (rowId) =>
            bank.secrets.encrypt(accessToken, { rowId, column: "connections.credential" }),
        });
        plaid.answer(ACCOUNTS_GET, {
          body: { accounts: [plaidAccount({ account_id: "old-checking", mask: "0000" })] },
        });
        await syncConnection(id, on("2026-10-05"));
        plaid.answer(SYNC, { status: 400, body: plaidFailure("ITEM_ERROR", "ITEM_NOT_FOUND") });
        await expect(syncConnection(id, on("2026-10-07"))).rejects.toThrow("ITEM_NOT_FOUND");
        return id;
      }

      // The new Item's first sync: its copy of the Refund on day D, and a purchase after it.
      async function syncNewItem(connectionId: string) {
        plaid.answer(
          SYNC,
          {
            body: plaidSyncPage("new-1", [
              plaidTransaction({
                transaction_id: "new-on-d",
                account_id: "new-checking",
                date: "2026-10-05",
                amount: -4,
              }),
            ]),
          },
          { body: plaidSyncPage("new-1") },
        );
        plaid.answer(ACCOUNTS_GET, {
          body: { accounts: [plaidAccount({ account_id: "new-checking", mask: "0000" })] },
        });
        await syncConnection(connectionId, NOW);
        await runFollowUp(NOW);
      }

      it("moves the link to the new copy on Link again, and keeps the totals", async () => {
        const { broken, linkId } = await linkedBrokenConnection();
        const before = await october();
        expect(before).toMatchObject({ spending: 600 });
        exchangeAnswers();
        plaid.answer(ITEM_GET, {
          body: { ...RECORDED.itemGet, item: { ...RECORDED.itemGet.item, item_id: newItemId() } },
        });

        const outcome = await linking.finishLink(
          result({ bankId: "ins_fake", bankName: "Fake Plaid Bank", accounts: [CHECKING_0000] }),
          { replaces: broken },
        );
        const connectionId = outcome.outcome === "linked" ? outcome.connectionId : "";
        await syncNewItem(connectionId);

        expect(await refunds()).toEqual([
          {
            id: linkId,
            money: "new-on-d",
            spending: "old-before-d",
            made_by: "Member",
            member_id: "member-1",
          },
        ]);
        expect(await october()).toEqual(before);
        expect(await rows("SELECT old_connection_id FROM connection_carry_overs")).toEqual([
          { old_connection_id: broken },
        ]);
      });

      // K10: the browser names the Broken Connection's bank; Plaid's /item/get names another.
      it("moves nothing when Plaid names another bank than the browser did", async () => {
        const { broken, linkId } = await linkedBrokenConnection();
        exchangeAnswers();
        plaid.answer(ITEM_GET, {
          body: {
            ...RECORDED.itemGet,
            item: {
              ...RECORDED.itemGet.item,
              item_id: newItemId(),
              institution_id: "ins_other",
              institution_name: "Other Bank",
            },
          },
        });

        const outcome = await linking.finishLink(
          result({ bankId: "ins_fake", bankName: "Fake Plaid Bank", accounts: [CHECKING_0000] }),
          { replaces: broken },
        );
        expect(outcome).toMatchObject({ outcome: "added other bank" });
        const connectionId = "connectionId" in outcome ? outcome.connectionId : "";
        await syncNewItem(connectionId);

        expect(await rows("SELECT * FROM connection_carry_overs")).toEqual([]);
        expect(await refunds()).toEqual([
          {
            id: linkId,
            money: "old-on-d",
            spending: "old-before-d",
            made_by: "Member",
            member_id: "member-1",
          },
        ]);
      });
    });
  });

  // Import Plaid Connection (spec 02): an access token made outside the app.
  describe("importing a Plaid Connection by its access token", () => {
    const ACCOUNTS_GET = "/accounts/get";

    // Plaid's recorded /item/get and /accounts/get answers for one token, for each call.
    function knownToken(calls = 1) {
      const item = { ...RECORDED.itemGet.item, item_id: newItemId() };
      for (let i = 0; i < calls; i += 1) {
        plaid.answer(ITEM_GET, { body: { ...RECORDED.itemGet, item } });
        plaid.answer(ACCOUNTS_GET, { body: { ...RECORDED.accountsGet, item } });
      }
      return { accessToken: newAccessToken(), itemId: String(item.item_id) };
    }

    it("shows the bank and its Accounts, with their last 4 digits, and saves nothing", async () => {
      const { accessToken, itemId } = knownToken();

      const preview = await linking.previewImport(accessToken);

      expect(preview).toEqual({
        outcome: "preview",
        bankName: "Fake Plaid Bank",
        accounts: [
          { name: "Plaid Checking", type: "depository", subtype: "checking", mask: "0000" },
          { name: "Plaid Credit Card", type: "credit", subtype: "credit card", mask: "3333" },
          { name: "Plaid Student Loan", type: "loan", subtype: "student", mask: "7777" },
          { name: "Personal Loan", type: "loan", subtype: "personal", mask: "8888" },
          { name: "Plaid Mortgage", type: "loan", subtype: "mortgage", mask: "9999" },
        ],
      });
      expect(plaid.to(ITEM_GET).map((request) => request.body.access_token)).toEqual([accessToken]);
      expect(JSON.stringify(preview)).not.toContain(itemId);
      expect(await rows("SELECT count(*) AS n FROM connections")).toEqual([{ n: 0 }]);
      expect(holdsSecretValue(accessToken)).toBe(true);
    });

    it("says Plaid rejected the token, in an error that names no token, and saves nothing", async () => {
      const accessToken = newAccessToken();
      plaid.answer(ITEM_GET, {
        status: 400,
        body: plaidFailure("INVALID_INPUT", "INVALID_ACCESS_TOKEN"),
      });
      plaid.answer(ITEM_GET, {
        status: 400,
        body: plaidFailure("INVALID_INPUT", "INVALID_ACCESS_TOKEN"),
      });

      const preview = await linking.previewImport(accessToken);
      const saved = await linking.importConnection(accessToken);

      for (const answer of [preview, saved]) {
        expect(answer).toEqual({
          outcome: "provider error",
          message: "Plaid answered INVALID_ACCESS_TOKEN (INVALID_INPUT).",
        });
      }
      expect(plaid.to(ACCOUNTS_GET)).toEqual([]);
      expect(await rows("SELECT count(*) AS n FROM connections")).toEqual([{ n: 0 }]);
      expect((await readPlaidSettings(bank.database)).appItems).toBe(0);
      expect(bank.syncsStarted).toEqual([]);
    });

    it("blocks a duplicate bank, as linking does, and saves nothing", async () => {
      const covering = await existing("ins_other", "Other Bank", {
        kind: "credit",
        mask: "3333",
      });
      const { accessToken } = knownToken(2);

      const covered = {
        outcome: "duplicate",
        coveredBy: { connectionId: covering, bankName: "Other Bank" },
      };
      expect(await linking.previewImport(accessToken)).toEqual(covered);
      expect(await linking.importConnection(accessToken)).toEqual(covered);
      expect(await rows("SELECT count(*) AS n FROM connections")).toEqual([{ n: 1 }]);
    });

    it("blocks a token for a bank the app already has by its institution ID", async () => {
      const covering = await existing("ins_fake", "Fake Plaid Bank");
      const { accessToken } = knownToken();

      expect(await linking.importConnection(accessToken)).toEqual({
        outcome: "duplicate",
        coveredBy: { connectionId: covering, bankName: "Fake Plaid Bank" },
      });
    });

    it("stores the token encrypted, marks the Connection imported, counts it in N, and syncs from an empty cursor", async () => {
      const { accessToken } = knownToken();

      const saved = await linking.importConnection(accessToken);

      expect(saved).toMatchObject({ outcome: "imported", bankName: "Fake Plaid Bank" });
      const connectionId = saved.outcome === "imported" ? saved.connectionId : "";
      const [stored] = await rows(
        "SELECT id, bank_id, origin, credential, sync_cursor FROM connections",
      );
      expect(stored).toMatchObject({
        id: connectionId,
        bank_id: "ins_fake",
        origin: "imported",
        sync_cursor: null,
      });
      expect(String(stored?.credential)).not.toContain(accessToken);
      expect(
        bank.secrets.decrypt(String(stored?.credential), {
          rowId: connectionId,
          column: "connections.credential",
        }),
      ).toBe(accessToken);
      expect((await readPlaidSettings(bank.database)).appItems).toBe(1);
      expect(bank.syncsStarted).toEqual([connectionId]);

      plaid.answer("/transactions/sync", {
        body: {
          added: [],
          modified: [],
          removed: [],
          next_cursor: "cursor-1",
          has_more: false,
          transactions_update_status: "NOT_READY",
          accounts: [],
        },
      });
      plaid.answer(ACCOUNTS_GET, { body: { accounts: [] } });
      await syncConnection(connectionId);
      const [first] = plaid.to("/transactions/sync");
      expect(first?.body.access_token).toBe(accessToken);
      expect(first?.body).not.toHaveProperty("cursor");
    });

    it("imports even at N of 10, since an import spends no Item", async () => {
      await storeItemsUsed(bank.database, 10);
      const { accessToken } = knownToken();

      expect(await linking.importConnection(accessToken)).toMatchObject({ outcome: "imported" });
    });
  });
});
