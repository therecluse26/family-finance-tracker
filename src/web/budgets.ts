import { YEARLY_CATEGORIES } from "../budgets/periods.ts";
import { CATEGORY_GROUPS, type Category } from "../categories/list.ts";
import { type StatusWord, wholeDollars } from "../format.ts";
import type { BudgetStatusView, BudgetsView, MonthBudgetView } from "../server/budgets-views.ts";
import { api } from "./api.ts";
import { centsOf } from "./pages/settings/UnconnectedAccounts.tsx";

// The Budgets page's rows, requests, and words (spec 07, Budgets page). The routes that read their
// body themselves are not named in the typed client, so each body goes in through a separate
// object.

export const budgetRequests = {
  budgets: (month: string) => {
    const read = { query: { month } };
    return api.budgets.$get(read);
  },
  // A Member's edit, in whole cents: per month, or per year for a yearly Budget.
  edit: (category: string, amount: number) => {
    const edit = { param: { category: encodeURIComponent(category) }, json: { amount } };
    return api.budgets[":category"].$put(edit);
  },
  followTheBill: (category: string) => {
    const follow = { param: { category: encodeURIComponent(category) }, json: {} };
    return api.budgets[":category"]["follow-the-bill"].$post(follow);
  },
  acceptAll: () => {
    const accept = { json: {} };
    return api.budgets["accept-all"].$post(accept);
  },
};

// A Category's row: this month's Spending, its Budget, or undefined with no Budget, and its average
// Spending per month, or undefined with no complete month of history.
export type BudgetRow = {
  category: string;
  spending: number;
  budget: MonthBudgetView | undefined;
  average?: number | undefined;
};

export type BudgetRows = {
  // Every Category with no yearly Budget, by Category group, in Category list order.
  groups: { categoryGroup: string; rows: BudgetRow[] }[];
  // Every yearly Budget, for its own section at the end.
  yearly: MonthBudgetView[];
};

export function budgetRows(
  view: Pick<BudgetsView, "budgets" | "unbudgeted" | "averages">,
): BudgetRows {
  const budgets = new Map(view.budgets.map((budget) => [budget.category, budget]));
  const unbudgeted = new Map(view.unbudgeted.map((each) => [each.category, each.spending]));
  const groups = CATEGORY_GROUPS.map((group) => ({
    categoryGroup: group.name as string,
    rows: group.categories
      .map(({ name }): BudgetRow => {
        const budget = budgets.get(name);
        return {
          category: name,
          spending: budget?.spending ?? unbudgeted.get(name) ?? 0,
          budget,
          average: view.averages?.[name],
        };
      })
      .filter((row) => row.budget?.period !== "yearly"),
  })).filter((group) => group.rows.length > 0);
  return { groups, yearly: view.budgets.filter((budget) => budget.period === "yearly") };
}

// A Budget's status as its icon's tone and its word (spec 07, Status: color, icon, and word
// together).
export type BudgetStatusShown =
  | { tone: "critical"; word: StatusWord<"critical"> }
  | { tone: "serious"; word: StatusWord<"serious"> }
  | { tone: "good"; word: StatusWord<"good"> };

export const STATUS_SHOWN: Record<BudgetStatusView, BudgetStatusShown> = {
  "Over Budget": { tone: "critical", word: "Over Budget" },
  "On pace": { tone: "serious", word: "On pace to go over" },
  "on track": { tone: "good", word: "On track" },
};

// A Category's average Spending, per the period of its Budget box: "averages $612 a month", or for
// a yearly Category 12 times its monthly average, "averages $1,800 a year". Undefined with none.
export function averageLine(category: string, perMonth: number | undefined): string | undefined {
  if (perMonth === undefined) return undefined;
  return YEARLY_CATEGORIES.includes(category as Category)
    ? `averages ${wholeDollars(perMonth * 12)} a year`
    : `averages ${wholeDollars(perMonth)} a month`;
}

// The Budget as a Member types it: "150", or "150.50" when it has cents.
export function typedBudget(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

export const ENTER_BUDGET = "Enter the Budget in dollars and cents.";

export type ChangeOutcome = { changed: true } | { changed: false; error: string };

async function outcomeOf(send: () => Promise<Response>): Promise<ChangeOutcome> {
  let res: Response;
  try {
    res = await send();
  } catch {
    return { changed: false, error: "The server did not answer." };
  }
  if (res.ok) return { changed: true };
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return {
    changed: false,
    error: typeof body.error === "string" ? body.error : "That did not work.",
  };
}

// Sends a Member's edit of a Budget, typed in dollars, such as "$1,200" or "150.50".
export async function editBudget(category: string, typed: string): Promise<ChangeOutcome> {
  const amount = centsOf(typed);
  if (amount === undefined || amount < 0) return { changed: false, error: ENTER_BUDGET };
  return outcomeOf(() => budgetRequests.edit(category, amount));
}

export const followTheBill = (category: string) =>
  outcomeOf(() => budgetRequests.followTheBill(category));

export const acceptAll = () => outcomeOf(() => budgetRequests.acceptAll());
