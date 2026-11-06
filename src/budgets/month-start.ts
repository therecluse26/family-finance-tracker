import { CATEGORIES, categoryGroupOf } from "../categories/index.ts";
import {
  countMonthStartFailure,
  type Database,
  type MonthBudget,
  markMonthStartDone,
  readBudgetInputs,
  readMonthStart,
  storeMonthBudgets,
} from "../db/index.ts";
import { Job } from "../jobs/index.ts";
import { log } from "../log.ts";
import { endCondition, raiseNotice } from "../notify/index.ts";
import { householdDay } from "./first-draft.ts";
import { draftBudgets, shareOfT, sharesTWith } from "./formulas.ts";
import { readDraftTerms } from "./terms.ts";

// The month's Bills Budgets (spec 05, When the app drafts; Bills group; Stored Budgets).
// - The Month start job, on the 1st, Household time, computes and stores each Bills Budget for the
//   month, and gives each Category with no Budget its first one, by formula, once it qualifies.
// - The Bills Budgets step, in the follow-up job after the Recurring charge checks, sets this
//   month's Bills Budgets again as Transactions post. K is fixed on the 1st, so only an early
//   Recurring charge or loan payment, which moves its known amount into this month, and a loan
//   payment's actual interest, which replaces its expected interest, change them.
// Neither touches a pinned Bills Budget, a Bills Budget a Member set by hand this month, a flexible
// Budget that exists, or any month but the current one. The one exception is Groceries and
// Superstores, which share one figure, T: when the Month start gives one of them its first Budget
// while the formula set the other's, it sets the other's to its share too, so their total stays T.
// It does so only when the formula gives the other a Budget this month and its share is above $0.

// A month's Month start runs at most this many times before it stops until the next month.
export const MONTH_START_CAP = 3;

// The System notice condition while this month's Month start has stopped at the cap. The next
// month's success ends it.
export const MONTH_START_STOPPED = "month start stopped";

// Sets the current month's Bills Budgets from the formula, and with `firstBudgets`, the first
// Budget of each Category that has none. Nothing before the first draft. Returns how many Budgets
// it wrote.
async function setMonthBudgets(
  database: Database,
  now: Date,
  firstBudgets: boolean,
): Promise<number> {
  const inputs = await readBudgetInputs(database);
  if (inputs === undefined) return 0;
  const today = await householdDay(database, now);
  const month = today.slice(0, 7);
  if (month < inputs.firstDraftMonth) return 0;
  // The first draft's month keeps the Recurring charge amounts of the day the draft ran.
  const pricedOn =
    month === inputs.firstDraftMonth ? await householdDay(database, inputs.recordedAt) : undefined;
  const terms = await readDraftTerms(database, month, now, pricedOn);
  const drafted = new Map(draftBudgets(terms).map((budget) => [budget.category, budget]));
  const entries: MonthBudget[] = [];
  for (const { name: category } of CATEGORIES) {
    const bills = categoryGroupOf(category) === "Bills";
    const budget = drafted.get(category);
    // Groceries' or Superstores' share of T, only when the formula gives it a Budget this month on
    // its own: one with no Spending in the window and no known amounts never gets a $0 Budget.
    const share = firstBudgets && budget !== undefined ? shareOfT(terms, category) : undefined;
    if (!bills && (!firstBudgets || budget === undefined)) continue;
    entries.push({
      category,
      // A Bills Category the formula gives no Budget to keeps following it at $0, once it has one.
      amount: share ?? budget?.amount ?? 0,
      period: budget?.period ?? "monthly",
      takesEffect: budget?.period === "yearly" ? month.slice(0, 4) : month,
      source: "formula",
      setBy: null,
      pinned: bills ? false : null,
      setAt: now,
      follows: bills,
      first: firstBudgets && budget !== undefined,
      sharesTWith: share === undefined ? undefined : sharesTWith(category),
    });
  }
  return storeMonthBudgets(database, month, entries);
}

// The follow-up step's work: this month's Bills Budgets again. Safe to run after every sync. While
// this month's Month start has stopped at its cap, last month's Budgets stay in effect, as its
// System notice says.
export async function followBills(database: Database, now = new Date()): Promise<void> {
  const state = await readMonthStart(database, (await householdDay(database, now)).slice(0, 7));
  if (state?.doneAt == null && (state?.failedTries ?? 0) >= MONTH_START_CAP) return;
  const written = await setMonthBudgets(database, now, false);
  if (written > 0) log.info("Set this month's Bills Budgets again", { budgets: written });
}

async function raiseMonthStartStopped(): Promise<void> {
  await raiseNotice({
    kind: "condition",
    condition: MONTH_START_STOPPED,
    text: "The app could not set this month's Bills Budgets. Last month's stay in effect. It tries again on the 1st of next month.",
  });
}

// Work another module does in the Month start job, on the 1st, Household time: the Goal Done check
// (spec 05, Done). A step runs in each run that finds the month's work due, after the month's
// Budgets, whether they were set or not. Its failure is its own: it changes neither the Month
// start's result nor its tries. A step must be safe to run again, as it does after a failed run.
export type MonthStartStep = (now: Date) => Promise<void>;

const monthStartSteps = new Map<string, MonthStartStep>();

// Registers a step's work. Returns a function that removes it again.
export function registerMonthStartStep(name: string, step: MonthStartStep): () => void {
  if (monthStartSteps.has(name)) {
    throw new Error(`The Month start step "${name}" is already registered.`);
  }
  monthStartSteps.set(name, step);
  return () => {
    if (monthStartSteps.get(name) === step) monthStartSteps.delete(name);
  };
}

async function runMonthStartSteps(now: Date): Promise<void> {
  for (const [name, step] of monthStartSteps) {
    try {
      await step(now);
    } catch (error) {
      log.error("A Month start step failed", {
        step: name,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}

// The Month start's work for the Household's month, when it is due: after the first draft, not yet
// done, and not stopped at the cap. A failed run counts a try and never throws, so the daily task
// tries again the next day. The run that reaches the cap raises one System notice. Each registered
// step runs after the month's Budgets.
export async function runMonthStart(
  database: Database,
  now = new Date(),
): Promise<"not due" | "done" | "failed" | "stopped"> {
  const inputs = await readBudgetInputs(database);
  if (inputs === undefined) return "not due";
  const month = (await householdDay(database, now)).slice(0, 7);
  const state = await readMonthStart(database, month);
  if (state?.doneAt != null) return "not due";
  if ((state?.failedTries ?? 0) >= MONTH_START_CAP) return "stopped";
  const result = await setMonthStartBudgets(database, month, now);
  await runMonthStartSteps(now);
  return result;
}

async function setMonthStartBudgets(
  database: Database,
  month: string,
  now: Date,
): Promise<"done" | "failed" | "stopped"> {
  try {
    const written = await setMonthBudgets(database, now, true);
    await markMonthStartDone(database, month, now);
    log.info("Set the month's Budgets", { month, budgets: written });
    await endCondition(MONTH_START_STOPPED);
    return "done";
  } catch (error) {
    const tries = await countMonthStartFailure(database, month);
    log.error("The Month start failed", { month, tries, error });
    if (tries === MONTH_START_CAP) await raiseMonthStartStopped();
    return tries >= MONTH_START_CAP ? "stopped" : "failed";
  }
}

let running: { database: Database; now: () => Date } | undefined;

export function startMonthStart(services: { database: Database; now: () => Date }): () => void {
  if (running !== undefined) throw new Error("The Month start is already running.");
  running = services;
  return () => {
    if (running === services) running = undefined;
  };
}

// The daily task's job. Most days it finds the month's work done and does nothing. It is safe to
// run twice: a second run finds the month done, or counts one more failed try toward the cap.
export class MonthStartJob extends Job {
  override async run(): Promise<void> {
    if (running === undefined) throw new Error("The Month start is not running.");
    await runMonthStart(running.database, running.now());
  }
}
