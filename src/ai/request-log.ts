import {
  addAiRequestLogEntry,
  clearAiRequestLogCleanupFailures,
  countAiRequestLogCleanupFailure,
  type Database,
  deleteAiRequestLogBefore,
  listAiRequestLog,
  readAiRequestLogEntry,
  readAiRequestLogSettings,
  stopAiRequestLogCleanup,
  storeAiRequestLogSettings,
} from "../db/index.ts";
import { Job } from "../jobs/index.ts";
import { type Logger, log } from "../log.ts";
import { endCondition, type NewNotice, raiseNotice } from "../notify/index.ts";
import type { AiUse } from "./ai-view.ts";
import type { CallLog, CallOptions, ReplyPart } from "./outbound.ts";
import {
  AI_REQUEST_TEXT_LIMIT_BYTES,
  type AiRequestFailure,
  type AiRequestLogItem,
  type AiRequestLogRoutes,
  type AiRequestLogSettingsView,
} from "./request-log-view.ts";

// The AI request log (spec 08, AI request log): while a Member keeps it on, the text of each AI
// call, as the AI provider got it and as the AI answered, for the kept days. The one AI call path
// (src/ai/call.ts) hands each call to callLog through the cost middleware, after the privacy
// filter. It is a table in app.db, never a log line: no log line here holds its text.

// Daily cleanup runs that may fail in a row before the cleanup stops. The log keeps no new text
// while it is stopped.
export const AI_REQUEST_LOG_CLEANUP_CAP = 3;

// The System notice condition while the cleanup has stopped. The first run that works ends it.
export const AI_REQUEST_LOG_CLEANUP_STOPPED = "ai request log cleanup stopped";

// Kept calls deleted in each statement.
export const AI_REQUEST_LOG_CLEANUP_BATCH = 500;

// The most statements one cleanup run makes, so one run always ends: 1,000,000 kept calls.
const MAX_CLEANUP_BATCHES = 2_000;

// The most bytes of UTF-8 all kept text may hold. Past it, the oldest kept calls go first.
export const AI_REQUEST_LOG_MAX_BYTES = 100 * 1024 * 1024;

// Kept calls on each page of the log page.
export const AI_REQUEST_LOG_PAGE = 50;

const DAY_MS = 24 * 60 * 60 * 1000;

// What a failed call failed with, in the log's words, and the AI provider's HTTP status.
export type KeptFailure = { failure: AiRequestFailure; status: number | null };

// `text` cut to at most AI_REQUEST_TEXT_LIMIT_BYTES of UTF-8, at a character's edge.
export function cutText(text: string): { text: string; cut: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= AI_REQUEST_TEXT_LIMIT_BYTES) return { text, cut: false };
  let end = AI_REQUEST_TEXT_LIMIT_BYTES;
  // A byte 10xxxxxx continues a character, so the cut moves back to the character's first byte.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), cut: true };
}

// The request as the app hands it to the AI provider, after the privacy filter, written as compact
// JSON: the messages, the tools the AI may call, the tool choice, and the reply's schema. The
// provider's own request has a different layout, but the JSON writes each text with the very
// characters it sends. It leaves out the headers, which may hold a key, and the provider options,
// which the AI does not read. The call's page indents it for reading.
export function requestText(params: CallOptions): string {
  return JSON.stringify({
    prompt: params.prompt,
    tools: params.tools,
    toolChoice: params.toolChoice,
    responseFormat: params.responseFormat,
  });
}

// The reply as the AI wrote it: each text, each piece of reasoning, and each tool call, with a
// blank line between parts.
export function replyText(reply: readonly ReplyPart[]): string {
  return reply
    .map((part) => {
      if (part.type === "tool call") return `Tool call: ${part.toolName} ${part.input}`;
      return part.type === "reasoning" ? `Reasoning:\n${part.text}` : part.text;
    })
    .join("\n\n");
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

// The log's part of one model call: undefined while the log is off or its cleanup has stopped, so
// a call then builds no text. It notes how many times a Member has turned the log off, and the
// write checks all three again, so a call that ends after a Member turned the log off keeps
// nothing, even when the log is on again. A failure here is logged and never fails the call.
export function callLog(
  database: Database,
  call: { use: AiUse; model: string; chatThreadId?: string },
  failureOf: (error: unknown) => KeptFailure,
  logger: Logger = log,
): CallLog {
  return {
    async start(params) {
      let request: { text: string; cut: boolean };
      let switchOffs: number;
      try {
        const settings = await readAiRequestLogSettings(database);
        if (!settings.on || settings.cleanupFailures >= AI_REQUEST_LOG_CLEANUP_CAP)
          return undefined;
        switchOffs = settings.switchOffs;
        request = cutText(requestText(params));
      } catch (error) {
        logger.warn("The AI request log could not read a call", { error: errorName(error) });
        return undefined;
      }
      return {
        async end({ aiCallId, reply, error }) {
          try {
            const failed = error === undefined ? undefined : failureOf(error);
            const response = cutText(replyText(reply));
            await addAiRequestLogEntry(
              database,
              {
                at: new Date(),
                aiCallId: aiCallId ?? null,
                chatThreadId: call.chatThreadId ?? null,
                use: call.use,
                model: call.model,
                request: request.text,
                requestCut: request.cut,
                response: response.text,
                responseCut: response.cut,
                failure: failed?.failure ?? null,
                failureStatus: failed?.status ?? null,
              },
              {
                cleanupCap: AI_REQUEST_LOG_CLEANUP_CAP,
                switchOffs,
                maxBytes: AI_REQUEST_LOG_MAX_BYTES,
              },
            );
          } catch (failure) {
            logger.warn("The AI request log could not keep a call", { error: errorName(failure) });
          }
        },
      };
    },
  };
}

export type AiRequestLogOptions = {
  database: Database;
  now?: () => Date;
  // System notices: the notify module's, unless a test gives its own.
  notices?: {
    raise?: (notice: NewNotice) => Promise<unknown>;
    end?: (condition: string) => Promise<void>;
  };
  logger?: Logger;
};

async function raiseStopped(options: AiRequestLogOptions): Promise<void> {
  await (options.notices?.raise ?? raiseNotice)({
    kind: "condition",
    condition: AI_REQUEST_LOG_CLEANUP_STOPPED,
    text: "The app could not delete old AI request text. It keeps no new text until a Member changes the AI request log on the AI usage page.",
  });
}

// One cleanup run: deletes each kept call older than the kept days, AI_REQUEST_LOG_CLEANUP_BATCH
// at a time, one statement each. A failed run counts a try and never throws, so the daily task
// tries again the next day. The run that reaches the cap stops the cleanup and raises one System
// notice. A run that works ends it.
export async function cleanUpAiRequestLog(
  options: AiRequestLogOptions,
): Promise<"done" | "failed" | "stopped"> {
  const { database, logger = log } = options;
  const now = (options.now ?? (() => new Date()))();
  try {
    const settings = await readAiRequestLogSettings(database);
    if (settings.cleanupFailures >= AI_REQUEST_LOG_CLEANUP_CAP) return "stopped";
    const cutoff = new Date(now.getTime() - settings.keepDays * DAY_MS);
    let deleted = 0;
    for (let batch = 0; batch < MAX_CLEANUP_BATCHES; batch += 1) {
      const each = await deleteAiRequestLogBefore(database, cutoff, AI_REQUEST_LOG_CLEANUP_BATCH);
      deleted += each;
      if (each < AI_REQUEST_LOG_CLEANUP_BATCH) break;
    }
    if (settings.cleanupFailures > 0) await clearAiRequestLogCleanupFailures(database);
    if (deleted > 0) logger.info("Deleted old AI request text", { deleted });
  } catch (error) {
    let tries: number;
    try {
      tries = await countAiRequestLogCleanupFailure(database);
    } catch (counting) {
      logger.error("The AI request log cleanup could not count a failed run", {
        error: errorName(counting),
      });
      return "failed";
    }
    logger.error("The AI request log cleanup failed", { tries, error: errorName(error) });
    if (tries === AI_REQUEST_LOG_CLEANUP_CAP) {
      try {
        await raiseStopped(options);
      } catch (raising) {
        logger.warn("The AI request log's System notice could not be raised", {
          error: errorName(raising),
        });
      }
    }
    return tries >= AI_REQUEST_LOG_CLEANUP_CAP ? "stopped" : "failed";
  }
  try {
    await (options.notices?.end ?? endCondition)(AI_REQUEST_LOG_CLEANUP_STOPPED);
  } catch (error) {
    logger.warn("The AI request log's System notice could not be ended", {
      error: errorName(error),
    });
  }
  return "done";
}

const settingsView = (settings: {
  on: boolean;
  keepDays: AiRequestLogSettingsView["keepDays"];
  cleanupFailures: number;
}): AiRequestLogSettingsView => ({
  on: settings.on,
  keepDays: settings.keepDays,
  stopped: settings.cleanupFailures >= AI_REQUEST_LOG_CLEANUP_CAP,
});

// The log's routes: its pages, one kept call, and a Member's change of the switch or the kept days.
export function aiRequestLogRoutes(options: AiRequestLogOptions): AiRequestLogRoutes {
  const { database } = options;
  const item = (row: Awaited<ReturnType<typeof listAiRequestLog>>[number]): AiRequestLogItem => ({
    ...row,
    at: row.at.toISOString(),
  });
  return {
    async page({ before }) {
      const [settings, rows] = await Promise.all([
        readAiRequestLogSettings(database),
        listAiRequestLog(database, {
          ...(before === undefined ? {} : { before }),
          limit: AI_REQUEST_LOG_PAGE + 1,
        }),
      ]);
      const entries = rows.slice(0, AI_REQUEST_LOG_PAGE).map(item);
      return {
        settings: settingsView(settings),
        entries,
        older: rows.length > AI_REQUEST_LOG_PAGE ? (entries.at(-1)?.id ?? null) : null,
      };
    },

    async settings() {
      return settingsView(await readAiRequestLogSettings(database));
    },

    async entry(id) {
      const row = await readAiRequestLogEntry(database, id);
      return row === undefined ? undefined : { ...row, at: row.at.toISOString() };
    },

    // Fewer kept days, or a cleanup stopped at its cap, runs the cleanup at once. A stopped cleanup
    // that fails again stays stopped, so the log still keeps no new text.
    async set(settings) {
      const before = await storeAiRequestLogSettings(database, settings);
      const stopped = before.cleanupFailures >= AI_REQUEST_LOG_CLEANUP_CAP;
      if (settings.keepDays < before.keepDays || stopped) {
        const ran = await cleanUpAiRequestLog(options);
        if (stopped && ran !== "done") {
          await stopAiRequestLogCleanup(database, AI_REQUEST_LOG_CLEANUP_CAP);
        }
      }
      return settingsView(await readAiRequestLogSettings(database));
    },
  };
}

let running: AiRequestLogOptions | undefined;

export function startAiRequestLogCleanup(options: AiRequestLogOptions): () => void {
  if (running !== undefined) throw new Error("The AI request log cleanup is already running.");
  running = options;
  return () => {
    if (running === options) running = undefined;
  };
}

// The daily task's job. It is safe to run twice: a second run finds nothing old left. It never
// throws for a failed run, which counts toward the cap, so Sidequest makes no retry of its own.
export class AiRequestLogCleanupJob extends Job {
  override async run(): Promise<void> {
    if (running === undefined) throw new Error("The AI request log cleanup is not running.");
    await cleanUpAiRequestLog(running);
  }
}
