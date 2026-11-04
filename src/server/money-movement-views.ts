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

export type MoneyMovementRoutes = {
  // Undefined when no Transaction that shows has the ID.
  setType(
    transactionId: string,
    type: "Spending" | "Transfer" | "Income" | "Saving",
  ): Promise<TransactionDecisionView | undefined>;
  // Every month with a posted Transaction, oldest first.
  totals(): Promise<MonthTotalsView[]>;
};
