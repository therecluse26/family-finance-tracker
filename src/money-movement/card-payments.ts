import type { DecisionAccount } from "../db/index.ts";
import { calendarDateIn } from "../format.ts";
import { addBusinessDays, addDays } from "./business-days.ts";
import { toUnconnectedAccount } from "./one-sided.ts";
import type { Decision, DecisionInput, DecisionRule } from "./order.ts";
import { CARD_PAYMENT_WINDOW, isCardReward, namesInstitutionIn } from "./transfers.ts";

// Card payments with no pair, steps 5.1 and 6.6, and card rewards, step 6.1 (spec 03, One side
// missing, Card rewards). Pairing has had its turn, so these Transactions have no pair.

// Plaid's category for a card payment, on either side.
const CARD_PAYMENT = "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT";

const isCard = (account: DecisionAccount | undefined) => account?.kind === "credit";

// Last 4 digits: four digits that are not part of a longer number, right after a card word, with
// only spaces and punctuation between. A card word is "ending" (or "ending in"), "card", a run of
// the letter x that is not part of a longer word (`x`, `XXXX`), or `*`, in any case. A store
// number, a year, or an ID, as in "PURCHASE 1005 BLUEBIRD BOOKS", is not a last 4.
const LAST_FOUR =
  /(?:(?<!\p{L})(?:ending(?:[\s\p{P}]+in)?|card|x+)(?!\p{L})|\*)[\s\p{P}]*(\d{4})(?!\d)/giu;

const lastFoursIn = (description: string) =>
  new Set([...description.matchAll(LAST_FOUR)].map((match) => match[1]));

// A card Closed because its Connection was removed stays tracked for this many days after the
// removal, in Household time.
const REMOVED_CARD_DAYS = 90;

// Whether the app tracks a card for a payment dated `date`. A card whose Connection is broken is
// still tracked, and so is one Closed for another reason, such as by a Member or because it
// vanished from the provider.
function tracksOn(card: DecisionAccount, date: string, timeZone: string): boolean {
  if (card.closedReason !== "connection removed" || card.closedAt === null) return true;
  return date <= addDays(calendarDateIn(card.closedAt, timeZone), REMOVED_CARD_DAYS);
}

// The card a payment's description names, among the cards the app tracks on its date. When it
// holds last 4 digits, only a card with those digits is named. With none, a card at the
// institution it names is.
function cardNamedIn(txn: DecisionInput): DecisionAccount | undefined {
  const cards = [...txn.accounts.values()].filter(
    (account) =>
      account.id !== txn.accountId &&
      isCard(account) &&
      tracksOn(account, txn.postedDate, txn.timeZone),
  );
  const lastFours = lastFoursIn(txn.description);
  if (lastFours.size > 0) {
    return cards.find((card) => card.mask !== null && lastFours.has(card.mask));
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
