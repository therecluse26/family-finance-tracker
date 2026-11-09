// What the Reports routes answer (spec 07, Reports). This file imports only types, so the web app's
// type check can follow it through api.ts. Each report's view is a placeholder for now: R1 fills
// Spending over time and Cash flow, R2 Balances and debt, and R3 Merchants and Recurring.
import type { CategoryGroup } from "../categories/list.ts";
import type { ReportRange } from "../reports/range.ts";

// What every report holds: its range and the months it covers, each written YYYY-MM, oldest first.
export type ReportFrameView = { range: ReportRange; months: string[] };

// Spending over time, for every Category group or for one (R1).
export type SpendingReportQuery = { range: ReportRange; group?: CategoryGroup };
export type SpendingReportView = ReportFrameView;

// Cash flow: Income, Spending and Saving by month (R1).
export type CashFlowReportQuery = { range: ReportRange };
export type CashFlowReportView = ReportFrameView;

// Balances and total Debt over time, for every Account or for one (R2). No net worth (spec 13).
export type BalancesReportQuery = { range: ReportRange; account?: string };
export type BalancesReportView = ReportFrameView;

// Spending at the top Merchants, or at one Merchant group (R3).
export type MerchantsReportQuery = { range: ReportRange; merchant?: string };
export type MerchantsReportView = ReportFrameView;

// Recurring charges over time (R3).
export type RecurringReportQuery = { range: ReportRange };
export type RecurringReportView = ReportFrameView;

export type ReportRoutes = {
  // The months `range` covers on the Household's data: up to its current month, and from no
  // earlier than the month of the first posted Transaction.
  months(range: ReportRange, now?: Date): Promise<string[]>;
};
