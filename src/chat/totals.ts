import { categoryGroupOf, isCategory } from "../categories/index.ts";
import { type Database, listPostedParts, readShownTransactions } from "../db/index.ts";

// Totals for Chat's get_totals (spec 08, Lookup tools), counted as the app counts them everywhere
// (src/money-movement/totals.ts): posted Transactions only, each part in the month of its purchase
// date, and a linked Refund or Reimbursement with its Spending's Category, date, and Merchant.

export const TOTAL_KINDS = ["Spending", "Income", "Saving"] as const;
export type TotalKind = (typeof TOTAL_KINDS)[number];
export const TOTAL_GROUPINGS = ["Category", "Category group", "Merchant", "month"] as const;
export type TotalGrouping = (typeof TOTAL_GROUPINGS)[number];

export const NO_CATEGORY = "No Category";
export const NO_MERCHANT = "No Merchant";

type Part = Awaited<ReturnType<typeof listPostedParts>>[number];

// Each part's amount in the kind's total, or undefined when it does not count: Spending is money
// out, so a Spending part's amount is negative and a Refund's positive; Income is money in; Saving
// is money moved into an investment or retirement account, less money taken back out.
function amountIn(kind: TotalKind, part: Part): number | undefined {
  switch (kind) {
    case "Spending":
      return part.type === "Spending" || part.type === "Refund" || part.type === "Reimbursement"
        ? -part.amount
        : undefined;
    case "Income":
      return part.type === "Income" ? part.amount : undefined;
    case "Saving":
      return part.type === "Saving" ? -part.amount : undefined;
  }
}

// Every row's name and total in whole cents, largest first, from the parts whose purchase date is
// in the range. Spending is summed first by Category, or by Merchant, and month, and each such sum
// goes no lower than $0, as a Category's month does (spec 03, Link shapes).
export async function totalsBy(
  database: Database,
  kind: TotalKind,
  grouping: TotalGrouping,
  range: { from: string; to: string },
): Promise<{ name: string; total: number }[]> {
  const parts = (await listPostedParts(database)).filter((part) => {
    // The purchase date when there is one, else the posted date (spec 04, Which month a
    // Transaction counts in).
    const day = part.authorizedDate ?? part.postedDate;
    return day >= range.from && day <= range.to;
  });
  const merchants = new Map<string, string | null>();
  if (grouping === "Merchant") {
    const ids = parts.map((part) => part.spendingTransactionId ?? part.transactionId);
    for (const txn of await readShownTransactions(database, ids)) {
      merchants.set(txn.id, txn.merchantCleanName);
    }
  }
  const categoryOf = (part: Part) =>
    part.category !== null && isCategory(part.category) ? part.category : null;
  const nameOf = (part: Part): string => {
    const category = categoryOf(part);
    switch (grouping) {
      case "Category":
        return category ?? NO_CATEGORY;
      case "Category group":
        return category === null ? NO_CATEGORY : categoryGroupOf(category);
      case "Merchant":
        return merchants.get(part.spendingTransactionId ?? part.transactionId) ?? NO_MERCHANT;
      case "month":
        return (part.authorizedDate ?? part.postedDate).slice(0, 7);
    }
  };
  // Each sum that goes no lower than $0 for Spending, by its key, with the row it adds to.
  const sums = new Map<string, { name: string; total: number }>();
  for (const part of parts) {
    const amount = amountIn(kind, part);
    if (amount === undefined) continue;
    const name = nameOf(part);
    const month = (part.authorizedDate ?? part.postedDate).slice(0, 7);
    const unit = grouping === "Merchant" ? name : (categoryOf(part) ?? NO_CATEGORY);
    const key = kind === "Spending" ? `${unit}\u0000${month}\u0000${name}` : name;
    const sum = sums.get(key);
    if (sum === undefined) sums.set(key, { name, total: amount });
    else sum.total += amount;
  }
  const rows = new Map<string, number>();
  for (const { name, total } of sums.values()) {
    rows.set(name, (rows.get(name) ?? 0) + (kind === "Spending" ? Math.max(0, total) : total));
  }
  return [...rows]
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}
