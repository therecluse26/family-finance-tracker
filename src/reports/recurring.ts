import type {
  RecurringChangeView,
  RecurringPriceChangeView,
  RecurringReportView,
  RecurringSeriesView,
} from "../server/reports-views.ts";

// Recurring charges over time (spec 07, Reports): each month's payments to Recurring charges, as a
// stacked bar of the 8 charges with the most in the range and one "Other" for the rest; the price
// changes in the range; and each charge's amount now against a year ago. A payment is a posted
// Transaction in the charge that still shows, in whole cents spent, in the month of its purchase
// date.

export const CHARGE_COUNT = 8;

export type ReportCharge = {
  id: string;
  name: string | null;
  merchantId: string | null;
  merchantName: string;
  status: RecurringChangeView["status"];
  latestAmount: number;
};

// `date` is the purchase date, else the posted date; `postedDate` is the date the charge's price
// history and price changes use.
export type ReportPayment = { chargeId: string; date: string; postedDate: string; amount: number };

export type ReportPriceChange = {
  chargeId: string;
  fromDate: string;
  amount: number;
  byHand: boolean;
};

// The same calendar day a year before `day`, both written YYYY-MM-DD. Feb 29 stays Feb 29, which
// still sorts between Feb 28 and Mar 1.
const yearBefore = (day: string) => `${String(Number(day.slice(0, 4)) - 1)}${day.slice(4)}`;

// The report over `months`, oldest first, on the Household's date `today`. `payments` are every
// charge's, oldest first by posted date: the amount a year ago may come from before the range.
export function recurringReport(
  rows: {
    charges: readonly ReportCharge[];
    payments: readonly ReportPayment[];
    priceChanges: readonly ReportPriceChange[];
  },
  months: readonly string[],
  today: string,
): Omit<RecurringReportView, "range" | "months"> {
  const at = new Map(months.map((month, index) => [month, index]));
  const yearAgoDay = yearBefore(today);
  const byMonth = new Map<string, number[]>();
  const yearAgo = new Map<string, number>();
  const paidBy = new Map<string, ReportPayment[]>();
  for (const payment of rows.payments) {
    const list = paidBy.get(payment.chargeId) ?? [];
    list.push(payment);
    paidBy.set(payment.chargeId, list);
    if (payment.date <= yearAgoDay) yearAgo.set(payment.chargeId, payment.amount);
    const index = at.get(payment.date.slice(0, 7));
    if (index === undefined) continue;
    const sums = byMonth.get(payment.chargeId) ?? months.map(() => 0);
    sums[index] = (sums[index] ?? 0) + payment.amount;
    byMonth.set(payment.chargeId, sums);
  }

  const nameOf = (charge: ReportCharge) => charge.name ?? charge.merchantName;
  const shown: { charge: ReportCharge; series: RecurringSeriesView }[] = [];
  for (const charge of rows.charges) {
    const sums = byMonth.get(charge.id);
    if (sums === undefined) continue;
    const total = sums.reduce((sum, cents) => sum + cents, 0);
    const series = {
      id: charge.id,
      name: nameOf(charge),
      merchantId: charge.merchantId,
      merchantName: charge.merchantName,
    };
    shown.push({ charge, series: { ...series, total, byMonth: sums } });
  }
  shown.sort(
    (a, b) =>
      b.series.total - a.series.total ||
      a.series.name.localeCompare(b.series.name, "en-US", { sensitivity: "base" }) ||
      a.charge.id.localeCompare(b.charge.id),
  );

  const totals = months.map(() => 0);
  const other = { count: 0, byMonth: months.map(() => 0) };
  shown.forEach(({ series }, place) => {
    series.byMonth.forEach((cents, index) => {
      totals[index] = (totals[index] ?? 0) + cents;
      if (place >= CHARGE_COUNT) other.byMonth[index] = (other.byMonth[index] ?? 0) + cents;
    });
  });
  other.count = Math.max(0, shown.length - CHARGE_COUNT);

  // Now is the charge's current amount, a Member's price change included; a year ago is its last
  // payment on or before the same day a year back.
  const changes: RecurringChangeView[] = shown.map(({ charge, series }) => {
    const now = charge.status === "ended" ? null : charge.latestAmount;
    const then = yearAgo.get(charge.id) ?? null;
    return {
      id: series.id,
      name: series.name,
      merchantName: series.merchantName,
      status: charge.status,
      now,
      yearAgo: then,
      change: now === null || then === null ? null : now - then,
    };
  });

  // One marker for each charge's price change in the range, in the month of its date. A Member's
  // change and one the checks found never share a day, but one marker a day is kept either way.
  const named = new Map(shown.map(({ series }) => [series.id, series]));
  const marked = new Set<string>();
  const priceChanges: RecurringPriceChangeView[] = [];
  for (const change of [...rows.priceChanges].sort(
    (a, b) => a.fromDate.localeCompare(b.fromDate) || Number(b.byHand) - Number(a.byHand),
  )) {
    const series = named.get(change.chargeId);
    const month = change.fromDate.slice(0, 7);
    const mark = `${change.chargeId} ${change.fromDate}`;
    if (series === undefined || !at.has(month) || marked.has(mark)) continue;
    marked.add(mark);
    const earlier = (paidBy.get(change.chargeId) ?? []).filter(
      (payment) => payment.postedDate < change.fromDate,
    );
    priceChanges.push({
      chargeId: change.chargeId,
      name: series.name,
      merchantName: series.merchantName,
      month,
      fromDate: change.fromDate,
      amount: change.amount,
      before: earlier.at(-1)?.amount ?? null,
    });
  }

  return {
    charges: shown.slice(0, CHARGE_COUNT).map(({ series }) => series),
    other,
    totals,
    priceChanges,
    changes,
  };
}
