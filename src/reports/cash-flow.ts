import type { MonthTotals } from "../money-movement/index.ts";
import type { CashFlowAmounts, CashFlowReportView } from "../server/reports-views.ts";
import type { ReportRange } from "./range.ts";
import { perMonth } from "./spending.ts";

// Cash flow (spec 07, Reports): each month's Income, Spending and Saving, from totalsByMonth as
// Spending over time reads them, and what is left over: Income less Spending less Saving. It adds
// no money rule of its own. Left over and Saving may be below $0.

const NONE: CashFlowAmounts = Object.freeze({ income: 0, spending: 0, saving: 0, leftOver: 0 });

function amountsOf(totals: MonthTotals | undefined): CashFlowAmounts {
  if (totals === undefined) return NONE;
  const { income, spending, saving } = totals;
  return { income, spending, saving, leftOver: income - spending - saving };
}

export function cashFlowReport(input: {
  range: ReportRange;
  // The range's months, oldest first.
  months: readonly string[];
  // totalsByMonth: every month with a posted Transaction, oldest first.
  totals: readonly MonthTotals[];
}): CashFlowReportView {
  const byMonth = new Map(input.totals.map((each) => [each.month, each]));
  const bars = input.months.map((month) => ({ month, ...amountsOf(byMonth.get(month)) }));
  const total = { ...NONE };
  for (const bar of bars) {
    total.income += bar.income;
    total.spending += bar.spending;
    total.saving += bar.saving;
    total.leftOver += bar.leftOver;
  }
  const count = bars.length;
  return {
    range: input.range,
    months: [...input.months],
    bars,
    total,
    average: {
      income: perMonth(total.income, count),
      spending: perMonth(total.spending, count),
      saving: perMonth(total.saving, count),
      leftOver: perMonth(total.leftOver, count),
    },
  };
}
