import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addConnection, PLAID_SETTINGS_ROW, storePlaidKeys } from "../db/index.ts";
import { holdsSecretValue } from "../log.ts";
import { FakePlaid, plaidFailure, RECORDED } from "./fake-plaid.ts";
import {
  type BankConnection,
  type BankDataAdapter,
  BankDataError,
  type PlaidKeys,
  plaidAdapter,
  syncConnection,
} from "./index.ts";
import { newPlaidKeys, newTestBank, type TestBank } from "./testing.ts";

// The Plaid adapter (spec 02, What a Plaid sync calls and Plaid errors), on Plaid's real client
// pointed at a fake Plaid server on 127.0.0.1. The fake answers with responses written by hand in
// Plaid's shape. No test calls Plaid. Every token and key is made when the test runs.

// A /transactions/sync page.
function syncPage(fields: {
  added?: unknown[];
  modified?: unknown[];
  removed?: unknown[];
  next_cursor: string;
  has_more?: boolean;
  transactions_update_status?: string;
}) {
  return {
    body: {
      transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
      accounts: [],
      added: [],
      modified: [],
      removed: [],
      has_more: false,
      request_id: "req-sync",
      ...fields,
    },
  };
}

const [COFFEE] = (RECORDED.transactionsSync[0]?.added ?? []) as Record<string, unknown>[];
// A recorded Transaction with another ID.
const anotherTxn = (id: string) => ({ ...COFFEE, transaction_id: id });

const SYNC = "/transactions/sync";
const ACCOUNTS = "/accounts/get";
const LIABILITIES = "/liabilities/get";
const ITEM = "/item/get";
const REFRESH = "/transactions/refresh";

describe("the Plaid adapter", () => {
  let bank: TestBank;
  let plaid: FakePlaid;
  let adapter: BankDataAdapter;
  let connectionId: string;
  let accessToken: string;
  let connection: BankConnection;
  let keys: PlaidKeys;

  beforeEach(async () => {
    plaid = new FakePlaid();
    await plaid.start();
    bank = await newTestBank({
      adapters: ({ database, secrets }) => {
        adapter = plaidAdapter({ database, secrets, clientFor: plaid.clientFor });
        return [adapter];
      },
    });
    keys = newPlaidKeys();
    await storePlaidKeys(bank.database, {
      clientId: keys.clientId,
      secret: bank.secrets.encrypt(keys.secret, {
        rowId: PLAID_SETTINGS_ROW,
        column: "plaid_settings.secret",
      }),
    });
    connectionId = await addConnection(bank.database, {
      provider: "plaid",
      bankId: "ins_fake",
      bankName: "Fake Plaid Bank",
      origin: "imported",
      syncMinute: 7,
    });
    accessToken = `access-test-${crypto.randomUUID()}`;
    await bank.database.$client.execute({
      sql: "UPDATE connections SET credential = ? WHERE id = ?",
      args: [
        bank.secrets.encrypt(accessToken, {
          rowId: connectionId,
          column: "connections.credential",
        }),
        connectionId,
      ],
    });
    connection = {
      id: connectionId,
      provider: "plaid",
      bankId: "ins_fake",
      bankName: "Fake Plaid Bank",
      credential: accessToken,
    };
    plaid.answer(ACCOUNTS, { body: RECORDED.accountsGet });
    plaid.answer(LIABILITIES, { body: RECORDED.liabilitiesGet });
  });

  afterEach(async () => {
    bank.close();
    await plaid.close();
  });

  const rows = async (sql: string) => (await bank.database.$client.execute(sql)).rows;

  const recordedPages = () =>
    plaid.answer(SYNC, ...RECORDED.transactionsSync.map((body) => ({ body })));

  it("declares no gap between syncs and all three actions", () => {
    expect(adapter.provider).toBe("plaid");
    expect(adapter.minSyncGapHours).toBe(0);
    expect(adapter.actions).toEqual({ repairInApp: true, importExisting: true, refresh: true });
  });

  it("pages through /transactions/sync until has_more is false, and returns one page", async () => {
    recordedPages();

    const result = await adapter.sync(connection, null);

    const pages = plaid.to(SYNC);
    expect(pages.map((page) => page.body.cursor)).toEqual([undefined, "cursor-1"]);
    for (const page of pages) {
      expect(page.body).toMatchObject({
        access_token: accessToken,
        count: 500,
        options: { include_original_description: true, personal_finance_category_version: "v2" },
      });
      expect(page.headers["plaid-client-id"]).toBe(keys.clientId);
    }
    expect(result.added.map((record) => record.id)).toEqual(["txn-coffee", "txn-pay", "txn-zero"]);
    expect(result.changed.map((record) => record.id)).toEqual(["txn-older"]);
    expect(result.removed).toEqual([{ id: "txn-gone", reason: "removed by provider" }]);
    expect(result.nextCursor).toBe("cursor-2");
    expect(result.historyLoaded).toBe(true);
  });

  it("maps Plaid's Transaction fields, keeps the raw data, and leaves the MCC empty", async () => {
    recordedPages();

    const { added } = await adapter.sync(connection, null);

    expect(added[0]).toEqual({
      id: "txn-coffee",
      accountId: "acct-card",
      amount: -1_234,
      postedDate: "2026-10-03",
      authorizedDate: "2026-10-02",
      pending: false,
      pendingTransactionId: "txn-coffee-pending",
      description: "STARBUCKS STORE 00000 SPRINGFIELD",
      merchantName: "Starbucks",
      merchantId: "merchant-starbucks",
      counterparties: [
        { name: "Starbucks", type: "merchant" },
        { name: "Square", type: "payment_terminal" },
      ],
      category: {
        name: "FOOD_AND_DRINK_COFFEE",
        confidence: "VERY_HIGH",
        version: "v2",
        mcc: null,
      },
      raw: expect.objectContaining({ transaction_id: "txn-coffee", amount: 12.34 }),
    });
    // With no original description, Plaid's name stands in; with no category, the field is empty.
    expect(added[2]).toMatchObject({
      description: "Card check",
      pending: true,
      category: null,
      merchantName: null,
    });
  });

  it("flips Plaid's sign once into whole cents, so a positive amount is money in", async () => {
    recordedPages();

    const { added, changed, accounts } = await adapter.sync(connection, null);

    const amount = (id: string) => [...added, ...changed].find((record) => record.id === id);
    // Plaid's 12.34 out is -1234 cents; its -2500 in is +250000; 0 stays 0, not -0.
    expect(amount("txn-coffee")?.amount).toBe(-1_234);
    expect(amount("txn-pay")?.amount).toBe(250_000);
    expect(Object.is(amount("txn-zero")?.amount, 0)).toBe(true);
    expect(amount("txn-older")?.amount).toBe(-4_560);
    // Money owed on a card or loan is negative; a checking balance stays positive.
    const account = (id: string) => accounts.find((snapshot) => snapshot.id === id);
    expect(account("acct-checking")?.currentBalance).toBe(248_025);
    expect(account("acct-card")?.currentBalance).toBe(-41_055);
    expect(account("acct-card")?.card?.statementBalance).toBe(-170_877);
    expect(account("acct-personal")?.currentBalance).toBe(-1_200_001);
  });

  it("maps /accounts/get and /liabilities/get into Accounts with card and loan details", async () => {
    recordedPages();

    const { accounts } = await adapter.sync(connection, null);

    expect(accounts.map(({ raw, ...snapshot }) => snapshot)).toEqual([
      {
        id: "acct-checking",
        name: "Plaid Checking",
        type: "depository",
        subtype: "checking",
        mask: "0000",
        currentBalance: 248_025,
        availableBalance: 240_050,
        creditLimit: null,
        card: null,
        loan: null,
      },
      {
        id: "acct-card",
        name: "Plaid Credit Card",
        type: "credit",
        subtype: "credit card",
        mask: "3333",
        currentBalance: -41_055,
        availableBalance: 458_945,
        creditLimit: 500_000,
        card: {
          aprs: [
            { type: "balance_transfer_apr", apr: 15.24 },
            { type: "purchase_apr", apr: 27.95 },
          ],
          statementBalance: -170_877,
          minimumPayment: 2_000,
          dueDate: "2026-11-01",
          statementIssueDate: "2026-10-04",
        },
        loan: null,
      },
      {
        id: "acct-student",
        name: "Plaid Student Loan",
        type: "loan",
        subtype: "student",
        mask: "7777",
        currentBalance: -6_526_200,
        availableBalance: null,
        creditLimit: null,
        card: null,
        loan: {
          apr: 5.25,
          principal: 6_526_200,
          interestPaidThisYear: 28_055,
          minimumPayment: 2_500,
          dueDate: "2026-11-01",
        },
      },
      {
        // Plaid's Liabilities data does not cover personal loans: the details stay empty.
        id: "acct-personal",
        name: "Personal Loan",
        type: "loan",
        subtype: "personal",
        mask: "8888",
        currentBalance: -1_200_001,
        availableBalance: null,
        creditLimit: null,
        card: null,
        loan: null,
      },
    ]);
    // The raw data keeps the account and its Liabilities data, with no account number.
    expect(accounts[2]?.raw).toMatchObject({
      account: { account_id: "acct-student" },
      liability: { account_id: "acct-student", ytd_interest_paid: 280.55 },
    });
    expect(JSON.stringify(accounts)).not.toContain("account_number");
  });

  it("stores raw data with no account number, by field name or by value", async () => {
    // The recorded student loan has an account number and a different payment reference number,
    // and the recorded payment terminal has a bank account number.
    const names = ["account_number", "account_numbers", "payment_reference_number"];
    const values = ["9000000001", "9000000002", "90000003"];
    const recorded = JSON.stringify(RECORDED);
    for (const text of [...names, ...values]) expect(recorded).toContain(text);
    recordedPages();

    await syncConnection(connectionId);

    const stored = JSON.stringify([
      ...(await rows("SELECT raw FROM household_accounts")),
      ...(await rows("SELECT raw FROM transactions")),
    ]);
    expect(stored).toContain("acct-student");
    expect(stored).toContain("txn-coffee");
    for (const text of [...names, ...values]) expect(stored).not.toContain(text);
  });

  it.each([
    ["NO_LIABILITY_ACCOUNTS", "ITEM_ERROR"],
    ["PRODUCTS_NOT_SUPPORTED", "ITEM_ERROR"],
    ["PRODUCT_NOT_READY", "ITEM_ERROR"],
    ["ADDITIONAL_CONSENT_REQUIRED", "ITEM_ERROR"],
    // The Plaid team has no Liabilities access.
    ["INVALID_PRODUCT", "INVALID_INPUT"],
  ])("leaves the details empty when Plaid has no Liabilities data (%s)", async (code, type) => {
    plaid.answer(SYNC, syncPage({ next_cursor: "cursor-1" }));
    plaid.answer(LIABILITIES, { status: 400, body: plaidFailure(type, code) });

    const { accounts } = await adapter.sync(connection, null);

    expect(accounts).toHaveLength(4);
    expect(accounts.every((snapshot) => snapshot.card === null && snapshot.loan === null)).toBe(
      true,
    );
  });

  it("leaves the details empty when Liabilities data names none of the Accounts", async () => {
    plaid.answer(SYNC, syncPage({ next_cursor: "cursor-1" }));
    plaid.answer(LIABILITIES, {
      body: { accounts: [], liabilities: { credit: null, mortgage: null, student: null } },
    });

    const { accounts } = await adapter.sync(connection, null);

    expect(accounts.map((snapshot) => [snapshot.card, snapshot.loan])).toEqual(
      accounts.map(() => [null, null]),
    );
  });

  it("asks for no Liabilities data when the Connection has no card or loan", async () => {
    plaid.answer(SYNC, syncPage({ next_cursor: "cursor-1" }));
    plaid.answer(ACCOUNTS, { body: { accounts: [RECORDED.accountsGet.accounts[0]] } });

    await adapter.sync(connection, null);

    expect(plaid.to(LIABILITIES)).toEqual([]);
  });

  it.each([
    ["HISTORICAL_UPDATE_COMPLETE", true],
    ["INITIAL_UPDATE_COMPLETE", false],
    ["NOT_READY", false],
    ["TRANSACTIONS_UPDATE_STATUS_UNKNOWN", false],
  ])("sets historyLoaded from the last page: %s gives %s", async (status, loaded) => {
    plaid.answer(SYNC, syncPage({ next_cursor: "cursor-1", transactions_update_status: status }));

    expect((await adapter.sync(connection, null)).historyLoaded).toBe(loaded);
  });

  it("keeps historyLoaded false when only a page with more to come says history is complete", async () => {
    plaid.answer(
      SYNC,
      syncPage({ next_cursor: "cursor-1", has_more: true }),
      syncPage({ next_cursor: "cursor-2", transactions_update_status: "INITIAL_UPDATE_COMPLETE" }),
    );

    expect((await adapter.sync(connection, null)).historyLoaded).toBe(false);
  });

  it("returns the cursor it was asked with when nothing changed, so the sync ends", async () => {
    plaid.answer(SYNC, syncPage({ next_cursor: "a-new-cursor" }));

    const result = await adapter.sync(connection, "cursor-2");

    expect(plaid.to(SYNC).map((page) => page.body.cursor)).toEqual(["cursor-2"]);
    expect(result.nextCursor).toBe("cursor-2");
  });

  describe("through a sync of the Connection", () => {
    it("restarts from the run's first cursor when Plaid's data changes, and stores no record twice", async () => {
      plaid.answer(
        SYNC,
        syncPage({
          added: [anotherTxn("t1"), anotherTxn("t2")],
          next_cursor: "c1",
          has_more: true,
        }),
        {
          status: 400,
          body: plaidFailure("TRANSACTIONS_ERROR", "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"),
        },
        syncPage({
          added: [anotherTxn("t1"), anotherTxn("t2")],
          next_cursor: "c1",
          has_more: true,
        }),
        syncPage({ added: [anotherTxn("t3")], next_cursor: "c2" }),
        // The sync asks again from c2. Nothing changed, though Plaid hands out a new cursor.
        syncPage({ next_cursor: "c3" }),
      );

      const report = await syncConnection(connectionId);

      expect(plaid.to(SYNC).map((page) => page.body.cursor)).toEqual([
        undefined,
        "c1",
        undefined,
        "c1",
        "c2",
      ]);
      expect(report.added).toBe(3);
      expect(
        await rows("SELECT provider_transaction_id AS id FROM transactions ORDER BY id"),
      ).toEqual([{ id: "t1" }, { id: "t2" }, { id: "t3" }]);
      expect(await rows("SELECT sync_cursor, history_loaded FROM connections")).toEqual([
        { sync_cursor: "c2", history_loaded: 1 },
      ]);
    });

    it("saves no cursor and stores nothing when a page fails, so the next sync starts again", async () => {
      plaid.answer(
        SYNC,
        syncPage({ added: [anotherTxn("t1")], next_cursor: "c1", has_more: true }),
        "hang up",
        syncPage({ added: [anotherTxn("t1")], next_cursor: "c1", has_more: true }),
        syncPage({ added: [anotherTxn("t2")], next_cursor: "c2" }),
      );

      await expect(syncConnection(connectionId)).rejects.toMatchObject({ kind: "temporary" });
      expect(await rows("SELECT id FROM transactions")).toEqual([]);
      expect(await rows("SELECT sync_cursor FROM connections")).toEqual([{ sync_cursor: null }]);

      await syncConnection(connectionId);

      expect(plaid.to(SYNC).map((page) => page.body.cursor)).toEqual([
        undefined,
        "c1",
        undefined,
        "c1",
        "c2",
      ]);
      expect(await rows("SELECT count(*) AS n FROM transactions")).toEqual([{ n: 2 }]);
    });

    // The recorded run, then a page with no changes for the sync's second ask.
    const recordedThenNothing = () =>
      plaid.answer(
        SYNC,
        ...RECORDED.transactionsSync.map((body) => ({ body })),
        syncPage({ next_cursor: "cursor-3" }),
      );

    it("calls /accounts/get and /liabilities/get once per sync with changes", async () => {
      recordedThenNothing();

      await syncConnection(connectionId);

      expect(plaid.to(SYNC).map((page) => page.body.cursor)).toEqual([
        undefined,
        "cursor-1",
        "cursor-2",
      ]);
      expect(plaid.to(ACCOUNTS)).toHaveLength(1);
      expect(plaid.to(LIABILITIES)).toHaveLength(1);
      expect(await rows("SELECT count(*) AS n FROM daily_balances")).toEqual([{ n: 4 }]);
    });

    it("fetches the Accounts again for the next sync", async () => {
      recordedThenNothing();
      await syncConnection(connectionId);

      await syncConnection(connectionId);

      expect(plaid.to(ACCOUNTS)).toHaveLength(2);
    });

    it("stores the card's statement issue date with its details", async () => {
      recordedPages();

      await syncConnection(connectionId);

      expect(
        await rows(
          "SELECT a.statement_issue_date AS account, b.statement_issue_date AS day FROM household_accounts a JOIN daily_balances b ON b.account_id = a.id WHERE a.provider_account_id = 'acct-card'",
        ),
      ).toEqual([{ account: "2026-10-04", day: "2026-10-04" }]);
    });
  });

  describe("sorting Plaid's errors", () => {
    it.each([
      [400, "INSTITUTION_ERROR", "INSTITUTION_DOWN", "temporary"],
      [500, "API_ERROR", "INTERNAL_SERVER_ERROR", "temporary"],
      [429, "RATE_LIMIT_EXCEEDED", "TRANSACTIONS_LIMIT", "temporary"],
      [400, "INVALID_REQUEST", "MISSING_FIELDS", "temporary"],
      [400, "TRANSACTIONS_ERROR", "TRANSACTIONS_SYNC_LIMIT", "temporary"],
      [400, "ITEM_ERROR", "ITEM_LOGIN_REQUIRED", "needs a member"],
      [400, "ITEM_ERROR", "ITEM_LOCKED", "needs a member"],
      [400, "ITEM_ERROR", "USER_SETUP_REQUIRED", "needs a member"],
      [400, "ITEM_ERROR", "ITEM_NOT_FOUND", "gone"],
      [400, "INVALID_INPUT", "INVALID_ACCESS_TOKEN", "gone"],
      [400, "INSTITUTION_ERROR", "INSTITUTION_NO_LONGER_SUPPORTED", "gone"],
    ])("HTTP %i, %s %s: %s", async (status, type, code, kind) => {
      plaid.answer(SYNC, { status, body: plaidFailure(type, code) });

      const failed = adapter.sync(connection, null);

      await expect(failed).rejects.toBeInstanceOf(BankDataError);
      await expect(failed).rejects.toMatchObject({
        kind,
        message: `Plaid answered ${code} (${type}).`,
      });
    });

    it.each([
      ["INSTITUTION_ERROR", "INSTITUTION_NO_LONGER_SUPPORTED", "gone"],
      ["API_ERROR", "ITEM_LOGIN_REQUIRED", "needs a member"],
      ["RATE_LIMIT_EXCEEDED", "INVALID_ACCESS_TOKEN", "gone"],
    ])("lets a listed code win over its type: %s %s is %s", async (type, code, kind) => {
      plaid.answer(SYNC, { status: 400, body: plaidFailure(type, code) });

      await expect(adapter.sync(connection, null)).rejects.toMatchObject({ kind });
    });

    it.each([
      ["an HTTP 5xx with no Plaid error", { status: 503, body: "Service Unavailable" }],
      ["a network failure", "hang up" as const],
    ])("sorts %s as Temporary", async (_name, answer) => {
      plaid.answer(SYNC, answer);

      await expect(adapter.sync(connection, null)).rejects.toMatchObject({ kind: "temporary" });
    });

    it("sorts a failed /liabilities/get like any call", async () => {
      plaid.answer(SYNC, syncPage({ next_cursor: "cursor-1" }));
      plaid.answer(LIABILITIES, { status: 400, body: plaidFailure("ITEM_ERROR", "ITEM_LOCKED") });

      await expect(adapter.sync(connection, null)).rejects.toMatchObject({
        kind: "needs a member",
      });
    });

    it("follows no redirect, so the keys and the access token never go to another host", async () => {
      const elsewhere = new FakePlaid();
      const elsewhereUrl = await elsewhere.start();
      try {
        plaid.answer(SYNC, { redirect: `${elsewhereUrl}${SYNC}` });

        await expect(adapter.sync(connection, null)).rejects.toMatchObject({
          kind: "temporary",
          message: "Plaid answered HTTP 307.",
        });
        expect(elsewhere.requests).toEqual([]);
      } finally {
        await elsewhere.close();
      }
    });

    it("puts no access token, Item ID, account number, or key into an error", async () => {
      const itemId = `item-test-${crypto.randomUUID()}`;
      const echo = `token ${accessToken}, Item ${itemId}, account 0000000000, key ${keys.secret}`;
      plaid.answer(SYNC, {
        status: 400,
        body: plaidFailure("ITEM_ERROR", "ITEM_LOGIN_REQUIRED", echo),
      });

      const error = await adapter.sync(connection, null).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(BankDataError);
      const written = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack}`;
      for (const secret of [accessToken, itemId, "0000000000", keys.secret, keys.clientId]) {
        expect(written).not.toContain(secret);
      }
      expect((error as Error).cause).toBeUndefined();
    });

    it("restarts a run that Plaid keeps changing only 3 times, then fails as Temporary", async () => {
      plaid.answer(SYNC, {
        status: 400,
        body: plaidFailure("TRANSACTIONS_ERROR", "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION"),
      });

      await expect(adapter.sync(connection, null)).rejects.toMatchObject({ kind: "temporary" });
      expect(plaid.to(SYNC)).toHaveLength(4);
    });
  });

  it("registers the access token with the logger before any call", async () => {
    const fresh = `access-test-${crypto.randomUUID()}`;
    plaid.answer(SYNC, syncPage({ next_cursor: "cursor-1" }));
    expect(holdsSecretValue(fresh)).toBe(false);

    await adapter.sync({ ...connection, credential: fresh }, null);

    expect(holdsSecretValue(fresh)).toBe(true);
    expect(plaid.to(SYNC)[0]?.body.access_token).toBe(fresh);
  });

  describe("the daily check", () => {
    it("calls /item/get once, and finds no error", async () => {
      plaid.answer(ITEM, {
        body: { item: { item_id: `item-test-${crypto.randomUUID()}`, error: null } },
      });

      await adapter.check(connection);

      expect(plaid.requests.map((request) => [request.path, request.body])).toEqual([
        [ITEM, { access_token: accessToken }],
      ]);
    });

    it("throws the Item's error, sorted", async () => {
      plaid.answer(ITEM, {
        body: {
          item: {
            item_id: `item-test-${crypto.randomUUID()}`,
            error: plaidFailure("ITEM_ERROR", "ITEM_LOGIN_REQUIRED"),
          },
        },
      });

      await expect(adapter.check(connection)).rejects.toMatchObject({
        kind: "needs a member",
        message: "Plaid answered ITEM_LOGIN_REQUIRED (ITEM_ERROR).",
      });
    });

    it("throws a failed call, sorted", async () => {
      plaid.answer(ITEM, {
        status: 400,
        body: plaidFailure("INVALID_INPUT", "INVALID_ACCESS_TOKEN"),
      });

      await expect(adapter.check(connection)).rejects.toMatchObject({ kind: "gone" });
    });
  });

  it("refreshes through /transactions/refresh", async () => {
    plaid.answer(REFRESH, { body: { request_id: "req-refresh" } });

    await adapter.refresh?.(connection);

    expect(plaid.requests.map((request) => [request.path, request.body])).toEqual([
      [REFRESH, { access_token: accessToken }],
    ]);
  });

  it("fails as Temporary while the Plaid keys are not set, and calls nothing", async () => {
    await bank.database.$client.execute("DELETE FROM plaid_settings");

    await expect(adapter.sync(connection, null)).rejects.toMatchObject({ kind: "temporary" });
    expect(plaid.requests).toEqual([]);
  });
});
