import {
  type AccountSnapshot,
  type AdapterActions,
  type BankConnection,
  type BankDataAdapter,
  BankDataError,
  type BankErrorKind,
  type LinkResult,
  type LinkSession,
  type NewConnection,
  type RemovalReason,
  type SyncResult,
  type TxnRecord,
} from "./adapter.ts";

// The in-memory fake adapter (spec 02, The bank-data adapter). It makes the seam real and keeps
// tests offline. Each test scripts it per bank: pages of Accounts and of added, changed, and
// removed records, whether history is loaded, and errors of each kind. A script added under a
// Connection's ID wins over its bank's, for a bank linked twice. It never touches a network.

export type FakePage = {
  // The Accounts this page returns. A page without them returns the last ones given.
  accounts?: AccountSnapshot[];
  added?: TxnRecord[];
  changed?: TxnRecord[];
  removed?: { id: string; reason?: RemovalReason }[];
  historyLoaded?: boolean;
};

// An error of a kind, or a given error, which a test may fill with what a provider's error holds.
export type FakeFailure = BankErrorKind | Error;

type Script = { pages: FakePage[]; failures: Map<number, FakeFailure> };

// The cursor after page `index` of a script, such as "fake-chase:2".
const cursorOf = (key: string, index: number) => `${key}:${index}`;

export class FakeBankAdapter implements BankDataAdapter {
  readonly provider = "fake";
  // Tests may set a longer gap, as SimpleFIN would.
  minSyncGapHours = 0;
  // Tests may set any action.
  actions: AdapterActions = { repairInApp: false, importExisting: false, refresh: false };
  // Each sync call, in order.
  readonly calls: { connectionId: string; cursor: string | null }[] = [];
  // Each check, by Connection ID, in order.
  readonly checks: string[] = [];
  // Each update-mode link session asked for, in order.
  readonly repairs: { connectionId: string; addAccounts: boolean }[] = [];

  private readonly scripts = new Map<string, Script>();
  // The error each check of a bank, or of one Connection, finds, until it is cleared.
  private readonly checkErrors = new Map<string, FakeFailure>();

  // A bank's ID, or a Connection's ID.
  private script(key: string): Script {
    let script = this.scripts.get(key);
    if (script === undefined) {
      script = { pages: [], failures: new Map() };
      this.scripts.set(key, script);
    }
    return script;
  }

  // Adds pages to the script of a bank, or of one Connection, after the ones it has.
  addPages(key: string, ...pages: FakePage[]): void {
    this.script(key).pages.push(...pages);
  }

  // The next request for page `index` of the script throws an error of this kind, or this error,
  // once.
  failAt(key: string, index: number, failure: FakeFailure): void {
    this.script(key).failures.set(index, failure);
  }

  // Every check of a bank, or of one Connection, throws an error of this kind, or this error,
  // until it is set to null.
  setCheckError(key: string, failure: FakeFailure | null): void {
    if (failure === null) this.checkErrors.delete(key);
    else this.checkErrors.set(key, failure);
  }

  async check(connection: BankConnection): Promise<void> {
    this.checks.push(connection.id);
    const failure = this.checkErrors.get(connection.id) ?? this.checkErrors.get(connection.bankId);
    if (failure instanceof Error) throw failure;
    if (failure !== undefined) {
      throw new BankDataError(failure, `The fake bank's check found ${failure}.`);
    }
  }

  async sync(connection: BankConnection, cursor: string | null): Promise<SyncResult> {
    this.calls.push({ connectionId: connection.id, cursor });
    const key = this.scripts.has(connection.id) ? connection.id : connection.bankId;
    const { pages, failures } = this.script(key);
    const index = cursor === null ? 0 : Number(cursor.slice(cursor.lastIndexOf(":") + 1));
    if (!Number.isSafeInteger(index) || index < 0) throw new Error(`Unknown cursor "${cursor}".`);
    const failure = failures.get(index);
    if (failure !== undefined) {
      failures.delete(index);
      if (failure instanceof Error) throw failure;
      throw new BankDataError(failure, `The fake bank failed page ${index} (${failure}).`);
    }
    const accounts = pages.slice(0, index + 1).findLast((page) => page.accounts)?.accounts ?? [];
    const page = pages[index];
    if (page === undefined) {
      // Nothing more: the page returns the cursor it was asked with.
      const last = pages.at(-1);
      return {
        accounts,
        added: [],
        changed: [],
        removed: [],
        nextCursor: cursor ?? cursorOf(key, 0),
        historyLoaded: last?.historyLoaded ?? false,
      };
    }
    return {
      accounts,
      added: page.added ?? [],
      changed: page.changed ?? [],
      removed: (page.removed ?? []).map(({ id, reason }) => ({
        id,
        reason: reason ?? "removed by provider",
      })),
      nextCursor: cursorOf(key, index + 1),
      historyLoaded: page.historyLoaded ?? false,
    };
  }

  async startLink(): Promise<LinkSession> {
    return { linkToken: "fake-link-token" };
  }

  // Update mode, as Plaid's: the same Connection, so nothing is made.
  async startRepair(
    connection: BankConnection,
    options: { addAccounts: boolean },
  ): Promise<LinkSession> {
    this.repairs.push({ connectionId: connection.id, addAccounts: options.addAccounts });
    return { linkToken: "fake-update-link-token" };
  }

  async finishLink(_result: LinkResult): Promise<NewConnection> {
    throw new Error("The fake adapter does not link banks.");
  }

  async remove(_connection: BankConnection): Promise<void> {}
}

// Test data: an Account snapshot with every optional field empty, and the fields given.
export function fakeAccount(fields: Partial<AccountSnapshot> & { id: string }): AccountSnapshot {
  return {
    name: `Account ${fields.id}`,
    type: "depository",
    subtype: "checking",
    mask: null,
    currentBalance: null,
    availableBalance: null,
    creditLimit: null,
    card: null,
    loan: null,
    raw: { account_id: fields.id },
    ...fields,
  };
}

// Test data: a posted Transaction record with every optional field empty, and the fields given.
export function fakeTxn(
  fields: Partial<TxnRecord> & { id: string; accountId: string; amount: number },
): TxnRecord {
  return {
    postedDate: "2026-10-09",
    authorizedDate: null,
    pending: false,
    pendingTransactionId: null,
    description: `FAKE ${fields.id}`,
    merchantName: null,
    merchantId: null,
    counterparties: [],
    category: null,
    raw: { transaction_id: fields.id },
    ...fields,
  };
}
