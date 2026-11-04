import type { Category } from "../categories/index.ts";
import {
  addManualLoan as addStoredLoan,
  type Database,
  isOtherLinkRefused,
  type LoanType,
  listLoanLinkedTransactions,
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
};

// The loan type's Category, for a Purchase loan's principal (spec 03, Payments on a tracked loan).
const CATEGORIES: Record<ManualLoanType, Category> = {
  mortgage: "Housing",
  car: "Car",
  student: "Books and education",
  "buy now pay later": "General goods",
  personal: "Miscellaneous",
};

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
  payments: { postedDate: string }[];
};

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
        return {
          loan,
          loanType: loanTypeOf(loan, linked),
          payments: linked.filter((each) => each.amount < 0),
        };
      })();
      facts.set(loanId, found);
    }
    return found;
  };
}

// The interest in a payment on `date` (spec 02, Interest), in whole cents. A mortgage accrues
// balance × APR ÷ 12 for each payment. Every other type accrues balance × APR ÷ 365 for each day
// since the previous payment, or since the balance date for the first. The balance is the newest
// one a Member typed on or before the payment; a payment before every typed balance counts the
// days back to the first one.
export function manualLoanInterest(facts: ManualLoanFacts, date: string): number {
  const { balances, apr, subtype } = facts.loan;
  const typed = balances.filter((each) => each.date <= date).at(-1);
  const anchor = typed ?? balances[0];
  if (anchor === undefined) return 0;
  const owed = Math.abs(anchor.balance);
  if (subtype === "mortgage") return Math.round((owed * apr) / 100 / 12);
  const previous = facts.payments.filter((each) => each.postedDate < date).at(-1)?.postedDate;
  let from = anchor.date;
  if (previous !== undefined && (typed === undefined || previous > typed.date)) from = previous;
  const days = Math.abs(daysBetween(from, date));
  return Math.round(((owed * apr) / 100 / 365) * days);
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
  const payment = -txn.amount;
  const interest = Math.min(manualLoanInterest(facts, txn.postedDate), payment);
  const escrow =
    facts.loan.subtype === "mortgage" ? Math.min(facts.loan.escrow ?? 0, payment - interest) : 0;
  const principal = payment - interest - escrow;
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

type Payout = Awaited<ReturnType<typeof listUnlinkedLoanPayouts>>[number];

// The payout names the lender: its Merchant, its description, or a financial institution among
// its counterparties.
function namesLender(payout: Payout, lender: string): boolean {
  return (
    namesInstitutionIn(payout.merchantName ?? "", lender) ||
    namesInstitutionIn(payout.description, lender) ||
    payout.counterparties.some(
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
  };
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
// at each unlinked payout that names a Manual loan's lender.
async function decideLoanAgain(database: Database, loanId: string): Promise<void> {
  const ids = (await listLoanLinkedTransactions(database, [loanId])).map(
    (each) => each.transactionId,
  );
  for (const { payouts } of await payoutsToLink(database)) {
    ids.push(...payouts.map((payout) => payout.id));
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
