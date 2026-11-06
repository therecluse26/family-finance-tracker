import {
  type AccountBase,
  CountryCode,
  type LiabilitiesObject,
  PersonalFinanceCategoryVersion,
  PlaidApi,
  Products,
  type RemovedTransaction,
  type Transaction,
  TransactionsUpdateStatus,
} from "plaid";
import type { Database } from "../db/index.ts";
import { log, registerSecretValue } from "../log.ts";
import type { Secrets } from "../secrets/index.ts";
import {
  type AccountSnapshot,
  type BankConnection,
  type BankDataAdapter,
  BankDataError,
  type BankErrorKind,
  type Cents,
  type SyncResult,
  type TxnRecord,
} from "./adapter.ts";
import { plaidConfiguration, plaidError, readPlaidKeys } from "./plaid-keys.ts";
import type { PlaidKeys } from "./plaid-view.ts";

// The Plaid adapter (spec 02, The Plaid adapter, Linking a new bank, Repair, What a Plaid sync
// calls, and Plaid errors). It links a bank through /link/token/create and
// /item/public_token/exchange, confirms the bank through /item/get, repairs one or adds Accounts to
// it through /link/token/create in update mode, imports one through /item/get, and removes one
// through /item/remove. It reads a Connection
// through /transactions/sync, /accounts/get, and /liabilities/get, and maps
// Plaid's fields into the app's records. It sorts every Plaid error into an error kind. Its errors
// name only Plaid's error code and type, or the HTTP status: Plaid's own error also holds the
// request, with the keys and the access token. No token, Item ID, or account number goes into an
// error, and the raw data it returns holds no account number. Each token is registered with the
// logger before any call, so no log line can hold it.

// The parts of Plaid's client that the adapter uses. Tests point it at a fake Plaid server.
export type PlaidClient = Pick<
  PlaidApi,
  | "transactionsSync"
  | "accountsGet"
  | "liabilitiesGet"
  | "itemGet"
  | "transactionsRefresh"
  | "linkTokenCreate"
  | "itemPublicTokenExchange"
  | "itemRemove"
>;
export type PlaidClientFor = (keys: PlaidKeys) => PlaidClient;

const PAGE_SIZE = 500;
// A run of /transactions/sync pages that has not ended after this many pages stops.
const MAX_PAGES = 1_000;
// How many times one sync restarts a run that Plaid's data changed under.
const MAX_RESTARTS = 3;

// Plaid changed the Item's data while the adapter paged through it: the run starts again from its
// first cursor.
const MUTATION_DURING_PAGINATION = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";

// Every other code, every error type, an HTTP error, and a network failure is Temporary. That
// covers the types INSTITUTION_ERROR, API_ERROR, and RATE_LIMIT_EXCEEDED. A listed code wins over
// its type: INSTITUTION_NO_LONGER_SUPPORTED has the type INSTITUTION_ERROR, and is Gone.
const KIND_OF_CODE = new Map<string, BankErrorKind>([
  ["ITEM_LOGIN_REQUIRED", "needs a member"],
  ["ITEM_LOCKED", "needs a member"],
  ["USER_SETUP_REQUIRED", "needs a member"],
  ["ITEM_NOT_FOUND", "gone"],
  ["INVALID_ACCESS_TOKEN", "gone"],
  ["INSTITUTION_NO_LONGER_SUPPORTED", "gone"],
]);

// The /liabilities/get errors that mean Plaid has no Liabilities data for the Connection. The card
// and loan details stay empty, and that is not an error. INVALID_PRODUCT means the Plaid team has
// no Liabilities access: as an error, it would fail every sync of a Connection with a card or loan.
const NO_LIABILITIES_DATA = new Set([
  "NO_LIABILITY_ACCOUNTS",
  "PRODUCTS_NOT_SUPPORTED",
  "PRODUCT_NOT_READY",
  "ADDITIONAL_CONSENT_REQUIRED",
  "INVALID_PRODUCT",
]);

// The link token's settings (spec 02, Linking a new bank). Plaid fixes days_requested when the bank
// is linked, and the app never asks to raise it. The token has no webhook (ADR 0004) and no
// redirect URI, so OAuth banks open in a pop-up.
const CLIENT_NAME = "Family Finance Tracker";
const DAYS_REQUESTED = 730;

// A sync asks for a second page from the cursor the first one returned, and that page has no
// changes. Its Accounts come from the first page when it came this recently, so one sync calls
// /accounts/get and /liabilities/get once.
const ACCOUNTS_REUSE_MS = 5 * 60_000;

// Plaid's error codes and types are upper-case names. Anything else is not written into a message.
const PLAID_NAME = /^[A-Z0-9_]{1,80}$/;

// The /item/remove errors that mean the Item no longer exists at Plaid, so the Connection has
// already ended. Any other error, INSTITUTION_NO_LONGER_SUPPORTED included, may leave the Item at
// Plaid, so the removal does not go on.
const ALREADY_ENDED = new Set(["ITEM_NOT_FOUND", "INVALID_ACCESS_TOKEN"]);

const plaidName = (value: unknown): string | undefined =>
  typeof value === "string" && PLAID_NAME.test(value) ? value : undefined;

// A Plaid error, sorted. It keeps Plaid's error code, so the adapter can act on it.
class PlaidCallError extends BankDataError {
  readonly code: string | undefined;

  constructor(found: { type: unknown; code: unknown; status: unknown }) {
    const code = plaidName(found.code);
    const type = plaidName(found.type);
    const kind = (code === undefined ? undefined : KIND_OF_CODE.get(code)) ?? "temporary";
    let message = "Plaid could not be reached.";
    if (code !== undefined) message = `Plaid answered ${code}${type ? ` (${type})` : ""}.`;
    else if (typeof found.status === "number") message = `Plaid answered HTTP ${found.status}.`;
    super(kind, message);
    this.code = code;
  }
}

// One Plaid call. A failure becomes a sorted error, and the client's own error goes no further.
async function call<T>(request: () => Promise<{ data: T }>): Promise<T> {
  try {
    return (await request()).data;
  } catch (error) {
    throw new PlaidCallError(plaidError(error));
  }
}

// Plaid's dollars, as whole cents, converted once.
function cents(dollars: number | null | undefined): Cents | null {
  if (dollars === null || dollars === undefined) return null;
  if (!Number.isFinite(dollars)) throw new BankDataError("temporary", "Plaid sent a bad amount.");
  return Math.round(dollars * 100);
}

// The other sign. 0 - 0 is 0, where -0 would be -0.
const flip = (amount: Cents | null): Cents | null => (amount === null ? null : 0 - amount);

// The fields of Plaid's data that hold an account number or a personal detail (spec 02, Records
// the adapter returns). A student loan's payment_reference_number is, by Plaid's docs, usually its
// account number. A Transaction's payment_meta holds a reference_number and a ppd_id, its
// account_owner names a person, and a mortgage's property_address is the Household's home.
const PERSONAL_FIELDS = new Set([
  "account_number",
  "account_numbers",
  "payment_reference_number",
  "reference_number",
  "ppd_id",
  "account_owner",
  "property_address",
]);

// Plaid's data with every account number and personal detail left out, by field name at every
// depth, for a record's raw data. Liabilities and other parties can hold one.
function withoutPersonalFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPersonalFields);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name]) => !PERSONAL_FIELDS.has(name))
      .map(([name, field]) => [name, withoutPersonalFields(field)]),
  );
}

// One Transaction. Plaid's amount is positive for money out; the app's is positive for money in.
function txnRecord(txn: Transaction): TxnRecord {
  const category = txn.personal_finance_category;
  return {
    id: txn.transaction_id,
    accountId: txn.account_id,
    amount: flip(cents(txn.amount)) ?? 0,
    postedDate: txn.date,
    authorizedDate: txn.authorized_date ?? null,
    pending: txn.pending,
    pendingTransactionId: txn.pending_transaction_id ?? null,
    // Plaid sends the original bank description when asked. Its cleaned name stands in when none
    // came.
    description: txn.original_description ?? txn.name,
    merchantName: txn.merchant_name ?? null,
    merchantId: txn.merchant_entity_id ?? null,
    counterparties: (txn.counterparties ?? []).map((party) => ({
      name: party.name,
      type: party.type,
    })),
    // The MCC stays empty (spec 02, Records the adapter returns).
    category: category
      ? {
          name: category.detailed,
          confidence: category.confidence_level ?? null,
          version: category.version ?? PersonalFinanceCategoryVersion.V2,
          mcc: null,
        }
      : null,
    raw: withoutPersonalFields(txn),
  };
}

// One Account, with its card or loan details from Plaid's Liabilities data. Plaid sends money owed
// on a card or loan as a positive number; the app's balances use the Transaction sign, so the
// current balance and the statement balance flip. The principal is the loan's current balance as
// Plaid sends it: what is still owed.
function accountSnapshot(account: AccountBase, liabilities: LiabilitiesObject | null) {
  const owed = account.type === "credit" || account.type === "loan";
  const current = cents(account.balances.current);
  const ofThisAccount = <T extends { account_id: string | null }>(list: T[] | null | undefined) =>
    list?.find((entry) => entry.account_id === account.account_id);
  const credit = ofThisAccount(liabilities?.credit);
  const student = ofThisAccount(liabilities?.student);
  const mortgage = ofThisAccount(liabilities?.mortgage);
  const loan = student ?? mortgage;
  const snapshot: AccountSnapshot = {
    id: account.account_id,
    name: account.name,
    type: account.type,
    subtype: account.subtype ?? null,
    mask: account.mask ?? null,
    currentBalance: owed ? flip(current) : current,
    availableBalance: cents(account.balances.available),
    creditLimit: cents(account.balances.limit),
    card: credit
      ? {
          aprs: credit.aprs.map((apr) => ({ type: apr.apr_type, apr: apr.apr_percentage })),
          statementBalance: flip(cents(credit.last_statement_balance)),
          minimumPayment: cents(credit.minimum_payment_amount),
          dueDate: credit.next_payment_due_date ?? null,
          statementIssueDate: credit.last_statement_issue_date ?? null,
        }
      : null,
    loan: loan
      ? {
          apr: student
            ? student.interest_rate_percentage
            : (mortgage?.interest_rate.percentage ?? null),
          principal: current,
          interestPaidThisYear: cents(loan.ytd_interest_paid),
          // Plaid's mortgage data has no minimum_payment_amount.
          minimumPayment: student ? cents(student.minimum_payment_amount) : null,
          dueDate: loan.next_payment_due_date ?? null,
        }
      : null,
    raw: withoutPersonalFields({ account, liability: credit ?? loan ?? null }),
  };
  return snapshot;
}

type TransactionsRun = {
  added: Transaction[];
  modified: Transaction[];
  removed: RemovedTransaction[];
  nextCursor: string;
  historyLoaded: boolean;
};

export function plaidAdapter(options: {
  database: Database;
  secrets: Secrets;
  clientFor?: PlaidClientFor;
}): BankDataAdapter {
  const {
    database,
    secrets,
    clientFor = (keys) => new PlaidApi(plaidConfiguration(keys)),
  } = options;

  // The Plaid client, with the saved keys.
  async function plaidClient(): Promise<PlaidClient> {
    const keys = await readPlaidKeys(database, secrets);
    if (keys === undefined) throw new BankDataError("temporary", "The Plaid keys are not set.");
    return clientFor(keys);
  }

  // The Plaid client and the Connection's access token. The token is registered with the logger
  // before any call, so no log line can hold it.
  async function open(connection: BankConnection) {
    const accessToken = connection.credential;
    if (accessToken === null)
      throw new BankDataError("gone", "The Connection has no Plaid access.");
    registerSecretValue(accessToken);
    return { client: await plaidClient(), access_token: accessToken };
  }

  // The Accounts of each Connection's last sync page that had changes, with the cursor it handed
  // out, by Connection ID.
  const lastAccounts = new Map<
    string,
    { cursor: string; accounts: AccountSnapshot[]; at: number }
  >();

  // One run of /transactions/sync pages, from `cursor` until has_more is false.
  async function pullRun(
    client: PlaidClient,
    access_token: string,
    cursor: string | null,
  ): Promise<TransactionsRun> {
    const run: TransactionsRun = {
      added: [],
      modified: [],
      removed: [],
      nextCursor: "",
      historyLoaded: false,
    };
    let next = cursor;
    for (let pages = 0; pages < MAX_PAGES; pages += 1) {
      const page = await call(() =>
        client.transactionsSync({
          access_token,
          ...(next ? { cursor: next } : {}),
          count: PAGE_SIZE,
          options: {
            include_original_description: true,
            personal_finance_category_version: PersonalFinanceCategoryVersion.V2,
          },
        }),
      );
      run.added.push(...page.added);
      run.modified.push(...page.modified);
      run.removed.push(...page.removed);
      next = page.next_cursor;
      if (!page.has_more) {
        run.nextCursor = page.next_cursor;
        run.historyLoaded =
          page.transactions_update_status === TransactionsUpdateStatus.HistoricalUpdateComplete;
        return run;
      }
    }
    throw new BankDataError("temporary", `Plaid's pages did not end after ${MAX_PAGES} pages.`);
  }

  // The run, restarted from its first cursor when Plaid's data changes during it. Nothing of a
  // failed run is kept, so no page is returned twice.
  async function pullTransactions(
    client: PlaidClient,
    access_token: string,
    cursor: string | null,
  ): Promise<TransactionsRun> {
    for (let restarts = 0; ; restarts += 1) {
      try {
        return await pullRun(client, access_token, cursor);
      } catch (error) {
        const mutated =
          error instanceof PlaidCallError && error.code === MUTATION_DURING_PAGINATION;
        if (!mutated || restarts >= MAX_RESTARTS) throw error;
      }
    }
  }

  // The Accounts and their balances, with card and loan details where Plaid has them.
  async function accounts(client: PlaidClient, access_token: string): Promise<AccountSnapshot[]> {
    const { accounts: found } = await call(() => client.accountsGet({ access_token }));
    let liabilities: LiabilitiesObject | null = null;
    if (found.some((account) => account.type === "credit" || account.type === "loan")) {
      try {
        ({ liabilities } = await call(() => client.liabilitiesGet({ access_token })));
      } catch (error) {
        const none = error instanceof PlaidCallError && NO_LIABILITIES_DATA.has(error.code ?? "");
        if (!none) throw error;
      }
    }
    return found.map((account) => accountSnapshot(account, liabilities));
  }

  return {
    provider: "plaid",
    minSyncGapHours: 0,
    actions: { repairInApp: true, importExisting: true, refresh: true },

    // The adapter pages through Plaid inside one call, and hands the core one page. The core
    // stores it, then asks again from its cursor, and ends when a page returns the cursor it was
    // asked with. A run with no changes returns the cursor it was asked with, so the sync ends even
    // when Plaid hands out a new cursor with nothing new. That last page reuses the Accounts of the
    // page before it, so a sync calls /accounts/get and /liabilities/get once.
    async sync(connection, cursor): Promise<SyncResult> {
      const { client, access_token } = await open(connection);
      const run = await pullTransactions(client, access_token, cursor);
      const changes = run.added.length + run.modified.length + run.removed.length;
      const last = lastAccounts.get(connection.id);
      lastAccounts.delete(connection.id);
      const reuse =
        last !== undefined &&
        changes === 0 &&
        last.cursor === cursor &&
        Date.now() - last.at < ACCOUNTS_REUSE_MS;
      const snapshots = reuse ? last.accounts : await accounts(client, access_token);
      if (changes > 0) {
        lastAccounts.set(connection.id, {
          cursor: run.nextCursor,
          accounts: snapshots,
          at: Date.now(),
        });
      }
      return {
        accounts: snapshots,
        added: run.added.map(txnRecord),
        changed: run.modified.map(txnRecord),
        removed: run.removed.map((removal) => ({
          id: removal.transaction_id,
          reason: "removed by provider",
        })),
        nextCursor: changes === 0 && cursor !== null ? cursor : run.nextCursor,
        historyLoaded: run.historyLoaded,
      };
    },

    // One cheap, read-only /item/get call. Plaid answers it with the Item's error, if it has one.
    async check(connection) {
      const { client, access_token } = await open(connection);
      const { item } = await call(() => client.itemGet({ access_token }));
      if (item.error) {
        throw new PlaidCallError({
          type: item.error.error_type,
          code: item.error.error_code,
          status: undefined,
        });
      }
    },

    async refresh(connection) {
      const { client, access_token } = await open(connection);
      await call(() => client.transactionsRefresh({ access_token }));
    },

    // A link token for a new bank (spec 02, Linking a new bank). The only detail about the Household
    // that Plaid gets is client_user_id, which Plaid requires: a random ID made for this token, so
    // it names no Member.
    async startLink() {
      const client = await plaidClient();
      const { link_token } = await call(() =>
        client.linkTokenCreate({
          client_name: CLIENT_NAME,
          user: { client_user_id: crypto.randomUUID() },
          products: [Products.Transactions],
          required_if_supported_products: [Products.Liabilities],
          transactions: { days_requested: DAYS_REQUESTED },
          country_codes: [CountryCode.Us],
          language: "en",
        }),
      );
      registerSecretValue(link_token);
      return { linkToken: link_token };
    },

    // A link token in update mode (spec 02, Repair and New accounts at a bank): it carries the
    // Connection's access token and no products, so Link repairs the same Item and spends none. With
    // `addAccounts`, the Member also picks Accounts to add. Link's public token is not exchanged
    // after update mode: the access token stays the same. client_user_id is a new random ID, as for
    // a new bank.
    async startRepair(connection, { addAccounts }) {
      const { client, access_token } = await open(connection);
      const { link_token } = await call(() =>
        client.linkTokenCreate({
          client_name: CLIENT_NAME,
          user: { client_user_id: crypto.randomUUID() },
          country_codes: [CountryCode.Us],
          language: "en",
          access_token,
          ...(addAccounts ? { update: { account_selection_enabled: true } } : {}),
        }),
      );
      registerSecretValue(link_token);
      return { linkToken: link_token };
    },

    // Exchanges Link's public token for the access token. The core already checked the bank Link's
    // metadata named. One /item/get, which spends no Item, then confirms the bank by Plaid's own ID,
    // so the browser's word does not decide the stored bank. When that call fails, or names no
    // bank, the Item is already spent, so the Connection keeps Link's bank rather than losing its
    // access token, marked unconfirmed, so the core decides nothing on it. The first sync brings
    // the Accounts.
    async finishLink(result) {
      registerSecretValue(result.publicToken);
      const client = await plaidClient();
      const exchanged = await call(() =>
        client.itemPublicTokenExchange({ public_token: result.publicToken }),
      );
      registerSecretValue(exchanged.access_token);
      registerSecretValue(exchanged.item_id);
      let bankId = result.bankId;
      let bankName = result.bankName;
      let bankConfirmed = false;
      try {
        const { item } = await call(() => client.itemGet({ access_token: exchanged.access_token }));
        if (item.institution_id) {
          if (item.institution_id !== result.bankId) {
            log.warn("Plaid named another bank than Link did; the app keeps Plaid's");
          }
          bankId = item.institution_id;
          bankName = item.institution_name ?? bankName;
          bankConfirmed = true;
        }
      } catch (error) {
        log.warn("Plaid did not confirm a new bank; the app keeps Link's", { error });
      }
      return { bankId, bankName, bankConfirmed, credential: exchanged.access_token, accounts: [] };
    },

    // Adopts an access token made outside the app (spec 02, Import Plaid Connection). One /item/get
    // checks the token and names the bank; /accounts/get lists its Accounts for the preview. A
    // token Plaid refuses throws a sorted error that names no token.
    async importExisting(credential) {
      registerSecretValue(credential);
      const client = await plaidClient();
      const { item } = await call(() => client.itemGet({ access_token: credential }));
      registerSecretValue(item.item_id);
      const { accounts: found } = await call(() =>
        client.accountsGet({ access_token: credential }),
      );
      const bankId = item.institution_id ?? null;
      if (bankId === null) {
        throw new BankDataError("gone", "Plaid named no bank for this access token.");
      }
      return {
        bankId,
        bankName: item.institution_name ?? bankId,
        bankConfirmed: true,
        credential,
        accounts: found.map((account) => accountSnapshot(account, null)),
      };
    },

    // Ends the Item at Plaid (spec 02, Removing a Connection). Plaid's slot stays spent. Only
    // ITEM_NOT_FOUND and INVALID_ACCESS_TOKEN throw as Gone; every other Gone code is Temporary
    // here, since the Item may still exist at Plaid.
    async remove(connection) {
      const { client, access_token } = await open(connection);
      try {
        await call(() => client.itemRemove({ access_token }));
      } catch (error) {
        const ended = error instanceof PlaidCallError && ALREADY_ENDED.has(error.code ?? "");
        if (error instanceof BankDataError && error.kind === "gone" && !ended) {
          throw new BankDataError("temporary", error.message);
        }
        throw error;
      }
      lastAccounts.delete(connection.id);
    },
  };
}
