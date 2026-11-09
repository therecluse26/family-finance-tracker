import { budgetsForMonths } from "../budgets/index.ts";
import type { Database } from "../db/index.ts";
import { totalsByMonth } from "../money-movement/index.ts";
import { cashFlowReport } from "../reports/cash-flow.ts";
import { spendingReport } from "../reports/spending.ts";
import type { ReportRoutes } from "./reports-views.ts";

// Spending over time and Cash flow (spec 07, Reports). Each request reads the posted Transactions
// once, through totalsByMonth, and every Budget version once, then folds them in memory.

export function spendingReports(
  database: Database,
  months: ReportRoutes["months"],
): Pick<ReportRoutes, "spending" | "cashFlow"> {
  return {
    async spending(query, now = new Date()) {
      const inRange = await months(query.range, now);
      const all = query.range === "all" ? inRange : await months("all", now);
      return spendingReport({
        range: query.range,
        months: inRange,
        firstMonth: all[0] ?? null,
        group: query.group ?? null,
        totals: await totalsByMonth(database),
        budgets: await budgetsForMonths(database, inRange),
      });
    },
    async cashFlow(query, now = new Date()) {
      return cashFlowReport({
        range: query.range,
        months: await months(query.range, now),
        totals: await totalsByMonth(database),
      });
    },
  };
}
