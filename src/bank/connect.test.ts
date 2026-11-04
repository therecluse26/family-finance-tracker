import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addConnection,
  PLAID_SETTINGS_ROW,
  readPlaidSettings,
  saveSyncState,
  storeItemsUsed,
  storePlaidKeys,
} from "../db/index.ts";
import { holdsSecretValue } from "../log.ts";
import {
  FakePlaid,
  newAccessToken,
  newItemId,
  newLinkToken,
  newPublicToken,
  plaidFailure,
  RECORDED,
} from "./fake-plaid.ts";
import {
  type BankConnecting,
  bankConnecting,
  type LinkResult,
  plaidAdapter,
  syncConnection,
} from "./index.ts";
import { newPlaidKeys, newTestBank, type TestBank } from "./testing.ts";

// Linking a new bank through Plaid (spec 02, Linking a new bank and The 10 lifetime Items), on
// Plaid's real client pointed at a fake Plaid server. No test calls Plaid. Every token is made
// when the test runs.

const LINK_TOKEN = "/link/token/create";
const EXCHANGE = "/item/public_token/exchange";

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

  function exchangeAnswers() {
    const answer = { access_token: newAccessToken(), item_id: newItemId() };
    plaid.answer(EXCHANGE, { body: { ...answer, request_id: "req-exchange" } });
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
  });

  // Import Plaid Connection (spec 02): an access token made outside the app.
  describe("importing a Plaid Connection by its access token", () => {
    const ITEM_GET = "/item/get";
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
