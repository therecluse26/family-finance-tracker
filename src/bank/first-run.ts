import {
  claimFirstRunDone,
  claimFirstRunRestart,
  claimFirstRunRetry,
  claimFirstRunStop,
  claimHistoryWaitEnd,
  readHistoryWait,
} from "../db/index.ts";
import { Job, startJobUnlessWaiting } from "../jobs/index.ts";
import { log } from "../log.ts";
import { endCondition, raiseNotice } from "../notify/index.ts";
import { FIRST_RUN_STOPPED, historyWaitMayEnd } from "./history-load.ts";
import { runningBank } from "./sync.ts";
import { HISTORY_JOB_ATTEMPTS, HISTORY_JOB_RESTARTS, LOST_HISTORY_JOB_MS } from "./sync-times.ts";

// The end of the wait for the first history load, and the First run job (spec 02, First history
// load; spec 10, Job list). When every Connection's history has loaded, or stopped holding back AI,
// the wait ends once. The First run job then runs its registered steps once, in this order, and
// every Member gets one System notice: "Your history is ready". Each owner ticket registers its
// step; a step with nothing registered does nothing.
export const FIRST_RUN_STEPS = ["ai first run", "budget draft"] as const;

export type FirstRunStepName = (typeof FIRST_RUN_STEPS)[number];

// A step must be safe to run twice, as every job is: a stop can cut the First run job off.
export type FirstRunStep = () => Promise<void>;

const steps = new Map<FirstRunStepName, FirstRunStep>();

// Registers the step's work. Returns a function that removes it again.
export function registerFirstRunStep(name: FirstRunStepName, step: FirstRunStep): () => void {
  if (steps.has(name)) throw new Error(`The First run step "${name}" is already registered.`);
  steps.set(name, step);
  return () => {
    if (steps.get(name) === step) steps.delete(name);
  };
}

export const HISTORY_READY = "Your history is ready";

// The First run job's work. Once it has sent the System notice, it does nothing again. A step that
// throws fails the job, and Sidequest runs it again.
export async function runFirstRun(now: () => Date = () => new Date()): Promise<void> {
  const { database } = runningBank();
  const wait = await readHistoryWait(database);
  if (wait.endedAt === null || wait.firstRunDoneAt !== null) return;
  for (const name of FIRST_RUN_STEPS) {
    const step = steps.get(name);
    if (step !== undefined) await step();
  }
  if (await claimFirstRunDone(database, now())) {
    log.info("The First run job finished");
    await raiseNotice({ kind: "event", text: HISTORY_READY });
  }
}

export class FirstRunJob extends Job {
  override async run(): Promise<void> {
    await runFirstRun();
  }
}

// Each start gets HISTORY_JOB_ATTEMPTS attempts, since a step may call the AI.
export async function startFirstRun(): Promise<void> {
  await startJobUnlessWaiting(FirstRunJob, [], { maxAttempts: HISTORY_JOB_ATTEMPTS });
}

// Ends the wait, once, when it may end at `now`, and starts the First run job. True when this call
// ended it. Each sync job calls it when it ends, and so does the sync schedule's job every minute,
// for the 24-hour release.
export async function endHistoryWait(
  now = new Date(),
  start: () => Promise<void> = startFirstRun,
): Promise<boolean> {
  const { database } = runningBank();
  if (!(await historyWaitMayEnd(database, now))) return false;
  if (!(await claimHistoryWaitEnd(database, now))) return false;
  log.info("The wait for the first history load ended");
  await start();
  return true;
}

export const FIRST_RUN_STOPPED_TEXT =
  "The first run on your history did not finish. Press Retry to try it again";

// What the sync schedule's job did about a lost history job.
export type LostJobOutcome = "none" | "started again" | "stopped";

// Starts the First run job again when the wait ended but the First run has not finished
// LOST_HISTORY_JOB_MS after it last started: a stop lost the job, or it used up its attempts. It
// starts again at most HISTORY_JOB_RESTARTS times. The next time it is found lost, it stops, and
// every Member gets one System notice with a Retry button. The sync schedule's job calls this every
// minute.
export async function restartLostFirstRun(
  now = new Date(),
  start: () => Promise<void> = startFirstRun,
): Promise<LostJobOutcome> {
  const { database } = runningBank();
  const before = new Date(now.getTime() - LOST_HISTORY_JOB_MS);
  if (await claimFirstRunRestart(database, now, before, HISTORY_JOB_RESTARTS)) {
    log.warn("Started the First run job again");
    await start();
    return "started again";
  }
  if (await claimFirstRunStop(database, before, HISTORY_JOB_RESTARTS)) {
    log.error("The First run job stopped after its last restart");
    await raiseNotice({
      kind: "condition",
      condition: FIRST_RUN_STOPPED,
      text: FIRST_RUN_STOPPED_TEXT,
    });
    return "stopped";
  }
  return "none";
}

// A Member pressed Retry on the notice: a stopped First run starts again with its count reset.
// True when one was stopped.
export async function retryFirstRun(
  now = new Date(),
  start: () => Promise<void> = startFirstRun,
): Promise<boolean> {
  if (!(await claimFirstRunRetry(runningBank().database, now, HISTORY_JOB_RESTARTS))) return false;
  log.info("A Member started the First run job again");
  await endCondition(FIRST_RUN_STOPPED);
  await start();
  return true;
}
