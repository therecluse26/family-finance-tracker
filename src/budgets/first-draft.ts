import { registerFirstRunStep } from "../bank/index.ts";
import { benchmarkSnapshot } from "../benchmarks/index.ts";
import { type Category, categoryGroupOf } from "../categories/index.ts";
import { type Database, readBudgetInputs, storeFirstDraft } from "../db/index.ts";
import { registerFollowUpStep } from "../follow-up/index.ts";
import { calendarDateIn } from "../format.ts";
import { householdTimeZone } from "../household/index.ts";
import { log } from "../log.ts";
import { fitToIncome } from "./fit.ts";
import { type DraftedBudget, draftBudgets } from "./formulas.ts";
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

// The AI's part in the first draft (spec 05, The AI's part in a draft): Budget tailoring's figure
// and one-sentence reason for each flexible Category it tailors, or undefined when the draft stays
// the formula's figures, such as with no AI provider or when the AI fails. The tailoring module
// gives it, with its one AI call.
export type DraftTailoring = (draft: {
  month: string;
  budgets: readonly DraftedBudget[];
}) => Promise<ReadonlyMap<string, { amount: number; reason: string }> | undefined>;

// An AI figure stays within 50% of the formula's figure: from half of it to 1.5 times it, in whole
// dollars. A figure outside is moved to the nearer end.
export function withinHalfOf(formula: number, figure: number): number {
  const low = Math.ceil(formula / 200) * 100;
  const high = Math.floor((formula * 3) / 200) * 100;
  return Math.min(high, Math.max(low, Math.round(figure / 100) * 100));
}

// Drafts and stores every Budget, and records the inputs behind them: Steady Income and the CE
// data year. Safe to run twice: once a first draft is stored, it does nothing. True when this call
// stored it. With `tailor`, the AI's figures replace the formula's for flexible Categories, at
// once, with the source "AI draft" and the AI's reasons. Tailoring never changes a Bills Budget,
// which holds Interest and fees.
export async function draftFirstBudgets(
  database: Database,
  now = new Date(),
  tailor?: DraftTailoring,
): Promise<boolean> {
  if ((await readBudgetInputs(database)) !== undefined) return false;
  const month = await householdMonth(database, now);
  const terms = await readDraftTerms(database, month, now, await householdDay(database, now));
  const { budgets: drafted, fixedCostsPassIncome } = fitToIncome(draftBudgets(terms), terms);
  const figures = await tailor?.({ month, budgets: drafted });
  const tailored = (category: Category) =>
    categoryGroupOf(category) === "Bills" ? undefined : figures?.get(category);
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
    budgets: drafted.map(({ category, amount, period }) => {
      const figure = tailored(category);
      return {
        category,
        amount: figure === undefined ? amount : withinHalfOf(amount, figure.amount),
        period,
        takesEffect: period === "yearly" ? month.slice(0, 4) : month,
        source: figure === undefined ? "formula" : "AI draft",
        setBy: null,
        pinned: categoryGroupOf(category) === "Bills" ? false : null,
        setAt: now,
        reason: figure?.reason ?? null,
      };
    }),
    // The draft took the AI's figures, so no Tailoring run follows it.
    tailored: figures !== undefined,
  });
  if (stored) {
    log.info("Drafted the first Budgets", {
      budgets: drafted.length,
      aiDraft: drafted.filter(({ category }) => tailored(category) !== undefined).length,
    });
  }
  return stored;
}

// Registers the first draft as the First run's "budget draft" step, and the Bills Budgets step of
// the follow-up job, and gives the Month start job app.db. The start calls it before jobs run.
// `tailorDraft` is Budget tailoring's part in the first draft.
export function startBudgets(options: {
  database: Database;
  now?: () => Date;
  tailorDraft?: DraftTailoring;
}): {
  stop(): void;
} {
  const { database, now = () => new Date(), tailorDraft } = options;
  const stops = [
    registerFirstRunStep("budget draft", async () => {
      await draftFirstBudgets(database, now(), tailorDraft);
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
