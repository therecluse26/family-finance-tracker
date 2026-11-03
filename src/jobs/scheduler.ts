import { type Database, scheduledTasks } from "../db/index.ts";
import { log } from "../log.ts";
import type { JobClass } from "./job.ts";
import type { Schedule } from "./schedule.ts";

export type ScheduledTask = {
  // The key of the task's schedule state in app.db. A new name starts a new schedule.
  name: string;
  schedule: Schedule;
  // The job each run starts. It takes no arguments.
  job: JobClass<[]>;
};

// Until a Household time zone is set, schedules use UTC.
const DEFAULT_TIME_ZONE = "UTC";

type SchedulerOptions = {
  database: Database;
  tasks: readonly ScheduledTask[];
  // The Household time zone, an IANA name such as America/New_York, or undefined until one is set.
  timeZone: () => Promise<string | undefined>;
  now: () => Date;
  startTask: (task: ScheduledTask) => Promise<void>;
};

type TaskState = typeof scheduledTasks.$inferSelect;

function sameState(a: TaskState, b: TaskState): boolean {
  return (
    a.lastRunAt?.getTime() === b.lastRunAt?.getTime() &&
    a.nextRunAt.getTime() === b.nextRunAt.getTime() &&
    a.timeZone === b.timeZone
  );
}

// The state a task has after a tick at `now`, and whether the tick starts it.
function tickState(
  task: ScheduledTask,
  stored: TaskState | undefined,
  now: Date,
  timeZone: string,
): { state: TaskState; due: boolean } {
  let nextRunAt: Date;
  if (stored === undefined) {
    // A new task first runs at its next scheduled time.
    nextRunAt = task.schedule.next(now, timeZone);
  } else if (stored.timeZone !== timeZone) {
    // The Household time zone changed, so the next run follows the last run in the new zone.
    nextRunAt = task.schedule.next(stored.lastRunAt ?? now, timeZone);
  } else {
    nextRunAt = stored.nextRunAt;
  }
  const lastRunAt = stored?.lastRunAt ?? null;
  if (nextRunAt > now) {
    return { state: { name: task.name, lastRunAt, nextRunAt, timeZone }, due: false };
  }
  // However many runs it missed, the task runs once, and its next run comes after now.
  const next = task.schedule.next(now, timeZone);
  return { state: { name: task.name, lastRunAt: now, nextRunAt: next, timeZone }, due: true };
}

// The scheduler tick: it starts each task whose next run time has passed. Ticks run one at a time.
export function createScheduler(options: SchedulerOptions): { tick(): Promise<string[]> } {
  let previous: Promise<unknown> = Promise.resolve();

  const tickOnce = async (): Promise<string[]> => {
    if (options.tasks.length === 0) return [];
    const now = options.now();
    const timeZone = (await options.timeZone()) ?? DEFAULT_TIME_ZONE;
    const rows = await options.database.select().from(scheduledTasks);
    const stored = new Map(rows.map((row) => [row.name, row]));
    const started: string[] = [];
    for (const task of options.tasks) {
      const before = stored.get(task.name);
      const { state, due } = tickState(task, before, now, timeZone);
      if (due) {
        // The job starts before the new state is saved. If the app stops in between, the next
        // tick starts it again, which every job allows.
        await options.startTask(task);
        log.info("Started a scheduled task", { task: task.name });
        started.push(task.name);
      }
      if (before === undefined || !sameState(before, state)) {
        await options.database
          .insert(scheduledTasks)
          .values(state)
          .onConflictDoUpdate({ target: scheduledTasks.name, set: state });
      }
    }
    return started;
  };

  return {
    tick() {
      const run = previous.then(tickOnce);
      previous = run.catch(() => {});
      return run;
    },
  };
}
