// The job list. Sidequest imports each job class from it by class name, so every job class is
// exported here under its own name. The server build is one file, so src/server/main.ts
// re-exports this list and names the server file as the job list.
import { AiRetryJob } from "../ai/index.ts";
import { BACKUP_SCHEDULE, BackupJob } from "../backups/index.ts";
import { SyncScheduleJob } from "../bank/index.ts";
import { CpiFetchJob } from "../benchmarks/index.ts";
import { MonthStartJob } from "../budgets/index.ts";
import { ProvisionalResultsJob } from "../money-movement/index.ts";
import { MonthlyReviewDueJob, MonthlyReviewJob, ON_THE_FIRST } from "../monthly-review/index.ts";
import { AiBackJob } from "../redo/index.ts";
import { BudgetTailoringJob } from "../tailoring/index.ts";
import { UpdateCheckJob } from "../updates/index.ts";
import { daily, everyMinute } from "./schedule.ts";
import type { ScheduledTask } from "./scheduler.ts";

export { BankAddedLaterJob, FirstRunJob, SyncConnectionJob } from "../bank/index.ts";
export { FollowUpJob } from "../follow-up/index.ts";
export { DeliveryJob, MorningDeliveryJob } from "../notify/index.ts";
export { RedoNoAiWorkJob } from "../redo/index.ts";
export { TickJob } from "./sidequest.ts";
export {
  AiBackJob,
  AiRetryJob,
  BackupJob,
  BudgetTailoringJob,
  CpiFetchJob,
  MonthlyReviewDueJob,
  MonthlyReviewJob,
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
  // Runs each waiting Budget tailoring run once a day, such as one paused at the AI cost cap until
  // the 1st (spec 08, The AI cost cap). With no run waiting, its job makes no AI call and no write.
  { name: "budget tailoring", schedule: daily("00:20"), job: BudgetTailoringJob, quiet: true },
  // Brings AI back once a pause of AI has ended on its own, such as at the AI cost cap until the
  // 1st, and starts the Redo no-AI work job then (spec 08, Redo of no-AI work). A change of the AI
  // settings checks at once. With AI not away, its job makes no AI call and no write.
  { name: "ai back", schedule: daily("00:25"), job: AiBackJob, quiet: true },
  // Asks GitHub for the latest release once a day (spec 12, Updates). Off, its job makes no
  // request.
  { name: "update check", schedule: daily("05:00"), job: UpdateCheckJob },
  // Backs up app.db at 3:00 AM, Household time (spec 11, When backups run). A failed backup starts
  // its own retry an hour later. Its job finds the day's backup done when one is newer than 3:00 AM.
  { name: "backup", schedule: BACKUP_SCHEDULE, job: BackupJob },
  // The review of the month just ended comes due at midnight on the 1st, Household time (spec 08,
  // Monthly review). A 1st missed while the app was down comes due at the next start.
  { name: "monthly review", schedule: ON_THE_FIRST, job: MonthlyReviewDueJob },
  // Writes a due Monthly review once every Healthy Connection has synced on the 1st, or at noon,
  // and tries again at its retry times. Most minutes it finds nothing due. Its job logs only when
  // it does something.
  { name: "monthly review check", schedule: everyMinute, job: MonthlyReviewJob, quiet: true },
];
