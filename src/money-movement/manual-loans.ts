import type { Category } from "../categories/index.ts";
import {
  addManualLoan as addStoredLoan,
  closeManualLoan,
  type Database,
  isOtherLinkRefused,
  type LoanType,
  listLoanLinkedTransactions,
  listLoanPaymentCandidates,
  listManualLoans,
  listUnlinkedLoanPayouts,
  type ManualLoanFields,
  type ManualLoanType,
  type StoredManualLoan,
  storeOtherLink,
  updateManualLoan,
} from "../db/index.ts";
import { followUpAgain } from "../follow-up/index.ts";
import { log } from "../log.ts";
import { daysBetween } from "./business-days.ts";
import { followUpSoon } from "./matching.ts";
import type { Decision, DecisionInput, Part } from "./order.ts";
import { namesInstitutionIn } from "./transfers.ts";

// Manual loans (spec 02, Manual loans): a loan a Member enters by hand. The app works out each
// payment's interest from the balance and the APR, and divides the payment into the parts of a
// tracked loan (spec 03, Payments on a tracked loan). Unless a Member chose Purchase loan, it looks
// for the payout and links it as a Transfer from the loan, which makes it a Cash loan. Finding
// payments and lowering the balance are T44's.

export type ManualLoanInput = {
  lender: string;
  kind: ManualLoanType;
  // What is owed, in whole cents, on the day a Member gives.
  balance: number;
  balanceDate: string;
  // A percent, such as 7.3.
  apr: number;
  regularPayment: number | null;
  // Mortgages only.
  escrow: number | null;
  // A Member's choice, or null to let the app decide.
  loanType: LoanType | null;
};

export type ManualLoan = Omit<ManualLoanInput, "loanType"> & {
  id: string;
  loanType: LoanType;
  setBy: "Member" | "app";
  // What is owed now: the newest typed balance, less the principal of each payment after its date.
  currentBalance: number;
  closed: boolean;
};

// The loan type's Category, for a Purchase loan's principal (spec 03, Payments on a tracked loan).
const CATEGORIES: Record<ManualLoanType, Category> = {
  mortgage: "Housing",
  car: "Car",
  student: "Books and education",
  "buy now pay later": "General goods",
  personal: "Miscellaneous",
};

// A linked payment or payout. A payment's amount is negative: money out of the Household.
type Linked = { transactionId: string; amount: number; postedDate: string };

// A Member's choice wins. Else a loan whose payout is linked is a Cash loan, and else a personal
// loan is a Cash loan and every other type a Purchase loan.
function loanTypeOf(loan: StoredManualLoan, linked: readonly Linked[]): LoanType {
  if (loan.loanType !== null) return loan.loanType;
  if (loan.subtype === "personal" || linked.some((each) => each.amount > 0)) return "cash loan";
  return "purchase loan";
}

// What the order reads of one Manual loan, once a run.
export type ManualLoanFacts = {
  loan: StoredManualLoan;
  loanType: LoanType;
  // Its linked payments, money out of the Household, oldest first.
  payments: Linked[];
  schedule: ManualLoanSchedule;
};

// How one payment divides, in whole cents (spec 02, Interest).
export type PaymentSplit = { interest: number; escrow: number; principal: number };

export type ManualLoanSchedule = {
  // Each linked payment's split, by its Transaction's ID.
  splits: Map<string, PaymentSplit>;
  // What is owed now, in whole cents, never below $0.
  balance: number;
};

// A payment divides from the balance owed before it. A mortgage accrues balance × APR ÷ 12 for
// each payment; every other type accrues balance × APR ÷ 365 for each day. The interest comes
// first, then a mortgage's escrow; the principal is the rest, and never below $0.
function rateOf(loan: StoredManualLoan, days: number): number {
  return loan.subtype === "mortgage" ? loan.apr / 100 / 12 : (loan.apr / 100 / 365) * days;
}

function splitPayment(
  loan: StoredManualLoan,
  owed: number,
  days: number,
  payment: number,
): PaymentSplit {
  const interest = Math.min(Math.round(owed * rateOf(loan, days)), payment);
  const escrow = loan.subtype === "mortgage" ? Math.min(loan.escrow ?? 0, payment - interest) : 0;
  return { interest, escrow, principal: payment - interest - escrow };
}

// Each linked payment's interest and principal, and the balance now (spec 02, Interest, Finding
// payments, Balance and payoff):
// - A payment after the first typed balance's date counts from the newest typed balance before
//   it, and lowers the balance by its principal. A newer typed balance starts the count again.
// - A payment on or before the first typed balance's date works backward from it: the balance
//   before it is the one after it, plus its principal. It never changes the balance now.
// - The days run from the previous payment, or from the balance date for the first payment.
export function manualLoanSchedule(
  loan: StoredManualLoan,
  linked: readonly Linked[],
): ManualLoanSchedule {
  const splits = new Map<string, PaymentSplit>();
  const typed = loan.balances.map((each) => ({ date: each.date, owed: Math.abs(each.balance) }));
  const first = typed[0];
  const newest = typed.at(-1);
  if (first === undefined || newest === undefined) return { splits, balance: 0 };
  const payments = linked
    .filter((each) => each.amount < 0)
    .sort(
      (a, b) =>
        a.postedDate.localeCompare(b.postedDate) || a.transactionId.localeCompare(b.transactionId),
    );
  const daysTo = (index: number, from: string) => {
    const payment = payments[index];
    if (payment === undefined) return 0;
    const previous = payments[index - 1]?.postedDate;
    const start = previous !== undefined && previous > from ? previous : from;
    return Math.abs(daysBetween(start, payment.postedDate));
  };
  const backward = payments.filter((each) => each.postedDate <= first.date).length;
  let after = first.owed;
  for (let index = backward - 1; index >= 0; index -= 1) {
    const payment = payments[index];
    if (payment === undefined) continue;
    const paid = -payment.amount;
    const days = index === 0 ? daysTo(index, first.date) : daysTo(index, "");
    const escrow = loan.subtype === "mortgage" ? Math.min(loan.escrow ?? 0, paid) : 0;
    const before = Math.max(after, Math.round((after + paid - escrow) / (1 + rateOf(loan, days))));
    splits.set(payment.transactionId, splitPayment(loan, before, days, paid));
    after = before;
  }
  let owed = first.owed;
  let anchor = first;
  for (let index = backward; index < payments.length; index += 1) {
    const payment = payments[index];
    if (payment === undefined) continue;
    const newer = typed.filter((each) => each.date < payment.postedDate).at(-1) ?? first;
    if (newer !== anchor) {
      anchor = newer;
      owed = newer.owed;
    }
    const split = splitPayment(loan, owed, daysTo(index, anchor.date), -payment.amount);
    splits.set(payment.transactionId, split);
    owed = Math.max(0, owed - split.principal);
  }
  const last = payments.at(-1);
  const balance = last !== undefined && last.postedDate > newest.date ? owed : newest.owed;
  return { splits, balance };
}

// The facts of each Manual loan a run reads, read once.
export function manualLoanFactsReader(
  database: Database,
): (loanId: string) => Promise<ManualLoanFacts | undefined> {
  const facts = new Map<string, Promise<ManualLoanFacts | undefined>>();
  return (loanId) => {
    let found = facts.get(loanId);
    if (found === undefined) {
      found = (async () => {
        const [loan] = await listManualLoans(database, [loanId]);
        if (loan === undefined) return undefined;
        const linked = await listLoanLinkedTransactions(database, [loanId]);
        const payments = linked.filter((each) => each.amount < 0);
        return {
          loan,
          loanType: loanTypeOf(loan, linked),
          payments,
          schedule: manualLoanSchedule(loan, payments),
        };
      })();
      facts.set(loanId, found);
    }
    return found;
  };
}

// A payment or payout linked to a Manual loan. A payout is a Transfer from the loan. A payment
// divides into interest, Spending in Interest and fees; escrow on a mortgage, Spending in Housing;
// and the principal, the rest and never below $0: a Transfer on a Cash loan, or Spending in the
// loan type's Category on a Purchase loan. A hand-set Category still wins over the named ones.
export async function manualLoanTreatment(txn: DecisionInput, loanId: string): Promise<Decision> {
  const transfer: Decision = { parts: [{ type: "Transfer", amount: txn.amount, category: null }] };
  if (txn.amount >= 0) return transfer;
  const facts = await txn.manualLoanFacts(loanId);
  if (facts === undefined) return transfer;
  // A payment the run linked after it read the loan counts with the loan's other payments.
  const { interest, escrow, principal } = facts.schedule.splits.get(txn.id) ??
    manualLoanSchedule(facts.loan, [
      ...facts.payments,
      { transactionId: txn.id, amount: txn.amount, postedDate: txn.postedDate },
    ]).splits.get(txn.id) ?? { interest: 0, escrow: 0, principal: -txn.amount };
  const parts: Part[] = [];
  const spending = (amount: number, category: Category): Part => ({
    type: "Spending",
    amount: -amount,
    category,
    keepsCategory: true,
  });
  if (interest > 0) parts.push(spending(interest, "Interest and fees"));
  if (escrow > 0) parts.push(spending(escrow, "Housing"));
  if (principal > 0 || parts.length === 0) {
    parts.push(
      facts.loanType === "cash loan"
        ? { type: "Transfer", amount: -principal, category: null }
        : spending(principal, CATEGORIES[facts.loan.subtype]),
    );
  }
  return { parts };
}

// A payout or a payment names the lender: its Merchant, its description, or a financial
// institution among its counterparties.
export function namesLender(
  txn: {
    description: string;
    merchantName: string | null;
    merchantCleanName?: string | null;
    counterparties: { name: string; type: string }[];
  },
  lender: string,
): boolean {
  return (
    namesInstitutionIn(txn.merchantCleanName ?? "", lender) ||
    namesInstitutionIn(txn.merchantName ?? "", lender) ||
    namesInstitutionIn(txn.description, lender) ||
    txn.counterparties.some(
      (party) => party.type === "financial_institution" && namesInstitutionIn(party.name, lender),
    )
  );
}

// The Manual loans with no payout linked yet, except one a Member made a Purchase loan, and the
// unlinked payouts that name each one's lender, on or before its newest typed balance. A loan whose
// type the app decides becomes a Cash loan once its payout links (spec 02, Manual loans).
async function payoutsToLink(database: Database) {
  const loans = await listManualLoans(database);
  if (loans.length === 0) return [];
  const linked = await listLoanLinkedTransactions(
    database,
    loans.map((loan) => loan.id),
  );
  const looking = loans.filter((loan) => {
    const own = linked.filter((each) => each.loanAccountId === loan.id);
    return loan.loanType !== "purchase loan" && !own.some((each) => each.amount > 0);
  });
  if (looking.length === 0) return [];
  const payouts = await listUnlinkedLoanPayouts(database);
  return looking.map((loan) => {
    const newest = loan.balances.at(-1)?.date ?? "";
    return {
      loan,
      payouts: payouts.filter(
        (payout) => payout.postedDate <= newest && namesLender(payout, loan.lender),
      ),
    };
  });
}

// Matching links each Manual loan's payout, among these Transactions, as a Transfer from the loan:
// the newest one that names the lender and that no Member refused. Returns what it linked.
export async function linkManualLoanPayouts(
  database: Database,
  among: readonly string[],
  now: Date,
): Promise<string[]> {
  if (among.length === 0) return [];
  const candidates = new Set(among);
  const made: string[] = [];
  for (const { loan, payouts } of await payoutsToLink(database)) {
    for (const payout of payouts.filter((each) => candidates.has(each.id)).reverse()) {
      const link = { kind: "loan" as const, transactionId: payout.id, loanAccountId: loan.id };
      if (await isOtherLinkRefused(database, link)) continue;
      const stored = await storeOtherLink(database, link, {
        tier: "Strong",
        signals: ["lender"],
        aiAnswer: null,
        aiConfidence: null,
        madeBy: "app",
        memberId: null,
        createdAt: now,
      });
      candidates.delete(payout.id);
      made.push(payout.id, ...stored.ended);
      break;
    }
  }
  return made;
}

function view(loan: StoredManualLoan, linked: readonly Linked[]): ManualLoan {
  const newest = loan.balances.at(-1);
  return {
    id: loan.id,
    lender: loan.lender,
    kind: loan.subtype,
    balance: Math.abs(newest?.balance ?? 0),
    balanceDate: newest?.date ?? "",
    apr: loan.apr,
    regularPayment: loan.regularPayment,
    escrow: loan.escrow,
    loanType: loanTypeOf(loan, linked),
    setBy: loan.loanType === null ? "app" : "Member",
    currentBalance: manualLoanSchedule(loan, linked).balance,
    closed: loan.closed,
  };
}

// Closes each of these Manual loans whose balance reached $0 (spec 02, Balance and payoff), unless
// it is Closed already. Returns the loans it closed.
export async function closePaidOffLoans(
  database: Database,
  loanIds: readonly string[],
  now: Date,
): Promise<string[]> {
  const loans = (await listManualLoans(database, [...new Set(loanIds)])).filter(
    (loan) => !loan.closed,
  );
  if (loans.length === 0) return [];
  const linked = await listLoanLinkedTransactions(
    database,
    loans.map((loan) => loan.id),
  );
  const closed: string[] = [];
  for (const loan of loans) {
    const own = linked.filter((each) => each.loanAccountId === loan.id);
    if (manualLoanSchedule(loan, own).balance > 0) continue;
    if (await closeManualLoan(database, loan.id, { reason: "paid off", at: now })) {
      closed.push(loan.id);
    }
  }
  if (closed.length > 0)
    log.info("Manual loans were paid off and closed", { count: closed.length });
  return closed;
}

export async function listManualLoanViews(
  database: Database,
  ids?: readonly string[],
): Promise<ManualLoan[]> {
  const loans = await listManualLoans(database, ids);
  const linked = await listLoanLinkedTransactions(
    database,
    loans.map((loan) => loan.id),
  );
  return loans.map((loan) =>
    view(
      loan,
      linked.filter((each) => each.loanAccountId === loan.id),
    ),
  );
}

const fieldsOf = (input: ManualLoanInput): ManualLoanFields => ({
  lender: input.lender,
  subtype: input.kind,
  apr: input.apr,
  regularPayment: input.regularPayment,
  escrow: input.kind === "mortgage" ? input.escrow : null,
  loanType: input.loanType,
});

const typedOf = (input: ManualLoanInput, memberId: string) => ({
  date: input.balanceDate,
  // Owed money is negative.
  balance: -input.balance,
  typedAt: new Date(),
  typedBy: memberId,
});

// After an add or an edit, the follow-up job decides the loan's linked payments again, and looks
// at each unlinked payout that names a Manual loan's lender, and at each unlinked payment that
// names this loan's, so Matching finds its payments in the history it has. A typed balance of $0
// closes the loan.
async function decideLoanAgain(database: Database, loanId: string): Promise<void> {
  await closePaidOffLoans(database, [loanId], new Date());
  const ids = (await listLoanLinkedTransactions(database, [loanId])).map(
    (each) => each.transactionId,
  );
  for (const { payouts } of await payoutsToLink(database)) {
    ids.push(...payouts.map((payout) => payout.id));
  }
  const [loan] = await listManualLoans(database, [loanId]);
  if (loan !== undefined) {
    for (const payment of await listLoanPaymentCandidates(database)) {
      if (namesLender(payment, loan.lender)) ids.push(payment.id);
    }
  }
  if (ids.length === 0) return;
  await followUpAgain(database, [...new Set(ids)]);
  await followUpSoon();
}

// Any Member adds a Manual loan at any time, with no payment linked.
export async function addManualLoan(
  database: Database,
  input: ManualLoanInput,
  memberId: string,
): Promise<ManualLoan> {
  const id = await addStoredLoan(database, fieldsOf(input), typedOf(input, memberId));
  await decideLoanAgain(database, id);
  log.info("A Member added a Manual loan", { kind: input.kind });
  const [added] = await listManualLoanViews(database, [id]);
  if (added === undefined) throw new Error("The new Manual loan was not saved.");
  return added;
}

// Undefined when no Manual loan has the ID. The balance is saved with its date; one on the same
// day replaces that day's.
export async function editManualLoan(
  database: Database,
  id: string,
  input: ManualLoanInput,
  memberId: string,
): Promise<ManualLoan | undefined> {
  if (!(await updateManualLoan(database, id, fieldsOf(input), typedOf(input, memberId)))) {
    return undefined;
  }
  await decideLoanAgain(database, id);
  log.info("A Member edited a Manual loan", { kind: input.kind });
  const [edited] = await listManualLoanViews(database, [id]);
  return edited;
}
