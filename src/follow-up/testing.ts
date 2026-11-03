// A job list for the follow-up tests: the sync and follow-up jobs, and a job that marks a point in
// the job order. Jobs run one at a time, oldest first, so when MarkJob runs, every job started
// before it has ended.
import { countWaitingJobs, Job } from "../jobs/index.ts";
import { FollowUpJob } from "./job.ts";

export { SyncConnectionJob } from "../bank/job.ts";
export { TickJob } from "../jobs/sidequest.ts";
export { FollowUpJob };

export const TEST_FOLLOW_UP_JOB_LIST = import.meta.url;

// The waiting follow-up jobs each MarkJob run found, in order.
export const waitingAtMarks: number[] = [];

export class MarkJob extends Job {
  override async run(): Promise<void> {
    waitingAtMarks.push(await countWaitingJobs(FollowUpJob));
  }
}
