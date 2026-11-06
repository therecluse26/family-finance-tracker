import { claimRefresh, listConnections } from "../db/index.ts";
import { log } from "../log.ts";
import { errorKind } from "./health.ts";
import { startSync } from "./job.ts";
import { loadConnection, runningBank } from "./sync.ts";
import { REFRESH_GAP_MS, SECOND_SYNC_AFTER_MS } from "./sync-times.ts";

// Sync now (spec 02, Sync now). Any Member may press it. It syncs every Healthy or Retrying
// Connection, each as its own sync job. A removed or held Connection never syncs, so it is left
// out. Where the adapter declares Refresh, it first asks the provider for fresh data, at most once
// an hour per Connection, and then syncs at once and again 5 minutes later. A Connection synced
// less than minSyncGapHours ago is skipped. A successful sync ends any back-off, as every
// successful sync does.

const HOUR_MS = 60 * 60 * 1000;

export type SyncNowResult = {
  connectionId: string;
  bankName: string;
} & (
  | { outcome: "syncing"; refreshed: boolean }
  // When the Connection may sync again.
  | { outcome: "skipped"; canSyncAt: Date }
);

// Asks the provider to Refresh, unless a Refresh came within the hour. True when the provider took
// it. A failed Refresh is logged, and the Connection just syncs.
async function refreshOnce(connectionId: string, now: Date): Promise<boolean> {
  const { database } = runningBank();
  const loaded = await loadConnection(connectionId);
  if (loaded === undefined) return false;
  const { refresh } = loaded.adapter;
  if (!loaded.adapter.actions.refresh || refresh === undefined) return false;
  const after = new Date(now.getTime() - REFRESH_GAP_MS);
  if (!(await claimRefresh(database, connectionId, now, after))) return false;
  try {
    await refresh.call(loaded.adapter, loaded.connection);
    return true;
  } catch (error) {
    log.warn("A Connection's Refresh failed", { connectionId, kind: errorKind(error), error });
    return false;
  }
}

export async function syncNow(
  now = new Date(),
  start: (connectionId: string, at?: Date) => Promise<void> = startSync,
): Promise<SyncNowResult[]> {
  const { database, adapters } = runningBank();
  const results: SyncNowResult[] = [];
  for (const connection of await listConnections(database)) {
    if (connection.health !== "healthy" && connection.health !== "retrying") continue;
    if (connection.removedAt !== null || connection.syncHeld) continue;
    const { id: connectionId, bankName } = connection;
    const gapMs = (adapters.get(connection.provider)?.minSyncGapHours ?? 0) * HOUR_MS;
    const last = connection.lastSyncAttemptAt;
    if (last !== null && now.getTime() - last.getTime() < gapMs) {
      const canSyncAt = new Date(last.getTime() + gapMs);
      results.push({ connectionId, bankName, outcome: "skipped", canSyncAt });
      continue;
    }
    const refreshed = await refreshOnce(connectionId, now);
    await start(connectionId);
    if (refreshed) await start(connectionId, new Date(now.getTime() + SECOND_SYNC_AFTER_MS));
    results.push({ connectionId, bankName, outcome: "syncing", refreshed });
  }
  log.info("A Member pressed Sync now", {
    syncing: results.filter((result) => result.outcome === "syncing").length,
    skipped: results.filter((result) => result.outcome === "skipped").length,
  });
  return results;
}
