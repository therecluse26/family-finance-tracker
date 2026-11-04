import type { Category } from "../categories/index.ts";
import {
  type Database,
  type DecisionAccount,
  type LoanHistory,
  type LoanPayouts,
  type LoanType,
  listDecisionAccounts,
  listLoanPayouts,
  readLoanHistory,
} from "../db/index.ts";
import { daysBetween } from "./business-days.ts";
import type { Decision, DecisionInput, Part } from "./order.ts";
import { namesInstitutionIn, namesMask } from "./transfers.ts";

// Connected loans: their type, the interest in each payment, and how a payment and a payout count
// (spec 02, Connected loans; spec 03, Loans).

// A loan that syncs: an Account of Plaid type `loan`. A loan is never an Unconnected account.
export function isLoan(account: DecisionAccount | undefined): boolean {
  return account?.connected === true && account.kind === "loan";
}

// What the order reads of one loan, once a run.
export type LoanFacts = LoanHistory & {
  loanType: LoanType;
  // The loan type's Category, for a Purchase loan's principal.
  category: Category;
  mortgage: boolean;
  // The interest share (interest ÷ payment) of the first payment the app measured from saved
  // data, or undefined until it has measured one.
  firstShare: number | undefined;
};

// The loan type's Category (spec 03, Payments on a tracked loan).
const CATEGORIES: Record<string, Category> = {
  mortgage: "Housing",
  auto: "Car",
  student: "Books and education",
  "buy now pay later": "General goods",
};

// The app sees a loan's payout land in an Account: the loan is the money-out side of a Transfer
// pair into it, or a LOAN_DISBURSEMENTS_* line names the loan by its last 4 digits or its lender.
function payoutSeen(loan: DecisionAccount, payouts: LoanPayouts): boolean {
  if (payouts.pairedLoanIds.includes(loan.id)) return true;
  return payouts.disbursements.some(
    (line) =>
      namesMask(line.description, loan.mask) ||
      namesInstitutionIn(line.description, loan.institutionName) ||
      line.counterparties.some(
        (party) =>
          party.type === "financial_institution" &&
          namesInstitutionIn(party.name, loan.institutionName),
      ),
  );
}

// A Member's choice wins. Else a loan whose payout the app saw is a Cash loan, and else the
// subtype decides: `personal` is a Cash loan, and every other subtype a Purchase loan.
function loanTypeOf(loan: DecisionAccount, payouts: LoanPayouts): LoanType {
  if (loan.loanType !== null) return loan.loanType;
  if (loan.subtype === "personal" || payoutSeen(loan, payouts)) return "cash loan";
  return "purchase loan";
}

// The balances on each side of a payment: the last sync before its day, and the first after.
function around(history: LoanHistory, date: string) {
  let before: LoanHistory["balances"][number] | undefined;
  let after: LoanHistory["balances"][number] | undefined;
  for (const row of history.balances) {
    if (row.date < date) before = row;
    else if (row.date > date && after === undefined) after = row;
  }
  return { before, after };
}

const clamp = (interest: number, payment: number) =>
  Math.min(Math.max(Math.round(interest), 0), payment);

// The interest the saved data shows for a payment: first the rise in interest paid this year, or
// the new value when it fell, as when a year starts; else the payment minus the drop in what is
// owed. Undefined when no sync before or after the payment has the data.
function measured(history: LoanHistory, date: string, payment: number): number | undefined {
  const { before, after } = around(history, date);
  if (before === undefined || after === undefined) return undefined;
  const [was, now] = [before.interestPaidThisYear, after.interestPaidThisYear];
  if (was !== null && now !== null) return clamp(now >= was ? now - was : now, payment);
  const owedBefore = before.currentBalance;
  if (owedBefore === null) return undefined;
  // The lender's balance may lag the payment, so the drop counts from the first saved balance
  // after it that moved, before the next payment. Until one has, nothing is measured.
  const next = history.payments.find((each) => each.postedDate > date)?.postedDate;
  const moved = history.balances.find(
    (row) =>
      row.date > date &&
      (next === undefined || row.date < next) &&
      row.currentBalance !== null &&
      row.currentBalance !== owedBefore,
  )?.currentBalance;
  if (moved === undefined || moved === null) return undefined;
  // Owed money is negative, so a payment raises the balance by its principal.
  return clamp(payment - (moved - owedBefore), payment);
}

export async function readLoanFacts(
  database: Database,
  loan: DecisionAccount,
  payouts: LoanPayouts,
): Promise<LoanFacts> {
  const history = await readLoanHistory(database, loan.id);
  let firstShare: number | undefined;
  for (const payment of history.payments) {
    const interest = measured(history, payment.postedDate, payment.amount);
    if (interest === undefined) continue;
    firstShare = interest / payment.amount;
    break;
  }
  return {
    ...history,
    loanType: loanTypeOf(loan, payouts),
    category: CATEGORIES[loan.subtype ?? ""] ?? "Miscellaneous",
    mortgage: loan.subtype === "mortgage",
    firstShare,
  };
}

// The facts of each loan a run reads, read once, with the Household's payouts read once.
export function loanFactsReader(
  database: Database,
  accounts: ReadonlyMap<string, DecisionAccount>,
): (loanId: string) => Promise<LoanFacts> {
  let payouts: Promise<LoanPayouts> | undefined;
  const facts = new Map<string, Promise<LoanFacts>>();
  return (loanId) => {
    const loan = accounts.get(loanId);
    if (loan === undefined) throw new Error("The loan is not one of the Household's Accounts.");
    let found = facts.get(loanId);
    if (found === undefined) {
      payouts ??= listLoanPayouts(database);
      found = payouts.then((seen) => readLoanFacts(database, loan, seen));
      facts.set(loanId, found);
    }
    return found;
  };
}

// How long a payment's interest waits for the data to measure it.
export const PROVISIONAL_INTEREST_DAYS = 45;

// The interest in a payment that landed on the loan on `date` (spec 02, Connected loans), first
// from the rise in interest paid this year, then from an APR a Member typed, then from the drop in
// what is owed. It is provisional while the sync after the payment has not run, while the lender's
// balance has not moved, and while a payment from before the first saved balance has no measured
// share to use. Once the next payment has landed, or 45 days have passed (from the first saved
// balance, for a payment before it), the wait ends: the interest is decided once from the best
// data, the share of the first measured payment or else none, and is not decided again each day.
function interestIn(
  facts: LoanFacts,
  apr: number | null,
  payment: { date: string; amount: number },
  today: string,
): { interest: number; provisional: boolean } {
  const { before, after } = around(facts, payment.date);
  const known = (interest: number) => ({
    interest: clamp(interest, payment.amount),
    provisional: false,
  });
  const hasYtd = before?.interestPaidThisYear != null && after?.interestPaidThisYear != null;
  if (hasYtd) return known(measured(facts, payment.date, payment.amount) ?? 0);
  if (apr !== null) {
    // As for a Manual loan: on what was owed before the payment, monthly for a mortgage, else
    // daily from the previous payment, or from the balance date for the first.
    const owed = Math.abs(before?.currentBalance ?? facts.balances[0]?.currentBalance ?? 0);
    if (facts.mortgage) return known((owed * apr) / 100 / 12);
    const previous = facts.payments.filter((each) => each.postedDate < payment.date).at(-1);
    const from = previous?.postedDate ?? before?.date;
    const days = from === undefined ? 30 : daysBetween(from, payment.date);
    return known(((owed * apr) / 100 / 365) * days);
  }
  const drop = measured(facts, payment.date, payment.amount);
  if (drop !== undefined) return known(drop);
  // Before the first saved balance, the share of the first payment the app measured.
  if (before === undefined && facts.firstShare !== undefined) {
    return known(facts.firstShare * payment.amount);
  }
  // A payment from before the first saved balance waits for a later payment to be measured, so its
  // days count from that balance, and the next payment does not end its wait.
  const firstSaved = facts.balances[0]?.date;
  const early = before === undefined && firstSaved !== undefined && firstSaved > payment.date;
  const nextLanded = !early && facts.payments.some((each) => each.postedDate > payment.date);
  const from = early ? firstSaved : payment.date;
  const waited = daysBetween(from, today) > PROVISIONAL_INTEREST_DAYS;
  return {
    interest: clamp((facts.firstShare ?? 0) * payment.amount, payment.amount),
    provisional: !nextLanded && !waited,
  };
}

// A payment's parts, with the paying side's sign: interest, Spending in Interest and fees; the
// principal, a Transfer on a Cash loan or Spending in the loan's Category on a Purchase loan. A
// hand-set Category still wins over the named ones.
async function paymentParts(
  txn: DecisionInput,
  loanId: string,
  payment: { date: string; amount: number },
): Promise<Decision> {
  const loan = txn.accounts.get(loanId);
  const facts = await txn.loanFacts(loanId);
  const { interest, provisional } = interestIn(facts, loan?.memberApr ?? null, payment, txn.today);
  const principal = payment.amount - interest;
  const parts: Part[] = [];
  if (interest > 0) {
    parts.push({
      type: "Spending",
      amount: -interest,
      category: "Interest and fees",
      keepsCategory: true,
    });
  }
  if (principal > 0 || parts.length === 0) {
    parts.push(
      facts.loanType === "cash loan"
        ? { type: "Transfer", amount: -principal, category: null }
        : { type: "Spending", amount: -principal, category: facts.category, keepsCategory: true },
    );
  }
  return { parts, ...(provisional ? { provisionalUntil: txn.today } : {}) };
}

// One side of a Transfer pair with a loan on the other side. The paying side takes the payment's
// parts, dated by the day it landed on the loan. A payout from the loan is a Transfer.
export async function loanPairTreatment(
  txn: DecisionInput,
  loanId: string,
  landed: string,
): Promise<Decision> {
  if (txn.amount >= 0) return { parts: [{ type: "Transfer", amount: txn.amount, category: null }] };
  return paymentParts(txn, loanId, { date: landed, amount: -txn.amount });
}

// A payment on the loan that no Household Account sent: its parts go on the loan's own
// Transaction, with the paying side's sign.
export async function paidFromOutside(txn: DecisionInput): Promise<Decision> {
  const decision = await paymentParts(txn, txn.accountId, {
    date: txn.postedDate,
    amount: txn.amount,
  });
  return { ...decision, paidFromOutside: true };
}

// Step 6.2: money in under a LOAN_DISBURSEMENTS_* code is a loan payout, a Transfer from the loan.
// It is never Income.
export function loanPayout(txn: DecisionInput): Decision | undefined {
  return txn.providerCategory?.startsWith("LOAN_DISBURSEMENTS_") === true
    ? { parts: [{ type: "Transfer", amount: txn.amount, category: null }] }
    : undefined;
}

// A connected loan's type as it counts, who set it, and the APR a Member typed (spec 02, Account
// fields).
export type LoanSettings = {
  accountId: string;
  loanType: LoanType;
  setBy: "Member" | "app";
  // A percent, such as 6.5, or null.
  apr: number | null;
};

// Undefined when no connected loan has the ID.
export async function readLoanSettings(
  database: Database,
  accountId: string,
): Promise<LoanSettings | undefined> {
  const loan = (await listDecisionAccounts(database)).find((account) => account.id === accountId);
  if (loan === undefined || !isLoan(loan)) return undefined;
  return {
    accountId,
    loanType: loanTypeOf(loan, await listLoanPayouts(database)),
    setBy: loan.loanType === null ? "app" : "Member",
    apr: loan.memberApr,
  };
}
