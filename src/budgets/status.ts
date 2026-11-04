import {
  CATEGORIES,
  CATEGORY_GROUPS,
  type Category,
  type CategoryGroup,
  categoryGroupOf,
} from "../categories/index.ts";
import type { Database } from "../db/index.ts";
import { YEARLY_CATEGORIES } from "./formulas.ts";
import { monthDay, projectCategories } from "./projection.ts";
import type { Budget } from "./stored.ts";

// Each Budget's status (spec 06, Overspending; spec 05, Yearly Budgets). The Budget is the only
// baseline: a Category with no Budget has no Overspending.
// - Over Budget: the Spending has passed the Budget.
// - On pace: not Over Budget, and P passes the Budget. A yearly Budget has no P, so it is never
//   On pace.
// - on track: neither.

export type BudgetStatus = "Over Budget" | "On pace" | "on track";

export function statusOf(spending: number, projected: number | null, budget: number): BudgetStatus {
  if (spending > budget) return "Over Budget";
  if (projected !== null && projected > budget) return "On pace";
  return "on track";
}

// How much of `year`, written YYYY, has passed on `today`: the day of the year ÷ the days in the
// year. 0 before it starts, 1 after it ends.
export function shareOfYear(year: string, today: string): number {
  if (today < `${year}-01-01`) return 0;
  if (today > `${year}-12-31`) return 1;
  const start = Date.UTC(Number(year), 0, 1);
  const day = (Date.parse(`${today}T00:00:00Z`) - start) / 86_400_000 + 1;
  const days = (Date.UTC(Number(year) + 1, 0, 1) - start) / 86_400_000;
  return day / days;
}

export type BudgetSpending = {
  // The month's Spending, or for a yearly Budget the year's through the month.
  spending: number;
  // P, or null for a yearly Budget, Interest and fees, and a month that has not started.
  projected: number | null;
  status: BudgetStatus;
  // A yearly Budget's share of the year; null for a monthly one.
  shareOfYear: number | null;
};

export type MonthSpending = {
  budgets: Map<Category, BudgetSpending>;
  // Each Category with Spending this month and no Budget: no status.
  unbudgeted: { category: Category; spending: number; projected: number | null }[];
  // Each Category group's box (spec 07, A usual month): the Spending and P of the Categories Left
  // to spend counts, its monthly Budgets and its monthly Categories with no Budget, and how many
  // of its Categories are Over Budget and On pace. Over Budget wins over On pace. Null with neither.
  groups: Map<CategoryGroup, GroupSpending | null>;
};

export type GroupSpending = {
  spending: number;
  projected: number | null;
  overBudget: number;
  onPace: number;
  status: BudgetStatus;
};

// A group's status from its Categories' counts.
function groupStatus({ overBudget, onPace }: GroupSpending): BudgetStatus {
  if (overBudget > 0) return "Over Budget";
  return onPace > 0 ? "On pace" : "on track";
}

// The Spending, P and status of each Budget in effect in `month`, written YYYY-MM, on `now`'s day,
// Household time.
export async function budgetSpending(
  database: Database,
  month: string,
  budgets: readonly Budget[],
  now = new Date(),
): Promise<MonthSpending> {
  const byCategory = new Map(budgets.map((budget) => [budget.category, budget]));
  const monthly = new Map(
    budgets.filter((each) => each.period === "monthly").map((each) => [each.category, each.amount]),
  );
  const { today, categories, totals } = await projectCategories(database, month, monthly, now);
  const year = month.slice(0, 4);
  const yearSpending = (category: Category) =>
    totals
      .filter((each) => each.month.startsWith(year) && each.month <= month)
      .reduce((sum, each) => sum + (each.byCategory[category] ?? 0), 0);

  // A past month's share of the year is taken on its last day.
  const { days } = monthDay(month, today);
  const asOf = month < today.slice(0, 7) ? `${month}-${String(days).padStart(2, "0")}` : today;
  // Adds a monthly Category to its group's box. A Category with no projection adds its Spending to
  // the group's P.
  const addToGroup = (
    category: Category,
    spending: number,
    projected: number | null,
    status: BudgetStatus | undefined,
  ) => {
    const group = categoryGroupOf(category);
    const sum = found.groups.get(group) ?? {
      spending: 0,
      projected: 0,
      overBudget: 0,
      onPace: 0,
      status: "on track",
    };
    sum.spending += spending;
    sum.projected =
      sum.projected === null || (projected === null && category !== "Interest and fees")
        ? null
        : sum.projected + (projected ?? spending);
    if (status === "Over Budget") sum.overBudget += 1;
    if (status === "On pace") sum.onPace += 1;
    sum.status = groupStatus(sum);
    found.groups.set(group, sum);
  };

  const found: MonthSpending = {
    budgets: new Map(),
    unbudgeted: [],
    groups: new Map(CATEGORY_GROUPS.map(({ name }) => [name, null])),
  };
  for (const { name: category } of CATEGORIES) {
    const { spending, projected } = categories.get(category) ?? { spending: 0, projected: null };
    const budget = byCategory.get(category);
    if (budget === undefined) {
      if (spending <= 0) continue;
      found.unbudgeted.push({ category, spending, projected });
      // Travel, and Gifts and donations, stay out of the group's box.
      if (!YEARLY_CATEGORIES.includes(category))
        addToGroup(category, spending, projected, undefined);
      continue;
    }
    if (budget.period === "yearly") {
      const spent = yearSpending(category);
      found.budgets.set(category, {
        spending: spent,
        projected: null,
        status: statusOf(spent, null, budget.amount),
        shareOfYear: shareOfYear(year, asOf),
      });
      continue;
    }
    const status = statusOf(spending, projected, budget.amount);
    found.budgets.set(category, { spending, projected, status, shareOfYear: null });
    addToGroup(category, spending, projected, status);
  }
  return found;
}
