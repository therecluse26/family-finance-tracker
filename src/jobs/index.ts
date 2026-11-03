// The jobs module's interface. Other modules import from here, never from Sidequest.
// It does not export the job list, src/jobs/list.ts, which imports the job classes of other modules.
export { Job, type JobArgument, type JobClass } from "./job.ts";
export { daily, type Schedule } from "./schedule.ts";
export type { ScheduledTask } from "./scheduler.ts";
export {
  countWaitingJobs,
  JOBS_DB_FILE,
  type JobsOptions,
  type RunningJobs,
  startJob,
  startJobs,
  startJobUnlessWaiting,
} from "./sidequest.ts";
