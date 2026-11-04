import { budgetsForMonth } from "../budgets/index.ts";
import type { Database } from "../db/index.ts";
import type { BudgetRoutes } from "./budgets-views.ts";

// The Budget route (spec 05, Stored Budgets): each Category's Budget for a month, through the
// budgets module.
export function budgetRoutes(database: Database): BudgetRoutes {
  return {
    async budgets(month) {
      const { notice, budgets, groups } = await budgetsForMonth(database, month);
      return { month, notice: notice ?? null, budgets, groups };
    },
  };
}
