import type { Category } from "../categories/index.ts";
import type { DecisionAccount, DecisionRecord, LoanPayouts } from "../db/index.ts";
import { cardPayment, cardPaymentReceived, cardRewards } from "./card-payments.ts";
import { type LoanFacts, loanPayout } from "./loans.ts";
import { type ManualLoanFacts, manualLoanTreatment } from "./manual-loans.ts";
import { oneSidedTransfer } from "./one-sided.ts";
import { accountsTreatment, isExcluded, pairTreatment } from "./pairs.ts";
import {
  cashWithdrawal,
  moneyFromPerson,
  paymentToPerson,
  zelleWithMember,
} from "./payment-apps.ts";
import { linkedTreatment, refundLink, unlinkedRefund } from "./refunds.ts";
import { withSplit } from "./splits.ts";
import { HAND_SET_TYPES, type HandSetType, type TransactionType } from "./types.ts";
import { type ManualLoanOffer, untrackedLoanPayment } from "./untracked-loans.ts";

// The order of decisions (spec 03, Order of decisions): each Transaction's type comes from an
// ordered list of steps, and the first step that fits wins. Steps 1 to 4 apply to every
// Transaction, steps 5.1 to 5.7 to money out, and steps 6.1 to 6.9 to money in. Every step is
// built in.

export const DECISION_STEPS = [
  { step: "1", name: "a type a Member set by hand" },
  { step: "2", name: "a link a Member made by hand" },
  { step: "3", name: "Transfer pairing" },
  { step: "4", name: "a link to a Manual loan" },
  { step: "5.1", name: "a card payment with no pair" },
  { step: "5.2", name: "a loan payment with no pair" },
  { step: "5.3", name: "a cash withdrawal" },
  { step: "5.4", name: "Zelle to a Member's own name" },
  { step: "5.5", name: "a payment to a person" },
  { step: "5.6", name: "transfer wording or a Plaid transfer category, money out" },
  { step: "5.7", name: "Spending" },
  { step: "6.1", name: "card rewards" },
  { step: "6.2", name: "a loan payout" },
  { step: "6.3", name: "Zelle from a Member's own name" },
  { step: "6.4", name: "a Refund link" },
  { step: "6.5", name: "money from a person" },
  { step: "6.6", name: "a payment on a card with no pair" },
  { step: "6.7", name: "transfer wording or a Plaid transfer category, money in" },
  { step: "6.8", name: "an unlinked Refund" },
  { step: "6.9", name: "Income" },
] as const;

export type DecisionStep = (typeof DECISION_STEPS)[number]["step"];

// One part of a Transaction. Amounts have the Transaction's sign: money into the Account is
// positive. Only Spending, Refunds, and Reimbursements have a Category. A Spending part has none
// until the categorization step picks one, unless a Money movement rule names it, such as Cash; a
// hand-set Category or a Category rule still wins over a named one. A part of a tracked loan
// payment sets `keepsCategory`: only a hand edit changes its Category (spec 04, Categories that
// Money movement names). The part of a Refund or Reimbursement that its link reduces sets `linked`:
// it has no Category of its own, and counts with its Spending's Category and month (spec 03, Which
// month a link changes).
export type Part = {
  type: TransactionType;
  amount: number;
  category: Category | null;
  keepsCategory?: boolean;
  linked?: boolean;
  // A part of a split a Member made (spec 04, Splits): its Category is hand-set, so the cascade
  // never changes it.
  categorySource?: "hand-set";
  categoryConfidence?: "certain";
};

// A rule's answer. The parts add up to the Transaction's amount. A one-sided result may be
// provisional to the end of a day, the last day of its window; a daily task decides it again
// once that day has passed.
// - `unconnectedAccountId` assigns the Transaction to an Unconnected account, or to a synced
//   investment Account, which moves its balance estimate (spec 03, Unconnected accounts).
// - `asks` puts a one-sided Transfer on the Review list, with what the app decided and its best
//   answer.
// - `paidFromOutside` marks a payment on a tracked loan that no Household Account sent. Its parts
//   sit on the loan's own Transaction with the paying side's sign, so they add up to minus the
//   Transaction's amount: money into the loan is money out of the Household (spec 03, Payments on
//   a tracked loan).
export type Decision = {
  parts: Part[];
  provisionalUntil?: string;
  unconnectedAccountId?: string;
  asks?: { decided: string; bestAnswer: { value: string; label: string } };
  paidFromOutside?: boolean;
  // An untracked loan whose payout the app saw: the Review list offers to add it as a Manual loan.
  offersManualLoan?: ManualLoanOffer;
};

// What a rule reads besides the Transaction: the Household's date and time zone, its Accounts by
// ID, its Members' names, and the facts of a connected loan or a Manual loan, read once a run when
// a rule first needs them.
export type DecisionContext = {
  today: string;
  timeZone: string;
  accounts: ReadonlyMap<string, DecisionAccount>;
  members: readonly string[];
  loanFacts(loanId: string): Promise<LoanFacts>;
  // Undefined when no Manual loan has the ID.
  manualLoanFacts(loanId: string): Promise<ManualLoanFacts | undefined>;
  // The loan payouts the app has seen land in an Account.
  loanPayouts(): Promise<LoanPayouts>;
  // Money out on the paying side of an Unclear pair with a connected loan, open on the Review list.
  unclearLoanPayments: ReadonlySet<string>;
  // How much each linked Refund or Reimbursement among the Transactions decided reduces its
  // Spending, by the money in's ID (spec 03, Link shapes).
  spendingAllocations: ReadonlyMap<string, number>;
};

// What a rule reads: the Transaction, and its context.
export type DecisionInput = Omit<DecisionRecord, "hidden"> & DecisionContext;

// A rule fits when it gives a Decision, and does not fit when it gives undefined.
export type DecisionRule = (
  txn: DecisionInput,
) => Decision | undefined | Promise<Decision | undefined>;

// The whole Transaction as one part.
export function whole(txn: { amount: number }, type: TransactionType): Decision {
  return { parts: [{ type, amount: txn.amount, category: null }] };
}

export function isHandSetType(value: unknown): value is HandSetType {
  return HAND_SET_TYPES.includes(value as HandSetType);
}

// An excluded Account's own Transactions count nowhere (spec 02, Exclude), so steps 1 and 2 pass
// them to step 3. The app keeps them, and their hand-set fields count again once the switch is
// off.
const ownExcluded = (txn: DecisionInput) => isExcluded(txn.accounts.get(txn.accountId));

// Step 1. The type is in the Transaction's hand-set fields, which a sync never writes.
const handSetType: DecisionRule = (txn) =>
  isHandSetType(txn.handSet.type) && !ownExcluded(txn) ? whole(txn, txn.handSet.type) : undefined;

// A payment or payout linked to a Manual loan: a payout is a Transfer from the loan, and a payment
// divides into the parts of a tracked loan (spec 03, Payments on a tracked loan).
const loanLinkTreatment = (txn: DecisionInput, loanId: string): Promise<Decision> =>
  manualLoanTreatment(txn, loanId);

// Step 2. A Transfer, Manual loan, Refund, or Reimbursement link a Member made by hand. The
// Accounts on a Transfer's two sides decide how it counts. A Refund or Reimbursement reduces its
// Spending, down to $0. A Transaction on an excluded Account goes on to step 3.
const handLink: DecisionRule = (txn) => {
  if (ownExcluded(txn)) return undefined;
  if (txn.transferLink === "Member") return pairTreatment(txn);
  if (txn.loanLink?.madeBy === "Member") return loanLinkTreatment(txn, txn.loanLink.loanAccountId);
  if (txn.spendingLink?.madeBy === "Member" && txn.amount > 0) {
    return linkedTreatment(txn, txn.spendingLink.kind);
  }
  return undefined;
};

// Step 3. A Transfer pair that pairing or the AI linked (spec 03, Transfers). The Accounts on its
// two sides decide how it counts. A Transaction with no pair, on an Account whose own Transactions
// count only through pairs, an investment Account, a loan, or an excluded Account, is decided here
// too. A payment in an Unclear pair with a connected loan counts nowhere while the pair waits: the
// loan's own Transaction carries the payment's parts, so it counts once.
const transferPair: DecisionRule = (txn) => {
  if (ownExcluded(txn)) return accountsTreatment(txn);
  if (txn.transferLink === "app" || txn.transferLink === "AI") return pairTreatment(txn);
  if (txn.unclearLoanPayments.has(txn.id)) return whole(txn, "Transfer");
  return accountsTreatment(txn);
};

// Step 4. A link to a Manual loan that the app or the AI made (spec 03, Loans).
const manualLoanLink: DecisionRule = (txn) =>
  txn.loanLink !== null ? loanLinkTreatment(txn, txn.loanLink.loanAccountId) : undefined;

const RULES = new Map<DecisionStep, DecisionRule>([
  ["1", handSetType],
  ["2", handLink],
  ["3", transferPair],
  ["4", manualLoanLink],
  ["5.1", cardPayment],
  ["5.2", untrackedLoanPayment],
  ["5.3", cashWithdrawal],
  ["5.4", zelleWithMember],
  ["5.5", paymentToPerson],
  ["5.6", oneSidedTransfer],
  ["5.7", (txn) => whole(txn, "Spending")],
  ["6.1", cardRewards],
  ["6.2", loanPayout],
  ["6.3", zelleWithMember],
  ["6.4", refundLink],
  ["6.5", moneyFromPerson],
  ["6.6", cardPaymentReceived],
  ["6.7", oneSidedTransfer],
  ["6.8", unlinkedRefund],
  ["6.9", (txn) => whole(txn, "Income")],
]);

// Money out is a negative amount. A $0 Transaction goes through the money-out steps.
const appliesTo = (step: DecisionStep, amount: number) =>
  step.startsWith("5.") ? amount <= 0 : step.startsWith("6.") ? amount > 0 : true;

function checkDecision(step: DecisionStep, txn: DecisionInput, decision: Decision): void {
  const sum = decision.parts.reduce((total, part) => total + part.amount, 0);
  const amount = decision.paidFromOutside === true ? -txn.amount : txn.amount;
  if (decision.parts.length === 0 || sum !== amount) {
    throw new Error(`Step ${step} gave parts that do not add up to the Transaction's amount.`);
  }
  for (const part of decision.parts) {
    const takesCategory =
      part.type !== "Transfer" && part.type !== "Income" && part.type !== "Saving";
    if (part.category !== null && !takesCategory) {
      throw new Error(`Step ${step} gave a ${part.type} part a Category.`);
    }
    if (part.keepsCategory === true && (part.type !== "Spending" || part.category === null)) {
      throw new Error(`Step ${step} kept a Category on a part that has none to keep.`);
    }
    if (
      part.linked === true &&
      ((part.type !== "Refund" && part.type !== "Reimbursement") || part.category !== null)
    ) {
      throw new Error(`Step ${step} linked a part that no link reduces.`);
    }
    if (part.categorySource !== undefined && (part.type !== "Spending" || part.category === null)) {
      throw new Error(`Step ${step} set a hand-set Category on a part that takes none.`);
    }
  }
}

// Runs the order on one Transaction. The first step that fits wins. A Member's split then divides
// a Spending answer into its parts (spec 04, Splits).
export async function decide(txn: DecisionInput): Promise<Decision & { step: DecisionStep }> {
  for (const { step } of DECISION_STEPS) {
    if (!appliesTo(step, txn.amount)) continue;
    const rule = RULES.get(step);
    if (rule === undefined) continue;
    const answer = await rule(txn);
    if (answer === undefined) continue;
    const decision = withSplit(txn, answer);
    checkDecision(step, txn, decision);
    return { ...decision, step };
  }
  // Steps 5.7 and 6.9 always fit.
  throw new Error("No step of the order of decisions fit.");
}
