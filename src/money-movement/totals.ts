import {
  type Category,
  type CategoryGroup,
  categoryGroupTotals,
  isCategory,
} from "../categories/index.ts";
import { type Database, listPostedParts } from "../db/index.ts";

// Totals by type (spec 03, Transaction types; spec 04, Which month a Transaction counts in).

// A Transaction's month comes from its purchase date when it has one, else its posted date. The
// dates are the bank's calendar dates, never shifted by time zone: a dinner on Oct 31 that posts
// Nov 2 counts in October.
export function monthOf(txn: { postedDate: string; authorizedDate: string | null }): string {
  return (txn.authorizedDate ?? txn.postedDate).slice(0, 7);
}

// One month's totals, in whole cents. Spending and Income are positive. Saving is the money moved
// in, minus the money taken back out, and may be negative. A Refund or Reimbursement reduces the
// Spending in its Category. Spending with no Category yet counts in `spending` only.
export type MonthTotals = {
  month: string;
  spending: number;
  income: number;
  saving: number;
  byCategory: Partial<Record<Category, number>>;
  byCategoryGroup: Record<CategoryGroup, number>;
};

// Every month with a posted Transaction, oldest first. Pending Transactions are left out.
export async function totalsByMonth(database: Database): Promise<MonthTotals[]> {
  const months = new Map<string, Omit<MonthTotals, "byCategoryGroup">>();
  for (const part of await listPostedParts(database)) {
    const month = monthOf(part);
    let totals = months.get(month);
    if (totals === undefined) {
      totals = { month, spending: 0, income: 0, saving: 0, byCategory: {} };
      months.set(month, totals);
    }
    switch (part.type) {
      case "Spending":
      case "Refund":
      case "Reimbursement": {
        // Spending is money out, so its amount is negative; a Refund's is positive.
        totals.spending -= part.amount;
        if (part.category !== null && isCategory(part.category)) {
          totals.byCategory[part.category] = (totals.byCategory[part.category] ?? 0) - part.amount;
        }
        break;
      }
      case "Income":
        totals.income += part.amount;
        break;
      case "Saving":
        totals.saving -= part.amount;
        break;
      case "Transfer":
        break;
    }
  }
  return [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((totals) => ({ ...totals, byCategoryGroup: categoryGroupTotals(totals.byCategory) }));
}
