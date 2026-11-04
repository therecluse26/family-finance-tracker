import {
  listConnections,
  listDueConnections,
  type PageCounts,
  saveSyncState,
} from "../db/index.ts";
import { requestFollowUp } from "../follow-up/index.ts";
import { Job, type JobArgument, startJob } from "../jobs/index.ts";
import { log } from "../log.ts";
import { runningBank, runSyncJob } from "./sync.ts";
import { CATCH_UP_AFTER_MS, CHECK_GAP_MS, STARTED_SYNC_GAP_MS } from "./sync-times.ts";

// Each Connection syncs as its own job (spec 02, Sync schedule). Its argument is the Connection's
// ID, never its credential. A second run is safe: records are stored by their stable IDs, and the
// cursor is saved only at the end. A sync that adds, changes, or removes Transactions starts one
// follow-up job, unless one already waits (spec 02, After a sync). So does a sync that fails after
// storing a page that changed Transactions: its retry finds those records stored, and would start
// none. A sync with no changes starts nothing, so it never leads to an AI call.
export class SyncConnectionJob extends Job {
  override async run(...args: JobArgument[]): Promise<void> {
    const [connectionId] = args;
    if (typeof connectionId !== "string")
      throw new Error("SyncConnectionJob needs a Connection ID.");
    let changedTransactions = false;
    const onPageStored = (counts: PageCounts) => {
      if (counts.added + counts.changed + counts.removed > 0) changedTransactions = true;
    };
    try {
      const outcome = await runSyncJob(connectionId, undefined, { onPageStored });
      log.info("Ran a Connection's sync job", { connectionId, outcome, changedTransactions });
    } finally {
      if (changedTransactions) await requestFollowUp();
    }
  }
}

export function startSync(connectionId: string): Promise<void> {
  return startJob(SyncConnectionJob, [connectionId]);
}

// Starts the sync job of each Connection that is due, and returns their IDs. Each one's next sync
// time moves ahead first, so the next minute does not start it again; the job's outcome sets the
// real one. A Connection that needs a Member is due once a day, for its check.
export async function startDueSyncs(
  now = new Date(),
  start: (connectionId: string) => Promise<void> = startSync,
): Promise<string[]> {
  const { database } = runningBank();
  const due = await listDueConnections(database, now);
  for (const connection of due) {
    const gap = connection.health === "needs a member" ? CHECK_GAP_MS : STARTED_SYNC_GAP_MS;
    await saveSyncState(database, connection.id, { nextSyncAt: new Date(now.getTime() + gap) });
    await start(connection.id);
  }
  return due.map((connection) => connection.id);
}

// At startup, each Healthy or Retrying Connection whose last sync attempt is more than 6 hours old
// syncs at once, back-off or not (spec 02, Sync schedule). Then every due Connection starts.
export async function catchUpSyncs(
  now = new Date(),
  start: (connectionId: string) => Promise<void> = startSync,
): Promise<string[]> {
  const { database } = runningBank();
  for (const connection of await listConnections(database)) {
    if (connection.health !== "healthy" && connection.health !== "retrying") continue;
    if (connection.removedAt !== null) continue;
    const attempt = connection.lastSyncAttemptAt;
    if (attempt === null || now.getTime() - attempt.getTime() > CATCH_UP_AFTER_MS) {
      await saveSyncState(database, connection.id, { nextSyncAt: now });
    }
  }
  return startDueSyncs(now, start);
}

// The sync schedule's job. The scheduler starts it every minute, and it starts each due sync job.
export class SyncScheduleJob extends Job {
  override async run(): Promise<void> {
    const started = await startDueSyncs();
    if (started.length > 0) log.info("Started due sync jobs", { count: started.length });
  }
}
