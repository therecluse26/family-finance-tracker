import {
  type ArrivingTxn,
  type Database,
  type FinishedSync,
  finishSync,
  type NewAccount,
  type PageCounts,
  readConnection,
  type StoredConnection,
  storeSyncPage,
} from "../db/index.ts";
import { calendarDateIn } from "../format.ts";
import { log } from "../log.ts";
import { cleanMerchant } from "../merchants/index.ts";
import { raiseNotice } from "../notify/index.ts";
import type { Secrets } from "../secrets/index.ts";
import type {
  AdapterActions,
  BankConnection,
  BankDataAdapter,
  Provider,
  TxnRecord,
} from "./adapter.ts";
import {
  errorKind,
  recordCheckFailed,
  recordCheckPassed,
  recordSyncError,
  recordSyncSuccess,
  type SyncContext,
} from "./health.ts";

// Syncing one Connection (spec 02, Sync schedule and Changes to synced data). A sync asks the
// adapter for pages from the saved cursor, stores each page's records by their stable IDs, and
// saves the new cursor only after every record is stored. A sync that fails partway saves no
// cursor, so the next one starts again from the same cursor and stores no record twice. A sync
// that ends saves each Account's balance for the day (spec 02, Balances). Every sync sets the
// Connection's health and its next sync time (spec 02, Back-off).

// A sync that returns an Account the app has not seen tracks it at once (spec 02, New accounts at a
// bank). Every Member gets a gentler System notice that names it and points to its Exclude switch:
// an event notice, with no banner and no Repair button. A Connection's first sync brings only the
// Accounts the Member just picked, so it sends none. A notice that fails is logged, and the sync
// goes on: the Account is tracked either way.
async function tellNewAccounts(stored: StoredConnection, accounts: NewAccount[]): Promise<void> {
  if (stored.lastSyncedAt === null) return;
  for (const account of accounts) {
    const named = `${account.name}${account.mask === null ? "" : ` ··${account.mask}`}`;
    try {
      await raiseNotice({
        kind: "event",
        text: `${stored.bankName} has a new Account, ${named}. The app tracks it now. To leave it out, turn on its Exclude switch in the Account list`,
      });
    } catch (error) {
      log.error("Could not send a new Account's System notice", {
        connectionId: stored.id,
        accountId: account.id,
        error,
      });
    }
  }
}

// Each Transaction gets its Merchant as it arrives, before matching, because Refund links need the
// Merchant (spec 04, Names). A person named in a payment-app line is the Merchant with no Merchant
// ID, so the app's ID never makes two people one Merchant.
function arriving(record: TxnRecord): ArrivingTxn {
  const { merchant, needsAi } = cleanMerchant(record);
  return {
    ...record,
    merchantId: merchant === null ? record.merchantId : merchant.id,
    merchant: { cleanName: merchant?.name || null, needsAi },
  };
}

// A sync that has not reached its last page after this many pages stops, with no cursor saved.
const MAX_PAGES = 10_000;

const NO_ACTIONS: AdapterActions = { repairInApp: false, importExisting: false, refresh: false };

// Until a Household time zone is set, a sync's day is the day in UTC.
const DEFAULT_TIME_ZONE = "UTC";

type BankServices = {
  database: Database;
  secrets: Secrets;
  adapters: ReadonlyMap<Provider, BankDataAdapter>;
  timeZone: () => Promise<string | undefined>;
  // Starts a Connection's sync job. Unset in the app, which starts the job itself.
  startSync?: (connectionId: string) => Promise<void>;
};

let services: BankServices | undefined;

// Gives the bank module app.db, the secrets, and the adapters. The start calls it before jobs run.
export function startBank(options: {
  database: Database;
  secrets: Secrets;
  adapters: readonly BankDataAdapter[];
  // The Household time zone, an IANA name such as America/New_York, or undefined until one is set.
  timeZone?: () => Promise<string | undefined>;
  // Only tests give it, to see which sync jobs start without a job queue.
  startSync?: (connectionId: string) => Promise<void>;
}): { stop(): void } {
  if (services !== undefined) throw new Error("The bank module is already running.");
  const adapters = new Map(options.adapters.map((adapter) => [adapter.provider, adapter]));
  const started: BankServices = {
    ...options,
    adapters,
    timeZone: options.timeZone ?? (async () => undefined),
  };
  services = started;
  return {
    stop() {
      if (services === started) services = undefined;
    },
  };
}

// The bank module's services, for its other files.
export function runningBank(): BankServices {
  if (services === undefined) throw new Error("The bank module is not running.");
  return services;
}

// The adapter's actions, so screens hide the buttons for missing ones.
export function adapterActions(provider: Provider): AdapterActions {
  return services?.adapters.get(provider)?.actions ?? NO_ACTIONS;
}

// What one sync did to the Connection's Transactions.
export type SyncReport = {
  added: number;
  changed: number;
  removed: number;
  // True when the sync added, changed, or removed any Transaction.
  changedTransactions: boolean;
  // True when this sync loaded the history of a bank added later, so its hooks became due.
  laterHooksDue: boolean;
  // True when this sync ended the first history load of a Connection whose old Transactions still
  // had hand-made links waiting for a new copy, so the follow-up job ends them (spec 02, Link
  // carry-over).
  copiesNoLongerAwaited: boolean;
};

// The sync running for each Connection, so one Connection runs one sync at a time.
const syncing = new Map<string, Promise<unknown>>();

export type SyncOptions = {
  // Called after each page is stored, with what it did to the Transactions. A sync that fails
  // later keeps the pages it stored, so a caller can act on them, such as starting a follow-up job.
  onPageStored?: (counts: PageCounts) => void;
  // Called once the sync has stored everything, as soon as that commits, with what it stored about
  // the history load. A failure to record the sync's success comes after it.
  onFinished?: (finished: FinishedSync) => void;
  // Called once the sync has stored everything and recorded its success, with its report.
  onSynced?: (report: SyncReport) => void;
};

// Syncs one Connection, and sets its health from the outcome. A failed sync throws its error once
// the Connection's health records it.
export function syncConnection(
  connectionId: string,
  now: () => Date = () => new Date(),
  options: SyncOptions = {},
): Promise<SyncReport> {
  return oneAtATimeFor(connectionId, () => syncOnce(connectionId, now, options));
}

// Runs `work` once the Connection's running sync, or other work on it, ends. Removing a Connection
// waits this way, so no sync stores a page after it.
export function oneAtATimeFor<T>(connectionId: string, work: () => Promise<T>): Promise<T> {
  const before = syncing.get(connectionId) ?? Promise.resolve();
  const run = before.catch(() => {}).then(work);
  const settled = run.catch(() => {});
  syncing.set(connectionId, settled);
  void settled.then(() => {
    if (syncing.get(connectionId) === settled) syncing.delete(connectionId);
  });
  return run;
}

const NOTHING_SYNCED: SyncReport = {
  added: 0,
  changed: 0,
  removed: 0,
  changedTransactions: false,
  laterHooksDue: false,
  copiesNoLongerAwaited: false,
};

export type LoadedConnection = {
  stored: StoredConnection;
  adapter: BankDataAdapter;
  // The Connection as its adapter sees it, with its credential decrypted.
  connection: BankConnection;
  context: SyncContext;
};

// The stored Connection as its adapter sees it, with its credential decrypted for its row and
// column.
export function adapterConnection(stored: StoredConnection): BankConnection {
  const { secrets } = runningBank();
  return {
    id: stored.id,
    provider: stored.provider,
    bankId: stored.bankId,
    bankName: stored.bankName,
    credential:
      stored.credential === null
        ? null
        : secrets.decrypt(stored.credential, {
            rowId: stored.id,
            column: "connections.credential",
          }),
  };
}

export async function loadConnection(connectionId: string): Promise<LoadedConnection> {
  const { database, adapters, timeZone } = runningBank();
  const stored = await readConnection(database, connectionId);
  if (stored === undefined) throw new Error(`No Connection has the ID ${connectionId}.`);
  const adapter = adapters.get(stored.provider);
  if (adapter === undefined) throw new Error(`No adapter for the provider "${stored.provider}".`);
  const connection = adapterConnection(stored);
  const context: SyncContext = {
    database,
    minSyncGapHours: adapter.minSyncGapHours,
    timeZone: (await timeZone()) ?? DEFAULT_TIME_ZONE,
  };
  return { stored, adapter, connection, context };
}

async function syncOnce(
  connectionId: string,
  now: () => Date,
  options: SyncOptions,
): Promise<SyncReport> {
  const loaded = await loadConnection(connectionId);
  // A removed Connection has no credential, and never syncs; nor does a held one.
  if (loaded.stored.removedAt !== null || loaded.stored.syncHeld) return NOTHING_SYNCED;
  const startedAt = now();
  let pulled: { report: SyncReport; finished: FinishedSync };
  try {
    pulled = await pullPages(loaded, now, options);
  } catch (error) {
    try {
      await recordSyncError(loaded.context, loaded.stored, error, startedAt);
    } catch (recordError) {
      log.error("Could not record a failed sync", { connectionId, error: recordError });
    }
    throw error;
  }
  await recordSyncSuccess(loaded.context, loaded.stored, {
    startedAt,
    endedAt: now(),
    historyLoaded: pulled.finished.historyLoaded,
  });
  options.onSynced?.(pulled.report);
  return pulled.report;
}

async function pullPages(
  { stored, adapter, connection, context }: LoadedConnection,
  now: () => Date,
  options: SyncOptions,
): Promise<{ report: SyncReport; finished: FinishedSync }> {
  const { database, timeZone: zone } = context;
  const report: SyncReport = {
    added: 0,
    changed: 0,
    removed: 0,
    changedTransactions: false,
    laterHooksDue: false,
    copiesNoLongerAwaited: false,
  };
  let cursor = stored.syncCursor;
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const page = await adapter.sync(connection, cursor);
    const counts = await storeSyncPage(
      database,
      connection.id,
      { ...page, added: page.added.map(arriving), changed: page.changed.map(arriving) },
      now(),
      zone,
    );
    await tellNewAccounts(stored, counts.newAccounts);
    options.onPageStored?.(counts);
    report.added += counts.added;
    report.changed += counts.changed;
    report.removed += counts.removed;
    if (page.nextCursor === cursor) {
      const at = now();
      const finished = await finishSync(database, connection.id, {
        cursor: page.nextCursor,
        historyLoaded: page.historyLoaded,
        accounts: page.accounts,
        day: calendarDateIn(at, zone),
        at,
      });
      options.onFinished?.(finished);
      report.changedTransactions = report.added + report.changed + report.removed > 0;
      report.laterHooksDue = finished.laterHooksDue;
      report.copiesNoLongerAwaited = finished.copiesNoLongerAwaited > 0;
      return { report, finished };
    }
    cursor = page.nextCursor;
  }
  throw new Error(`The sync of Connection ${connection.id} did not end after ${MAX_PAGES} pages.`);
}

export type SyncJobOutcome = "synced" | "failed" | "still needs a member" | "not polled";

// The sync job's work (spec 02, Sync schedule and Back-off). A Broken Connection does not poll.
// One that needs a Member runs its adapter's check, and syncs once the check finds no error. The
// Connection's health records a failed sync and sets its retry, so a failure ends the job without
// an error: the back-off times the retry, not the job queue.
export async function runSyncJob(
  connectionId: string,
  now: () => Date = () => new Date(),
  options: SyncOptions = {},
): Promise<SyncJobOutcome> {
  // The check runs in the Connection's queue too, so a Remove waits for it, and a check that ends
  // after a Remove cannot bring back its notice.
  return oneAtATimeFor(connectionId, async () => {
    // A job started before the Connection was removed finds it removed, or its history deleted,
    // and does nothing.
    if ((await readConnection(runningBank().database, connectionId)) === undefined) {
      return "not polled";
    }
    const { stored, adapter, connection, context } = await loadConnection(connectionId);
    if (stored.health === "broken" || stored.removedAt !== null || stored.syncHeld) {
      return "not polled";
    }
    if (stored.health === "needs a member") {
      const at = now();
      try {
        await adapter.check(connection);
      } catch (error) {
        log.warn("A Connection's check failed", { connectionId, kind: errorKind(error), error });
        await recordCheckFailed(context, stored, error, at);
        return "still needs a member";
      }
      await recordCheckPassed(context, stored);
    }
    try {
      await syncOnce(connectionId, now, options);
      return "synced";
    } catch (error) {
      log.warn("A sync failed", { connectionId, kind: errorKind(error), error });
      return "failed";
    }
  });
}
