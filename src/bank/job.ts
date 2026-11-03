import type { PageCounts } from "../db/index.ts";
import { requestFollowUp } from "../follow-up/index.ts";
import { Job, type JobArgument, startJob } from "../jobs/index.ts";
import { log } from "../log.ts";
import { syncConnection } from "./sync.ts";

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
      const report = await syncConnection(connectionId, undefined, { onPageStored });
      // Whether the sync added, changed, or removed Transactions.
      log.info("Synced a Connection", { connectionId, ...report });
    } finally {
      if (changedTransactions) await requestFollowUp();
    }
  }
}

export function startSync(connectionId: string): Promise<void> {
  return startJob(SyncConnectionJob, [connectionId]);
}
