import { type CategoryBenchmarks, categoryBenchmarks } from "../benchmarks/index.ts";
import { CATEGORIES, type Category, isCategory } from "../categories/index.ts";
import { type Database, listPostedParts, readHistoryStart } from "../db/index.ts";
import { calendarDateIn } from "../format.ts";
import { householdTimeZone } from "../household/index.ts";
import { monthOf } from "../money-movement/index.ts";
import {
  addDays,
  addMonths,
  daysBetween,
  lastActiveDay,
  nextExpected,
  type RecurringCharge,
  recurringCharges,
  steadyIncome,
} from "../recurring/index.ts";
import type { CategoryTerms, DraftTerms } from "./formulas.ts";
import { listTrackedLoanPayments, type TrackedLoanPayment } from "./loans.ts";

// The formula terms for a month m (spec 05, Formula terms), read from app.db in a fixed number of
// reads, whatever the history's size.

// The history window holds at most this many months.
const WINDOW_MONTHS = 12;

// With n = 0, the days of history are never fewer than this many (spec 05, Formula terms).
const MIN_HISTORY_DAYS = 7;

// The month `months` months after `month`, both written YYYY-MM.
export const monthAfter = (month: string, months = 1) =>
  addMonths(`${month}-01`, months).slice(0, 7);

// The history window for m: the last 12 complete calendar months before m. History starts at the
// earliest posted Transaction, so the month it starts in is complete only when it starts on the
// 1st. Oldest first, and empty with no history.
export function historyWindow(month: string, historyStart: string | undefined): string[] {
  if (historyStart === undefined) return [];
  const firstComplete = historyStart.endsWith("-01")
    ? historyStart.slice(0, 7)
    : monthAfter(historyStart.slice(0, 7));
  const window: string[] = [];
  for (let back = WINDOW_MONTHS; back >= 1; back -= 1) {
    const each = monthAfter(month, -back);
    if (each >= firstComplete) window.push(each);
  }
  return window;
}

// The days in a month written YYYY-MM.
const daysIn = (month: string) => Number(addDays(addMonths(`${month}-01`, 1), -1).slice(8, 10));

// The day before a date written YYYY-MM-DD.
function dayBefore(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

// A Recurring charge as K counts it in m (spec 05, Formula terms; Bills group): as it stood when
// m's figure was set, so the figure stays put as the month's Transactions post. Its amount is its
// latest one on `pricedOn`: the day before the 1st, so a new amount reaches the Budget from the
// next month. It counts when it was active on the 1st, or, for a later month, is active today.
// Undefined when it does not count.
export function chargeInMonth(
  charge: RecurringCharge,
  month: string,
  today: string,
  pricedOn = dayBefore(`${month}-01`),
): { amount: number; count: number } | undefined {
  if (charge.status === "ended") return undefined;
  const start = `${month}-01`;
  const last = charge.priceHistory.findLast((entry) => entry.date < start);
  const priced = charge.priceHistory.findLast((entry) => entry.date <= pricedOn) ?? last;
  if (last === undefined || priced === undefined) return undefined;
  const asOf = today < start ? today : start;
  if (asOf > lastActiveDay(charge.schedule, last.date)) return undefined;
  return { amount: priced.amount, count: chargeCountIn(charge, month, last.date) };
}

// The times a Recurring charge is in m, from `last`, its last Transaction before m: once for each
// date expected in m, and once more for each early one that posted in m though it was expected
// in the next month. A date expected before m that can still post within its margin counts in m,
// as a late one does. A date already paid by an earlier Transaction is not expected again, and a
// later month never counts the dates of the months between.
function chargeCountIn(charge: RecurringCharge, month: string, last: string): number {
  const start = `${month}-01`;
  const after = `${monthAfter(month)}-01`;
  let expected = 0;
  for (
    let previous = last, date = nextExpected(charge.schedule, last);
    date < after;
    previous = date, date = nextExpected(charge.schedule, date)
  ) {
    if (date >= start || lastActiveDay(charge.schedule, previous) >= start) expected += 1;
  }
  const posted = charge.priceHistory.filter((entry) => entry.date.startsWith(month)).length;
  return Math.max(expected, posted);
}

type LoanPart = { category: string | null; amount: number };

// The Spending parts each tracked loan contributes to K in m: those of each payment in m, and
// those of its last payment again when its next payment, one month after the last, is in m. A
// Closed loan expects no payment. A payment whose parts are not known, because its paying side is
// hidden while its Transfer pair is still live, takes those of the loan's last payment before it
// whose parts are known.
export function loanPartsIn(payments: readonly TrackedLoanPayment[], month: string): LoanPart[] {
  const { posted, due } = loanParts(payments, month);
  return [...posted, ...due];
}

// loanPartsIn's parts apart: those of the payments in m, and those of the next payment still due
// in m.
export function loanParts(
  payments: readonly TrackedLoanPayment[],
  month: string,
): { posted: LoanPart[]; due: LoanPart[] } {
  const byLoan = new Map<string, TrackedLoanPayment[]>();
  for (const payment of payments) {
    if (payment.closed) continue;
    byLoan.set(payment.loanId, [...(byLoan.get(payment.loanId) ?? []), payment]);
  }
  const parts: LoanPart[] = [];
  const due: LoanPart[] = [];
  for (const loanPayments of byLoan.values()) {
    let known: TrackedLoanPayment["spending"] = [];
    const spendingOf = (payment: TrackedLoanPayment) => {
      if (payment.partsKnown) known = payment.spending;
      return known;
    };
    for (const payment of loanPayments) {
      const spending = spendingOf(payment);
      if (monthOf(payment) === month) parts.push(...spending);
    }
    const last = loanPayments.at(-1);
    if (last !== undefined && addMonths(last.postedDate, 1).startsWith(month)) {
      due.push(...known);
    }
  }
  return { posted: parts, due };
}

// The parts that count as Spending: Spending, and the Refunds and Reimbursements that reduce it.
const SPENDING_TYPES = new Set(["Spending", "Refund", "Reimbursement"]);

const emptyTerms = (): CategoryTerms => ({
  spent: 0,
  a: 0,
  aOther: 0,
  aFlex: 0,
  k: 0,
  y: 0,
  kLoans: 0,
  yearlyCharges: 0,
});

// B(c) for each Category whose Benchmark drafts its Budget.
function draftingBenchmarks(
  computed: CategoryBenchmarks | undefined,
): Partial<Record<Category, number | null>> {
  const found: Partial<Record<Category, number | null>> = {};
  for (const { category, role, amount } of computed?.categories ?? []) {
    if (role === "drafts" || role === "drafts shared") found[category] = amount;
  }
  return found;
}

// Every term the formulas need for m, written YYYY-MM. K takes each Recurring charge's latest
// amount on `pricedOn`, written YYYY-MM-DD: by default the day before the 1st of m. The first draft
// takes the amounts of the day it runs. With n = 0, the Spending loaded so far stands as of that
// day too.
export async function readDraftTerms(
  database: Database,
  month: string,
  now = new Date(),
  pricedOn?: string,
): Promise<DraftTerms> {
  const today = calendarDateIn(now, (await householdTimeZone(database)) ?? "UTC");
  const historyStart = await readHistoryStart(database);
  const window = new Set(historyWindow(month, historyStart));
  const n = window.size;
  // A(c), A_other(c), and A_flex(c) from a sum: ÷ n. With n = 0, the sum is all Spending loaded so
  // far, scaled to a month: × the days in m ÷ the days of history, from its start to the day the
  // app computes, both days counted, and at least 7 (spec 05, Formula terms). That day is the one
  // m's figure is set on, `pricedOn` or the day before the 1st, so the figure stays put as m's
  // Transactions post, as K does.
  const asOf = pricedOn ?? dayBefore(`${month}-01`);
  const historyDays = Math.max(MIN_HISTORY_DAYS, daysBetween(historyStart ?? asOf, asOf) + 1);
  const perMonth = (sum: number) => (n === 0 ? (sum * daysIn(month)) / historyDays : sum / n);
  const charges = await recurringCharges(database, now);
  const posted = await listPostedParts(database);
  const loanPayments = await listTrackedLoanPayments(database, posted);
  const loanPaymentIds = new Set(loanPayments.map((payment) => payment.transactionId));
  // A_other leaves out every Recurring charge, active or not. A_flex leaves out yearly ones.
  const chargeIds = new Set<string>();
  const yearlyChargeIds = new Set<string>();
  for (const charge of charges) {
    for (const { transactionId } of charge.priceHistory) {
      chargeIds.add(transactionId);
      if (charge.schedule === "yearly") yearlyChargeIds.add(transactionId);
    }
  }

  const terms = Object.fromEntries(CATEGORIES.map(({ name }) => [name, emptyTerms()])) as Record<
    Category,
    CategoryTerms
  >;
  const sums = new Map<Category, { all: number; other: number; flex: number }>();
  for (const part of posted) {
    if (!SPENDING_TYPES.has(part.type)) continue;
    if (part.category === null || !isCategory(part.category)) continue;
    // A linked Refund or Reimbursement already carries the Spending it reduces: its Category and
    // dates (spec 03, Which month a link changes).
    const spending = { ...part, id: part.spendingTransactionId ?? part.transactionId };
    const spent = -part.amount;
    if (n === 0 ? spending.postedDate > asOf : !window.has(monthOf(spending))) continue;
    const sum = sums.get(part.category) ?? { all: 0, other: 0, flex: 0 };
    sum.all += spent;
    if (!chargeIds.has(spending.id) && !loanPaymentIds.has(spending.id)) sum.other += spent;
    if (!yearlyChargeIds.has(spending.id)) sum.flex += spent;
    sums.set(part.category, sum);
  }
  for (const [category, sum] of sums) {
    terms[category].spent = sum.all;
    terms[category].a = perMonth(sum.all);
    terms[category].aOther = perMonth(sum.other);
    terms[category].aFlex = perMonth(sum.flex);
  }

  // K: each active Recurring charge at its latest amount, once for each time it is in m, as it
  // stood on the 1st. A Recurring charge on tracked loan payments counts through the loan's parts
  // instead.
  for (const charge of charges) {
    if (charge.category === null || !isCategory(charge.category)) continue;
    const last = charge.priceHistory.at(-1);
    if (last !== undefined && loanPaymentIds.has(last.transactionId)) continue;
    const counted = chargeInMonth(charge, month, today, pricedOn);
    if (counted === undefined) continue;
    const known = counted.amount * counted.count;
    terms[charge.category].k += known;
    if (charge.schedule === "yearly") {
      terms[charge.category].y += known;
      terms[charge.category].yearlyCharges += counted.amount;
    }
  }
  // K: each Spending part of each tracked loan payment in m.
  for (const part of loanPartsIn(loanPayments, month)) {
    if (part.category === null || !isCategory(part.category)) continue;
    terms[part.category].k -= part.amount;
    terms[part.category].kLoans -= part.amount;
  }

  const benchmarks = await categoryBenchmarks(database, now);
  return {
    n,
    income: benchmarks?.income ?? (await steadyIncome(database, now)).amount,
    categories: terms,
    split: { groceries: terms.Groceries.spent, superstores: terms.Superstores.spent },
    benchmarks: draftingBenchmarks(benchmarks),
  };
}
