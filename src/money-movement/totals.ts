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
  return purchaseDate(txn).slice(0, 7);
}

// The day the money moved: the purchase date when there is one, else the posted date. A purchase
// posts days after it was made, so a Refund or Reimbursement may arrive before the posted date.
export function purchaseDate(txn: { postedDate: string; authorizedDate: string | null }): string {
  return txn.authorizedDate ?? txn.postedDate;
}

// One month's totals, in whole cents. Spending and Income are positive. Saving is the money moved
// in, minus the money taken back out, and may be negative. A Refund or Reimbursement reduces the
// Spending in its Category; a linked one counts in its Spending's month and Category. No Category's
// month goes below $0: what Refunds would take lower counts nowhere (spec 03, Link shapes).
// Spending with no Category yet counts in `spending` only, and goes no lower than $0 either.
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
  const months = new Map<
    string,
    Omit<MonthTotals, "byCategoryGroup"> & { uncategorized: number }
  >();
  for (const part of await listPostedParts(database)) {
    const month = monthOf(part);
    let totals = months.get(month);
    if (totals === undefined) {
      totals = { month, spending: 0, income: 0, saving: 0, byCategory: {}, uncategorized: 0 };
      months.set(month, totals);
    }
    switch (part.type) {
      case "Spending":
      case "Refund":
      case "Reimbursement": {
        // Spending is money out, so its amount is negative; a Refund's is positive.
        if (part.category !== null && isCategory(part.category)) {
          totals.byCategory[part.category] = (totals.byCategory[part.category] ?? 0) - part.amount;
        } else {
          totals.uncategorized -= part.amount;
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
    .map(({ uncategorized, ...totals }) => {
      const byCategory = Object.fromEntries(
        Object.entries(totals.byCategory).map(([category, cents]) => [
          category,
          Math.max(0, cents),
        ]),
      ) as MonthTotals["byCategory"];
      const spending =
        Math.max(0, uncategorized) +
        Object.values(byCategory).reduce((sum, cents) => sum + cents, 0);
      return { ...totals, spending, byCategory, byCategoryGroup: categoryGroupTotals(byCategory) };
    });
}
