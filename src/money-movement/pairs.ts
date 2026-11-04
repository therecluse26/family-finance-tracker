import type { DecisionAccount } from "../db/index.ts";
import { isLoan, loanPairTreatment, paidFromOutside } from "./loans.ts";
import type { Decision, DecisionInput } from "./order.ts";
import type { TransactionType } from "./types.ts";

// How a Transfer pair counts, by the Accounts on its two sides, and how the own Transactions of an
// Account that counts only through pairs count (spec 02, Accounts; spec 03, Saving and Loans).

// A synced Account of Plaid type `investment` counts like an Unconnected account of kind
// "investment or retirement" (spec 02, Accounts): money into it is Saving, and its own
// Transactions count nowhere, though the app keeps them.
export function isInvestment(account: DecisionAccount | undefined): boolean {
  return account?.connected === true && account.kind === "investment";
}

// A Member turned on the Account's Exclude switch (spec 02, Exclude). It counts as an Unconnected
// account: its own Transactions count nowhere, though the app keeps them, and money between it and
// an included Account is a Transfer.
export function isExcluded(account: DecisionAccount | undefined): boolean {
  return account?.excluded === true;
}

const one = (txn: DecisionInput, type: TransactionType): Decision => ({
  parts: [{ type, amount: txn.amount, category: null }],
});

// A linked pair, from one side.
// - The loan's own side counts nowhere. On the other side, a payment to the loan divides into
//   interest and principal, and a payout from it is a Transfer.
// - Money between a Household Account and an investment Account is Saving on the Household
//   Account's side: money in reduces Saving. The investment Account's own side counts nowhere.
// - Money to or from an excluded Account is a Transfer, whatever its kind.
// - Any other pair is a Transfer.
export async function pairTreatment(txn: DecisionInput): Promise<Decision> {
  const own = txn.accounts.get(txn.accountId);
  const other = txn.otherSide === null ? undefined : txn.accounts.get(txn.otherSide.accountId);
  if (isLoan(own) || isExcluded(own) || isExcluded(other)) return one(txn, "Transfer");
  if (txn.otherSide !== null && isLoan(other)) {
    return loanPairTreatment(txn, txn.otherSide.accountId, txn.otherSide.postedDate);
  }
  if (!isInvestment(own) && isInvestment(other)) return one(txn, "Saving");
  return one(txn, "Transfer");
}

// A Transaction with no pair, on an Account that counts only through pairs. On an investment
// Account or an excluded Account it counts nowhere. On a loan, money out, such as a payout or a
// charge, counts nowhere; money in is a payment that no Household Account sent. Undefined for any
// other Account.
export async function accountsTreatment(txn: DecisionInput): Promise<Decision | undefined> {
  const own = txn.accounts.get(txn.accountId);
  if (isInvestment(own) || isExcluded(own)) return one(txn, "Transfer");
  if (!isLoan(own)) return undefined;
  return txn.amount > 0 ? paidFromOutside(txn) : one(txn, "Transfer");
}
