// The job list. Sidequest imports each job class from it by class name, so every job class is
// exported here under its own name. The server build is one file, so src/server/main.ts
// re-exports this list and names the server file as the job list.
import type { ScheduledTask } from "./scheduler.ts";

export { SyncConnectionJob } from "../bank/index.ts";
export { FollowUpJob } from "../follow-up/index.ts";
export { TickJob } from "./sidequest.ts";

// Every scheduled task. Each task's job is in the list above.
export const scheduledTasks: readonly ScheduledTask[] = [];
