import type { Budget } from "../budgets/index.ts";
import { CATEGORY_GROUPS, type CategoryGroup } from "../categories/index.ts";
import type { MonthTotals } from "../money-movement/index.ts";
import {
  NO_CATEGORY_YET,
  type SpendingReportBar,
  type SpendingReportView,
} from "../server/reports-views.ts";
import { median, monthsBefore } from "../server/usual.ts";
import type { ReportRange } from "./range.ts";

// Spending over time (spec 07, Reports): each month's Spending, by Category group or by the chosen
// group's Categories, with the Budget in effect each month and the usual month. Every amount comes
// from totalsByMonth, so a Transfer counts nowhere, a Refund or Reimbursement lowers its Category,
// no Category's month goes below $0, and a pending Transaction counts nowhere. This adds no money
// rule of its own.

export type SpendingReportInput = {
  range: ReportRange;
  // The range's months, oldest first, ending with the Household's current month.
  months: readonly string[];
  // The history's first month, where "All" starts, or null with no history. A range before that
  // starts earlier is not a whole range, so it has no change.
  firstMonth: string | null;
  group: CategoryGroup | null;
  // totalsByMonth: every month with a posted Transaction, oldest first.
  totals: readonly MonthTotals[];
  // Each Category's Budget in effect in each of the range's months (budgetsForMonths).
  budgets: ReadonlyMap<string, readonly Budget[]>;
};

// A whole-cent average per month, never -0.
export function perMonth(total: number, months: number): number {
  return months === 0 ? 0 : Math.round(total / months) + 0;
}

// Each segment's part of one month: the groups' Spending and the Spending with no Category yet,
// or the chosen group's Categories.
function segmentsOf(
  totals: MonthTotals | undefined,
  group: CategoryGroup | null,
): Record<string, number> {
  if (group !== null) {
    const categories = CATEGORY_GROUPS.find((each) => each.name === group)?.categories ?? [];
    return Object.fromEntries(
      categories.map(({ name }) => [name, totals?.byCategory[name] ?? 0] as const),
    );
  }
  const segments: Record<string, number> = {};
  let grouped = 0;
  for (const { name } of CATEGORY_GROUPS) {
    const cents = totals?.byCategoryGroup[name] ?? 0;
    segments[name] = cents;
    grouped += cents;
  }
  // Spending holds the Categories' Spending and the Spending with no Category yet, so each bar
  // equals its month's Spending.
  segments[NO_CATEGORY_YET] = (totals?.spending ?? 0) - grouped;
  return segments;
}

// The sum of the monthly Budgets in effect in `month` in the report's Categories, or null with
// none. A yearly Budget is for a whole year, so it is not on a monthly line.
function budgetLine(budgets: readonly Budget[] | undefined, group: CategoryGroup | null) {
  const monthly = (budgets ?? []).filter(
    (budget) => budget.period === "monthly" && (group === null || budget.categoryGroup === group),
  );
  return monthly.length === 0 ? null : monthly.reduce((sum, budget) => sum + budget.amount, 0);
}

export function spendingReport(input: SpendingReportInput): SpendingReportView {
  const { range, months, group, totals } = input;
  const frame = { range, months: [...months], group };
  const current = months.at(-1);
  if (current === undefined) return { ...frame, segments: [], bars: [], usual: null, rows: [] };

  const byMonth = new Map(totals.map((each) => [each.month, each]));
  const segmentsIn = (month: string) => segmentsOf(byMonth.get(month), group);
  const bars: SpendingReportBar[] = months.map((month) => {
    const segments = segmentsIn(month);
    return {
      month,
      spending: Object.values(segments).reduce((sum, cents) => sum + cents, 0),
      segments,
      budget: budgetLine(input.budgets.get(month), group),
    };
  });

  // The usual month, by the number tiles' rule: the 12 complete months before this one, less any
  // before the history's first month.
  const first = totals[0]?.month;
  const usualMonths = monthsBefore(current, 12).filter(
    (month) => first !== undefined && month >= first,
  );
  const scopeIn = (month: string) => {
    const found = byMonth.get(month);
    if (found === undefined) return 0;
    return group === null ? found.spending : found.byCategoryGroup[group];
  };
  const usual = median(usualMonths.map(scopeIn));

  // The range before: as many months, just before this range, when the history holds all of them.
  const before = monthsBefore(months[0] ?? current, months.length);
  const hasBefore =
    range !== "all" && input.firstMonth !== null && (before[0] ?? "") >= input.firstMonth;
  const beforeSegments = hasBefore ? before.map(segmentsIn) : [];

  const names = Object.keys(bars[0]?.segments ?? {}).filter(
    (name) => name !== NO_CATEGORY_YET || bars.some((bar) => (bar.segments[name] ?? 0) !== 0),
  );
  const sum = (rows: readonly Record<string, number>[], name: string) =>
    rows.reduce((total, segments) => total + (segments[name] ?? 0), 0);
  const rows = names.map((name) => {
    const total = sum(
      bars.map((bar) => bar.segments),
      name,
    );
    return {
      name,
      total,
      average: perMonth(total, months.length),
      change: hasBefore ? total - sum(beforeSegments, name) : null,
    };
  });
  return { ...frame, segments: names, bars, usual, rows };
}
