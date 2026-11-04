import {
  clearAiRetry,
  type Database,
  listDueAiRetries,
  markAiRetryAsked,
  readAiRetry,
  storeAiFailure,
} from "../db/index.ts";
import { Job } from "../jobs/index.ts";
import { log } from "../log.ts";
import type { ModelUse } from "./ai-view.ts";

// AI retries (spec 08, Failures; spec 10, The follow-up pipeline). A background use whose call
// fails with an AI error tries again after 1, 5, and 30 minutes, then takes its no-AI path. Each
// use keeps its own retry time in app.db, and checks it before each call: until it is due, the use
// makes no call. So a follow-up job that a sync starts early never brings a retry forward, and a
// retry never holds back a sync's follow-up job.

// The wait before each retry: after the first failed call, the second, and the third.
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;

// The background uses that run in the follow-up job (spec 08, Every AI use). Their retry asks for
// a follow-up job.
export const FOLLOW_UP_AI_USES: readonly ModelUse[] = [
  "category fix",
  "merchant cleanup",
  "unclear transfer",
  "reimbursement linking",
  "alert advice",
  "insight cards",
];

export type AiRetries = {
  // The time the use's next try is due, while it is still to come. Until then the use makes no
  // call.
  waitsUntil(use: ModelUse, now: Date): Promise<Date | undefined>;
  // One more failed call. Returns when the use tries again, or undefined after the last retry,
  // when the use takes its no-AI path and waits for no retry.
  failed(use: ModelUse, now: Date): Promise<Date | undefined>;
  // The call worked, or the AI provider rejected the key: the use waits for no retry.
  ended(use: ModelUse): Promise<void>;
};

export function aiRetries(database: Database): AiRetries {
  return {
    async waitsUntil(use, now) {
      const retry = await readAiRetry(database, use);
      return retry !== undefined && retry.retryAt > now ? retry.retryAt : undefined;
    },
    async failed(use, now) {
      const failures = ((await readAiRetry(database, use))?.failures ?? 0) + 1;
      const delay = RETRY_DELAYS_MS[failures - 1];
      if (delay === undefined) {
        await clearAiRetry(database, use);
        return undefined;
      }
      const retryAt = new Date(now.getTime() + delay);
      await storeAiFailure(database, use, failures, retryAt);
      return retryAt;
    },
    ended: (use) => clearAiRetry(database, use),
  };
}

// What a use's retry starts, such as a follow-up job.
export type AiRetryRunner = () => Promise<unknown>;

let services: { database: Database; runners: Partial<Record<ModelUse, AiRetryRunner>> } | undefined;

// Gives the AI retry job app.db and what each use's retry starts. The start calls it before jobs
// run.
export function startAiRetries(options: {
  database: Database;
  runners: Partial<Record<ModelUse, AiRetryRunner>>;
}): { stop(): void } {
  if (services !== undefined) throw new Error("AI retries are already running.");
  const started = { database: options.database, runners: { ...options.runners } };
  services = started;
  return {
    stop() {
      if (services === started) services = undefined;
    },
  };
}

// Starts the work of each use whose retry is due and not yet asked for, once for each retry time,
// and returns those uses. The scheduler tick runs it every minute and once at startup, so a retry
// that came due while the app was down runs at start. It notes each retry as asked before it
// starts the work, so a failed start never repeats each minute: the use's next call, such as in
// the next sync's follow-up job, finds its retry due.
export async function runAiRetries(now = new Date()): Promise<ModelUse[]> {
  if (services === undefined) throw new Error("AI retries are not running.");
  const { database, runners } = services;
  const asked: ModelUse[] = [];
  for (const retry of await listDueAiRetries(database, now)) {
    const use = retry.use;
    if (use === "check on save") continue;
    if (!(await markAiRetryAsked(database, use, retry.retryAt, now))) continue;
    const runner = runners[use];
    if (runner === undefined) {
      log.warn("An AI retry came due for a use with nothing to start", { use });
      continue;
    }
    try {
      await runner();
      asked.push(use);
    } catch (error) {
      log.error("An AI retry could not start its work", {
        use,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  if (asked.length > 0) log.info("Started AI retries", { uses: asked });
  return asked;
}

// The AI retry job (spec 10, Job list). A scheduled task starts it every minute.
export class AiRetryJob extends Job {
  override async run(): Promise<void> {
    await runAiRetries();
  }
}
