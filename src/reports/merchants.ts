import type { MerchantSeriesView, MerchantsReportView } from "../server/reports-views.ts";
import { merchantGroupOfPart } from "../server/top-merchants.ts";
import { median } from "../server/usual.ts";

// Merchants (spec 07, Reports): Spending at the top 10 Merchant groups by month, or at one. It
// counts as Top Merchants does (src/server/top-merchants.ts): the same Merchant groups, and each
// Refund or Reimbursement reduces its Merchant group's Spending. A linked one counts in its
// Spending's month, an unlinked one in its own. Like Top Merchants, nothing is floored at $0: a
// month may go below $0 when an unlinked Refund is more than that month's Spending at the
// Merchant, so the months of a range sum to what Top Merchants shows for the same months. A
// Merchant group left with no Spending in the range is not in the top 10.

export const TOP_MERCHANT_COUNT = 10;

// A Spending, Refund or Reimbursement part, as listSpendingPartsSince gives it. Amounts have the
// Transaction's sign: Spending is negative.
export type MerchantPart = {
  amount: number;
  date: string;
  merchantId: string | null;
  merchantName: string | null;
};

type Sum = { merchantId: string | null; merchantName: string; namedOn: string; byMonth: number[] };

const byMost = (a: MerchantSeriesView, b: MerchantSeriesView) =>
  b.total - a.total ||
  a.merchantName.localeCompare(b.merchantName, "en-US", { sensitivity: "base" });

// The report over `months`, oldest first, from the parts of those months: one pass over them.
// `merchant` is the filter's Merchant group key. A key that names no group gives no series; it is
// only ever compared as a value.
export function merchantsReport(
  parts: readonly MerchantPart[],
  months: readonly string[],
  merchant?: string,
): Omit<MerchantsReportView, "range" | "months"> {
  const at = new Map(months.map((month, index) => [month, index]));
  const sums = new Map<string, Sum>();
  for (const part of parts) {
    const index = at.get(part.date.slice(0, 7));
    if (index === undefined) continue;
    const group = merchantGroupOfPart(part);
    if (group === null) continue;
    let sum = sums.get(group.key);
    if (sum === undefined) {
      sum = {
        merchantId: part.merchantId,
        merchantName: group.merchantName,
        namedOn: part.date,
        byMonth: months.map(() => 0),
      };
      sums.set(group.key, sum);
    } else if (part.date > sum.namedOn) {
      // The name of the latest part, as on Top Merchants.
      sum.merchantName = group.merchantName;
      sum.namedOn = part.date;
    }
    // Spending is money out, so its parts are negative and a Refund's are positive.
    sum.byMonth[index] = (sum.byMonth[index] ?? 0) - part.amount;
  }

  const series = (key: string, sum: Sum): MerchantSeriesView => ({
    key,
    merchantId: sum.merchantId,
    merchantName: sum.merchantName,
    total: sum.byMonth.reduce((total, cents) => total + cents, 0),
    byMonth: sum.byMonth,
  });
  const top = [...sums]
    .map(([key, sum]) => series(key, sum))
    .filter((each) => each.total > 0)
    .sort(byMost)
    .slice(0, TOP_MERCHANT_COUNT);
  const choices = top.map(({ key, merchantName }) => ({ key, merchantName }));
  if (merchant === undefined) return { merchant: null, choices, series: top, usual: null };

  const found = sums.get(merchant);
  if (found === undefined) return { merchant, choices, series: [], usual: null };
  const one = series(merchant, found);
  if (!choices.some((choice) => choice.key === merchant)) {
    choices.push({ key: merchant, merchantName: one.merchantName });
  }
  return { merchant, choices, series: [one], usual: median(one.byMonth) };
}
