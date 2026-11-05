import { type Database, listSpendingPartsSince } from "../db/index.ts";
import { merchantKey } from "../merchants/index.ts";
import { addMonths, householdToday, merchantGroupOf } from "../recurring/index.ts";
import type {
  TopMerchantPeriod,
  TopMerchantRoutes,
  TopMerchantsView,
  TopMerchantView,
} from "./top-merchants-views.ts";

// Top Merchants (spec 07, Top Merchants): Merchants ranked by Spending, as the totals count it.
// "This month" runs from the first of the Household's month; "Last 12 months" from the first of
// the month 11 months before it, so it holds this month and the 11 before. Refunds and
// Reimbursements reduce their Spending's Merchant; a Merchant left with no Spending is not listed.
// A Transaction with no Merchant, such as a paper check, is in no row. One read for the period.

type Sum = {
  merchantName: string;
  // The purchase date of the part that gave the name: the latest one.
  namedOn: string;
  spending: number;
  transactions: Set<string>;
  byCategory: Map<string, number>;
};

// The Category that holds most of the Merchant's Spending; on a tie, the first by name.
function categoryOf(byCategory: Map<string, number>): string | null {
  let found: { category: string; spending: number } | null = null;
  for (const [category, spending] of byCategory) {
    if (
      found === null ||
      spending > found.spending ||
      (spending === found.spending && category < found.category)
    ) {
      found = { category, spending };
    }
  }
  return found?.category ?? null;
}

export function topMerchantRoutes(database: Database): TopMerchantRoutes {
  return {
    async view(period: TopMerchantPeriod, now = new Date()): Promise<TopMerchantsView> {
      const month = `${(await householdToday(database, now)).slice(0, 7)}-01`;
      const from = period === "This month" ? month : addMonths(month, -11);

      const sums = new Map<string, Sum>();
      for (const part of await listSpendingPartsSince(database, from)) {
        if (part.merchantName === null) continue;
        const merchant = { id: part.merchantId, name: part.merchantName };
        if (merchant.id === null && merchantKey(merchant.name) === "") continue;
        const key = merchantGroupOf(merchant);
        let sum = sums.get(key);
        if (sum === undefined) {
          sum = {
            merchantName: merchant.name,
            namedOn: part.date,
            spending: 0,
            transactions: new Set(),
            byCategory: new Map(),
          };
          sums.set(key, sum);
        } else if (part.date > sum.namedOn) {
          sum.merchantName = merchant.name;
          sum.namedOn = part.date;
        }
        // Spending is money out, so its parts are negative and a Refund's are positive.
        sum.spending -= part.amount;
        if (part.type !== "Spending") continue;
        sum.transactions.add(part.transactionId);
        if (part.category !== null) {
          sum.byCategory.set(part.category, (sum.byCategory.get(part.category) ?? 0) - part.amount);
        }
      }

      const merchants: TopMerchantView[] = [...sums]
        .filter(([, sum]) => sum.spending > 0)
        .map(([id, sum]) => ({
          id,
          merchantName: sum.merchantName,
          spending: sum.spending,
          transactions: sum.transactions.size,
          category: categoryOf(sum.byCategory),
        }))
        .sort(
          (a, b) =>
            b.spending - a.spending ||
            a.merchantName.localeCompare(b.merchantName, "en-US", { sensitivity: "base" }),
        );
      return { period, from, merchants };
    },
  };
}
