import { Job as SidequestJob } from "sidequest";
import { log } from "../log.ts";

// A value Sidequest can store in jobs.db as a job's argument.
export type JobArgument =
  | string
  | number
  | boolean
  | null
  | JobArgument[]
  | { [key: string]: JobArgument };

// The job contract. Every background job:
// - extends Job, and src/jobs/list.ts exports it under its own class name. Sidequest finds each
//   job class there, so the server build needs no script file per job.
// - is safe to run twice. A stop can cut a job off, and Sidequest runs it again after the next
//   start.
// - never waits in place. A step that must wait, such as a retry, starts a new job with a start
//   time, through startJob(SomeJob, args, { at }), and the running job ends.
// - takes JobArgument values, such as IDs, never a secret: Sidequest stores them in jobs.db, and
//   startJob refuses a registered secret value.
// - may throw any error. Job logs it through the app's log, which refuses secrets, and hands
//   Sidequest only "<class> failed.". Sidequest would log the original error whole and store it in
//   jobs.db, and an HTTP client's error can hold a request's credentials.
export abstract class Job extends SidequestJob {
  abstract override run(...args: JobArgument[]): Promise<void>;

  // Sidequest calls perform, which calls run. This replaces Sidequest's own perform, which hands
  // a thrown error to Sidequest as it is.
  override async perform(...args: JobArgument[]): ReturnType<SidequestJob["perform"]> {
    const name = this.constructor.name;
    try {
      await this.run(...args);
    } catch (error) {
      log.error("A job failed", { job: name, error });
      return this.retry(new Error(`${name} failed.`));
    }
    return this.complete(undefined);
  }
}

export type JobClass<Args extends JobArgument[] = JobArgument[]> = (new () => Job) & {
  prototype: { run(...args: Args): Promise<void> };
};
