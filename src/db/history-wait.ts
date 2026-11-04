import { and, eq, gt, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { connections, historyWait } from "./schema.ts";

// The wait for the first history load (spec 02, First history load), and the hooks for a bank
// added later (spec 02, A bank added later). The bank module decides when the wait ends; these
// functions store and read. Each claim is one conditional update, so it succeeds once.

const HISTORY_WAIT_ROW = 1;

export type HistoryWait = {
  endedAt: Date | null;
  firstRunStartedAt: Date | null;
  firstRunDoneAt: Date | null;
};

export async function readHistoryWait(database: Database): Promise<HistoryWait> {
  const [row] = await database
    .select({
      endedAt: historyWait.endedAt,
      firstRunStartedAt: historyWait.firstRunStartedAt,
      firstRunDoneAt: historyWait.firstRunDoneAt,
    })
    .from(historyWait)
    .where(eq(historyWait.id, HISTORY_WAIT_ROW));
  return row ?? { endedAt: null, firstRunStartedAt: null, firstRunDoneAt: null };
}

// Ends the wait at `at`, and records that the First run job starts then. True only for the call
// that ended it.
export async function claimHistoryWaitEnd(database: Database, at: Date): Promise<boolean> {
  await database.insert(historyWait).values({ id: HISTORY_WAIT_ROW }).onConflictDoNothing();
  const claimed = await database
    .update(historyWait)
    .set({ endedAt: at, firstRunStartedAt: at })
    .where(and(eq(historyWait.id, HISTORY_WAIT_ROW), isNull(historyWait.endedAt)))
    .returning({ id: historyWait.id });
  return claimed.length === 1;
}

// A lost history job starts again at most `cap` times (spec 08: no endless paid AI calls). The
// count then goes one past the cap, which means stopped: nothing starts it until a Member presses
// Retry.

// The First run is lost when the wait has ended, it is not done, and it last started at or before
// `before`.
function firstRunLost(before: Date) {
  return and(
    eq(historyWait.id, HISTORY_WAIT_ROW),
    isNotNull(historyWait.endedAt),
    isNull(historyWait.firstRunDoneAt),
    lte(historyWait.firstRunStartedAt, before),
  );
}

// Starts a lost First run again at `at`, while it has started again fewer than `cap` times. True
// only for the call that claimed it.
export async function claimFirstRunRestart(
  database: Database,
  at: Date,
  before: Date,
  cap: number,
): Promise<boolean> {
  const claimed = await database
    .update(historyWait)
    .set({ firstRunStartedAt: at, firstRunRestarts: sql`${historyWait.firstRunRestarts} + 1` })
    .where(and(firstRunLost(before), lt(historyWait.firstRunRestarts, cap)))
    .returning({ id: historyWait.id });
  return claimed.length === 1;
}

// Stops a lost First run that has started again `cap` times. True only for the call that stopped
// it, which then raises one System notice.
export async function claimFirstRunStop(
  database: Database,
  before: Date,
  cap: number,
): Promise<boolean> {
  const claimed = await database
    .update(historyWait)
    .set({ firstRunRestarts: cap + 1 })
    .where(and(firstRunLost(before), eq(historyWait.firstRunRestarts, cap)))
    .returning({ id: historyWait.id });
  return claimed.length === 1;
}

// A Member pressed Retry: a stopped First run starts at `at` with its count reset. True when one
// was stopped.
export async function claimFirstRunRetry(
  database: Database,
  at: Date,
  cap: number,
): Promise<boolean> {
  const claimed = await database
    .update(historyWait)
    .set({ firstRunStartedAt: at, firstRunRestarts: 0 })
    .where(
      and(
        eq(historyWait.id, HISTORY_WAIT_ROW),
        isNull(historyWait.firstRunDoneAt),
        gt(historyWait.firstRunRestarts, cap),
      ),
    )
    .returning({ id: historyWait.id });
  return claimed.length === 1;
}

// Records that the First run is done. True only for the call that recorded it, which then sends
// "Your history is ready".
export async function claimFirstRunDone(database: Database, at: Date): Promise<boolean> {
  const claimed = await database
    .update(historyWait)
    .set({ firstRunDoneAt: at })
    .where(and(eq(historyWait.id, HISTORY_WAIT_ROW), isNull(historyWait.firstRunDoneAt)))
    .returning({ id: historyWait.id });
  return claimed.length === 1;
}

// The IDs of the Connections whose bank-added-later hooks are due and not stopped.
export async function listLaterHooksDue(database: Database, cap: number): Promise<string[]> {
  const rows = await database
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        isNotNull(connections.laterHooksStartedAt),
        lte(connections.laterHooksRestarts, cap),
        isNull(connections.removedAt),
        eq(connections.syncHeld, false),
      ),
    )
    .orderBy(connections.createdAt, connections.id);
  return rows.map((row) => row.id);
}

// A Connection's hooks are lost when they are still due and last started at or before `before`.
function laterHooksLost(connectionId: string, before: Date) {
  return and(eq(connections.id, connectionId), lte(connections.laterHooksStartedAt, before));
}

// Starts a Connection's lost bank-added-later hooks again at `at`, while they have started again
// fewer than `cap` times. True only for the call that claimed it.
export async function claimLaterHooksRestart(
  database: Database,
  connectionId: string,
  at: Date,
  before: Date,
  cap: number,
): Promise<boolean> {
  const claimed = await database
    .update(connections)
    .set({
      laterHooksStartedAt: at,
      laterHooksRestarts: sql`${connections.laterHooksRestarts} + 1`,
    })
    .where(and(laterHooksLost(connectionId, before), lt(connections.laterHooksRestarts, cap)))
    .returning({ id: connections.id });
  return claimed.length === 1;
}

// Stops a Connection's lost hooks that have started again `cap` times. True only for the call that
// stopped them.
export async function claimLaterHooksStop(
  database: Database,
  connectionId: string,
  before: Date,
  cap: number,
): Promise<boolean> {
  const claimed = await database
    .update(connections)
    .set({ laterHooksRestarts: cap + 1 })
    .where(and(laterHooksLost(connectionId, before), eq(connections.laterHooksRestarts, cap)))
    .returning({ id: connections.id });
  return claimed.length === 1;
}

// A Member pressed Retry: each Connection whose hooks stopped starts again at `at` with its count
// reset. Returns how many.
export async function retryStoppedLaterHooks(
  database: Database,
  at: Date,
  cap: number,
): Promise<number> {
  const claimed = await database
    .update(connections)
    .set({ laterHooksStartedAt: at, laterHooksRestarts: 0 })
    .where(
      and(
        isNotNull(connections.laterHooksStartedAt),
        gt(connections.laterHooksRestarts, cap),
        isNull(connections.removedAt),
        eq(connections.syncHeld, false),
      ),
    )
    .returning({ id: connections.id });
  return claimed.length;
}

// Records that a Connection's bank-added-later hooks have all run.
export async function clearLaterHooks(database: Database, connectionId: string): Promise<void> {
  await database
    .update(connections)
    .set({ laterHooksStartedAt: null, laterHooksRestarts: 0 })
    .where(eq(connections.id, connectionId));
}
