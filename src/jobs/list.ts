// The job list. Sidequest imports each job class from it by class name, so every job class is
// exported here under its own name. The server build is one file, so src/server/main.ts
// re-exports this list and names the server file as the job list.
import { AiRetryJob } from "../ai/index.ts";
import { SyncScheduleJob } from "../bank/index.ts";
import { CpiFetchJob } from "../benchmarks/index.ts";
import { MonthStartJob } from "../budgets/index.ts";
import { ProvisionalResultsJob } from "../money-movement/index.ts";
import { UpdateCheckJob } from "../updates/index.ts";
import { daily, everyMinute } from "./schedule.ts";
import type { ScheduledTask } from "./scheduler.ts";

export { BankAddedLaterJob, FirstRunJob, SyncConnectionJob } from "../bank/index.ts";
export { FollowUpJob } from "../follow-up/index.ts";
export { TickJob } from "./sidequest.ts";
export {
  AiRetryJob,
  CpiFetchJob,
  MonthStartJob,
  ProvisionalResultsJob,
  SyncScheduleJob,
  UpdateCheckJob,
};

// Every scheduled task. Each task's job is in the list above.
export const scheduledTasks: readonly ScheduledTask[] = [
  // Starts each Connection's sync job when it is due (spec 02, Sync schedule and Back-off). Each
  // Connection keeps its own next sync time in app.db. Its job logs only when it starts a sync.
  { name: "sync schedule", schedule: everyMinute, job: SyncScheduleJob, quiet: true },
  // Starts each background AI use's work again once its retry time has passed (spec 08,
  // Failures). Each use keeps its own retry time in app.db, so a retry missed while the app was
  // down runs at start. Its job logs only when it starts a retry.
  { name: "ai retries", schedule: everyMinute, job: AiRetryJob, quiet: true },
  // Decides again each provisional one-sided result whose window has passed (spec 03, Order of
  // decisions), shortly after midnight Household time.
  { name: "provisional results", schedule: daily("00:15"), job: ProvisionalResultsJob },
  // Fetches the CPI on the 20th, Household time, and on each later day of the round until a fetch
  // succeeds or the round stops at its cap (spec 05, CPI). On other days its job makes no request.
  { name: "cpi fetch", schedule: daily("06:00"), job: CpiFetchJob },
  // Sets the month's Bills Budgets, and each qualified Category's first Budget, on the 1st,
  // Household time (spec 05, When the app drafts). A failed run tries again the next day, up to its
  // cap. On other days its job finds the month done.
  { name: "month start", schedule: daily("00:10"), job: MonthStartJob },
  // Asks GitHub for the latest release once a day (spec 12, Updates). Off, its job makes no
  // request.
  { name: "update check", schedule: daily("05:00"), job: UpdateCheckJob },
];
