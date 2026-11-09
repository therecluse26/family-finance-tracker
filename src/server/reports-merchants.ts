import { type Database, listRecurringReportRows, listSpendingPartsSince } from "../db/index.ts";
import { householdToday } from "../recurring/index.ts";
import { merchantsReport } from "../reports/merchants.ts";
import { recurringReport } from "../reports/recurring.ts";
import type {
  MerchantsReportQuery,
  MerchantsReportView,
  RecurringReportQuery,
  RecurringReportView,
  ReportRoutes,
} from "./reports-views.ts";

// The Reports page's Merchants and Recurring charges reports (spec 07, Reports). Each request reads
// its rows once and folds them in one pass (src/reports/merchants.ts, src/reports/recurring.ts).

export function merchantReports(
  database: Database,
  months: ReportRoutes["months"],
): Pick<ReportRoutes, "merchants" | "recurring"> {
  return {
    async merchants(query: MerchantsReportQuery, now = new Date()): Promise<MerchantsReportView> {
      const covered = await months(query.range, now);
      const first = covered[0];
      const parts =
        first === undefined ? [] : await listSpendingPartsSince(database, `${first}-01`);
      return {
        range: query.range,
        months: covered,
        ...merchantsReport(parts, covered, query.merchant),
      };
    },

    async recurring(query: RecurringReportQuery, now = new Date()): Promise<RecurringReportView> {
      const covered = await months(query.range, now);
      const rows =
        covered.length === 0
          ? { charges: [], payments: [], priceChanges: [] }
          : await listRecurringReportRows(database);
      const today = await householdToday(database, now);
      return { range: query.range, months: covered, ...recurringReport(rows, covered, today) };
    },
  };
}
