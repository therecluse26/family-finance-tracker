import { CATEGORIES, type Category, categoryGroupOf, isCategory } from "../categories/index.ts";
import { type Database, listPostedParts, listSpendingTransactions } from "../db/index.ts";
import { type Merchant, sameMerchant } from "../merchants/index.ts";
import { type MonthTotals, monthOf, totalsByMonth } from "../money-movement/index.ts";
import {
  lastActiveDay,
  nextExpected,
  type RecurringCharge,
  recurringCharges,
} from "../recurring/index.ts";
import { householdDay } from "./first-draft.ts";
import { isLargePurchase, type Purchase, purchasesFrom } from "./large-purchase.ts";
import { listTrackedLoanPayments, type PostedPart, type TrackedLoanPayment } from "./loans.ts";
import { loanParts, monthAfter } from "./terms.ts";

// The projection of month-end Spending (spec 06, The projection): on day d of a month with D days,
// P = R_posted + R_due + O + F × D ÷ d.
// - R_posted: posted Spending that belongs to a Recurring charge or a tracked loan payment.
// - R_due: the Recurring charges and tracked loan payments still due this month, at their latest
//   amounts.
// - O: each Transaction that is a Large purchase, or 50% or more of the Category's Budget.
// - F: the rest of the month's Spending, net of Refunds and Reimbursements, never below $0.
// The Bills group does not extrapolate F. Interest and fees has no projection.

export type ProjectionTerms = { rPosted: number; rDue: number; oneOffs: number; rest: number };

// P in whole cents from the terms, on `day` of a month with `days` days. Without `extrapolate`,
// F counts as it is.
export function projectedSpending(
  terms: ProjectionTerms,
  day: number,
  days: number,
  extrapolate: boolean,
): number {
  const rest = extrapolate ? Math.round((terms.rest * days) / day) : terms.rest;
  return terms.rPosted + terms.rDue + terms.oneOffs + rest;
}

// The terms' F: the month's Spending less R_posted and O, never below $0.
const restOf = (spending: number, rPosted: number, oneOffs: number) =>
  Math.max(0, spending - rPosted - oneOffs);

// The parts that count as Spending: Spending, and the Refunds and Reimbursements that reduce it.
const SPENDING_TYPES = new Set(["Spending", "Refund", "Reimbursement"]);

const daysIn = (month: string) => {
  const [year = 0, number = 1] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number, 0)).getUTCDate();
};

// Where a month stands on `today`: d, D, and whether it is the current month. A past month is
// complete, d = D; a later month has not started, d = 0.
export function monthDay(
  month: string,
  today: string,
): { day: number; days: number; current: boolean } {
  const days = daysIn(month);
  const current = today.startsWith(month);
  if (current) return { day: Number(today.slice(8, 10)), days, current };
  return { day: month < today ? days : 0, days, current };
}

// The times a Recurring charge is still due in this month on `today`: each date expected after its
// last Transaction, up to the month's end, while it can still post within its margin.
function timesDue(charge: RecurringCharge, month: string, today: string): number {
  const last = charge.priceHistory.findLast((entry) => entry.date <= today);
  if (charge.status === "ended" || last === undefined) return 0;
  const after = `${monthAfter(month)}-01`;
  let due = 0;
  for (
    let previous = last.date, date = nextExpected(charge.schedule, previous);
    date < after;
    previous = date, date = nextExpected(charge.schedule, date)
  ) {
    if (lastActiveDay(charge.schedule, previous) < today) break;
    due += 1;
  }
  return due;
}

// Everything the projection reads, in a fixed number of reads.
type SpendingFacts = {
  today: string;
  posted: PostedPart[];
  charges: RecurringCharge[];
  loanPayments: TrackedLoanPayment[];
  // The Transactions of a Recurring charge or a tracked loan payment: R_posted's.
  recurringIds: Set<string>;
  merchants: Map<string, Merchant | null>;
  purchases: Purchase[];
};

// Each Transaction's Merchant is read only `withMerchants`.
async function readSpendingFacts(
  database: Database,
  now: Date,
  withMerchants = false,
): Promise<SpendingFacts> {
  const today = await householdDay(database, now);
  const posted = await listPostedParts(database);
  const charges = await recurringCharges(database, now);
  const loanPayments = await listTrackedLoanPayments(database, posted);
  const recurringIds = new Set(loanPayments.map((payment) => payment.transactionId));
  for (const charge of charges) {
    for (const { transactionId } of charge.priceHistory) recurringIds.add(transactionId);
  }
  // A loan payment the app cannot track: a LOAN_PAYMENTS_* code other than a card payment.
  const untrackedLoanIds = new Set<string>();
  const merchants = new Map<string, Merchant | null>();
  const loanPaymentsOnly = !withMerchants;
  for (const txn of await listSpendingTransactions(database, { loanPaymentsOnly })) {
    const code = txn.providerCategory;
    if (code?.startsWith("LOAN_PAYMENTS_") && code !== "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT") {
      untrackedLoanIds.add(txn.id);
    }
    merchants.set(
      txn.id,
      txn.merchantCleanName === null ? null : { id: txn.merchantId, name: txn.merchantCleanName },
    );
  }
  const purchases = purchasesFrom(posted, (id) => recurringIds.has(id) || untrackedLoanIds.has(id));
  return { today, posted, charges, loanPayments, recurringIds, merchants, purchases };
}

// The Large purchases among this month's purchases.
function largeIn(facts: SpendingFacts, month: string): Set<string> {
  const large = new Set<string>();
  for (const purchase of facts.purchases) {
    if (purchase.date.startsWith(month) && isLargePurchase(purchase, facts.purchases)) {
      large.add(purchase.transactionId);
    }
  }
  return large;
}

export type CategoryProjection = {
  // The month's Spending, net of Refunds and Reimbursements, as the Totals count it.
  spending: number;
  // P, or null for Interest and fees, and for a month that has not started.
  projected: number | null;
};

// Each Category's Spending and P in `month`, written YYYY-MM, on `now`'s day, Household time.
// `budgets` holds each monthly Budget, for O's 50% test.
export async function projectCategories(
  database: Database,
  month: string,
  budgets: ReadonlyMap<Category, number>,
  now = new Date(),
): Promise<{
  today: string;
  categories: Map<Category, CategoryProjection>;
  totals: MonthTotals[];
}> {
  const facts = await readSpendingFacts(database, now);
  const all = await totalsByMonth(database);
  const totals = all.find((each) => each.month === month);
  const { day, days, current } = monthDay(month, facts.today);
  const large = largeIn(facts, month);

  // Each Transaction's Spending in each Category this month.
  const spent = new Map<string, Map<Category, number>>();
  for (const part of facts.posted) {
    if (part.type !== "Spending" || part.category === null || !isCategory(part.category)) continue;
    if (monthOf(part) !== month) continue;
    const byCategory = spent.get(part.transactionId) ?? new Map<Category, number>();
    byCategory.set(part.category, (byCategory.get(part.category) ?? 0) - part.amount);
    spent.set(part.transactionId, byCategory);
  }
  const terms = new Map<Category, ProjectionTerms>(
    CATEGORIES.map(({ name }) => [name, { rPosted: 0, rDue: 0, oneOffs: 0, rest: 0 }]),
  );
  for (const [id, byCategory] of spent) {
    for (const [category, amount] of byCategory) {
      const term = terms.get(category);
      if (term === undefined) continue;
      const budget = budgets.get(category);
      if (facts.recurringIds.has(id)) term.rPosted += amount;
      else if (large.has(id) || (budget !== undefined && amount * 2 >= budget)) {
        term.oneOffs += amount;
      }
    }
  }
  // R_due: only the current month has a payment still due.
  if (current) {
    const loanIds = new Set(facts.loanPayments.map((payment) => payment.transactionId));
    for (const charge of facts.charges) {
      if (charge.category === null || !isCategory(charge.category)) continue;
      const last = charge.priceHistory.at(-1);
      // A Recurring charge on tracked loan payments counts through the loan's parts.
      if (last !== undefined && loanIds.has(last.transactionId)) continue;
      const term = terms.get(charge.category);
      if (term !== undefined)
        term.rDue += timesDue(charge, month, facts.today) * charge.latestAmount;
    }
    for (const part of loanParts(facts.loanPayments, month).due) {
      if (part.category === null || !isCategory(part.category)) continue;
      const term = terms.get(part.category);
      if (term !== undefined) term.rDue -= part.amount;
    }
  }

  const categories = new Map<Category, CategoryProjection>();
  for (const [category, term] of terms) {
    const spending = totals?.byCategory[category] ?? 0;
    term.rest = restOf(spending, term.rPosted, term.oneOffs);
    const projected =
      category === "Interest and fees" || day === 0
        ? null
        : projectedSpending(term, day, days, categoryGroupOf(category) !== "Bills");
    categories.set(category, { spending, projected });
  }
  return { today: facts.today, categories, totals: all };
}

// A Merchant's Spending and P in `month`, for a Goal: the same rule on that Merchant's Spending,
// with Large purchases as its only one-offs. A Refund or Reimbursement linked to its Spending
// counts at that Spending's Merchant.
export async function projectMerchant(
  database: Database,
  merchant: Merchant,
  month: string,
  now = new Date(),
): Promise<CategoryProjection> {
  const facts = await readSpendingFacts(database, now, true);
  const { day, days, current } = monthDay(month, facts.today);
  const large = largeIn(facts, month);
  const atMerchant = (id: string) => sameMerchant(facts.merchants.get(id) ?? null, merchant);

  let net = 0;
  const term: ProjectionTerms = { rPosted: 0, rDue: 0, oneOffs: 0, rest: 0 };
  for (const part of facts.posted) {
    if (!SPENDING_TYPES.has(part.type) || monthOf(part) !== month) continue;
    const id = part.spendingTransactionId ?? part.transactionId;
    if (!atMerchant(id)) continue;
    net -= part.amount;
    if (part.type !== "Spending") continue;
    if (facts.recurringIds.has(id)) term.rPosted -= part.amount;
    else if (large.has(id)) term.oneOffs -= part.amount;
  }
  if (current) {
    for (const charge of facts.charges) {
      if (sameMerchant(charge.merchant, merchant)) {
        term.rDue += timesDue(charge, month, facts.today) * charge.latestAmount;
      }
    }
    const payments = facts.loanPayments.filter((payment) => atMerchant(payment.transactionId));
    for (const part of loanParts(payments, month).due) term.rDue -= part.amount;
  }
  const spending = Math.max(0, net);
  term.rest = restOf(spending, term.rPosted, term.oneOffs);
  return { spending, projected: day === 0 ? null : projectedSpending(term, day, days, true) };
}
