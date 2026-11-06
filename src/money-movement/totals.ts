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

// A posted part, as listPostedParts gives it.
export type PostedPart = Awaited<ReturnType<typeof listPostedParts>>[number];

// Every month with a posted Transaction, oldest first. Pending Transactions are left out.
export async function totalsByMonth(database: Database): Promise<MonthTotals[]> {
  return totalsByPeriod(await listPostedParts(database), monthOf).map(({ period, ...totals }) => ({
    month: period,
    ...totals,
  }));
}

// One period's totals, by the same rules as a month's.
export type PeriodTotals = Omit<MonthTotals, "month"> & { period: string };

// The totals of each period, by the rules of totalsByMonth: `periodOf` names a part's period, or
// null to leave it out. Each period with a part, in the order of its name.
export function totalsByPeriod(
  parts: readonly PostedPart[],
  periodOf: (part: PostedPart) => string | null,
): PeriodTotals[] {
  const periods = new Map<
    string,
    Omit<PeriodTotals, "byCategoryGroup"> & { uncategorized: number }
  >();
  for (const part of parts) {
    const period = periodOf(part);
    if (period === null) continue;
    let totals = periods.get(period);
    if (totals === undefined) {
      totals = { period, spending: 0, income: 0, saving: 0, byCategory: {}, uncategorized: 0 };
      periods.set(period, totals);
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
  return [...periods.values()]
    .sort((a, b) => a.period.localeCompare(b.period))
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
