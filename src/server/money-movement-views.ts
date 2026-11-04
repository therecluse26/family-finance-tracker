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

// One Transaction, with its type and its Transfer link's evidence.
export type TransactionDetailView = {
  transaction: {
    id: string;
    accountId: string;
    // Whole cents. Money into the Account is positive.
    amount: number;
    postedDate: string;
    authorizedDate: string | null;
    pending: boolean;
    description: string;
    merchantName: string | null;
  };
  // Null before Matching has decided it.
  decision: TransactionDecisionView | null;
  // Null when no Transfer link uses it.
  transferLink: TransferLinkView | null;
};

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

export type MoneyMovementRoutes = {
  // Undefined when no Transaction that shows has the ID.
  transaction(transactionId: string): Promise<TransactionDetailView | undefined>;
  // Undefined when no Transaction that shows has the ID.
  setType(
    transactionId: string,
    type: "Spending" | "Transfer" | "Income" | "Saving",
  ): Promise<TransactionDecisionView | undefined>;
  // Every month with a posted Transaction, oldest first.
  totals(): Promise<MonthTotalsView[]>;
  // Undefined when no connected loan has the ID.
  loan(accountId: string): Promise<LoanView | undefined>;
  // Undefined when no connected loan has the ID.
  setLoan(accountId: string, body: LoanBody): Promise<LoanView | undefined>;
};
