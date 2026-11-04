import { paymentAppLine } from "./payment-apps.ts";

// Merchant names (spec 04, Names). The provider's Merchant name wins. Otherwise fixed rules clean
// the bank's original description: they remove store numbers, payment-processor prefixes, cities,
// and dates. A name the rules cannot fix keeps the rule-cleaned text and is marked for AI cleanup,
// which runs later in the categorization step. When a rule cannot decide, it marks the name for AI
// cleanup rather than guess. The rules run when a Transaction arrives, in the sync, before
// matching, because Refund links need the Merchant.

// A Merchant: the provider's Merchant ID when it has one, and the clean name. The name is empty
// only when the provider gave a Merchant ID and the rules left no name.
export type Merchant = { id: string | null; name: string };

// What the cleanup decided for one Transaction. `merchant` is null when the Transaction has no
// Merchant, such as a paper check, or when the rules left no name and AI cleanup must find one.
// `needsAi` marks a name the rules could not fix.
export type MerchantCleanup = { merchant: Merchant | null; needsAi: boolean };

// The bank's lead-ins, such as "POS PURCHASE", "ACH DEBIT", or "CARD 1234". They name the payment,
// not the Merchant. A longer lead-in comes before a shorter one that starts it.
const LEAD_INS = [
  "PURCHASE AUTHORIZED ON",
  "DEBIT CARD PURCHASE",
  "RECURRING (?:PAYMENT|DEBIT|PURCHASE)",
  "(?:ONLINE |BILL )?PAYMENT(?: \\S*\\d\\S*)? TO",
  "ONLINE (?:PAYMENT|PURCHASE)",
  "ACH (?:DEBIT|PAYMENT|WITHDRAWAL)",
  "ACH",
  "(?:CARD|POS|DEBIT) PURCHASE",
  "POS DEBIT",
  "POS",
  "CHECK\\s*CARD(?: \\d+)?",
  "CARD \\d+",
  "PURCHASE",
  "PAYMENT",
];
const LEAD_IN = new RegExp(`^(?:${LEAD_INS.join("|").replace(/ /g, "\\s+")})(?:\\s+|$)`, "i");

// Payment-processor prefixes, such as "SQ *" (Square) and "TST*" (Toast). Each ends in "*".
const PROCESSORS = [
  "SQ",
  "SQU",
  "TST",
  "SP",
  "PP",
  "PAYPAL",
  "PY",
  "CKE",
  "DD",
  "BT",
  "FS",
  "IC",
  "LS",
  "GOOGLE",
  "GGL",
];
const PROCESSOR = new RegExp(`^(?:${PROCESSORS.join("|")})\\s?\\*\\s*`, "i");

const MONTHS = "JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEPT?|OCT|NOV|DEC";
const DATES = [
  // 2026-10-05. First, so the next rule cannot take its "10-05".
  /\b\d{4}-\d{2}-\d{2}\b/g,
  // 10/05, 10/05/26, 10-05-2026: a month from 1 to 12, then a day from 1 to 31. "24-7" is no date.
  /\b(?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\d|3[01])(?:[/-]\d{2,4})?\b/g,
  // OCT 05, OCT 5, 2026
  new RegExp(`\\b(?:${MONTHS})\\s?\\d{1,2}(?:,?\\s\\d{4})?\\b`, "gi"),
];

// A phone number, such as 866-579-7172 or (800) 555-1212. The store's place may follow it.
const PHONE = /(?:\(\d{3}\)\s?|\b\d{3}[-.])\d{3}[-.]\d{4}\b/g;
// An order or reference code after "*", such as "*2K4JD8", names the order.
const REFERENCE = /\*\s?(?=[A-Z0-9]*\d)[A-Z0-9]+\b/gi;
// "STORE 1234" or "NO. 12" is one store number.
const STORE_WORDS = /\b(?:STORE|STR|NO\.?)\s?#?\s?\d+\b/gi;

// A word that holds a number, not a name: a store number such as "#1234", "T-1234", or "F12345";
// digits alone; or any word with 4 or more digits in a row, such as a masked card number
// "XXXX4821", "CARD1234", "REF#12345678", or "ID:000123456789".
const NUMBER_WORD = /^(?:#\d*|[A-Z]{0,2}-?\d{3,}|\d+)$|\d{4}/i;
// Where the rules put a phone number. A phone number is always a place marker.
const PHONE_MARK = "\u0000PHONE";

// The 50 states, DC, and Puerto Rico. A bank puts a city and its state at the end of a description.
const STATES = new Set(
  (
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ " +
    "NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA WA WV WI WY"
  ).split(" "),
);

// Descriptions of a paper check. A check has no Merchant.
const CHECK = /^(?:CHECK|CHK|CHEQUE)(?:\s+PAID)?\s*(?:#|NO\.?|NUMBER)?\s*\d*$/i;

// A word that is only digits or symbols.
const NO_LETTERS = /^[^\p{L}]+$/u;

function words(text: string): string[] {
  return text.split(/\s+/).filter((word) => word !== "");
}

const isNumber = (word: string) => word === PHONE_MARK || NUMBER_WORD.test(word);
const isState = (word: string) => STATES.has(word.toUpperCase());

// Whether the words after a number are the store's place. After a phone number they always are.
// After a store number they are when they are 1 to 4 words that end in a state code.
function isPlace(marker: string, after: string[]): boolean {
  if (marker === PHONE_MARK) return true;
  const named = after.filter((word) => !isNumber(word));
  const last = named.at(-1);
  return named.length >= 1 && named.length <= 4 && last !== undefined && isState(last);
}

// "TRADER JOE'S" is "Trader Joe's". Text with any lowercase letter keeps its case, and so does a
// word with "&", such as H&M or AT&T.
function titleCase(text: string): string {
  if (/\p{Ll}/u.test(text)) return text;
  return words(text)
    .map((word) =>
      word.includes("&")
        ? word
        : word
            .toLowerCase()
            .replace(/(^|[-/])(\p{L})/gu, (_, before, letter) => before + letter.toUpperCase()),
    )
    .join(" ");
}

// The fixed cleanup rules on one bank description, with no provider data and no AI. `unsure` is
// set when a rule could not decide, such as a last word that may be a state code with nothing
// before it that marks a place.
export function cleanDescription(description: string): { name: string; unsure: boolean } {
  let text = description.replace(/\s+/g, " ").trim();
  for (let before = ""; before !== text; ) {
    before = text;
    text = text.replace(LEAD_IN, "").replace(PROCESSOR, "").trim();
  }
  text = text.replace(PHONE, ` ${PHONE_MARK} `);
  for (const date of DATES) text = text.replace(date, " ");
  text = text.replace(REFERENCE, " ").replace(STORE_WORDS, " # ").replace(/\*/g, " ");

  // A store number or phone number with a name before it, and the store's place after it: the
  // place goes. A number with no place after it goes alone.
  let parts = words(text);
  const place = parts.findIndex(
    (word, index) => index > 0 && isNumber(word) && isPlace(word, parts.slice(index + 1)),
  );
  if (place > 0) parts = parts.slice(0, place);
  parts = parts.filter((word) => !isNumber(word));

  // Loose symbols left at the ends of words, such as a trailing "-", ":", or "#".
  parts = parts.map((word) => word.replace(/^[-,:#]+|[-,:#]+$/g, "")).filter((word) => word !== "");

  // A last word that may be a state code, with nothing that marks a place: it may be a city and
  // state, or part of the name, as in BEST BUY CO. The rules do not guess.
  const last = parts.at(-1);
  const unsure = parts.length > 1 && last !== undefined && isState(last);
  return { name: titleCase(parts.join(" ")), unsure };
}

// A name counts as fixed when it has 1 to 4 words and no word is only digits or symbols.
export function isFixedName(name: string): boolean {
  const parts = words(name);
  return parts.length >= 1 && parts.length <= 4 && !parts.some((word) => NO_LETTERS.test(word));
}

// The Merchant of one arriving Transaction, from the provider's data and its bank description. In
// a payment-app line that names a person, that person is the Merchant, with no Merchant ID, so two
// people never share the app's ID. In one that names no one, such as `VENMO PAYMENT`, the payment
// app is the Merchant (spec 04, Identity). A line that names another Merchant is an ordinary
// purchase.
export function cleanMerchant(txn: {
  description: string;
  merchantName: string | null;
  merchantId: string | null;
  counterparties?: readonly { name: string; type: string }[];
  category?: { name: string } | null;
}): MerchantCleanup {
  const id = txn.merchantId === null || txn.merchantId.trim() === "" ? null : txn.merchantId;
  const line = paymentAppLine({ ...txn, providerCategory: txn.category?.name ?? null });
  if (line !== undefined && typeof line.party === "object") {
    return { merchant: { id: null, name: line.party.person }, needsAi: false };
  }
  const providerName = txn.merchantName?.replace(/\s+/g, " ").trim() ?? "";
  if (providerName !== "") return { merchant: { id, name: providerName }, needsAi: false };
  if (line?.party === "no one" && line.app !== null) {
    return { merchant: { id, name: line.app }, needsAi: false };
  }

  const description = txn.description.replace(/\s+/g, " ").trim();
  if (id === null && (description === "" || CHECK.test(description))) {
    return { merchant: null, needsAi: false };
  }
  // When the rules leave nothing, the clean name stays empty and AI cleanup finds one. The raw
  // description is never the name.
  const { name, unsure } = cleanDescription(description);
  if (name === "") return { merchant: id === null ? null : { id, name: "" }, needsAi: true };
  return { merchant: { id, name }, needsAi: unsure || !isFixedName(name) };
}
