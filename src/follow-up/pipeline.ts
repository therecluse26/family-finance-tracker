import { type Database, listUnhandledTransactions, markTransactionsHandled } from "../db/index.ts";
import { log } from "../log.ts";

// The follow-up pipeline (spec 10, The follow-up pipeline; spec 02, After a sync). A sync that
// adds, changes, or removes Transactions starts one follow-up job for the whole Household. The job
// runs the steps below in this order. Each owner ticket registers its step; a step with nothing
// registered does nothing.
export const FOLLOW_UP_STEPS = [
  "matching",
  "categorization",
  "recurring charge and anomaly checks",
  "alerts",
  "insight card check",
] as const;

export type FollowUpStepName = (typeof FOLLOW_UP_STEPS)[number];

// What a step did with the Transactions it was given.
// - Nothing (undefined): it handled every one.
// - { handled, again }: it handled only `handled`, and the job stops. A new follow-up job starts
//   at `again`, and every step handles what it has not handled yet. An AI step uses this after a
//   failed call, with the next retry time from spec 08.
export type FollowUpStepResult = undefined | { handled: readonly string[]; again: Date };

// A step gets the IDs of every Transaction it has not handled yet, hidden ones included, oldest
// first. A sync that changes or hides a Transaction makes it unhandled for every step again.
export type FollowUpStep = (unhandled: readonly string[]) => Promise<FollowUpStepResult>;

const steps = new Map<FollowUpStepName, FollowUpStep>();

// Registers the step's work. Returns a function that removes it again.
export function registerFollowUpStep(name: FollowUpStepName, step: FollowUpStep): () => void {
  if (steps.has(name)) throw new Error(`The follow-up step "${name}" is already registered.`);
  steps.set(name, step);
  return () => {
    if (steps.get(name) === step) steps.delete(name);
  };
}

let services: { database: Database } | undefined;

// Gives the follow-up pipeline app.db. The start calls it before jobs run.
export function startFollowUpPipeline(options: { database: Database }): { stop(): void } {
  if (services !== undefined) throw new Error("The follow-up pipeline is already running.");
  const started = { database: options.database };
  services = started;
  return {
    stop() {
      if (services === started) services = undefined;
    },
  };
}

// The result of one follow-up run: when the next one must start, if a step stopped the run.
export type FollowUpRun = { stoppedAt: FollowUpStepName; again: Date } | undefined;

// Runs each registered step in order, on the Transactions it has not handled yet. A step with
// nothing to handle is skipped. Safe to run twice: each step's marks say what it has handled.
export async function runFollowUp(now = () => new Date()): Promise<FollowUpRun> {
  if (services === undefined) throw new Error("The follow-up pipeline is not running.");
  const { database } = services;
  for (const name of FOLLOW_UP_STEPS) {
    const step = steps.get(name);
    if (step === undefined) continue;
    const unhandled = await listUnhandledTransactions(database, name);
    if (unhandled.length === 0) continue;
    const result = await step(unhandled);
    if (result === undefined) {
      await markTransactionsHandled(database, name, unhandled, now());
      continue;
    }
    // Only Transactions the step was given can be marked, so a step cannot mark others.
    const given = new Set(unhandled);
    const handled = result.handled.filter((id) => given.has(id));
    await markTransactionsHandled(database, name, handled, now());
    log.info("A follow-up step stopped the follow-up job", {
      step: name,
      left: unhandled.length - handled.length,
      again: result.again.toISOString(),
    });
    return { stoppedAt: name, again: result.again };
  }
  return undefined;
}
