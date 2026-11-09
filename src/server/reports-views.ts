// What the Reports routes answer (spec 07, Reports). This file imports only types, so the web app's
// type check can follow it through api.ts. Each report's view is a placeholder for now: R1 fills
// Spending over time and Cash flow, R2 Balances and debt, and R3 Merchants and Recurring.
import type { CategoryGroup } from "../categories/list.ts";
import type { ReportRange } from "../reports/range.ts";
import type { BalancePointView, MonthEndView } from "./bank-views.ts";

// What every report holds: its range and the months it covers, each written YYYY-MM, oldest first.
export type ReportFrameView = { range: ReportRange; months: string[] };

// Spending over time, for every Category group or for one (R1). Amounts are whole cents.
export type SpendingReportQuery = { range: ReportRange; group?: CategoryGroup };

// The segment for Spending with no Category yet, in the all-groups view.
export const NO_CATEGORY_YET = "No Category yet";

// One month's bar: its Spending, and each segment's part of it, by segment name. `budget` is the
// sum of the monthly Budgets in effect that month in the report's Categories, or null with none,
// such as before the first draft.
export type SpendingReportBar = {
  month: string;
  spending: number;
  segments: Record<string, number>;
  budget: number | null;
};

// One table row: a Category group, a Category, or "No Category yet", with its total over the
// range, its average per month, and its change from the range before. The change is null with no
// whole range before in the history, as with "All".
export type SpendingReportRow = {
  name: string;
  total: number;
  average: number;
  change: number | null;
};

export type SpendingReportView = ReportFrameView & {
  group: CategoryGroup | null;
  // The segments, bottom first: the Category groups, or the chosen group's Categories, then "No
  // Category yet" in the all-groups view when it has Spending.
  segments: string[];
  bars: SpendingReportBar[];
  // The usual month: the median of the 12 complete months before the current one, from the
  // history's first month (spec 07, 4. Number tiles). Null with no complete month yet.
  usual: number | null;
  rows: SpendingReportRow[];
};

// Cash flow: Income, Spending and Saving by month (R1), and what is left over: Income less
// Spending less Saving, which may be below $0. Saving may be below $0 too, when more came out of
// savings than went in. Amounts are whole cents.
export type CashFlowReportQuery = { range: ReportRange };
export type CashFlowAmounts = {
  income: number;
  spending: number;
  saving: number;
  leftOver: number;
};
export type CashFlowReportView = ReportFrameView & {
  bars: (CashFlowAmounts & { month: string })[];
  // Over the range: the totals, and the average per month.
  total: CashFlowAmounts;
  average: CashFlowAmounts;
};

// Balances and total Debt over time, for every Account or for one (R2). No net worth (spec 13).
export type BalancesReportQuery = { range: ReportRange; account?: string };

// One point of a Balances and debt line: a month, YYYY-MM, at its end, or today in the current
// month (`date`, YYYY-MM-DD). It is estimated when any Account behind it has an estimated balance
// that day, or one from before its first sync.
export type BalanceMonthEnd = { month: string; date: string; estimated: boolean };
// Whole cents. Cash on hand is money in the Accounts; Debt is what is owed, so it is positive.
export type BalanceAmountPoint = BalanceMonthEnd & { amount: number };
// A card's balance owed as a share of its credit limit that day, such as 0.42; null with no limit.
export type CreditUsePoint = BalanceMonthEnd & { share: number | null };
// What is still owed on a loan, in whole cents; null when its bank sent no principal for that day.
export type PrincipalPoint = BalanceMonthEnd & { principal: number | null };

export type BalancesReportAccount = { id: string; name: string; kind: string };

export type BalancesReportView = ReportFrameView & {
  // The Household's date, YYYY-MM-DD.
  today: string;
  // The Accounts the filter offers: every Account that counts in a balance, and the one set.
  accounts: BalancesReportAccount[];
  // With an Account set: its balance line over the range, and its month-ends. Every other line
  // is then empty.
  account:
    | (BalancesReportAccount & { points: BalancePointView[]; monthEnds: MonthEndView[] })
    | null;
  cashOnHand: BalanceAmountPoint[];
  debt: BalanceAmountPoint[];
  // Each card with a credit limit, and all of them together.
  creditUse: {
    cards: (BalancesReportAccount & { points: CreditUsePoint[] })[];
    all: CreditUsePoint[];
  };
  // Each loan with a principal.
  loans: (BalancesReportAccount & { points: PrincipalPoint[] })[];
};

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
  spending(query: SpendingReportQuery, now?: Date): Promise<SpendingReportView>;
  cashFlow(query: CashFlowReportQuery, now?: Date): Promise<CashFlowReportView>;
  // Balances and debt. Undefined when no Account has the ID `account`.
  balances(query: BalancesReportQuery, now?: Date): Promise<BalancesReportView | undefined>;
};
