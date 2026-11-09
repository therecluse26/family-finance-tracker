import { describe, expect, it } from "vitest";
import { categoryGroupTotals } from "../categories/index.ts";
import type { MonthTotals } from "../money-movement/index.ts";
import { cashFlowReport } from "./cash-flow.ts";

// Cash flow (spec 07, Reports) from month totals made by hand. The route's tests in
// src/server/reports-spending.test.ts read real Transactions through the money rules.

const month = (name: string, income: number, spending: number, saving: number): MonthTotals => ({
  month: name,
  income,
  spending,
  saving,
  byCategory: {},
  byCategoryGroup: categoryGroupTotals({}),
});

describe("Cash flow", () => {
  it("gives each month's Income, Spending, Saving and Left over, which may be below $0", () => {
    const view = cashFlowReport({
      range: "3m",
      months: ["2026-09", "2026-10", "2026-11"],
      totals: [
        month("2026-08", 999_999, 0, 0),
        month("2026-09", 500_000, 320_000, 50_000),
        // More came out of savings than went in, and Spending passed Income.
        month("2026-11", 100_000, 250_000, -20_000),
      ],
    });

    expect(view.bars).toEqual([
      { month: "2026-09", income: 500_000, spending: 320_000, saving: 50_000, leftOver: 130_000 },
      { month: "2026-10", income: 0, spending: 0, saving: 0, leftOver: 0 },
      { month: "2026-11", income: 100_000, spending: 250_000, saving: -20_000, leftOver: -130_000 },
    ]);
    expect(view.total).toEqual({ income: 600_000, spending: 570_000, saving: 30_000, leftOver: 0 });
    expect(view.average).toEqual({
      income: 200_000,
      spending: 190_000,
      saving: 10_000,
      leftOver: 0,
    });
  });

  it("rounds each average to the cent, and has no bars with no history", () => {
    const view = cashFlowReport({
      range: "3m",
      months: ["2026-09", "2026-10", "2026-11"],
      totals: [month("2026-09", 100, 0, -100)],
    });
    expect(view.average).toEqual({ income: 33, spending: 0, saving: -33, leftOver: 67 });
    // -1 cent over 3 months is $0, not -0.
    const small = cashFlowReport({
      range: "3m",
      months: ["2026-09", "2026-10", "2026-11"],
      totals: [month("2026-09", 0, 0, -1)],
    });
    expect(Object.is(small.average.saving, 0)).toBe(true);

    expect(cashFlowReport({ range: "all", months: [], totals: [] })).toEqual({
      range: "all",
      months: [],
      bars: [],
      total: { income: 0, spending: 0, saving: 0, leftOver: 0 },
      average: { income: 0, spending: 0, saving: 0, leftOver: 0 },
    });
  });
});
