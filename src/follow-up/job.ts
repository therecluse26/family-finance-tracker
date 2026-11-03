import { Job, startJobUnlessWaiting } from "../jobs/index.ts";
import { runFollowUp } from "./pipeline.ts";

// The follow-up job. It takes no arguments, since it covers the whole Household. A step that stops
// it asks for a new follow-up job at a given time.
export class FollowUpJob extends Job {
  override async run(): Promise<void> {
    const stopped = await runFollowUp();
    if (stopped !== undefined) await requestFollowUp({ at: stopped.again });
  }
}

// Starts a follow-up job, unless one already waits: at most one waits at a time, and it handles
// everything the steps have not handled when it runs. True when it started one.
export function requestFollowUp(options: { at?: Date } = {}): Promise<boolean> {
  return startJobUnlessWaiting(FollowUpJob, [], options);
}
