import { type Database, finishSync, readConnection, storeSyncPage } from "../db/index.ts";
import type { Secrets } from "../secrets/index.ts";
import type { AdapterActions, BankConnection, BankDataAdapter, Provider } from "./adapter.ts";

// Syncing one Connection (spec 02, Sync schedule and Changes to synced data). A sync asks the
// adapter for pages from the saved cursor, stores each page's records by their stable IDs, and
// saves the new cursor only after every record is stored. A sync that fails partway saves no
// cursor, so the next one starts again from the same cursor and stores no record twice.

// A sync that has not reached its last page after this many pages stops, with no cursor saved.
const MAX_PAGES = 10_000;

const NO_ACTIONS: AdapterActions = { repairInApp: false, importExisting: false, refresh: false };

type BankServices = {
  database: Database;
  secrets: Secrets;
  adapters: ReadonlyMap<Provider, BankDataAdapter>;
};

let services: BankServices | undefined;

// Gives the bank module app.db, the secrets, and the adapters. The start calls it before jobs run.
export function startBank(options: {
  database: Database;
  secrets: Secrets;
  adapters: readonly BankDataAdapter[];
}): { stop(): void } {
  if (services !== undefined) throw new Error("The bank module is already running.");
  const adapters = new Map(options.adapters.map((adapter) => [adapter.provider, adapter]));
  const started: BankServices = { ...options, adapters };
  services = started;
  return {
    stop() {
      if (services === started) services = undefined;
    },
  };
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

export function syncConnection(connectionId: string, now = () => new Date()): Promise<SyncReport> {
  const before = syncing.get(connectionId) ?? Promise.resolve();
  const run = before.catch(() => {}).then(() => syncOnce(connectionId, now));
  const settled = run.catch(() => {});
  syncing.set(connectionId, settled);
  void settled.then(() => {
    if (syncing.get(connectionId) === settled) syncing.delete(connectionId);
  });
  return run;
}

async function syncOnce(connectionId: string, now: () => Date): Promise<SyncReport> {
  if (services === undefined) throw new Error("The bank module is not running.");
  const { database, secrets, adapters } = services;
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

  const report: SyncReport = { added: 0, changed: 0, removed: 0, changedTransactions: false };
  let cursor = stored.syncCursor;
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const page = await adapter.sync(connection, cursor);
    const counts = await storeSyncPage(database, connection.id, page, now());
    report.added += counts.added;
    report.changed += counts.changed;
    report.removed += counts.removed;
    if (page.nextCursor === cursor) {
      await finishSync(database, connection.id, {
        cursor: page.nextCursor,
        historyLoaded: page.historyLoaded,
        at: now(),
      });
      report.changedTransactions = report.added + report.changed + report.removed > 0;
      return report;
    }
    cursor = page.nextCursor;
  }
  throw new Error(`The sync of Connection ${connectionId} did not end after ${MAX_PAGES} pages.`);
}
