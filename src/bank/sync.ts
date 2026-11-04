import {
  type ArrivingTxn,
  type Database,
  finishSync,
  type PageCounts,
  readConnection,
  type StoredConnection,
  storeSyncPage,
} from "../db/index.ts";
import { calendarDateIn } from "../format.ts";
import { log } from "../log.ts";
import { cleanMerchant } from "../merchants/index.ts";
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

// Each Transaction gets its Merchant as it arrives, before matching, because Refund links need the
// Merchant (spec 04, Names).
function arriving(record: TxnRecord): ArrivingTxn {
  const { merchant, needsAi } = cleanMerchant(record);
  return { ...record, merchant: { cleanName: merchant?.name || null, needsAi } };
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
};

// The sync running for each Connection, so one Connection runs one sync at a time.
const syncing = new Map<string, Promise<unknown>>();

export type SyncOptions = {
  // Called after each page is stored, with what it did to the Transactions. A sync that fails
  // later keeps the pages it stored, so a caller can act on them, such as starting a follow-up job.
  onPageStored?: (counts: PageCounts) => void;
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

const NOTHING_SYNCED: SyncReport = { added: 0, changed: 0, removed: 0, changedTransactions: false };

type LoadedConnection = {
  stored: StoredConnection;
  adapter: BankDataAdapter;
  // The Connection as its adapter sees it, with its credential decrypted.
  connection: BankConnection;
  context: SyncContext;
};

async function loadConnection(connectionId: string): Promise<LoadedConnection> {
  const { database, secrets, adapters, timeZone } = runningBank();
  const stored = await readConnection(database, connectionId);
  if (stored === undefined) throw new Error(`No Connection has the ID ${connectionId}.`);
  const adapter = adapters.get(stored.provider);
  if (adapter === undefined) throw new Error(`No adapter for the provider "${stored.provider}".`);
  const connection: BankConnection = {
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
  // A removed Connection has no credential, and never syncs.
  if (loaded.stored.removedAt !== null) return NOTHING_SYNCED;
  const startedAt = now();
  let pulled: { report: SyncReport; historyLoaded: boolean };
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
    historyLoaded: pulled.historyLoaded,
  });
  return pulled.report;
}

async function pullPages(
  { stored, adapter, connection, context }: LoadedConnection,
  now: () => Date,
  options: SyncOptions,
): Promise<{ report: SyncReport; historyLoaded: boolean }> {
  const { database, timeZone: zone } = context;
  const report: SyncReport = { added: 0, changed: 0, removed: 0, changedTransactions: false };
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
    options.onPageStored?.(counts);
    report.added += counts.added;
    report.changed += counts.changed;
    report.removed += counts.removed;
    if (page.nextCursor === cursor) {
      const at = now();
      await finishSync(database, connection.id, {
        cursor: page.nextCursor,
        historyLoaded: page.historyLoaded,
        accounts: page.accounts,
        day: calendarDateIn(at, zone),
        at,
      });
      report.changedTransactions = report.added + report.changed + report.removed > 0;
      return { report, historyLoaded: page.historyLoaded };
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
  // A job started before the Connection was removed finds it removed, or its history deleted, and
  // does nothing.
  if ((await readConnection(runningBank().database, connectionId)) === undefined) {
    return "not polled";
  }
  const { stored, adapter, connection, context } = await loadConnection(connectionId);
  if (stored.health === "broken" || stored.removedAt !== null) return "not polled";
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
    await syncConnection(connectionId, now, options);
    return "synced";
  } catch (error) {
    log.warn("A sync failed", { connectionId, kind: errorKind(error), error });
    return "failed";
  }
}
