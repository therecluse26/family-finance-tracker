import {
  claimLaterHooksRestart,
  claimLaterHooksStop,
  clearLaterHooks,
  listLaterHooksDue,
  retryStoppedLaterHooks,
} from "../db/index.ts";
import { Job, startJobUnlessWaiting } from "../jobs/index.ts";
import { log } from "../log.ts";
import { endCondition, raiseNotice } from "../notify/index.ts";
import type { LostJobOutcome } from "./first-run.ts";
import { LATER_HOOKS_STOPPED } from "./history-load.ts";
import { runningBank } from "./sync.ts";
import { HISTORY_JOB_ATTEMPTS, HISTORY_JOB_RESTARTS, LOST_HISTORY_JOB_MS } from "./sync-times.ts";

// A bank added later (spec 02, A bank added later): a Connection made after the wait for the first
// history load ended. The sync that loads its history marks its hooks due, in the same transaction
// (finishSync). The sync job then starts the bank-added-later job after the follow-up job, and jobs
// run one at a time, so the hooks see its Transactions matched and categorized. The app does not
// redraft Budgets then; a hook may propose a change.

// A hook must be safe to run twice, as every job is: a hook that throws fails the job, and every
// hook runs again.
export type BankAddedLaterHook = (connectionId: string) => Promise<void>;

const hooks = new Set<BankAddedLaterHook>();

// Registers a hook. Returns a function that removes it again.
export function registerBankAddedLaterHook(hook: BankAddedLaterHook): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

// The bank-added-later job's work: each due Connection's hooks run, then its mark is cleared. A
// Connection whose hook failed keeps its mark, and the job fails, so Sidequest runs it again. A
// Connection whose hooks stopped waits for a Member's Retry.
export async function runLaterHooks(): Promise<void> {
  const { database } = runningBank();
  let failed = 0;
  for (const connectionId of await listLaterHooksDue(database, HISTORY_JOB_RESTARTS)) {
    log.info("A bank added later loaded its history", { connectionId });
    let ok = true;
    for (const hook of hooks) {
      try {
        await hook(connectionId);
      } catch (error) {
        ok = false;
        log.error("A bank-added-later hook failed", { connectionId, error });
      }
    }
    if (ok) await clearLaterHooks(database, connectionId);
    else failed += 1;
  }
  if (failed > 0) throw new Error(`Bank-added-later hooks failed for ${failed} Connection(s).`);
}

export class BankAddedLaterJob extends Job {
  override async run(): Promise<void> {
    await runLaterHooks();
  }
}

// Starts the bank-added-later job, unless one already waits. The sync job calls it after it starts
// the follow-up job, only when that sync made a Connection's hooks due. Each start gets
// HISTORY_JOB_ATTEMPTS attempts, since a hook may call the AI.
export async function startLaterHooks(): Promise<void> {
  await startJobUnlessWaiting(BankAddedLaterJob, [], { maxAttempts: HISTORY_JOB_ATTEMPTS });
}

export const LATER_HOOKS_STOPPED_TEXT =
  "The update for a bank added later did not finish. Press Retry to try it again";

// Starts the bank-added-later job again for each Connection whose hooks are still due
// LOST_HISTORY_JOB_MS after they last started: a stop lost the job, or it used up its attempts.
// Each Connection's hooks start again at most HISTORY_JOB_RESTARTS times. The next time they are
// found lost, they stop, and every Member gets one System notice with a Retry button. The sync
// schedule's job calls this every minute.
export async function restartLostLaterHooks(
  now = new Date(),
  start: () => Promise<void> = startLaterHooks,
): Promise<LostJobOutcome> {
  const { database } = runningBank();
  const before = new Date(now.getTime() - LOST_HISTORY_JOB_MS);
  let restarted = false;
  let stopped = false;
  for (const connectionId of await listLaterHooksDue(database, HISTORY_JOB_RESTARTS)) {
    if (await claimLaterHooksRestart(database, connectionId, now, before, HISTORY_JOB_RESTARTS)) {
      restarted = true;
    } else if (await claimLaterHooksStop(database, connectionId, before, HISTORY_JOB_RESTARTS)) {
      log.error("A bank-added-later job stopped after its last restart", { connectionId });
      stopped = true;
    }
  }
  if (stopped) {
    await raiseNotice({
      kind: "condition",
      condition: LATER_HOOKS_STOPPED,
      text: LATER_HOOKS_STOPPED_TEXT,
    });
  }
  if (restarted) {
    log.warn("Started the bank-added-later job again");
    await start();
    return "started again";
  }
  return stopped ? "stopped" : "none";
}

// A Member pressed Retry on the notice: the hooks of each Connection that stopped start again,
// with their count reset. True when any had stopped.
export async function retryLaterHooks(
  now = new Date(),
  start: () => Promise<void> = startLaterHooks,
): Promise<boolean> {
  const retried = await retryStoppedLaterHooks(runningBank().database, now, HISTORY_JOB_RESTARTS);
  if (retried === 0) return false;
  log.info("A Member started the bank-added-later job again", { connections: retried });
  await endCondition(LATER_HOOKS_STOPPED);
  await start();
  return true;
}
