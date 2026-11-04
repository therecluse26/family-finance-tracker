import { paymentAppLine } from "../merchants/index.ts";
import { toUnconnectedAccount } from "./one-sided.ts";
import type { Decision, DecisionInput, DecisionRule } from "./order.ts";

// Payment apps and cash, steps 5.3, 5.4, 5.5, 6.3, and 6.5 (spec 03, Payment apps, Cash). Pairing
// has had its turn, so the money on these lines left or entered the Household: money added to a
// connected Venmo or PayPal Account pairs as a Transfer at step 3, like any other.

// Plaid's code for a cash withdrawal at an ATM or a teller.
const WITHDRAWAL = "TRANSFER_OUT_WITHDRAWAL";

// Cash back at a checkout. A line that also holds "purchase" is one line for the purchase and the
// cash, and takes the purchase's Category.
const CASH_BACK = /\bcash[\s-]?back\b/i;
const PURCHASE = /\bpurchase\b/i;

const named = (txn: DecisionInput, category: "Cash" | "Payments to people"): Decision => ({
  parts: [{ type: "Spending", amount: txn.amount, category }],
});

// Step 5.3. A cash withdrawal at an ATM or a teller is Spending in Cash, on the day of the
// withdrawal. So is cash back at a checkout on its own line.
export const cashWithdrawal: DecisionRule = (txn) =>
  txn.providerCategory === WITHDRAWAL ||
  (CASH_BACK.test(txn.description) && !PURCHASE.test(txn.description))
    ? named(txn, "Cash")
    : undefined;

// The words of a name, in lowercase.
const wordsOf = (text: string) => text.toLowerCase().match(/\p{L}+/gu) ?? [];

// A Zelle line names a Member when it holds that Member's first and last name, in any case. A
// Member's first name is the first word of the name the Member typed, and the last name the last
// word. A one-word name names no one.
function namesMember(txn: DecisionInput): boolean {
  const line = paymentAppLine(txn);
  if (line?.app !== "Zelle") return false;
  const found = new Set(wordsOf(txn.description));
  return txn.members.some((name) => {
    const [first, ...rest] = wordsOf(name);
    const last = rest.at(-1);
    return first !== undefined && last !== undefined && found.has(first) && found.has(last);
  });
}

// Steps 5.4 and 6.3. Zelle to or from a Member's own name, with no pair, is a one-sided Transfer.
// The one-sided rules pick its Unconnected account.
export const zelleWithMember: DecisionRule = (txn) =>
  namesMember(txn) ? toUnconnectedAccount(txn) : undefined;

// A payment-app line that names a person, or no one. A line that names another Merchant, such as a
// PayPal purchase at a store, is an ordinary purchase, and the cascade picks its Category.
function isMoneyWithPerson(txn: DecisionInput): boolean {
  const line = paymentAppLine(txn);
  return line !== undefined && line.party !== "another Merchant";
}

// Step 5.5. A Zelle, Venmo, Cash App, or PayPal payment to a person, and money added to Venmo or
// PayPal, is Spending in Payments to people. A hand-set Category or a Category rule for the person
// still wins.
export const paymentToPerson: DecisionRule = (txn) =>
  isMoneyWithPerson(txn) ? named(txn, "Payments to people") : undefined;

// Step 6.5. Money from a person, such as `VENMO CASHOUT` or Zelle from someone outside the
// Household, is Income until a Reimbursement links it.
export const moneyFromPerson: DecisionRule = (txn) =>
  isMoneyWithPerson(txn)
    ? { parts: [{ type: "Income", amount: txn.amount, category: null }] }
    : undefined;
