import { Sidequest } from "sidequest";
import type { Database } from "../db/index.ts";
import { holdsSecretValue, log } from "../log.ts";
import { Job, type JobArgument, type JobClass } from "./job.ts";
import { createScheduler, type ScheduledTask } from "./scheduler.ts";

// Sidequest's own file, in the same data volume as app.db. It holds waiting and finished jobs only.
export const JOBS_DB_FILE = "/data/jobs.db";

// Sidequest keeps this schedule in memory. The tick job keeps every other schedule in app.db.
const EVERY_MINUTE = "* * * * *";

export type JobsOptions = {
  // The SQLite file Sidequest keeps its jobs in.
  jobsDb: string;
  // The URL of the job list, which exports every job class under its class name. Sidequest
  // imports each job class from it. The server build names the server file, which re-exports
  // src/jobs/list.ts.
  jobList: string;
  tasks: readonly ScheduledTask[];
  database: Database;
  // The Household time zone, an IANA name, or undefined until one is set.
  timeZone?: () => Promise<string | undefined>;
  now?: () => Date;
};

export type RunningJobs = {
  // Runs the scheduler tick now, and returns the names of the tasks it started.
  tick(): Promise<string[]>;
  // Stops the tick job and stops starting jobs, then waits for the running job to end.
  stop(): Promise<void>;
};

let running: { jobs: ReadonlySet<JobClass>; tick: () => Promise<string[]> } | undefined;

// The tick job. Sidequest starts it every minute, and it runs the scheduler tick.
export class TickJob extends Job {
  override async run(): Promise<void> {
    if (running === undefined) throw new Error("The jobs module is not running.");
    await running.tick();
  }
}

function isJobClass(value: unknown): value is JobClass {
  return typeof value === "function" && value.prototype instanceof Job;
}

async function readJobList(url: string): Promise<Set<JobClass>> {
  const list: Record<string, unknown> = await import(/* @vite-ignore */ url);
  const jobs = new Set<JobClass>();
  for (const [name, value] of Object.entries(list)) {
    if (!isJobClass(value)) continue;
    if (value.name !== name) {
      throw new Error(
        `The job list exports ${value.name} as "${name}". Sidequest finds a job class by its ` +
          "class name, so export it under that name.",
      );
    }
    jobs.add(value);
  }
  // The same class, not a copy, so Sidequest's import of the list reaches this running module.
  if (list.TickJob !== TickJob) {
    throw new Error(
      `The job list ${url} does not export this app's TickJob. In the server build, ` +
        "src/server/main.ts must re-export src/jobs/list.ts.",
    );
  }
  return jobs;
}

function checkTasks(tasks: readonly ScheduledTask[], jobs: ReadonlySet<JobClass>): void {
  const names = new Set<string>();
  for (const task of tasks) {
    if (names.has(task.name)) throw new Error(`Two scheduled tasks are named "${task.name}".`);
    names.add(task.name);
    if (!jobs.has(task.job)) {
      throw new Error(
        `The scheduled task "${task.name}" starts ${task.job.name}, which is not in the job list.`,
      );
    }
  }
}

// Starts Sidequest and the tick job. Run the first tick before the app listens.
export async function startJobs(options: JobsOptions): Promise<RunningJobs> {
  if (running !== undefined) throw new Error("The jobs module is already running.");
  const jobs = await readJobList(options.jobList);
  checkTasks(options.tasks, jobs);
  await Sidequest.start({
    backend: { driver: "@sidequest/sqlite-backend", config: options.jobsDb },
    // Jobs run inside the app process, one at a time, as Sidequest's docs advise for SQLite.
    fork: false,
    runner: "inline",
    maxConcurrentJobs: 1,
    // The app's own SIGTERM handler stops Sidequest, and waits at most 10 seconds.
    gracefulShutdown: false,
    // Sidequest's manual mode for bundled builds: it imports each job class from the job list.
    manualJobResolution: true,
    jobsFilePath: options.jobList,
    // Below warn, Sidequest logs each job's arguments.
    logger: { level: "warn", json: true },
    // The dashboard would serve job data on its own port, outside the app's login.
    dashboard: { enabled: false },
  });
  const scheduler = createScheduler({
    database: options.database,
    tasks: options.tasks,
    timeZone: options.timeZone ?? (async () => undefined),
    now: options.now ?? (() => new Date()),
    startTask: (task) => startJob(task.job, []),
  });
  running = { jobs, tick: scheduler.tick };
  try {
    await Sidequest.build(TickJob).schedule(EVERY_MINUTE);
  } catch (error) {
    running = undefined;
    await Sidequest.stop();
    throw error;
  }
  log.info("Started background jobs", { jobsDb: options.jobsDb });
  return {
    tick: scheduler.tick,
    stop: async () => {
      await Sidequest.stop();
      running = undefined;
      log.info("Stopped background jobs");
    },
  };
}

// Whether an argument holds a registered secret value, in any text or name inside it.
function holdsSecret(argument: JobArgument): boolean {
  if (argument === null || typeof argument === "boolean") return false;
  if (typeof argument === "string" || typeof argument === "number") {
    return holdsSecretValue(String(argument));
  }
  if (Array.isArray(argument)) return argument.some(holdsSecret);
  return Object.entries(argument).some(
    ([name, value]) => holdsSecretValue(name) || holdsSecret(value),
  );
}

// Starts a job. Sidequest runs it when no other job runs, and not before `at` when given.
// It refuses an argument that holds a registered secret value, since jobs.db stores arguments as
// plain text.
export async function startJob<Args extends JobArgument[]>(
  job: JobClass<Args>,
  args: Args,
  options: { at?: Date } = {},
): Promise<void> {
  if (running === undefined) throw new Error("The jobs module is not running.");
  if (!running.jobs.has(job)) {
    throw new Error(`${job.name} is not in the job list. Export it from src/jobs/list.ts.`);
  }
  if (args.some(holdsSecret)) {
    throw new Error(`An argument to ${job.name} holds a secret. Pass an ID that names it instead.`);
  }
  const builder = Sidequest.build(job);
  if (options.at !== undefined) builder.availableAt(options.at);
  await builder.enqueue(...args);
}
