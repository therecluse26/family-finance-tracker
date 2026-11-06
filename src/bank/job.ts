import {
  type FinishedSync,
  listConnections,
  listDueConnections,
  type PageCounts,
  saveSyncState,
} from "../db/index.ts";
import { requestFollowUp } from "../follow-up/index.ts";
import { Job, type JobArgument, startJob } from "../jobs/index.ts";
import { log } from "../log.ts";
import { endLongCopyWaits } from "./copies-wait.ts";
import { endHistoryWait, restartLostFirstRun } from "./first-run.ts";
import { restartLostLaterHooks, startLaterHooks } from "./later-hooks.ts";
import { runningBank, runSyncJob, type SyncReport } from "./sync.ts";
import { CATCH_UP_AFTER_MS, CHECK_GAP_MS, STARTED_SYNC_GAP_MS } from "./sync-times.ts";

// Each Connection syncs as its own job (spec 02, Sync schedule). Its argument is the Connection's
// ID, never its credential. A second run is safe: records are stored by their stable IDs, and the
// cursor is saved only at the end. A sync that adds, changes, or removes Transactions starts one
// follow-up job, unless one already waits (spec 02, After a sync). So does a sync that fails after
// storing a page that changed Transactions: its retry finds those records stored, and would start
// none. So does a sync that ends a first history load while hand-made links wait for new copies.
// A sync with no other changes starts nothing, so it never leads to an AI call. A sync that loaded
// the history of a bank added later then starts the bank-added-later job. Then, when every
// Connection's history has loaded, the wait for the first history load ends, and the First run job
// starts. Both start after the follow-up job, and jobs run one at a time, so they see the new
// Transactions handled.
export class SyncConnectionJob extends Job {
  override async run(...args: JobArgument[]): Promise<void> {
    const [connectionId] = args;
    if (typeof connectionId !== "string")
      throw new Error("SyncConnectionJob needs a Connection ID.");
    let changedTransactions = false;
    const onPageStored = (counts: PageCounts) => {
      if (counts.added + counts.changed + counts.removed > 0) changedTransactions = true;
    };
    // Only the sync that made the hooks due starts their job. Any later start goes through the
    // capped restart or a Member's Retry.
    let laterHooksDue = false;
    const onSynced = (report: SyncReport) => {
      laterHooksDue = report.laterHooksDue;
    };
    // Hand-made links that no longer wait for a new copy end in the follow-up job. This is known as
    // soon as the sync's last write commits, so a failure after it still starts the job.
    const onFinished = (finished: FinishedSync) => {
      if (finished.copiesNoLongerAwaited > 0) changedTransactions = true;
    };
    try {
      const outcome = await runSyncJob(connectionId, undefined, {
        onPageStored,
        onFinished,
        onSynced,
      });
      log.info("Ran a Connection's sync job", { connectionId, outcome, changedTransactions });
    } finally {
      if (changedTransactions) await requestFollowUp();
    }
    if (laterHooksDue) await startLaterHooks();
    await endHistoryWait();
  }
}

// Starts a Connection's sync job, at once or not before `at`.
export function startSync(connectionId: string, at?: Date): Promise<void> {
  return startJob(SyncConnectionJob, [connectionId], at === undefined ? {} : { at });
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
// syncs at once, back-off or not (spec 02, Sync schedule). A held one never does. Then every due
// Connection starts.
export async function catchUpSyncs(
  now = new Date(),
  start: (connectionId: string) => Promise<void> = startSync,
): Promise<string[]> {
  const { database } = runningBank();
  for (const connection of await listConnections(database)) {
    if (connection.health !== "healthy" && connection.health !== "retrying") continue;
    if (connection.removedAt !== null || connection.syncHeld) continue;
    const attempt = connection.lastSyncAttemptAt;
    if (attempt === null || now.getTime() - attempt.getTime() > CATCH_UP_AFTER_MS) {
      await saveSyncState(database, connection.id, { nextSyncAt: now });
    }
  }
  return startDueSyncs(now, start);
}

// The sync schedule's job. The scheduler starts it every minute, and it starts each due sync job.
// It also ends the wait for the first history load once the last Connection holding it back has
// been made 24 hours ago, starts again a First run job or a bank-added-later job that was lost, and
// ends each wait of hand-made links for new copies that passed its cap.
export class SyncScheduleJob extends Job {
  override async run(): Promise<void> {
    const started = await startDueSyncs();
    if (started.length > 0) log.info("Started due sync jobs", { count: started.length });
    await endHistoryWait();
    await restartLostFirstRun();
    await restartLostLaterHooks();
    await endLongCopyWaits();
  }
}
