import { type CategoryBenchmarks, categoryBenchmarks } from "../benchmarks/index.ts";
import { CATEGORIES, type Category, isCategory } from "../categories/index.ts";
import { type Database, listPostedParts, readHistoryStart } from "../db/index.ts";
import { monthOf } from "../money-movement/index.ts";
import {
  addMonths,
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

// The times an active Recurring charge is in m: once for each of its Transactions that posted in
// m, and once for each expected date in m after its last one. A date already paid by an earlier
// Transaction is not expected again. An expected date before m that is still due can only post in
// m, so it counts there, as a late one does.
export function chargeCountIn(charge: RecurringCharge, month: string): number {
  let count = charge.priceHistory.filter((entry) => entry.date.startsWith(month)).length;
  const after = `${monthAfter(month)}-01`;
  for (
    let date = charge.nextExpectedDate;
    date < after;
    date = nextExpected(charge.schedule, date)
  ) {
    count += 1;
  }
  return count;
}

// The Spending parts each tracked loan contributes to K in m: those of each payment in m, and
// those of its last payment again when its next payment, one month after the last, is in m. A
// Closed loan expects no payment.
export function loanPartsIn(
  payments: readonly TrackedLoanPayment[],
  month: string,
): { category: string | null; amount: number }[] {
  const byLoan = new Map<string, TrackedLoanPayment[]>();
  for (const payment of payments) {
    if (payment.closed) continue;
    byLoan.set(payment.loanId, [...(byLoan.get(payment.loanId) ?? []), payment]);
  }
  const parts: { category: string | null; amount: number }[] = [];
  for (const loanPayments of byLoan.values()) {
    for (const payment of loanPayments) {
      if (monthOf(payment) === month) parts.push(...payment.spending);
    }
    const last = loanPayments.at(-1);
    if (last !== undefined && addMonths(last.postedDate, 1).startsWith(month)) {
      parts.push(...last.spending);
    }
  }
  return parts;
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

// Every term the formulas need for m, written YYYY-MM.
export async function readDraftTerms(
  database: Database,
  month: string,
  now = new Date(),
): Promise<DraftTerms> {
  const window = new Set(historyWindow(month, await readHistoryStart(database)));
  const n = window.size;
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
  const soFar = { groceries: 0, superstores: 0 };
  const sums = new Map<Category, { all: number; other: number; flex: number }>();
  for (const part of posted) {
    if (!SPENDING_TYPES.has(part.type)) continue;
    if (part.category === null || !isCategory(part.category)) continue;
    // A linked Refund or Reimbursement already carries the Spending it reduces: its Category and
    // dates (spec 03, Which month a link changes).
    const spending = { ...part, id: part.spendingTransactionId ?? part.transactionId };
    const spent = -part.amount;
    if (part.category === "Groceries") soFar.groceries += spent;
    if (part.category === "Superstores") soFar.superstores += spent;
    if (!window.has(monthOf(spending))) continue;
    const sum = sums.get(part.category) ?? { all: 0, other: 0, flex: 0 };
    sum.all += spent;
    if (!chargeIds.has(spending.id) && !loanPaymentIds.has(spending.id)) sum.other += spent;
    if (!yearlyChargeIds.has(spending.id)) sum.flex += spent;
    sums.set(part.category, sum);
  }
  for (const [category, sum] of sums) {
    terms[category].spent = sum.all;
    if (n === 0) continue;
    terms[category].a = sum.all / n;
    terms[category].aOther = sum.other / n;
    terms[category].aFlex = sum.flex / n;
  }

  // K: each active Recurring charge at its latest amount, once for each time it is in m. A
  // Recurring charge on tracked loan payments counts through the loan's parts instead.
  for (const charge of charges) {
    if (charge.status !== "active" || charge.category === null || !isCategory(charge.category)) {
      continue;
    }
    const last = charge.priceHistory.at(-1);
    if (last !== undefined && loanPaymentIds.has(last.transactionId)) continue;
    const known = charge.latestAmount * chargeCountIn(charge, month);
    terms[charge.category].k += known;
    if (charge.schedule === "yearly") terms[charge.category].y += known;
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
    split:
      n === 0
        ? soFar
        : {
            groceries: terms.Groceries.spent,
            superstores: terms.Superstores.spent,
          },
    benchmarks: draftingBenchmarks(benchmarks),
  };
}
