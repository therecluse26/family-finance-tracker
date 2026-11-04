// The Transaction types (spec 03, Transaction types). This file imports nothing, so the web app can
// use it.
export const TRANSACTION_TYPES = [
  "Spending",
  "Income",
  "Transfer",
  "Saving",
  "Refund",
  "Reimbursement",
] as const;

export type TransactionType = (typeof TRANSACTION_TYPES)[number];

// The types a Member may set by hand.
export const HAND_SET_TYPES = ["Spending", "Transfer", "Income", "Saving"] as const;

export type HandSetType = (typeof HAND_SET_TYPES)[number];

// How many parts a split has (spec 04, Splits).
export const MIN_SPLIT_PARTS = 2;
export const MAX_SPLIT_PARTS = 20;
