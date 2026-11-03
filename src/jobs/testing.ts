// A job list for tests. Tests name it as the job list in place of src/jobs/list.ts.
import { Job, type JobArgument } from "./job.ts";
import { daily } from "./schedule.ts";
import type { ScheduledTask } from "./scheduler.ts";

export { TickJob } from "./sidequest.ts";

export const TEST_JOB_LIST = import.meta.url;

// The runs of the jobs below, in order.
export const jobRuns: string[] = [];

// The sample task's job. It only records its run, so a second run does no harm, as every job
// allows. The task starts it with no label.
export class SampleJob extends Job {
  override async run(...args: JobArgument[]): Promise<void> {
    jobRuns.push(typeof args[0] === "string" ? args[0] : "SampleJob");
  }
}

// The sample task: SampleJob every day at 03:00, Household time.
export const sampleTask: ScheduledTask = {
  name: "sample",
  schedule: daily("03:00"),
  job: SampleJob,
};

let endSlowJob = () => {};

// A job that runs until finishSlowJob(), so a test can stop the app while a job runs.
export class SlowJob extends Job {
  override async run(): Promise<void> {
    jobRuns.push("SlowJob");
    await new Promise<void>((resolve) => {
      endSlowJob = resolve;
    });
  }
}

export function finishSlowJob(): void {
  endSlowJob();
}

let failure = new Error("FailingJob has no error to throw.");

// A job that throws the error given to failWith(). It ignores its arguments.
export class FailingJob extends Job {
  override async run(..._args: JobArgument[]): Promise<void> {
    throw failure;
  }
}

export function failWith(error: Error): void {
  failure = error;
}

// Sidequest polls for jobs on real timers, so tests wait for its work.
export async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Gave up waiting after ${timeoutMs} ms.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
