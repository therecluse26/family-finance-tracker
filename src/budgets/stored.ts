import { benchmarkNotice, SAMPLE_NOTICE } from "../benchmarks/index.ts";
import {
  CATEGORIES,
  CATEGORY_GROUPS,
  type Category,
  type CategoryGroup,
  categoryGroupOf,
  isCategory,
} from "../categories/index.ts";
import {
  type Database,
  listBudgetsInEffect,
  readBudgetInputs,
  readDraftAcceptance,
  type StoredBudget,
} from "../db/index.ts";

// Stored Budgets (spec 05, Stored Budgets): a month uses the Budget in effect that month, and
// there is no Budget line before the first draft's month.

const LIST_ORDER: readonly Category[] = CATEGORIES.map(({ name }) => name);

export type Budget = Omit<StoredBudget, "id" | "category" | "setAt"> & {
  category: Category;
  categoryGroup: CategoryGroup;
};

export function budgetOf({
  id: _,
  setAt: __,
  category,
  ...budget
}: StoredBudget & { category: Category }): Budget {
  return { ...budget, category, categoryGroup: categoryGroupOf(category) };
}

// The draft's note when the "must fit" cuts could not bring it within Steady Income (spec 05, The
// total must fit).
export const FIXED_COSTS_PASS_INCOME = "The fixed costs pass Steady Income.";

export type MonthBudgets = {
  // The label every drafted amount carries while the Benchmarks behind it, or the shipped ones, are
  // the sample. Undefined for real data.
  notice: string | undefined;
  // FIXED_COSTS_PASS_INCOME when the draft stayed above Steady Income after its cuts, else
  // undefined.
  fitNote: string | undefined;
  // True once a Member accepted the whole draft with "Accept all".
  draftAccepted: boolean;
  // Each Category's Budget in effect that month, in Category list order.
  budgets: Budget[];
  // A Category group's Budget is the sum of its Categories' Budgets: monthly and yearly apart.
  groups: { categoryGroup: CategoryGroup; monthly: number; yearly: number }[];
};

// Each Category's Budget for `month`, written YYYY-MM. Before the first draft's month there is
// none.
export async function budgetsForMonth(database: Database, month: string): Promise<MonthBudgets> {
  const inputs = await readBudgetInputs(database);
  const notice =
    benchmarkNotice() ?? (inputs?.sampleBenchmarks === true ? SAMPLE_NOTICE : undefined);
  const stored =
    inputs === undefined || month < inputs.firstDraftMonth
      ? []
      : await listBudgetsInEffect(database, month);
  const budgets = stored
    .filter((row): row is StoredBudget & { category: Category } => isCategory(row.category))
    .map(budgetOf);
  budgets.sort((a, b) => LIST_ORDER.indexOf(a.category) - LIST_ORDER.indexOf(b.category));
  const groups = CATEGORY_GROUPS.map(({ name }) => ({
    categoryGroup: name,
    monthly: 0,
    yearly: 0,
  }));
  for (const budget of budgets) {
    const group = groups.find((each) => each.categoryGroup === budget.categoryGroup);
    if (group !== undefined) group[budget.period] += budget.amount;
  }
  const fitNote = inputs?.fixedCostsPassIncome === true ? FIXED_COSTS_PASS_INCOME : undefined;
  const draftAccepted = (await readDraftAcceptance(database)) !== undefined;
  return { notice, fitNote, draftAccepted, budgets, groups };
}
