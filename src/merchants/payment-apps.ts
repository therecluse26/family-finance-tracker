// Payment-app lines (spec 03, Payment apps; spec 04, Identity). Venmo, PayPal, Cash App, and Zelle
// show up as lines in the Household's bank and card data. Merchant cleanup and Money movement both
// read a line through paymentAppLine, so they agree on what it names.

export const PAYMENT_APPS = ["Venmo", "PayPal", "Cash App", "Zelle"] as const;
export type PaymentApp = (typeof PAYMENT_APPS)[number];

// Each payment app's name in text, as whole words, in any case.
const APP_NAMES: readonly (readonly [PaymentApp, RegExp])[] = [
  ["Venmo", /\bvenmo\b/i],
  ["PayPal", /\bpaypal\b/i],
  ["Cash App", /\bcash\s?app\b/i],
  ["Zelle", /\bzelle\b/i],
];

// Plaid's codes for money to and from a payment app.
const APP_CODES = new Set([
  "TRANSFER_OUT_TRANSFER_OUT_FROM_APPS",
  "TRANSFER_IN_TRANSFER_IN_FROM_APPS",
]);

// A purchase through PayPal at a store, such as "PAYPAL *SUNSHINEYOGA". The store follows the "*".
// "PAYPAL *INST XFER" is money moved out of PayPal, not a store.
const PAYPAL_PURCHASE = /\bpaypal\s?\*\s*(?!inst\b|xfer\b|transfer\b)[a-z]/i;

// Venmo and Cash App put the person after a "*", as in "VENMO *MORGAN LEE" or "CASH APP*JOHN SMITH".
// Words such as "SENT" or "CASHOUT" there name the kind of payment, not a person.
const STARRED_PERSON = /\b(?:venmo|cash\s?app)\s?\*\s*([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,3})/i;
const NOT_A_PERSON_AFTER_STAR = new Set([
  "sent",
  "received",
  "payment",
  "cashout",
  "cash",
  "addfunds",
  "add",
  "transfer",
  "xfer",
  "inst",
  "refund",
]);

// What a line says about the other side of the money:
// - a person, who is then the Merchant;
// - another Merchant, which makes the line an ordinary purchase;
// - no one, so the payment app is the Merchant, as in `VENMO PAYMENT`.
export type PaymentAppParty = { person: string } | "another Merchant" | "no one";

export type PaymentAppLine = {
  // The payment app the line names, or null when only a Plaid code marks it.
  app: PaymentApp | null;
  party: PaymentAppParty;
};

// What the line reads of a Transaction.
export type PaymentAppInput = {
  description: string;
  merchantName?: string | null;
  counterparties?: readonly { name: string; type: string }[];
  providerCategory?: string | null;
};

function appIn(text: string): PaymentApp | undefined {
  return APP_NAMES.find(([, name]) => name.test(text))?.[0];
}

// The words of a person's name after "to" or "from", up to a reference, a date, or a number, such
// as "MORGAN LEE" in "Zelle payment to MORGAN LEE Conf# 1a2b3c". Words that name an account or a
// payment app are no person.
const NAMED_PERSON = /\b(?:to|from)\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*){0,3})/i;
const NOT_A_NAME = new Set([
  "conf",
  "ref",
  "id",
  "on",
  "memo",
  "for",
  "web",
  "ppd",
  "ccd",
  "trn",
  "transaction",
]);
const NOT_A_PERSON =
  /\b(?:bank|account|acct|checking|savings|card|balance|wallet|venmo|paypal|zelle|cash\s?app)\b/i;

// "MORGAN LEE" is "Morgan Lee". A name with any lowercase letter keeps its case.
function nameCase(name: string): string {
  if (/\p{Ll}/u.test(name)) return name;
  return name
    .toLowerCase()
    .replace(/(^|[\s'-])(\p{L})/gu, (_, before, letter) => before + letter.toUpperCase());
}

// The person a payment-app line names, after "to" or "from", or after Venmo's or Cash App's "*".
export function personIn(description: string): string | undefined {
  const text = description.replace(/\s+/g, " ");
  const starred = STARRED_PERSON.exec(text)?.[1];
  const found =
    starred !== undefined &&
    !NOT_A_PERSON_AFTER_STAR.has(starred.split(" ")[0]?.toLowerCase() ?? "")
      ? starred
      : NAMED_PERSON.exec(text)?.[1];
  if (found === undefined) return undefined;
  const words: string[] = [];
  for (const word of found.split(" ")) {
    if (NOT_A_NAME.has(word.toLowerCase().replace(/[.']/g, ""))) break;
    words.push(word);
  }
  const name = words.join(" ");
  if (name === "" || NOT_A_PERSON.test(name)) return undefined;
  return nameCase(name);
}

const sameName = (a: string, b: string) =>
  a.toLowerCase().replace(/[^\p{L}]/gu, "") === b.toLowerCase().replace(/[^\p{L}]/gu, "");

// The payment-app line a Transaction is, or undefined when it is none. A line is a payment-app line
// when it has a `counterparties[]` entry of type `payment_app`, Plaid's
// TRANSFER_OUT_TRANSFER_OUT_FROM_APPS or TRANSFER_IN_TRANSFER_IN_FROM_APPS, or "Venmo", "PayPal",
// "Cash App", or "Zelle" in the description. A provider Merchant or a merchant counterparty that is
// no payment app and not the person the line names makes it an ordinary purchase.
export function paymentAppLine(txn: PaymentAppInput): PaymentAppLine | undefined {
  const parties = txn.counterparties ?? [];
  const appParty = parties.find((party) => party.type === "payment_app");
  const app = appIn(txn.description) ?? (appParty === undefined ? undefined : appIn(appParty.name));
  const isLine =
    app !== undefined ||
    appParty !== undefined ||
    (txn.providerCategory != null && APP_CODES.has(txn.providerCategory));
  if (!isLine) return undefined;
  const person = personIn(txn.description);
  const merchants = [
    ...(txn.merchantName == null ? [] : [txn.merchantName]),
    ...parties
      .filter((party) => party.type === "merchant" || party.type === "marketplace")
      .map((party) => party.name),
  ].filter((name) => name.trim() !== "" && appIn(name) === undefined);
  const another = merchants.some((name) => person === undefined || !sameName(name, person));
  const party: PaymentAppParty = another
    ? "another Merchant"
    : person !== undefined
      ? { person }
      : PAYPAL_PURCHASE.test(txn.description)
        ? "another Merchant"
        : "no one";
  return { app: app ?? null, party };
}
