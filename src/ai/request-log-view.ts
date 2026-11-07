// The AI request log, as the AI usage page and the log page see it (spec 08, AI request log). The
// server and the web app both use this file, so it imports only types.
import type { AiUse } from "./ai-view.ts";

// The days a Member may keep AI request text. The default is 30.
export const AI_REQUEST_LOG_KEEP_DAYS = [7, 30, 90] as const;

export type AiRequestLogKeepDays = (typeof AI_REQUEST_LOG_KEEP_DAYS)[number];

// What went wrong with a kept call that failed. Never the error's own text.
export const AI_REQUEST_FAILURES = [
  "network",
  "timeout",
  "rate limit",
  "server error",
  "bad reply",
  "key rejected",
  "stopped",
  "app error",
] as const;

export type AiRequestFailure = (typeof AI_REQUEST_FAILURES)[number];

// What the page says when a Member's retry of a stopped cleanup failed too.
export const CLEANUP_FAILED_AGAIN = "The cleanup failed again.";

// The words the page shows for each failure.
export const AI_REQUEST_FAILURE_WORDS: Record<AiRequestFailure, string> = {
  network: "no answer from the AI provider",
  timeout: "no reply within 120 seconds",
  "rate limit": "rate limit",
  "server error": "server error",
  "bad reply": "a reply that failed its schema",
  "key rejected": "the AI provider rejected the key",
  stopped: "stopped before the reply ended",
  "app error": "failed in the app",
};

// "rate limit (HTTP 429)": a failure in words, with the AI provider's HTTP status when it gave one.
export function failureLine(failure: AiRequestFailure, status: number | null): string {
  const words = AI_REQUEST_FAILURE_WORDS[failure];
  return status === null ? words : `${words} (HTTP ${status})`;
}

// Each request and each reply is cut at this many bytes of UTF-8.
export const AI_REQUEST_TEXT_LIMIT_BYTES = 256 * 1024;

// The switch and the kept days. `stopped` is true while the daily cleanup has stopped at its cap:
// the log then keeps no new text until a Member changes a setting.
export type AiRequestLogSettingsView = {
  on: boolean;
  keepDays: AiRequestLogKeepDays;
  stopped: boolean;
};

// A kept call's AI usage row: its tokens and its cost in billionths of a dollar. Null for a failed
// call that counted nothing.
export type AiRequestUsage = {
  noCacheTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costNanos: number;
} | null;

// One kept call in the log page's list. `at` is a moment in UTC.
export type AiRequestLogItem = {
  id: number;
  at: string;
  use: AiUse;
  model: string;
  failure: AiRequestFailure | null;
  failureStatus: number | null;
  usage: AiRequestUsage;
};

// One page of the list, newest first. `older` is the cursor for the next page, or null at the end.
export type AiRequestLogPage = {
  settings: AiRequestLogSettingsView;
  entries: AiRequestLogItem[];
  older: number | null;
};

// One kept call with its text. Each `...Cut` is true when its text was cut at the limit.
export type AiRequestLogEntryView = AiRequestLogItem & {
  request: string;
  requestCut: boolean;
  response: string;
  responseCut: boolean;
};

// The log's routes (src/server/api.ts).
export type AiRequestLogRoutes = {
  page(options: { before?: number }): Promise<AiRequestLogPage>;
  // The switch and the kept days alone, for the AI usage page.
  settings(): Promise<AiRequestLogSettingsView>;
  entry(id: number): Promise<AiRequestLogEntryView | undefined>;
  // Stores the switch and the kept days. Off deletes every kept text. Fewer kept days runs the
  // cleanup at once.
  set(settings: { on: boolean; keepDays: AiRequestLogKeepDays }): Promise<AiRequestLogSettingsView>;
};
