import type { DecisionAccount } from "../db/index.ts";
import { addBusinessDays } from "./business-days.ts";
import { toUnconnectedAccount } from "./one-sided.ts";
import type { Decision, DecisionInput, DecisionRule } from "./order.ts";
import { CARD_PAYMENT_WINDOW, isCardReward, namesInstitutionIn, namesMask } from "./transfers.ts";

// Card payments with no pair, steps 5.1 and 6.6, and card rewards, step 6.1 (spec 03, One side
// missing, Card rewards). Pairing has had its turn, so these Transactions have no pair.

// Plaid's category for a card payment, on either side.
const CARD_PAYMENT = "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT";

const isCard = (account: DecisionAccount | undefined) => account?.kind === "credit";

// Last 4 digits: four digits that are not part of a longer number.
const LAST_FOUR = /(?<!\d)\d{4}(?!\d)/;

// The card a payment's description names. When it holds last 4 digits, only a card with those
// digits is named. With none, a card at the institution it names is. Every card Account counts,
// whatever its Connection's health: a card whose Connection is broken is still tracked.
function cardNamedIn(txn: DecisionInput): DecisionAccount | undefined {
  const cards = [...txn.accounts.values()].filter(
    (account) => account.id !== txn.accountId && isCard(account),
  );
  if (LAST_FOUR.test(txn.description)) {
    return cards.find((card) => namesMask(txn.description, card.mask));
  }
  return cards.find((card) => namesInstitutionIn(txn.description, card.institutionName));
}

// Step 5.1. A card payment is money out of an Account that is not a card, with Plaid's
// LOAN_PAYMENTS_CREDIT_CARD_PAYMENT category. Money out of a card itself under that category, such
// as a returned payment, is not a payment to a card, so later steps decide it.
// - To a card the app tracks: a Transfer to that card.
// - To a card it does not track: a Transfer while a pair may still come, for 4 business days. Then
//   Spending in Miscellaneous.
export const cardPayment: DecisionRule = (txn) => {
  if (txn.providerCategory !== CARD_PAYMENT || isCard(txn.accounts.get(txn.accountId))) {
    return undefined;
  }
  const transfer: Decision = { parts: [{ type: "Transfer", amount: txn.amount, category: null }] };
  if (cardNamedIn(txn) !== undefined) return transfer;
  const until = addBusinessDays(txn.postedDate, CARD_PAYMENT_WINDOW);
  if (until >= txn.today) return { ...transfer, provisionalUntil: until };
  return { parts: [{ type: "Spending", amount: txn.amount, category: "Miscellaneous" }] };
};

// Step 6.1. Money into a credit card whose description holds "reward" or "redemption", in any
// case, is card rewards, and card rewards are Income.
export const cardRewards: DecisionRule = (txn) => {
  const own = txn.accounts.get(txn.accountId);
  return own !== undefined &&
    isCardReward({ amount: txn.amount, accountKind: own.kind, description: txn.description })
    ? { parts: [{ type: "Income", amount: txn.amount, category: null }] }
    : undefined;
};

// Step 6.6. A payment on a card the app tracks that no connected Account sent: money into a credit
// card with Plaid's LOAN_PAYMENTS_CREDIT_CARD_PAYMENT category. It is a Transfer from an
// Unconnected account, which the one-sided rules pick.
export const cardPaymentReceived: DecisionRule = (txn) =>
  txn.providerCategory === CARD_PAYMENT && isCard(txn.accounts.get(txn.accountId))
    ? toUnconnectedAccount(txn, CARD_PAYMENT_WINDOW)
    : undefined;
