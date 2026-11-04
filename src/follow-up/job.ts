import { Job, startJobUnlessWaiting } from "../jobs/index.ts";
import { runFollowUp } from "./pipeline.ts";

// The follow-up job. It takes no arguments, since it covers the whole Household. A step that stops
// it is an AI step whose call failed, or whose retry is not due yet: its AI retry asks for a new
// follow-up job at the retry time (src/ai/retries.ts). This job starts none itself, so no job
// waits for the retry time, and a sync's follow-up job is never held back by one.
export class FollowUpJob extends Job {
  override async run(): Promise<void> {
    await runFollowUp();
  }
}

// Starts a follow-up job, unless one already waits: at most one waits at a time, and it handles
// everything the steps have not handled when it runs. True when it started one.
export function requestFollowUp(options: { at?: Date } = {}): Promise<boolean> {
  return startJobUnlessWaiting(FollowUpJob, [], options);
}
