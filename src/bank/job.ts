import { Job, type JobArgument, startJob } from "../jobs/index.ts";
import { log } from "../log.ts";
import { syncConnection } from "./sync.ts";

// Each Connection syncs as its own job (spec 02, Sync schedule). Its argument is the Connection's
// ID, never its credential. A second run is safe: records are stored by their stable IDs, and the
// cursor is saved only at the end.
export class SyncConnectionJob extends Job {
  override async run(...args: JobArgument[]): Promise<void> {
    const [connectionId] = args;
    if (typeof connectionId !== "string")
      throw new Error("SyncConnectionJob needs a Connection ID.");
    const report = await syncConnection(connectionId);
    // Whether the sync added, changed, or removed Transactions.
    log.info("Synced a Connection", { connectionId, ...report });
  }
}

export function startSync(connectionId: string): Promise<void> {
  return startJob(SyncConnectionJob, [connectionId]);
}
