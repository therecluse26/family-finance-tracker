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
import { draftBudgets } from "./formulas.ts";
import { readDraftTerms } from "./terms.ts";

// The month's Bills Budgets (spec 05, When the app drafts; Bills group; Stored Budgets).
// - The Month start job, on the 1st, Household time, computes and stores each Bills Budget for the
//   month, and gives each Category with no Budget its first one, by formula, once it qualifies.
// - The Bills Budgets step, in the follow-up job after the Recurring charge checks, sets this
//   month's Bills Budgets again as Transactions post. K is fixed on the 1st, so only an early
//   Recurring charge or loan payment, which moves its known amount into this month, and a loan
//   payment's actual interest, which replaces its expected interest, change them.
// Neither touches a pinned Bills Budget, a Bills Budget a Member set by hand this month, a flexible
// Budget that exists, or any month but the current one.

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
    if (!bills && (!firstBudgets || budget === undefined)) continue;
    entries.push({
      category,
      // A Bills Category the formula gives no Budget to keeps following it at $0, once it has one.
      amount: budget?.amount ?? 0,
      period: budget?.period ?? "monthly",
      takesEffect: budget?.period === "yearly" ? month.slice(0, 4) : month,
      source: "formula",
      setBy: null,
      pinned: bills ? false : null,
      setAt: now,
      follows: bills,
      first: firstBudgets && budget !== undefined,
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

// The Month start's work for the Household's month, when it is due: after the first draft, not yet
// done, and not stopped at the cap. A failed run counts a try and never throws, so the daily task
// tries again the next day. The run that reaches the cap raises one System notice.
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
