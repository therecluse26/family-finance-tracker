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

// The Budget routes (spec 05, Stored Budgets; Changing Budgets; spec 06, Overspending): each
// Category's Budget for a month with its Spending, projection and status, and a Member's changes,
// through the budgets module.
export function budgetRoutes(database: Database): BudgetRoutes {
  return {
    async budgets(month) {
      const { notice, fitNote, draftAccepted, budgets, groups } = await budgetsForMonth(
        database,
        month,
      );
      const spending = await budgetSpending(database, month, budgets);
      return {
        month,
        notice: notice ?? null,
        fitNote: fitNote ?? null,
        draftAccepted,
        budgets: budgets.map((budget) => {
          const found = spending.budgets.get(budget.category);
          return {
            ...budget,
            spending: found?.spending ?? 0,
            projected: found?.projected ?? null,
            status: found?.status ?? "on track",
            shareOfYear: found?.shareOfYear ?? null,
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
