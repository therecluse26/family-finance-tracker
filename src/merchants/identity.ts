import type { Merchant } from "./names.ts";

// Merchant identity (spec 04, Identity). Every "same Merchant" in the app uses sameMerchant:
// Category rules, Merchant history, Refund links, Recurring charges, Anomalies, and Top Merchants.
// v1 has no Merchant merge and no Merchant rename.

// A clean name as identity compares it: no case, no spaces, no punctuation. "Trader Joe's" and
// "TRADER JOES" are both "traderjoes".
export function merchantKey(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

// Whether two Transactions' Merchants are the same Merchant. When both have the provider's
// Merchant ID, the IDs decide. Otherwise their clean names decide. A Transaction with no Merchant,
// such as a paper check, is never the same Merchant as another.
export function sameMerchant(a: Merchant | null, b: Merchant | null): boolean {
  if (a === null || b === null) return false;
  if (a.id !== null && b.id !== null) return a.id === b.id;
  const key = merchantKey(a.name);
  return key !== "" && key === merchantKey(b.name);
}

// The payment apps whose lines may name a person (spec 04, Identity; spec 03, Payment apps).
const PAYMENT_APPS = new Set(["Venmo", "Zelle", "Cash App", "PayPal"].map(merchantKey));

// The words a payment-app line adds around the app's name that name no one.
const PAYMENT_WORDS = new Set([
  "payment",
  "payments",
  "pmt",
  "transfer",
  "xfer",
  "inst",
  "instant",
  "addfunds",
  "cashout",
  "web",
  "id",
  "sent",
  "received",
]);

// Linking words that name no one by themselves: "Zelle Payment To" names no payee, while "Zelle To
// Morgan Lee" does.
const LINKING_WORDS = new Set(["to", "from", "for"]);

const namesNoOne = (word: string) =>
  PAYMENT_WORDS.has(word) || LINKING_WORDS.has(word) || /^\p{N}+$/u.test(word);

// Whether the Merchant is a payment app itself: a payment-app or Zelle line that names no person,
// such as VENMO PAYMENT 1234567890 WEB ID, whose clean name is "Venmo Payment". That is the app's
// name followed only by payment words, linking words, and digits. Cleanup strips some apps' names
// as a processor prefix, so PAYPAL *INST XFER cleans to "Inst Xfer": a clean name of payment words
// alone is the bare app too. A line that names a person or a shop has that one as its Merchant.
export function isPaymentApp(merchant: Merchant): boolean {
  const words = merchant.name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
  // "Cash App" is two words.
  for (const length of [1, 2]) {
    if (!PAYMENT_APPS.has(words.slice(0, length).join(""))) continue;
    return words.slice(length).every(namesNoOne);
  }
  return words.some((word) => PAYMENT_WORDS.has(word)) && words.every(namesNoOne);
}
