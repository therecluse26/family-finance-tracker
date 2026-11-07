import {
  type Database,
  listUnhandledTransactions,
  markTransactionsHandled,
  markTransactionsUnhandled,
  type Queries,
  readLastFollowUpChange,
} from "../db/index.ts";
import { log } from "../log.ts";

// The follow-up pipeline (spec 10, The follow-up pipeline; spec 02, After a sync). A sync that
// adds, changes, or removes Transactions starts one follow-up job for the whole Household. The job
// runs the steps below in this order. Each owner ticket registers its step; a step with nothing
// registered does nothing.
export const FOLLOW_UP_STEPS = [
  "matching",
  "categorization",
  "recurring charge checks",
  // The Anomaly checks read the Recurring charges the checks before them found (spec 06,
  // Anomalies).
  "anomaly checks",
  // This month's Bills Budgets, which follow the Recurring charges and loan payments the checks
  // found, before the Alerts read them (spec 05, Bills group).
  "Bills Budgets",
  // The Goal Done check, on the Transactions matching and categorization just decided, before any
  // step that gives the AI the active Goals (spec 05, Done).
  "Goal done check",
  // The Income redraft check, on the Steady Income the Income series just found give (spec 05,
  // Which Proposals exist).
  "redraft check",
  // Over Budget, On pace, and card interest or fees, against the Bills Budgets just set (spec 06,
  // Overspending Alerts).
  "overspending checks",
  "alerts",
  "insight card check",
] as const;

export type FollowUpStepName = (typeof FOLLOW_UP_STEPS)[number];

// What a step did with the Transactions it was given.
// - Nothing (undefined): it handled every one.
// - { handled, again }: it handled only `handled`, and the job stops. An AI step uses this after a
//   failed call, or while its retry is not due, with its retry time from spec 08 as `again`. Its
//   AI retry starts a new follow-up job at that time (src/ai/retries.ts), and every step handles
//   what it has not handled yet. The stopped job starts no job itself.
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

let services: { database: Database; startJob: () => Promise<unknown> } | undefined;

// Gives the follow-up pipeline app.db, and the way to start a follow-up job: requestFollowUp in the
// app. The start calls it before jobs run.
export function startFollowUpPipeline(options: {
  database: Database;
  startJob: () => Promise<unknown>;
}): { stop(): void } {
  if (services !== undefined) throw new Error("The follow-up pipeline is already running.");
  const started = { database: options.database, startJob: options.startJob };
  services = started;
  return {
    stop() {
      if (services === started) services = undefined;
    },
  };
}

// A Member's answer or edit changed these Transactions: every step handles them again, as after a
// sync that changes them. Writes only through `database`, so it may run inside the change's
// transaction. Call askForFollowUp after it commits.
export function followUpAgain(database: Queries, transactionIds: readonly string[]): Promise<void> {
  return markTransactionsUnhandled(database, transactionIds);
}

// Starts a follow-up job, unless one already waits. Jobs run one at a time, so the steps never run
// beside a sync or another follow-up job.
export async function askForFollowUp(): Promise<void> {
  if (services === undefined) throw new Error("The follow-up pipeline is not running.");
  await services.startJob();
}

// The result of one follow-up run: when the next one must start, if a step stopped the run.
export type FollowUpRun = { stoppedAt: FollowUpStepName; again: Date } | undefined;

// Runs each registered step in order, on the Transactions it has not handled yet. A step with
// nothing to handle is skipped. Safe to run twice: each step's marks say what it has handled. A
// Member's answer or edit during a step leaves its Transactions unhandled, so the job it starts
// handles them again.
export async function runFollowUp(now = () => new Date()): Promise<FollowUpRun> {
  if (services === undefined) throw new Error("The follow-up pipeline is not running.");
  const { database } = services;
  for (const name of FOLLOW_UP_STEPS) {
    const step = steps.get(name);
    if (step === undefined) continue;
    const began = await readLastFollowUpChange(database);
    const unhandled = await listUnhandledTransactions(database, name);
    if (unhandled.length === 0) continue;
    const result = await step(unhandled);
    if (result === undefined) {
      await markTransactionsHandled(database, name, unhandled, now(), began);
      continue;
    }
    // Only Transactions the step was given can be marked, so a step cannot mark others.
    const given = new Set(unhandled);
    const handled = result.handled.filter((id) => given.has(id));
    await markTransactionsHandled(database, name, handled, now(), began);
    log.info("A follow-up step stopped the follow-up job", {
      step: name,
      left: unhandled.length - handled.length,
      again: result.again.toISOString(),
    });
    return { stoppedAt: name, again: result.again };
  }
  return undefined;
}
