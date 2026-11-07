import { desc, eq, lt, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  type AI_REQUEST_FAILURES,
  AI_REQUEST_LOG_KEEP_DAYS,
  aiCalls,
  aiRequestLog,
  aiRequestLogSettings,
} from "./schema.ts";

// The AI request log in app.db (spec 08, AI request log): its switch and kept days, and the text
// of each AI call while it is on. The ai module decides what to keep; these functions store and
// read. No function here logs the text.

export type AiRequestLogKeepDays = (typeof AI_REQUEST_LOG_KEEP_DAYS)[number];

export type AiRequestFailure = (typeof AI_REQUEST_FAILURES)[number];

export type AiRequestLogSettingsRow = {
  on: boolean;
  keepDays: AiRequestLogKeepDays;
  cleanupFailures: number;
  // Times a Member turned the log off.
  switchOffs: number;
};

// The ID of ai_request_log_settings' one row.
const SETTINGS_ROW = 1;

// Off and 30 days until a Member changes them.
export const DEFAULT_AI_REQUEST_LOG: AiRequestLogSettingsRow = {
  on: false,
  keepDays: 30,
  cleanupFailures: 0,
  switchOffs: 0,
};

const keepDaysOf = (days: number): AiRequestLogKeepDays =>
  AI_REQUEST_LOG_KEEP_DAYS.find((each) => each === days) ?? DEFAULT_AI_REQUEST_LOG.keepDays;

export async function readAiRequestLogSettings(
  database: Database,
): Promise<AiRequestLogSettingsRow> {
  const [row] = await database
    .select({
      on: aiRequestLogSettings.on,
      keepDays: aiRequestLogSettings.keepDays,
      cleanupFailures: aiRequestLogSettings.cleanupFailures,
      switchOffs: aiRequestLogSettings.switchOffs,
    })
    .from(aiRequestLogSettings)
    .where(eq(aiRequestLogSettings.id, SETTINGS_ROW));
  return row === undefined
    ? DEFAULT_AI_REQUEST_LOG
    : { ...row, keepDays: keepDaysOf(row.keepDays) };
}

// Stores a Member's switch and kept days, and starts the cleanup's count of failed runs again. Off
// deletes every kept text in the same transaction, so no entry outlives the switch, and counts a
// switch-off, so no call that started before it keeps text. Returns the settings from before the
// change.
export async function storeAiRequestLogSettings(
  database: Database,
  settings: { on: boolean; keepDays: AiRequestLogKeepDays },
): Promise<AiRequestLogSettingsRow> {
  return database.transaction(async (tx) => {
    const [before] = await tx
      .select({
        on: aiRequestLogSettings.on,
        keepDays: aiRequestLogSettings.keepDays,
        cleanupFailures: aiRequestLogSettings.cleanupFailures,
        switchOffs: aiRequestLogSettings.switchOffs,
      })
      .from(aiRequestLogSettings)
      .where(eq(aiRequestLogSettings.id, SETTINGS_ROW));
    const row = { ...settings, cleanupFailures: 0 };
    const offs = settings.on ? 0 : 1;
    await tx
      .insert(aiRequestLogSettings)
      .values({ id: SETTINGS_ROW, ...row, switchOffs: offs })
      .onConflictDoUpdate({
        target: aiRequestLogSettings.id,
        set: { ...row, switchOffs: sql`${aiRequestLogSettings.switchOffs} + ${offs}` },
      });
    if (!settings.on) await tx.delete(aiRequestLog);
    return before === undefined
      ? DEFAULT_AI_REQUEST_LOG
      : { ...before, keepDays: keepDaysOf(before.keepDays) };
  });
}

export type NewAiRequestLogEntry = {
  at: Date;
  aiCallId: number | null;
  chatThreadId: string | null;
  use: (typeof aiRequestLog.$inferInsert)["use"];
  model: string;
  request: string;
  requestCut: boolean;
  response: string;
  responseCut: boolean;
  failure: AiRequestFailure | null;
  failureStatus: number | null;
};

// What a kept call must still find as it writes: the cleanup's cap, the count of switch-offs the
// call noted when it started, and the most bytes all kept text may hold.
export type AiRequestLogKeeping = { cleanupCap: number; switchOffs: number; maxBytes: number };

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

// Keeps one call's text, in one transaction. Its insert checks, as it writes, that the log is on,
// that no Member turned it off since the call started, that its cleanup has not stopped, and that
// the call's Chat thread and AI usage row still exist. So a call that ends after a Member turned
// the log off, even when it is on again, or deleted its thread, keeps nothing. Then, when all kept
// text passes `maxBytes`, the oldest kept calls go until it fits. True when it kept the text.
export async function addAiRequestLogEntry(
  database: Database,
  entry: NewAiRequestLogEntry,
  keeping: AiRequestLogKeeping,
): Promise<boolean> {
  const bytes = utf8Bytes(entry.request) + utf8Bytes(entry.response);
  return database.transaction(async (tx) => {
    const result = await tx.run(sql`
      INSERT INTO ai_request_log (
        at, ai_call_id, chat_thread_id, use, model, bytes, request, request_cut, response,
        response_cut, failure, failure_status
      )
      SELECT
        ${entry.at.toISOString()}, ${entry.aiCallId}, ${entry.chatThreadId}, ${entry.use},
        ${entry.model}, ${bytes}, ${entry.request}, ${entry.requestCut ? 1 : 0}, ${entry.response},
        ${entry.responseCut ? 1 : 0}, ${entry.failure}, ${entry.failureStatus}
      FROM ai_request_log_settings
      WHERE id = ${SETTINGS_ROW}
        AND "on" = 1
        AND switch_offs = ${keeping.switchOffs}
        AND cleanup_failures < ${keeping.cleanupCap}
        AND (${entry.chatThreadId} IS NULL
          OR EXISTS (SELECT 1 FROM chat_threads WHERE id = ${entry.chatThreadId}))
        AND (${entry.aiCallId} IS NULL
          OR EXISTS (SELECT 1 FROM ai_calls WHERE id = ${entry.aiCallId}))
    `);
    if (result.rowsAffected !== 1) return false;
    // The sum reads only the bytes index. Past the cap, one statement deletes each kept call whose
    // bytes, added to those of every newer one, pass it: the oldest go first.
    const [total] = await tx
      .select({ bytes: sql<number | null>`sum(${aiRequestLog.bytes})` })
      .from(aiRequestLog);
    if ((total?.bytes ?? 0) > keeping.maxBytes) {
      await tx.run(sql`
        DELETE FROM ai_request_log
        WHERE id IN (
          SELECT id FROM (
            SELECT id, sum(bytes) OVER (ORDER BY id DESC) AS newer FROM ai_request_log
          )
          WHERE newer > ${keeping.maxBytes}
        )
      `);
    }
    return true;
  });
}

// One kept call as the log page lists it: its own facts, and its AI usage row's tokens and cost
// when it has one. No text.
export type AiRequestLogListed = {
  id: number;
  at: Date;
  use: NewAiRequestLogEntry["use"];
  model: string;
  failure: AiRequestFailure | null;
  failureStatus: number | null;
  usage: {
    noCacheTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    costNanos: number;
  } | null;
};

const listedColumns = {
  id: aiRequestLog.id,
  at: aiRequestLog.at,
  use: aiRequestLog.use,
  model: aiRequestLog.model,
  failure: aiRequestLog.failure,
  failureStatus: aiRequestLog.failureStatus,
  aiCallId: aiCalls.id,
  noCacheTokens: aiCalls.noCacheTokens,
  cacheReadTokens: aiCalls.cacheReadTokens,
  cacheWriteTokens: aiCalls.cacheWriteTokens,
  outputTokens: aiCalls.outputTokens,
  costNanos: aiCalls.costNanos,
};

type ListedRow = {
  id: number;
  at: Date;
  use: NewAiRequestLogEntry["use"];
  model: string;
  failure: AiRequestFailure | null;
  failureStatus: number | null;
  aiCallId: number | null;
  noCacheTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  costNanos: number | null;
};

function listed(row: ListedRow): AiRequestLogListed {
  const { aiCallId, noCacheTokens, cacheReadTokens, cacheWriteTokens, outputTokens, costNanos } =
    row;
  return {
    id: row.id,
    at: row.at,
    use: row.use,
    model: row.model,
    failure: row.failure,
    failureStatus: row.failureStatus,
    usage:
      aiCallId === null
        ? null
        : {
            noCacheTokens: noCacheTokens ?? 0,
            cacheReadTokens: cacheReadTokens ?? 0,
            cacheWriteTokens: cacheWriteTokens ?? 0,
            outputTokens: outputTokens ?? 0,
            costNanos: costNanos ?? 0,
          },
  };
}

// One page of kept calls, newest first, after the entry `before` when given: a keyset page on the
// primary key, which reads only the page's rows. IDs only grow, so newest first is highest ID
// first.
export async function listAiRequestLog(
  database: Database,
  options: { before?: number; limit: number },
): Promise<AiRequestLogListed[]> {
  const rows = await database
    .select(listedColumns)
    .from(aiRequestLog)
    .leftJoin(aiCalls, eq(aiCalls.id, aiRequestLog.aiCallId))
    .where(options.before === undefined ? undefined : lt(aiRequestLog.id, options.before))
    .orderBy(desc(aiRequestLog.id))
    .limit(options.limit);
  return rows.map(listed);
}

export type AiRequestLogEntry = AiRequestLogListed & {
  request: string;
  requestCut: boolean;
  response: string;
  responseCut: boolean;
};

// One kept call with its text, or undefined when no entry has the ID.
export async function readAiRequestLogEntry(
  database: Database,
  id: number,
): Promise<AiRequestLogEntry | undefined> {
  const [row] = await database
    .select({
      ...listedColumns,
      request: aiRequestLog.request,
      requestCut: aiRequestLog.requestCut,
      response: aiRequestLog.response,
      responseCut: aiRequestLog.responseCut,
    })
    .from(aiRequestLog)
    .leftJoin(aiCalls, eq(aiCalls.id, aiRequestLog.aiCallId))
    .where(eq(aiRequestLog.id, id));
  if (row === undefined) return undefined;
  const { request, requestCut, response, responseCut } = row;
  return { ...listed(row), request, requestCut, response, responseCut };
}

// Deletes at most `limit` kept calls from before `cutoff`, oldest first, in one statement. Returns
// how many it deleted: fewer than `limit` means none older is left.
export async function deleteAiRequestLogBefore(
  database: Database,
  cutoff: Date,
  limit: number,
): Promise<number> {
  const result = await database.run(sql`
    DELETE FROM ai_request_log
    WHERE id IN (
      SELECT id FROM ai_request_log WHERE at < ${cutoff.toISOString()} ORDER BY at, id LIMIT ${limit}
    )
  `);
  return result.rowsAffected;
}

// Counts one failed cleanup run. Returns the failed runs in a row, this one included.
export async function countAiRequestLogCleanupFailure(database: Database): Promise<number> {
  await database
    .insert(aiRequestLogSettings)
    .values({ id: SETTINGS_ROW, ...DEFAULT_AI_REQUEST_LOG })
    .onConflictDoNothing();
  const [row] = await database
    .update(aiRequestLogSettings)
    .set({ cleanupFailures: sql`${aiRequestLogSettings.cleanupFailures} + 1` })
    .where(eq(aiRequestLogSettings.id, SETTINGS_ROW))
    .returning({ cleanupFailures: aiRequestLogSettings.cleanupFailures });
  return row?.cleanupFailures ?? 1;
}

// A Member's retry of a stopped cleanup failed again: the cleanup stays stopped at `cap`, so the log
// still keeps no new text.
export async function stopAiRequestLogCleanup(database: Database, cap: number): Promise<void> {
  await database
    .update(aiRequestLogSettings)
    .set({ cleanupFailures: cap })
    .where(eq(aiRequestLogSettings.id, SETTINGS_ROW));
}

// A cleanup run worked: its count of failed runs starts again.
export async function clearAiRequestLogCleanupFailures(database: Database): Promise<void> {
  await database
    .update(aiRequestLogSettings)
    .set({ cleanupFailures: 0 })
    .where(eq(aiRequestLogSettings.id, SETTINGS_ROW));
}
