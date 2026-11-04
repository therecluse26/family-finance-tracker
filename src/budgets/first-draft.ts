import { registerFirstRunStep } from "../bank/index.ts";
import { benchmarkSnapshot } from "../benchmarks/index.ts";
import { categoryGroupOf } from "../categories/index.ts";
import { type Database, readBudgetInputs, storeFirstDraft } from "../db/index.ts";
import { registerFollowUpStep } from "../follow-up/index.ts";
import { calendarDateIn } from "../format.ts";
import { householdTimeZone } from "../household/index.ts";
import { log } from "../log.ts";
import { fitToIncome } from "./fit.ts";
import { draftBudgets } from "./formulas.ts";
import { followBills, startMonthStart } from "./month-start.ts";
import { readDraftTerms } from "./terms.ts";

// The first draft (spec 05, When the app drafts): a First run step, so it runs once, when the
// first history load ends. It drafts every Budget by formula, with no AI, cuts the draft to fit
// Steady Income, and the draft is the active Budget at once, from the month it runs. Months before
// it have no Budget.

// The Household's day, written YYYY-MM-DD, and its month, written YYYY-MM. Until the wizard's step
// 4 sets the Household time zone, they are the day and month in UTC.
export async function householdDay(database: Database, now: Date): Promise<string> {
  return calendarDateIn(now, (await householdTimeZone(database)) ?? "UTC");
}

export async function householdMonth(database: Database, now: Date): Promise<string> {
  return (await householdDay(database, now)).slice(0, 7);
}

// Drafts and stores every Budget, and records the inputs behind them: Steady Income and the CE
// data year. Safe to run twice: once a first draft is stored, it does nothing. True when this call
// stored it.
export async function draftFirstBudgets(database: Database, now = new Date()): Promise<boolean> {
  if ((await readBudgetInputs(database)) !== undefined) return false;
  const month = await householdMonth(database, now);
  const terms = await readDraftTerms(database, month, now, await householdDay(database, now));
  const { budgets: drafted, fixedCostsPassIncome } = fitToIncome(draftBudgets(terms), terms);
  const snapshot = benchmarkSnapshot();
  const stored = await storeFirstDraft(database, {
    inputs: {
      steadyIncome: terms.income,
      ceDataYear: snapshot.ce.dataYear,
      sampleBenchmarks: snapshot.sample,
      firstDraftMonth: month,
      fixedCostsPassIncome,
      recordedAt: now,
    },
    budgets: drafted.map(({ category, amount, period }) => ({
      category,
      amount,
      period,
      takesEffect: period === "yearly" ? month.slice(0, 4) : month,
      source: "formula",
      setBy: null,
      pinned: categoryGroupOf(category) === "Bills" ? false : null,
      setAt: now,
    })),
  });
  if (stored) log.info("Drafted the first Budgets", { budgets: drafted.length });
  return stored;
}

// Registers the first draft as the First run's "budget draft" step, and the Bills Budgets step of
// the follow-up job, and gives the Month start job app.db. The start calls it before jobs run.
export function startBudgets(options: { database: Database; now?: () => Date }): {
  stop(): void;
} {
  const { database, now = () => new Date() } = options;
  const stops = [
    registerFirstRunStep("budget draft", async () => {
      await draftFirstBudgets(database, now());
    }),
    registerFollowUpStep("Bills Budgets", async () => {
      await followBills(database, now());
      return undefined;
    }),
    startMonthStart({ database, now }),
  ];
  return {
    stop() {
      for (const stop of stops.reverse()) stop();
    },
  };
}
