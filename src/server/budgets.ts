import { benchmarkContextLine, categoryBenchmarks } from "../benchmarks/index.ts";
import {
  acceptDraft,
  budgetSpending,
  budgetsForMonth,
  editBudget,
  followTheBill,
} from "../budgets/index.ts";
import { categoryGroupOf } from "../categories/index.ts";
import type { Database } from "../db/index.ts";
import type { BudgetRoutes } from "./budgets-views.ts";

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
    edit: (category, amount, memberId) => editBudget(database, { category, amount, memberId }),
    followTheBill: (category, memberId) => followTheBill(database, { category, memberId }),
    acceptAll: (memberId) => acceptDraft(database, memberId),
  };
}
