import type { Category } from "../categories/index.ts";

// Part amounts from Line items (spec 14, Splits from Line items): each Category's share of the
// Transaction's amount is in proportion to its Line items' totals. Each part is rounded down to the
// cent, and the cents left over go one each to the parts with the largest remainders, so the parts
// always add up to the Transaction's amount. Tax, shipping, a promotion and gift card money so
// spread over the parts with no rule of their own. Whole cents only: no floating point.

export type PartFromLineItems = { amount: number; category: Category };

// The parts of a Spending Transaction of `amount` cents (negative: money out) whose Line items total
// `totals` cents in each Category, in the Transaction's sign, the largest first. A Category whose
// Line items total $0 or less, such as a free item, takes no part, and neither does one whose share
// rounds to 0 cents. Empty when no Category has a total above $0, or when the amount is not money
// out.
export function partsFromLineItems(
  amount: number,
  totals: ReadonlyMap<Category, number>,
): PartFromLineItems[] {
  const whole = -amount;
  if (!Number.isSafeInteger(whole) || whole <= 0) return [];
  const weights = [...totals].filter(([, total]) => total > 0);
  const sum = weights.reduce((all, [, total]) => all + total, 0);
  if (weights.length === 0 || sum <= 0) return [];
  const shares = weights.map(([category, weight], place) => {
    const exact = BigInt(whole) * BigInt(weight);
    return {
      category,
      weight,
      place,
      cents: Number(exact / BigInt(sum)),
      remainder: Number(exact % BigInt(sum)),
    };
  });
  let left = whole - shares.reduce((all, share) => all + share.cents, 0);
  const byRemainder = [...shares].sort(
    (a, b) => b.remainder - a.remainder || b.weight - a.weight || a.place - b.place,
  );
  for (const share of byRemainder) {
    if (left === 0) break;
    share.cents += 1;
    left -= 1;
  }
  return shares
    .filter((share) => share.cents > 0)
    .sort((a, b) => b.cents - a.cents || a.place - b.place)
    .map((share) => ({ amount: -share.cents, category: share.category }));
}
