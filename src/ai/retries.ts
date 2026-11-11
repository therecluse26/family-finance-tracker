import {
  clearAiRetry,
  type Database,
  isNoticeConditionOpen,
  listDueAiRetries,
  listOpenNotices,
  markAiRetryAsked,
  readAiRetry,
  storeAiFailure,
} from "../db/index.ts";
import { Job } from "../jobs/index.ts";
import { type Logger, log } from "../log.ts";
import type { ModelUse } from "./ai-view.ts";
import type { AiNotices } from "./settings.ts";

// AI retries (spec 08, Failures; spec 10, The follow-up pipeline). A background use whose call
// fails with an AI error tries again after 1, 5, and 30 minutes, then takes its no-AI path. Each
// use keeps its own retry time in app.db, and checks it before each call: until it is due, the use
// makes no call. So a follow-up job that a sync starts early never brings a retry forward, and a
// retry never holds back a sync's follow-up job.

// The wait before each retry: after the first failed call, the second, and the third.
export const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;

// The Monthly review never takes its no-AI path after the third retry: it tries again every 6
// hours until the review is written (spec 08, Failures). The monthly-review module ends its run
// at its cap, and ends the retry with it.
export const MONTHLY_REVIEW_RETRY_MS = 6 * 60 * 60_000;

// The background uses that run in the follow-up job (spec 08, Every AI use). Their retry asks for
// a follow-up job.
export const FOLLOW_UP_AI_USES: readonly ModelUse[] = [
  "category fix",
  "line item category",
  "merchant cleanup",
  "merchant lookup",
  "unclear transfer",
  "reimbursement linking",
  "alert advice",
  "insight cards",
];

// The background uses with a last retry. The Monthly review has none: its own module raises its
// notice when its run ends.
type LastRetryUse = Exclude<ModelUse, "chat" | "reading a goal" | "monthly review">;

// What the System notice says for each use with a last retry: the work it helps with, and when
// that work next calls the AI. The follow-up job runs after each sync, and so do the Insight
// cards a run left due (spec 08, Failures). A Budget tailoring run that fails takes its no-AI path
// and ends, so AI comes back with the next run.
const USE_WORDS: Record<LastRetryUse, { work: string; again: string }> = {
  "category fix": { work: "Categories", again: "at the next sync" },
  "line item category": { work: "Amazon item Categories", again: "at the next sync" },
  "merchant cleanup": { work: "Merchant names", again: "at the next sync" },
  "merchant lookup": { work: "Merchant web lookups", again: "at the next sync" },
  "product match": { work: "Product matches", again: "at the next plan run" },
  "unclear transfer": { work: "unclear Transfers", again: "at the next sync" },
  "reimbursement linking": { work: "Reimbursements", again: "at the next sync" },
  "alert advice": { work: "Alert advice", again: "at the next sync" },
  "budget tailoring": { work: "Budget tailoring", again: "at the next Budget tailoring run" },
  "insight cards": { work: "Insight cards", again: "at the next sync" },
};

const hasLastRetry = (use: ModelUse): use is LastRetryUse => Object.hasOwn(USE_WORDS, use);

// The condition of the System notice a use raises when it runs out of retries. It ends when the
// use's call works again, or when a Member removes the AI provider.
export const retriesRanOutCondition = (use: ModelUse) => `ai retries ran out:${use}`;

// The notice's text for a use with a last retry.
export function retriesRanOutText(use: LastRetryUse): string {
  const { work, again } = USE_WORDS[use];
  return `AI could not help with ${work} after ${RETRY_DELAYS_MS.length} retries, so the app went on without it. It tries AI again ${again}.`;
}

// A failed notice never fails the use or the change that led to it. Only the error's name goes to
// the log.
async function safely(logger: Logger, failed: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    logger.warn(failed, { error: error instanceof Error ? error.name : "unknown" });
  }
}

// Ends each use's notice that is open. Remove AI provider runs it: every use then takes its no-AI
// path and never calls the AI, so no call that works would end it. One read of the open notices.
export async function endRetriesRanOut(
  database: Database,
  notices: AiNotices,
  logger: Logger = log,
): Promise<void> {
  await safely(
    logger,
    "The System notices for AI retries that ran out could not be ended",
    async () => {
      const open = new Set((await listOpenNotices(database)).map((notice) => notice.condition));
      for (const use of Object.keys(USE_WORDS) as LastRetryUse[]) {
        const condition = retriesRanOutCondition(use);
        if (open.has(condition)) await notices.end(condition);
      }
    },
  );
}

export type AiRetries = {
  // The time the use's next try is due, while it is still to come. Until then the use makes no
  // call.
  waitsUntil(use: ModelUse, now: Date): Promise<Date | undefined>;
  // One more failed call. Returns when the use tries again, or undefined after the last retry,
  // when the use takes its no-AI path and waits for no retry, with one System notice for the run
  // of failures (known finding K4). The Monthly review has no last retry.
  failed(use: ModelUse, now: Date): Promise<Date | undefined>;
  // The call worked: the use waits for no retry, and its System notice ends.
  worked(use: ModelUse): Promise<void>;
  // The AI provider rejected the key: the use waits for no retry. The rejected key's own notice
  // takes over.
  ended(use: ModelUse): Promise<void>;
};

export function aiRetries(database: Database, notices: AiNotices, logger: Logger = log): AiRetries {
  return {
    async waitsUntil(use, now) {
      const retry = await readAiRetry(database, use);
      return retry !== undefined && retry.retryAt > now ? retry.retryAt : undefined;
    },
    async failed(use, now) {
      const failures = ((await readAiRetry(database, use))?.failures ?? 0) + 1;
      const delay =
        RETRY_DELAYS_MS[failures - 1] ??
        (use === "monthly review" ? MONTHLY_REVIEW_RETRY_MS : undefined);
      if (delay === undefined) {
        await clearAiRetry(database, use);
        // A condition notice: a later run of failures while it is open keeps the one notice.
        if (hasLastRetry(use)) {
          await safely(
            logger,
            "The System notice for AI retries that ran out could not be raised",
            () =>
              notices.raise({
                kind: "condition",
                condition: retriesRanOutCondition(use),
                text: retriesRanOutText(use),
              }),
          );
        }
        return undefined;
      }
      const retryAt = new Date(now.getTime() + delay);
      await storeAiFailure(database, use, failures, retryAt);
      return retryAt;
    },
    async worked(use) {
      await clearAiRetry(database, use);
      const condition = retriesRanOutCondition(use);
      // Read first, so a call that works with no notice open writes nothing more. A failed read
      // never makes the call that worked throw.
      await safely(
        logger,
        "The System notice for AI retries that ran out could not be ended",
        async () => {
          if (await isNoticeConditionOpen(database, condition)) await notices.end(condition);
        },
      );
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
    if (use === "check on save" || use === "key test") continue;
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
