// What the money-movement routes answer. This file imports nothing, so the web app's type check
// can follow it through api.ts.

// One part of a Transaction. Amounts are whole cents with the Transaction's sign: money into the
// Account is positive.
export type TransactionPartView = {
  type: "Spending" | "Income" | "Transfer" | "Saving" | "Refund" | "Reimbursement";
  amount: number;
  // Null for Transfers, Income, and Saving, and for Spending the categorization step has not
  // reached yet.
  category: string | null;
};

// A Transaction's type, as the order of decisions last decided it (spec 03, Order of decisions).
export type TransactionDecisionView = {
  // The step that decided it, such as "1" for a hand-set type.
  step: string;
  // The last day of a provisional one-sided result's window, or null.
  provisionalUntil: string | null;
  parts: TransactionPartView[];
};

// One month's totals, in whole cents (spec 03, Transaction types). Spending and Income are
// positive. Saving is the money moved in, minus the money taken back out, and may be negative.
export type MonthTotalsView = {
  // YYYY-MM, from each Transaction's purchase date, else its posted date.
  month: string;
  spending: number;
  income: number;
  saving: number;
  byCategory: Record<string, number>;
  byCategoryGroup: Record<string, number>;
};

// A Transfer link's evidence (spec 03, Evidence).
export type TransferLinkView = {
  // The link's ID, for Undo.
  id: string;
  // The Transaction on the other side of the pair.
  otherTransactionId: string;
  // Strong when at least one strong signal matched, else Unclear.
  tier: "Strong" | "Unclear";
  // Each strong signal that matched.
  signals: ("last 4 digits" | "institution name" | "Plaid category" | "earlier Transfer")[];
  // The AI's answer and confidence, or null when the app did not ask it.
  aiAnswer: "yes" | "no" | null;
  aiConfidence: "high" | "medium" | "low" | null;
  madeBy: "app" | "AI" | "Member";
  // True when the app picked it from two equally good sets of pairs.
  uncertain: boolean;
};

// A Refund, Reimbursement, or Manual loan link's evidence (spec 03, Evidence).
export type OtherLinkView = {
  // The link's ID, for Undo.
  id: string;
  kind: "Refund" | "Reimbursement" | "loan";
  // The Transaction on the other side, for a Refund or a Reimbursement; else null.
  otherTransactionId: string | null;
  // The Manual loan, for a loan link; else null.
  loanAccountId: string | null;
  tier: "Strong" | "Unclear";
  signals: string[];
  aiAnswer: "yes" | "no" | null;
  aiConfidence: "high" | "medium" | "low" | null;
  madeBy: "app" | "AI" | "Member";
};

// How a part's Category was chosen, as the Transactions page shows it (spec 04, Provenance): the
// cascade step, with "AI, unsure" for an AI answer below high confidence. "Money movement" is a
// Category that a Money movement rule names, such as Cash (spec 04, Categories that Money movement
// names).
export type CategoryChosenBy =
  | "hand-set"
  | "Category rule"
  | "Recurring charge"
  | "Plaid"
  | "Merchant history"
  | "AI"
  | "AI, unsure"
  | "Web lookup"
  | "Web lookup, unsure"
  | "best guess"
  | "Money movement";

// A part as the Transactions page shows it. A Refund or Reimbursement linked to a split purchase
// shows one part for each of the purchase's parts, in proportion to their amounts (spec 04, Splits).
export type ShownPartView = TransactionPartView & {
  // The part of a Refund or Reimbursement that its link reduces. It has its Spending's Category.
  linked: boolean;
  // Null for a part with no Category of its own: a Transfer, Income, Saving, a linked part, or
  // Spending the categorization step has not reached yet.
  categoryChosenBy: CategoryChosenBy | null;
};

// A Transaction as a row of the Transactions page shows it (spec 07, Transactions page).
export type TransactionRowView = {
  id: string;
  accountId: string;
  // Whole cents. Money into the Account is positive.
  amount: number;
  postedDate: string;
  authorizedDate: string | null;
  pending: boolean;
  description: string;
  merchantName: string | null;
  // The Merchant's clean name, or null when it has none, such as a paper check.
  merchant: string | null;
  // The name a Member gave the Recurring charge it is in, or null (spec 06, Member edits).
  recurringChargeName: string | null;
  // Empty before Matching has decided it.
  parts: ShownPartView[];
};

// One Transaction, with its type, how each Category was chosen, and its links' evidence.
export type TransactionDetailView = {
  transaction: TransactionRowView;
  // Null before Matching has decided it. Its parts are the row's.
  decision: (Omit<TransactionDecisionView, "parts"> & { parts: ShownPartView[] }) | null;
  // Null when no Transfer link uses it.
  transferLink: TransferLinkView | null;
  // The Refund, Reimbursement, and Manual loan links that use it.
  otherLinks: OtherLinkView[];
  // The Transaction on the other side of each link, for its evidence (spec 03, Evidence).
  matched: TransactionRowView[];
  // The line about the business that a Web lookup found, when a Web lookup chose a part's Category
  // (spec 04, Web lookup). Else null.
  webLookup: { description: string } | null;
};

// A link a Member makes by hand (spec 03, Undo and hand links).
export type HandLinkBody =
  | { kind: "Transfer"; outTransactionId: string; inTransactionId: string }
  | { kind: "Refund" | "Reimbursement"; transactionId: string; spendingTransactionId: string }
  | { kind: "loan"; transactionId: string; loanAccountId: string };

// The answer to a hand link: its ID, or why the app refused it. "not found" when a Transaction
// that shows, or the Manual loan, has no such ID.
export type HandLinkOutcome =
  | { outcome: "linked"; linkId: string }
  | { outcome: "not found" }
  | { outcome: "refused"; reason: string };

// A connected loan's type as it counts, and the APR a Member typed (spec 02, Account fields).
export type LoanView = {
  accountId: string;
  loanType: "cash loan" | "purchase loan";
  // "app" while the subtype or a payout decides the type.
  setBy: "Member" | "app";
  // A percent, such as 6.5, or null.
  apr: number | null;
};

// A Member's change to a connected loan. A field left out keeps its value. Null hands the type back
// to the app, or clears the APR.
export type LoanBody = {
  loanType?: "cash loan" | "purchase loan" | null;
  apr?: number | null;
};

// A Manual loan's type, as a Member picks it (spec 02, Manual loans).
export const MANUAL_LOAN_KINDS = [
  "personal",
  "car",
  "student",
  "mortgage",
  "buy now pay later",
] as const;
export type ManualLoanKind = (typeof MANUAL_LOAN_KINDS)[number];

// What a Member types for a Manual loan. Money is whole cents; the balance is what is owed, on
// its date. An APR is a percent, such as 7.3. Escrow is for a mortgage only. A null loanType lets
// the app decide Cash loan or Purchase loan.
export type ManualLoanBody = {
  lender: string;
  kind: ManualLoanKind;
  balance: number;
  balanceDate: string;
  apr: number;
  regularPayment: number | null;
  escrow: number | null;
  loanType: "cash loan" | "purchase loan" | null;
};

// A Manual loan, with its type as it counts and who set it.
export type ManualLoanView = Omit<ManualLoanBody, "loanType"> & {
  id: string;
  loanType: "cash loan" | "purchase loan";
  setBy: "Member" | "app";
};

// A split's parts: whole cents spent, and a Category each. They add up to the Transaction's
// amount.
export type SplitBody = { parts: { amount: number; category: string }[] };

export type SplitAnswer =
  | { outcome: "split"; decision: TransactionDecisionView }
  | { outcome: "not found" }
  | { outcome: "not Spending" }
  | { outcome: "wrong total" };

// A remembered one-sided Transfer answer, as Settings → Categories lists it (spec 03, One-sided
// Transfer cards).
export type TransferAnswerView = {
  id: string;
  merchantName: string;
  // The last 4 digits of each account number the lines hold, or empty.
  lastFours: string[];
  // "Keep it as a Transfer", "Not a Transfer", or the account's name.
  answer: string;
  madeAt: string;
};

export type MoneyMovementRoutes = {
  // Undefined when no Transaction that shows has the ID.
  transaction(transactionId: string): Promise<TransactionDetailView | undefined>;
  // Undefined when no Transaction that shows has the ID.
  setType(
    transactionId: string,
    type: "Spending" | "Transfer" | "Income" | "Saving",
  ): Promise<TransactionDecisionView | undefined>;
  // A Member splits a Spending Transaction by amount across Categories (spec 04, Splits).
  split(transactionId: string, body: SplitBody): Promise<SplitAnswer>;
  // False when no Transaction that shows has the ID and a split.
  removeSplit(transactionId: string): Promise<boolean>;
  // Every month with a posted Transaction, oldest first.
  totals(): Promise<MonthTotalsView[]>;
  // Undefined when no connected loan has the ID.
  loan(accountId: string): Promise<LoanView | undefined>;
  // Undefined when no connected loan has the ID.
  setLoan(accountId: string, body: LoanBody): Promise<LoanView | undefined>;
  // A Member links Transactions by hand.
  link(body: HandLinkBody, memberId: string): Promise<HandLinkOutcome>;
  // A Member undoes a link of any kind. False when no link has the ID.
  undoLink(linkId: string, memberId: string): Promise<boolean>;
  manualLoans(): Promise<ManualLoanView[]>;
  addManualLoan(body: ManualLoanBody, memberId: string): Promise<ManualLoanView>;
  // Undefined when no Manual loan has the ID.
  editManualLoan(
    id: string,
    body: ManualLoanBody,
    memberId: string,
  ): Promise<ManualLoanView | undefined>;
  // Settings → Categories: every remembered one-sided Transfer answer, by Merchant name.
  transferAnswers(): Promise<TransferAnswerView[]>;
  // False when no remembered answer has the ID.
  deleteTransferAnswer(id: string): Promise<boolean>;
};
