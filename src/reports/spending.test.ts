import { describe, expect, it } from "vitest";
import type { Budget } from "../budgets/index.ts";
import { type Category, categoryGroupOf, categoryGroupTotals } from "../categories/index.ts";
import type { MonthTotals } from "../money-movement/index.ts";
import { NO_CATEGORY_YET } from "../server/reports-views.ts";
import { type SpendingReportInput, spendingReport } from "./spending.ts";

// Spending over time (spec 07, Reports) from month totals made by hand. The route's tests in
// src/server/reports-spending.test.ts read real Transactions through the money rules.

// A month's totals: its Categories' Spending, and the Spending with no Category yet.
function month(
  name: string,
  byCategory: Partial<Record<Category, number>>,
  uncategorized = 0,
): MonthTotals {
  const categorized = Object.values(byCategory).reduce((sum, cents) => sum + cents, 0);
  return {
    month: name,
    spending: categorized + uncategorized,
    income: 0,
    saving: 0,
    byCategory,
    byCategoryGroup: categoryGroupTotals(byCategory),
  };
}

const monthly = (category: Category, amount: number): Budget => ({
  category,
  categoryGroup: categoryGroupOf(category),
  amount,
  period: "monthly",
  takesEffect: "2026-01",
  source: "formula",
  setBy: null,
  pinned: null,
  reason: null,
});

const report = (input: Partial<SpendingReportInput>) =>
  spendingReport({
    range: "3m",
    months: ["2026-09", "2026-10", "2026-11"],
    firstMonth: "2025-01",
    group: null,
    totals: [],
    budgets: new Map(),
    ...input,
  });

describe("Spending over time", () => {
  it("stacks each month by Category group, with the Spending with no Category yet, so each bar is the month's Spending", () => {
    const view = report({
      totals: [
        month("2026-09", { Groceries: 30_000, Housing: 200_000 }),
        month("2026-10", { Restaurants: 5_000 }, 2_500),
      ],
    });

    expect(view.segments).toEqual([
      "Bills",
      "Shopping",
      "Transportation",
      "Health and care",
      "Leisure",
      "Other",
      NO_CATEGORY_YET,
    ]);
    expect(view.bars.map((bar) => bar.spending)).toEqual([230_000, 7_500, 0]);
    expect(view.bars[1]?.segments).toMatchObject({ Leisure: 5_000, [NO_CATEGORY_YET]: 2_500 });
    // A month with no Transaction is $0.
    expect(Object.values(view.bars[2]?.segments ?? {}).every((cents) => cents === 0)).toBe(true);
  });

  it("leaves out the No Category yet segment when the range has none", () => {
    const view = report({ totals: [month("2026-09", { Groceries: 30_000 })] });

    expect(view.segments).not.toContain(NO_CATEGORY_YET);
    expect(view.rows.map((row) => row.name)).not.toContain(NO_CATEGORY_YET);
  });

  it("shows only the chosen group's Categories", () => {
    const view = report({
      group: "Health and care",
      totals: [month("2026-10", { Health: 8_000, Pets: 2_000, Groceries: 9_999 }, 1_000)],
    });

    expect(view.segments).toEqual(["Health", "Personal care", "Childcare", "Pets", "Fitness"]);
    expect(view.bars[1]?.segments).toEqual({
      Health: 8_000,
      "Personal care": 0,
      Childcare: 0,
      Pets: 2_000,
      Fitness: 0,
    });
    expect(view.bars[1]?.spending).toBe(10_000);
  });

  it("sums the monthly Budgets in effect each month, in the chosen group, with no line where there are none", () => {
    const budgets = new Map<string, Budget[]>([
      ["2026-09", []],
      ["2026-10", [monthly("Groceries", 40_000), monthly("Restaurants", 10_000)]],
      [
        "2026-11",
        [
          monthly("Groceries", 45_000),
          monthly("Restaurants", 10_000),
          { ...monthly("Travel", 480_000), period: "yearly", takesEffect: "2026" },
        ],
      ],
    ]);

    expect(report({ budgets }).bars.map((bar) => bar.budget)).toEqual([null, 50_000, 55_000]);
    expect(report({ budgets, group: "Shopping" }).bars.map((bar) => bar.budget)).toEqual([
      null,
      40_000,
      45_000,
    ]);
    expect(report({ budgets, group: "Bills" }).bars.map((bar) => bar.budget)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("takes the usual month from the 12 complete months before this one, from the history's first month", () => {
    const totals = [
      month("2025-06", { Groceries: 999_999 }),
      month("2026-08", { Groceries: 10_000 }),
      month("2026-09", { Groceries: 30_000 }),
      month("2026-10", { Groceries: 20_000, Housing: 100_000 }),
      // This month does not count.
      month("2026-11", { Groceries: 1 }),
    ];

    // 2025-11 to 2026-10: nine months at $0, then $100, $300 and $1,200.
    expect(report({ totals }).usual).toBe(0);
    // From August only: $100, $300 and $1,200.
    expect(report({ totals: totals.slice(1) }).usual).toBe(30_000);
    expect(report({ totals: totals.slice(1), group: "Bills" }).usual).toBe(0);
    // With no complete month there is no usual.
    expect(report({ totals: totals.slice(4) }).usual).toBeNull();
  });

  it("gives each row its range total, its average per month, and its change from the range before", () => {
    const totals = [
      month("2026-06", { Groceries: 10_000 }),
      month("2026-08", { Groceries: 20_000, Restaurants: 4_000 }),
      month("2026-09", { Groceries: 30_000 }),
      month("2026-10", { Groceries: 20_000, Restaurants: 1_000 }),
      month("2026-11", { Groceries: 1_000 }),
    ];

    const view = report({ totals });
    expect(view.rows.find((row) => row.name === "Shopping")).toEqual({
      name: "Shopping",
      total: 51_000,
      average: 17_000,
      change: 21_000,
    });
    expect(view.rows.find((row) => row.name === "Leisure")).toEqual({
      name: "Leisure",
      total: 1_000,
      average: 333,
      change: -3_000,
    });

    // A range before that starts before the history is not whole, and "All" has none.
    expect(report({ totals, firstMonth: "2026-07" }).rows[1]?.change).toBeNull();
    expect(report({ totals, firstMonth: "2026-06" }).rows[1]?.change).toBe(21_000);
    expect(
      report({ totals, range: "all", months: ["2026-06", "2026-07", "2026-08"] }).rows.map(
        (row) => row.change,
      ),
    ).toEqual([null, null, null, null, null, null]);
  });

  it("has no bars, rows or usual with no history", () => {
    expect(report({ months: [], firstMonth: null })).toEqual({
      range: "3m",
      months: [],
      group: null,
      segments: [],
      bars: [],
      usual: null,
      rows: [],
    });
  });
});
