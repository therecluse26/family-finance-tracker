import {
  type Database,
  type StoredConnection,
  type SyncState,
  saveSyncState,
} from "../db/index.ts";
import { calendarDateIn, dateLabel } from "../format.ts";
import { log } from "../log.ts";
import { endCondition, raiseNotice } from "../notify/index.ts";
import { BankDataError, type BankErrorKind } from "./adapter.ts";
import {
  CHECK_GAP_MS,
  nextHealthySync,
  nextRetry,
  RETRYING_NOTICE_AFTER_MS,
} from "./sync-times.ts";

// A Connection's health follows the errors its adapter reports (spec 02, Connections, Error kinds,
// Back-off, and Broken Connections). The core acts only on the error kind. No error deletes data:
// the Accounts and Transactions stay, and analysis keeps running on them.

export type Health = StoredConnection["health"];

// The System notice conditions about one Connection. A condition notice stays open until its
// condition ends, so each one reaches every Member once.
const condition = {
  // After 3 days in Retrying. It has no Repair button.
  notSyncing: (id: string) => `connection not syncing:${id}`,
  // Needs a Member and Broken. Each has a Repair button until the Connection is Healthy.
  needsAMember: (id: string) => `connection needs a member:${id}`,
  broken: (id: string) => `connection broken:${id}`,
};

const REPAIR_CONDITION = /^connection (?:needs a member|broken):(.+)$/;

// The Connection that a System notice's condition asks a Member to repair, or null. The notice
// shows a Repair button for it.
export function connectionToRepair(noticeCondition: string | null): string | null {
  return REPAIR_CONDITION.exec(noticeCondition ?? "")?.[1] ?? null;
}

export type SyncContext = {
  database: Database;
  minSyncGapHours: number;
  timeZone: string;
};

async function changeState(
  context: SyncContext,
  connection: StoredConnection,
  state: SyncState,
): Promise<void> {
  await saveSyncState(context.database, connection.id, state);
  if (state.health !== undefined && state.health !== connection.health) {
    log.info("A Connection's health changed", {
      connectionId: connection.id,
      from: connection.health,
      to: state.health,
    });
  }
}

// A successful sync makes the Connection Healthy, returns it to its schedule, and ends any
// back-off and every notice about it.
export async function recordSyncSuccess(
  context: SyncContext,
  connection: StoredConnection,
  sync: { startedAt: Date; endedAt: Date; historyLoaded: boolean },
): Promise<void> {
  await changeState(context, connection, {
    health: "healthy",
    lastSyncAttemptAt: sync.startedAt,
    nextSyncAt: nextHealthySync({
      ...sync,
      syncMinute: connection.syncMinute,
      minSyncGapHours: context.minSyncGapHours,
      timeZone: context.timeZone,
    }),
    retryingSince: null,
    failedSyncs: 0,
  });
  if (connection.health !== "healthy") await endConditions(connection.id);
}

// A check that finds no error makes a Connection that needed a Member Healthy. Its sync follows.
export async function recordCheckPassed(
  context: SyncContext,
  connection: StoredConnection,
): Promise<void> {
  await changeState(context, connection, {
    health: "healthy",
    retryingSince: null,
    failedSyncs: 0,
  });
  await endConditions(connection.id);
}

// Every System notice condition about the Connection.
export function connectionConditions(id: string): string[] {
  return [condition.notSyncing(id), condition.needsAMember(id), condition.broken(id)];
}

// Ends every System notice condition about the Connection.
export async function endConditions(id: string): Promise<void> {
  for (const key of connectionConditions(id)) await endCondition(key);
}

// The error kind the core acts on. An error the adapter did not sort counts as Temporary.
export function errorKind(error: unknown): BankErrorKind {
  return error instanceof BankDataError ? error.kind : "temporary";
}

// A sync that started at `startedAt` failed with this error.
export async function recordSyncError(
  context: SyncContext,
  connection: StoredConnection,
  error: unknown,
  startedAt: Date,
): Promise<void> {
  const kind = errorKind(error);
  if (kind === "temporary") {
    await recordTemporaryError(context, connection, startedAt);
  } else {
    await stopPolling(context, connection, kind, startedAt, { syncAttempt: true });
  }
}

// Temporary: the Connection becomes Retrying and backs off. A retry runs at the 3-day mark, and
// when it fails, every Member gets one System notice. Retries go on.
async function recordTemporaryError(
  context: SyncContext,
  connection: StoredConnection,
  startedAt: Date,
): Promise<void> {
  const failedSyncs = connection.failedSyncs + 1;
  const retryingSince = connection.retryingSince ?? startedAt;
  await changeState(context, connection, {
    health: "retrying",
    lastSyncAttemptAt: startedAt,
    nextSyncAt: nextRetry(startedAt, failedSyncs, context.minSyncGapHours, retryingSince),
    retryingSince,
    failedSyncs,
  });
  if (startedAt.getTime() - retryingSince.getTime() >= RETRYING_NOTICE_AFTER_MS) {
    const since = calendarDateIn(connection.lastSyncedAt ?? connection.createdAt, context.timeZone);
    const today = calendarDateIn(startedAt, context.timeZone);
    await raiseNotice({
      kind: "condition",
      condition: condition.notSyncing(connection.id),
      text: `${connection.bankName} has not synced since ${dateLabel(since, today)}`,
    });
  }
}

// Needs a Member: polling stops, and a check runs once a day. Gone: the Connection is Broken, and
// polling stops. Either way every Member gets one System notice, with a Repair button. A Connection
// whose history has not loaded stops holding back AI for good (spec 02, First history load).
async function stopPolling(
  context: SyncContext,
  connection: StoredConnection,
  kind: "needs a member" | "gone",
  at: Date,
  options: { syncAttempt: boolean },
): Promise<void> {
  const broken = kind === "gone";
  await changeState(context, connection, {
    health: broken ? "broken" : "needs a member",
    ...(options.syncAttempt ? { lastSyncAttemptAt: at } : {}),
    nextSyncAt: broken ? null : new Date(at.getTime() + CHECK_GAP_MS),
    retryingSince: null,
    failedSyncs: 0,
    ...(connection.historyLoaded || connection.historyWaitReleasedAt !== null
      ? {}
      : { historyWaitReleasedAt: at }),
  });
  // A Connection that needs a Member is not merely late, and one that is Broken needs no daily
  // check: the newer notice replaces the older one.
  await endCondition(condition.notSyncing(connection.id));
  if (broken) await endCondition(condition.needsAMember(connection.id));
  await raiseNotice(
    broken
      ? {
          kind: "condition",
          condition: condition.broken(connection.id),
          text: `${connection.bankName} has disconnected. Use Repair to link it again`,
        }
      : {
          kind: "condition",
          condition: condition.needsAMember(connection.id),
          text: `${connection.bankName} needs you to sign in again`,
        },
  );
}

// A daily check that still finds a Member is needed waits for the next day.
export async function recordCheckFailed(
  context: SyncContext,
  connection: StoredConnection,
  error: unknown,
  at: Date,
): Promise<void> {
  if (errorKind(error) === "gone") {
    await stopPolling(context, connection, "gone", at, { syncAttempt: false });
    return;
  }
  await changeState(context, connection, { nextSyncAt: new Date(at.getTime() + CHECK_GAP_MS) });
}
