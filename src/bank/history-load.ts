import {
  type Database,
  historyProgress,
  listConnections,
  readHistoryWait,
  type StoredConnection,
} from "../db/index.ts";
import { HISTORY_WAIT_RELEASE_MS } from "./sync-times.ts";

// The first history load (spec 02, First history load and A bank added later; spec 08, When AI
// does not run). Every AI use waits until every Connection's history has loaded. Non-AI work runs
// as data arrives meanwhile: a sync that changes Transactions starts the follow-up job as always,
// and only its AI steps wait at this gate. The wait ends once, and the First run job follows
// (src/bank/first-run.ts). A Connection made after that never holds back AI; its hooks run once its
// history loads (src/bank/later-hooks.ts).

// A removed Connection, or a held one, never syncs, so its history never loads. It takes no part
// in the wait, at once and without the 24 hours.
function waiting(connection: StoredConnection): boolean {
  return connection.removedAt === null && !connection.syncHeld;
}

// Whether a Connection holds back AI while the wait lasts. It stops once its history has loaded,
// once it has needed a Member or broken, or 24 hours after it was made.
function holdsBackAi(connection: StoredConnection, now: Date): boolean {
  if (!waiting(connection)) return false;
  if (connection.historyLoaded || connection.historyWaitReleasedAt !== null) return false;
  if (connection.health === "needs a member" || connection.health === "broken") return false;
  return now.getTime() - connection.createdAt.getTime() < HISTORY_WAIT_RELEASE_MS;
}

// The wait's state at `now`: ended, or still held back by some Connections.
async function waitAt(
  database: Database,
  now: Date,
): Promise<{ ended: boolean; connections: StoredConnection[]; holding: StoredConnection[] }> {
  const ended = (await readHistoryWait(database)).endedAt !== null;
  const connections = (await listConnections(database)).filter(waiting);
  const holding = ended ? [] : connections.filter((connection) => holdsBackAi(connection, now));
  return { ended, connections, holding };
}

// The gate on every AI use: false while any Connection holds back AI. Once the wait has ended it
// stays true. With no Connection yet, nothing holds AI back, but the wait does not end: it waits
// for a first Connection's history.
export async function aiMayRun(database: Database, now = new Date()): Promise<boolean> {
  return (await waitAt(database, now)).holding.length === 0;
}

// Whether the wait may end at `now`: it has not ended, a Connection that is neither removed nor
// held exists, and none holds back AI.
export async function historyWaitMayEnd(database: Database, now: Date): Promise<boolean> {
  const { ended, connections, holding } = await waitAt(database, now);
  return !ended && connections.length > 0 && holding.length === 0;
}

// One Connection whose history is still loading, for "loading history for <bank>".
export type HistoryLoading = {
  connectionId: string;
  bankName: string;
  // The Transactions it has brought in so far, and the posted date of the oldest, YYYY-MM-DD.
  transactions: number;
  oldestDate: string | null;
  // False once it has stopped holding back AI, such as 24 hours after it was made.
  holdsBackAi: boolean;
};

export type HistoryStatus = {
  // True once the wait for the first history load has ended.
  waitEnded: boolean;
  aiMayRun: boolean;
  // Each Healthy or Retrying Connection whose history has not loaded, and that is neither removed
  // nor held. One that needs a Member or is Broken shows its own banner instead.
  loading: HistoryLoading[];
};

export async function historyStatus(database: Database, now = new Date()): Promise<HistoryStatus> {
  const { ended, connections, holding } = await waitAt(database, now);
  const holdingIds = new Set(holding.map((connection) => connection.id));
  const loading = connections.filter(
    (connection) =>
      !connection.historyLoaded &&
      (connection.health === "healthy" || connection.health === "retrying"),
  );
  const progress = await historyProgress(
    database,
    loading.map((connection) => connection.id),
  );
  return {
    waitEnded: ended,
    aiMayRun: holding.length === 0,
    loading: loading.map((connection) => ({
      connectionId: connection.id,
      bankName: connection.bankName,
      transactions: progress.get(connection.id)?.transactions ?? 0,
      oldestDate: progress.get(connection.id)?.oldestDate ?? null,
      holdsBackAi: holdingIds.has(connection.id),
    })),
  };
}

// The System notice conditions of a stopped First run job and a stopped bank-added-later job. Each
// notice shows a Retry button.
export const FIRST_RUN_STOPPED = "history job stopped:first run";
export const LATER_HOOKS_STOPPED = "history job stopped:bank added later";

// Whether a System notice's condition asks a Member to retry a stopped history job.
export function historyJobToRetry(noticeCondition: string | null): boolean {
  return noticeCondition === FIRST_RUN_STOPPED || noticeCondition === LATER_HOOKS_STOPPED;
}
