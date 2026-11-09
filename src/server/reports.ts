import { type Database, readHistoryStart } from "../db/index.ts";
import { householdToday } from "../recurring/index.ts";
import { type ReportRange, reportMonths } from "../reports/range.ts";
import { balancesReports } from "./reports-balances.ts";
import { merchantReports } from "./reports-merchants.ts";
import { spendingReports } from "./reports-spending.ts";
import type { ReportRoutes } from "./reports-views.ts";

// The Reports page (spec 07, Reports). Every report covers the months of its range: they end with
// the Household's current month, on its own date, and start no earlier than the month of the first
// shown, posted Transaction. Each report's own read and view is in its own file.

export function reportRoutes(database: Database): ReportRoutes {
  async function months(range: ReportRange, now = new Date()): Promise<string[]> {
    const today = await householdToday(database, now);
    const first = await readHistoryStart(database);
    return reportMonths(range, today.slice(0, 7), first?.slice(0, 7) ?? null);
  }
  return {
    months,
    ...spendingReports(database, months),
    ...balancesReports(database, months),
    ...merchantReports(database, months),
  };
}
