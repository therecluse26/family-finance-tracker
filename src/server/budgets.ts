import { benchmarkContextLine, categoryBenchmarks } from "../benchmarks/index.ts";
import {
  acceptDraft,
  budgetSpending,
  budgetsForMonth,
  editBudget,
  followTheBill,
  YEARLY_CATEGORIES,
} from "../budgets/index.ts";
import { CATEGORY_GROUPS, type Category, categoryGroupOf } from "../categories/index.ts";
import type { Database } from "../db/index.ts";
import { totalsByMonth } from "../money-movement/index.ts";
import type { BudgetRoutes, UsualMonthView } from "./budgets-views.ts";
import { median, monthsBefore } from "./usual.ts";

// "A usual month" (spec 07, 5. "A usual month"): each Category group's Spending and Budget in the
// 12 complete months before `month` and in `month` so far, in the Categories Left to spend counts.
// A past month uses the Budget in effect that month.
async function usualMonth(database: Database, month: string): Promise<UsualMonthView> {
  const totals = await totalsByMonth(database);
  const first = totals[0]?.month;
  const byMonth = new Map(totals.map((each) => [each.month, each.byCategory]));
  const months = [...monthsBefore(month, 12), month].filter(
    (each) => each === month || (first !== undefined && each >= first),
  );
  const budgetsIn = new Map<string, Awaited<ReturnType<typeof budgetsForMonth>>["budgets"]>();
  for (const each of months) budgetsIn.set(each, (await budgetsForMonth(database, each)).budgets);

  const groups = CATEGORY_GROUPS.map((group) => {
    const categories: Category[] = group.categories
      .map(({ name }) => name)
      .filter((name) => !YEARLY_CATEGORIES.includes(name));
    const bars = months.map((each) => {
      const byCategory = byMonth.get(each) ?? {};
      const monthly = (budgetsIn.get(each) ?? []).filter(
        (budget) => budget.categoryGroup === group.name && budget.period === "monthly",
      );
      return {
        month: each,
        spending: categories.reduce((sum, category) => sum + (byCategory[category] ?? 0), 0),
        budget:
          monthly.length === 0 ? null : monthly.reduce((sum, budget) => sum + budget.amount, 0),
      };
    });
    return { categoryGroup: group.name as string, categories: categories as string[], bars };
  });
  const complete = months.filter((each) => each < month);
  const spendingIn = (each: string) =>
    groups.reduce(
      (sum, group) => sum + (group.bars.find((bar) => bar.month === each)?.spending ?? 0),
      0,
    );
  return { usual: median(complete.map(spendingIn)), groups };
}

// Each monthly Budget's Benchmark context line, by Category (spec 05, Context for Bills Budgets).
// Only a Bills Budget has a context Benchmark, so the Benchmarks are read only when one is in
// effect.
async function contextLines(
  database: Database,
  budgets: readonly { category: string; categoryGroup: string; amount: number; period: string }[],
): Promise<Map<string, string>> {
  const lines = new Map<string, string>();
  const bills = budgets.filter(
    (each) => each.categoryGroup === "Bills" && each.period === "monthly",
  );
  if (bills.length === 0) return lines;
  const benchmarks = await categoryBenchmarks(database);
  if (benchmarks === undefined) return lines;
  for (const budget of bills) {
    const benchmark = benchmarks.categories.find((each) => each.category === budget.category);
    const line =
      benchmark === undefined
        ? undefined
        : benchmarkContextLine(benchmark, budget.amount, benchmarks.income);
    if (line !== undefined) lines.set(budget.category, line);
  }
  return lines;
}

// The Budget routes (spec 05, Stored Budgets; Changing Budgets; spec 06, Overspending): each
// Category's Budget for a month with its Spending, projection, status and Benchmark context, and a
// Member's changes, through the budgets module.
export function budgetRoutes(database: Database): BudgetRoutes {
  return {
    async budgets(month) {
      const { notice, fitNote, drafted, draftAccepted, budgets, groups } = await budgetsForMonth(
        database,
        month,
      );
      const spending = await budgetSpending(database, month, budgets);
      const context = await contextLines(database, budgets);
      return {
        month,
        notice: notice ?? null,
        fitNote: fitNote ?? null,
        drafted,
        draftAccepted,
        budgets: budgets.map((budget) => {
          const found = spending.budgets.get(budget.category);
          return {
            ...budget,
            spending: found?.spending ?? 0,
            projected: found?.projected ?? null,
            status: found?.status ?? "on track",
            shareOfYear: found?.shareOfYear ?? null,
            context: context.get(budget.category) ?? null,
          };
        }),
        unbudgeted: spending.unbudgeted.map((each) => ({
          ...each,
          categoryGroup: categoryGroupOf(each.category),
        })),
        groups: groups.map((group) => {
          const found = spending.groups.get(group.categoryGroup) ?? null;
          return {
            ...group,
            spending: found?.spending ?? null,
            projected: found?.projected ?? null,
            overBudget: found?.overBudget ?? null,
            onPace: found?.onPace ?? null,
            status: found?.status ?? null,
          };
        }),
      };
    },
    usualMonth: (month) => usualMonth(database, month),
    edit: (category, amount, memberId) => editBudget(database, { category, amount, memberId }),
    followTheBill: (category, memberId) => followTheBill(database, { category, memberId }),
    acceptAll: (memberId) => acceptDraft(database, memberId),
  };
}
