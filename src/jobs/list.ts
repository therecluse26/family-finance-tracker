// The job list. Sidequest imports each job class from it by class name, so every job class is
// exported here under its own name. The server build is one file, so src/server/main.ts
// re-exports this list and names the server file as the job list.
import { SyncScheduleJob } from "../bank/index.ts";
import { ProvisionalResultsJob } from "../money-movement/index.ts";
import { daily, everyMinute } from "./schedule.ts";
import type { ScheduledTask } from "./scheduler.ts";

export { SyncConnectionJob } from "../bank/index.ts";
export { FollowUpJob } from "../follow-up/index.ts";
export { TickJob } from "./sidequest.ts";
export { ProvisionalResultsJob, SyncScheduleJob };

// Every scheduled task. Each task's job is in the list above.
export const scheduledTasks: readonly ScheduledTask[] = [
  // Starts each Connection's sync job when it is due (spec 02, Sync schedule and Back-off). Each
  // Connection keeps its own next sync time in app.db. Its job logs only when it starts a sync.
  { name: "sync schedule", schedule: everyMinute, job: SyncScheduleJob, quiet: true },
  // Decides again each provisional one-sided result whose window has passed (spec 03, Order of
  // decisions), shortly after midnight Household time.
  { name: "provisional results", schedule: daily("00:15"), job: ProvisionalResultsJob },
];
