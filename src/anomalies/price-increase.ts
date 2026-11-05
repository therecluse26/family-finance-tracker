import { fewestToFind, type RecurringCharge } from "../recurring/index.ts";

// Price increases (spec 06, Anomalies; Rules behind the table). A Transaction that continues a
// Recurring charge is a Price increase when it is more than 5% and more than $1 above the base
// price: the median of the previous 3 Transactions in the Recurring charge, counting only those
// from the last Price increase onward. $15.49 three times, then $17.99, is one; the next $17.99
// compares against $17.99 and is none.

// More than this many whole cents above the base price...
const MORE_THAN_CENTS = 100;
// ...and more than this many percent above it.
const MORE_THAN_PERCENT = 5;

const PREVIOUS = 3;

// The median, in whole cents: the middle amount, or the two middle ones' mean, rounded.
function median(amounts: readonly number[]): number {
  const sorted = [...amounts].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

export type PriceIncrease = {
  transactionId: string;
  date: string;
  // Whole cents spent.
  base: number;
  amount: number;
};

// Every Price increase in a Recurring charge's price history, oldest first. Only a Transaction
// after those it was found with continues it.
export function priceIncreases(charge: Pick<RecurringCharge, "schedule" | "priceHistory">) {
  const found: PriceIncrease[] = [];
  const history = charge.priceHistory;
  let since = 0;
  for (let index = fewestToFind(charge.schedule); index < history.length; index += 1) {
    const entry = history[index];
    if (entry === undefined) continue;
    const previous = history.slice(Math.max(since, index - PREVIOUS), index);
    const base = median(previous.map((each) => each.amount));
    const rise = entry.amount - base;
    if (rise > MORE_THAN_CENTS && rise * 100 > base * MORE_THAN_PERCENT) {
      found.push({
        transactionId: entry.transactionId,
        date: entry.date,
        base,
        amount: entry.amount,
      });
      since = index;
    }
  }
  return found;
}
