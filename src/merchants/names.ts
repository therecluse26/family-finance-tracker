import { paymentAppLine } from "./payment-apps.ts";

// Merchant names (spec 04, Names). The provider's Merchant name wins. Otherwise fixed rules clean
// the bank's original description: they remove store numbers, payment-processor prefixes, cities,
// dates, and card and Account numbers with the words that introduce them, such as "ACCT ENDING". A
// card payment line gets the name "<bank> card payment". A name the rules cannot fix keeps the rule-cleaned text and is marked for AI cleanup,
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

// Account-number lead-ins: the words that introduce a card or Account number, such as "ENDING IN",
// "ACCT ENDING", "CARD ENDING IN", "ACCOUNT #", "ACCT NO.", "LAST 4", or a mask such as "XXXX".
// Each goes with the number it introduced, wherever it stands. Between its words, and before the
// number, any short run of characters that are not letters or digits is a gap, so "ENDING-IN",
// "ACCT_ENDING", and "ENDING IN: X-4821" match too. A word inside a longer word, as in
// "NEVERENDING", is no lead-in.
const GAP = String.raw`[^\p{L}\p{N}]{1,3}`;
const ACCOUNT_WORD = `(?:acct|accnt|account|acc|a/c|card|crd)`;
const ENDING = `(?:ending|ends)(?:${GAP}(?:in|with))?`;
const LAST_FOUR = `last${GAP}(?:4|four)(?:${GAP}digits)?`;
const NUMBER_LABEL = `(?:no|nbr|num|number)`;
const MASK = `(?:[x*•]+)`;
const WORD_START = String.raw`(?<![\p{L}\p{N}])`;
const WORD_END = String.raw`(?!\p{L})`;
const SEP = String.raw`[^\p{L}\p{N}]{0,4}`;
const ACCOUNT_LEAD_IN = new RegExp(
  [
    // "ACCT ENDING", "CARD NO.", "ENDING IN", or "LAST 4", then any number.
    String.raw`(?:${ACCOUNT_WORD}${GAP}(?:${ENDING}|${LAST_FOUR}|${NUMBER_LABEL})|${ENDING}|${LAST_FOUR})(?:${SEP}${MASK})?${SEP}(?=\d)`,
    // "CARD" or "ACCT" alone, then a masked number or 4 digits. "GIFT CARD 25" keeps its words.
    String.raw`${ACCOUNT_WORD}${WORD_END}(?:${SEP}${MASK}${SEP}(?=\d)|${SEP}(?=\d{4}))`,
    // A mask alone, such as "XXXX 4821" or "•• 4821", or one "X" before 4 digits.
    String.raw`(?:x{2,}|[*•]+)(?:${SEP}${MASK})?${SEP}(?=\d)`,
    String.raw`x(?:${SEP}${MASK})?${SEP}(?=\d{4})`,
  ]
    .map((form) => WORD_START + form)
    .join("|"),
  "giu",
);
// A lead-in that ends the line with no number after it, as when the bank cut the line short:
// "CHASE CARD ENDING IN". It goes too, and the rules mark the name for AI cleanup, since they cannot
// be sure. A lone "ENDING" stays, as in "BLUEBIRD BOOKS ENDING".
const CUT_LEAD_IN = new RegExp(
  WORD_START +
    `(?:${ACCOUNT_WORD}${GAP}(?:${ENDING}|${LAST_FOUR}|${NUMBER_LABEL})|(?:ending|ends)${GAP}in|${LAST_FOUR})` +
    String.raw`[^\p{L}\p{N}]*$`,
  "iu",
);

// Every Unicode digit becomes 0 to 9, so a full-width or other script's number is a number to the
// rules. Unicode gives each script's digits as a run of ten, from 0 to 9, so a digit's value is
// its place in its run. A full-width letter or symbol becomes its plain form, every dash becomes
// "-", and format characters, such as a zero-width space, go.
const IS_DIGIT = /^\p{Nd}$/u;
const digitValues = new Map<string, string>();

function asciiDigit(char: string): string {
  let value = digitValues.get(char);
  if (value === undefined) {
    const code = char.codePointAt(0) ?? 0;
    let zero = code;
    while (IS_DIGIT.test(String.fromCodePoint(zero - 1))) zero--;
    value = String((code - zero) % 10);
    digitValues.set(char, value);
  }
  return value;
}

function plainForms(text: string): string {
  return text
    .replace(/\p{Cf}/gu, "")
    .replace(/[\uFF01-\uFF5E]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[^\0-\x7F]/gu, (char) => (IS_DIGIT.test(char) ? asciiDigit(char) : char))
    .replace(/\p{Pd}/gu, "-");
}

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
  let text = plainForms(description).replace(/\s+/g, " ").trim();
  for (let before = ""; before !== text; ) {
    before = text;
    text = text.replace(LEAD_IN, "").replace(PROCESSOR, "").trim();
  }
  // An account-number lead-in goes, and the number after it goes with the other numbers below.
  text = text.replace(ACCOUNT_LEAD_IN, " ");
  const cut = CUT_LEAD_IN.test(text);
  if (cut) text = text.replace(CUT_LEAD_IN, "");
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
  const unsure = cut || (parts.length > 1 && last !== undefined && isState(last));
  return { name: titleCase(parts.join(" ")), unsure };
}

// Plaid's category for a card payment, on either side.
const CARD_PAYMENT = "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT";

// The words of a card payment line that name the payment, not the bank.
const PAYMENT_WORDS = new Set(
  (
    "payment payments epayment pmt pymt pymnt paymt pmnt pay paid autopay autopmt auto epay e-pay " +
    "e-payment e-pmt online mobile web internet phone tel thank thanks you thankyou card crd " +
    "bill billpay received recd rcvd ach to from id ppd ccd acct account ending in ref conf " +
    "transfer xfer electronic elec recurring"
  ).split(" "),
);
// "CREDIT" names the payment only before "CARD", so "CREDIT ONE BANK" keeps it.
const CREDIT_CARD = /^credit$/i;
const CARD_WORD = /^(?:card|crd|cd)$/i;

// The bank a card payment line names: the rule-cleaned line, with no payment words, up to an ACH
// field such as "DES:", which names the payment and the payer. Empty when it names no bank.
function cardPaymentBank(description: string): string {
  const [before = ""] = plainForms(description).split(/\s(?:DES|INDN|CO ID):/i);
  const kept: string[] = [];
  const parts = words(cleanDescription(before).name);
  parts.forEach((word, index) => {
    if (PAYMENT_WORDS.has(word.toLowerCase())) return;
    if (CREDIT_CARD.test(word) && CARD_WORD.test(parts[index + 1] ?? "")) return;
    const pieces = word.split(/[-/:]/).filter((piece) => !PAYMENT_WORDS.has(piece.toLowerCase()));
    const rest = pieces.join("-").replace(/^[-,:#.]+|[-,:#.]+$/g, "");
    if (rest !== "") kept.push(rest);
  });
  return kept.length <= 4 ? kept.join(" ") : "";
}

// A card payment line, which Plaid files under its credit card payment code, is named
// "<bank> card payment", such as "Chase card payment", or "Card payment" when it names no bank
// (spec 04, Names). The card's last 4 never stays in the name.
function cardPaymentName(description: string): string {
  const bank = cardPaymentBank(description);
  return bank === "" ? "Card payment" : `${bank} card payment`;
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
// purchase. A card payment line with no provider Merchant name is "<bank> card payment".
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

  if (txn.category?.name === CARD_PAYMENT) {
    return { merchant: { id, name: cardPaymentName(txn.description) }, needsAi: false };
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
