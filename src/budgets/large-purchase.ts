import { categoryGroupOf, isCategory } from "../categories/index.ts";
import type { PostedPart } from "./loans.ts";

// Large purchases (spec 06, Large purchase): the projection's one-offs here, and the Large purchase
// Alert's test.

// A Large purchase is at least this many whole cents.
export const LARGE_PURCHASE_MIN = 25_000;

// ...and larger than at least this share of the purchases in the 365 days before it.
export const LARGE_PURCHASE_SHARE = 0.98;

const WINDOW_DAYS = 365;

// One purchase: a posted Spending Transaction outside the population's exclusions, with its date
// and the whole cents it spent.
export type Purchase = { transactionId: string; date: string; amount: number };

// A Transaction the population leaves out: a Recurring charge's, or a loan payment's.
export type LeftOut = (transactionId: string) => boolean;

// Every purchase, oldest first: each posted Spending Transaction's Spending outside the Bills group,
// summed. Recurring charges, loan payments and what `leftOut` names are left out; a Transfer has
// no Spending part.
export function purchasesFrom(posted: readonly PostedPart[], leftOut: LeftOut): Purchase[] {
  const found = new Map<string, Purchase>();
  for (const part of posted) {
    if (part.type !== "Spending" || leftOut(part.transactionId)) continue;
    if (part.category !== null && isCategory(part.category)) {
      if (categoryGroupOf(part.category) === "Bills") continue;
    }
    const purchase = found.get(part.transactionId) ?? {
      transactionId: part.transactionId,
      // The purchase date, as money-movement's purchaseDate reads it; its index does not export it.
      date: part.authorizedDate ?? part.postedDate,
      amount: 0,
    };
    purchase.amount -= part.amount;
    found.set(part.transactionId, purchase);
  }
  return [...found.values()]
    .filter((purchase) => purchase.amount > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.transactionId.localeCompare(b.transactionId));
}

function daysBefore(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - days);
  return day.toISOString().slice(0, 10);
}

// The first index in the date-sorted purchases on or after `date`.
function firstOnOrAfter(purchases: readonly Purchase[], date: string): number {
  let low = 0;
  let high = purchases.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((purchases[middle]?.date ?? "") < date) low = middle + 1;
    else high = middle;
  }
  return low;
}

// Whether `purchase` is a Large purchase among `purchases`, oldest first: at least $250, and larger
// than at least 98% of the purchases in the 365 days before it. With no purchase before it, it is
// larger than all of none.
export function isLargePurchase(purchase: Purchase, purchases: readonly Purchase[]): boolean {
  if (purchase.amount < LARGE_PURCHASE_MIN) return false;
  const from = firstOnOrAfter(purchases, daysBefore(purchase.date, WINDOW_DAYS));
  const to = firstOnOrAfter(purchases, purchase.date);
  let smaller = 0;
  for (let index = from; index < to; index += 1) {
    if ((purchases[index]?.amount ?? 0) < purchase.amount) smaller += 1;
  }
  return smaller >= LARGE_PURCHASE_SHARE * (to - from);
}
