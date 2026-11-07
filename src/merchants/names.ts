import { leftLeadIns, markAccountNumbers, plainForms } from "./lead-ins.ts";
import { paymentAppLine } from "./payment-apps.ts";

// Merchant names (spec 04, Names). The provider's Merchant name wins. Otherwise fixed rules clean
// the bank's original description: they remove store numbers, payment-processor prefixes, cities,
// dates, and card and Account numbers with the words that introduce them, such as "ACCT ENDING"
// (lead-ins.ts). A card payment line gets the name "<bank> card payment". A name the rules cannot
// fix keeps the rule-cleaned text and is marked for AI cleanup, which runs later in the
// categorization step. When a rule cannot decide, it marks the name for AI
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

// The 50 states, DC, and Puerto Rico. A bank puts a city and its state at the end of a
// description.
const STATES = new Set(
  (
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV " +
    "NH NJ NM NY NC ND OH OK OR PA PR RI SC SD TN TX UT VT VA WA WV WI WY"
  ).split(" "),
);

// Descriptions of a paper check. A check has no Merchant.
const CHECK = /^(?:CHECK|CHK|CHEQUE)(?:\s+PAID)?\s*(?:#|NO\.?|NUMBER)?\s*\d*$/i;

// A word that is only digits or symbols. A modifier letter, such as "ｰ" in "4ｰ8ｰ2ｰ1", looks like
// a symbol, so it counts as one.
const NO_LETTERS = /^[\P{L}\p{Lm}]+$/u;

function words(text: string): string[] {
  return text.split(/\s+/).filter((word) => word !== "");
}

// A word of digits and symbols with 4 or more digits, such as "4.8.2.1", is a number too.
const isNumber = (word: string) =>
  word === PHONE_MARK ||
  NUMBER_WORD.test(word) ||
  (NO_LETTERS.test(word) && (word.match(/\d/g)?.length ?? 0) >= 4);
const isState = (word: string) => STATES.has(word.toUpperCase());

// The first number with a name before it and the store's place after it, or -1. After a phone
// number the place always is. After a store number it is when the words after it, numbers left
// out, are 1 to 4 words that end in a state code. One pass from the end, so a long line costs no
// more than its length.
function placeIndex(parts: readonly string[]): number {
  const numbers = parts.map(isNumber);
  const lastNamed = numbers.lastIndexOf(false);
  const lastIsState = lastNamed >= 0 && isState(parts[lastNamed] ?? "");
  const namedAfter: number[] = new Array(parts.length + 1).fill(0);
  for (let index = parts.length - 1; index >= 0; index--) {
    namedAfter[index] = (namedAfter[index + 1] ?? 0) + (numbers[index] ? 0 : 1);
  }
  return parts.findIndex((word, index) => {
    if (index === 0 || !numbers[index]) return false;
    if (word === PHONE_MARK) return true;
    const named = namedAfter[index + 1] ?? 0;
    return named >= 1 && named <= 4 && lastIsState && lastNamed > index;
  });
}

// "TRADER" is "Trader". A word with "&", such as H&M or AT&T, keeps its case.
const titleWord = (word: string) =>
  word.includes("&")
    ? word
    : word
        .toLowerCase()
        .replace(/(^|[-/])(\p{L})/gu, (_, before, letter) => before + letter.toUpperCase());

// "TRADER JOE'S" is "Trader Joe's". Text with any lowercase letter keeps its case.
function titleCase(text: string): string {
  if (/\p{Ll}/u.test(text)) return text;
  return words(text).map(titleWord).join(" ");
}

// The rules' words for one bank description, before title case. `unsure` when a card number or a
// lead-in may be left. On a card payment line, "CARD" with 4 digits after it is a card number.
function cleanWords(
  description: string,
  options: { cardPayment: boolean },
): { parts: string[]; unsure: boolean } {
  let text = plainForms(description).replace(/\s+/g, " ").trim();
  for (let before = ""; before !== text; ) {
    before = text;
    text = text.replace(LEAD_IN, "").replace(PROCESSOR, "").trim();
  }
  // A card or Account number, with its lead-in, becomes one number for the rules below.
  const numbers = markAccountNumbers(text, "#", options);
  text = numbers.text.replace(PHONE, ` ${PHONE_MARK} `);
  for (const date of DATES) text = text.replace(date, " ");
  text = text.replace(REFERENCE, " ").replace(STORE_WORDS, " # ").replace(/\*/g, " ");

  // A store number or phone number with a name before it, and the store's place after it: the
  // place goes. A number with no place after it goes alone.
  let parts = words(text);
  const place = placeIndex(parts);
  if (place > 0) parts = parts.slice(0, place);
  parts = parts.filter((word) => !isNumber(word));

  // Loose symbols left at the ends of words, such as a trailing "-", ":", or "#".
  parts = parts.map((word) => word.replace(/^[-,:#]+|[-,:#]+$/g, "")).filter((word) => word !== "");

  // A lead-in the bank cut short at the end goes. Any lead-in left makes the rules unsure.
  const left = leftLeadIns(parts.join(" "));
  parts = words(left.name);

  return { parts, unsure: numbers.unsure || left.unsure };
}

// A last word that may be a state code, with nothing that marks a place: it may be a city and
// state, or part of the name, as in BEST BUY CO. The rules do not guess.
function endsInState(parts: readonly string[]): boolean {
  const last = parts.at(-1);
  return parts.length > 1 && last !== undefined && isState(last);
}

// The fixed cleanup rules on one bank description, with no provider data and no AI. `unsure` is
// set when a rule could not decide, such as a last word that may be a state code with nothing
// before it that marks a place, or a lead-in left in the name.
export function cleanDescription(description: string): { name: string; unsure: boolean } {
  const { parts, unsure } = cleanWords(description, { cardPayment: false });
  return { name: titleCase(parts.join(" ")), unsure: unsure || endsInState(parts) };
}

// Plaid's category for a card payment, on either side.
const CARD_PAYMENT = "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT";

// The words of a card payment line that name the payment, not the bank.
const PAYMENT_WORDS = new Set(
  (
    "payment payments epayment pmt pmts pymt pymnt pymnts paymt pmnt pay paid autopay autopmt " +
    "auto automatic epay e-pay e-payment e-pmt online mobile web internet banking phone tel " +
    "thank thanks you thankyou card crd cd dc bill billpay received recd rcvd ach to id ppd ccd " +
    "web acct account ending in ref conf confirmation transfer xfer electronic elec recurring"
  ).split(" "),
);
// "CREDIT" names the payment only before "CARD", so "CREDIT ONE BANK" keeps it.
const CREDIT_CARD = /^credit$/i;
const CARD_WORD = /^(?:card|crd|cd)$/i;
// Words that say the line names a person who paid, as in "PAYMENT FROM JAMIE RIVERA".
const PERSON_WORDS = /^(?:from|by|for|per)$/i;
// An ACH line's fields, such as "DES:", "INDN:", "IND NAME:", or "CO ID:". The bank comes before
// them, or after "ORIG CO NAME:", and the payer's name is in one of them. A run of 6 or more digits
// is an ID, and a bank such as Wells Fargo puts the payer's name after it with no field name.
const ORIGINATOR = /\bORIG(?:INATOR)?\s?CO\s?NAME\s?:\s?/i;
const ACH_FIELD_NAMES = [
  "DES",
  "DESCR",
  "INDN",
  "IND\\s?NAME",
  "IND\\s?ID",
  "NAME",
  "CO\\s?ID",
  "ORIG\\s?ID",
  "CO\\s?ENTRY\\s?DESCR",
  "RECEIVER",
  "RECV",
  "TRN",
  "SEC",
  "TRACE",
  "EED",
  "DESC\\s?DATE",
];
const ACH_FIELD = new RegExp(`\\b(?:${ACH_FIELD_NAMES.join("|")})\\s?[:#]|\\d{6,}`, "i");

// The bank a card payment line names: Plaid's financial institution on the line, when it has one.
// Otherwise the rule-cleaned line up to its first ACH field, with no payment words, when the rules
// are sure: a known card issuer's words at the start, title-cased as other clean names are, and
// nothing that may name a person. `bank` is null when the rules are not sure.
function cardPaymentBank(txn: {
  description: string;
  counterparties?: readonly { name: string; type: string }[];
}): { bank: string | null } {
  const institution = txn.counterparties
    ?.find((party) => party.type === "financial_institution")
    ?.name.replace(/\s+/g, " ")
    .trim();
  if (institution !== undefined && institution !== "") return { bank: institution };

  let text = plainForms(txn.description);
  const originator = ORIGINATOR.exec(text);
  if (originator !== null) text = text.slice(originator.index + originator[0].length);
  const field = ACH_FIELD.exec(text);
  if (field !== null) text = text.slice(0, field.index);
  const cleaned = cleanWords(text, { cardPayment: true });
  if (cleaned.unsure) return { bank: null };

  const kept: string[] = [];
  const parts = cleaned.parts;
  for (const [index, word] of parts.entries()) {
    if (PERSON_WORDS.test(word)) return { bank: null };
    if (PAYMENT_WORDS.has(word.toLowerCase())) continue;
    if (CREDIT_CARD.test(word) && CARD_WORD.test(parts[index + 1] ?? "")) continue;
    const pieces = word.split(/[-/:]/).filter((piece) => !PAYMENT_WORDS.has(piece.toLowerCase()));
    const rest = pieces.join("-").replace(/^[-,:#.]+|[-,:#.]+$/g, "");
    if (rest !== "") kept.push(rest);
  }
  // A word that starts with an earlier one names the payment, as in "CITI ... CITICARDAP". Only
  // the first words can name an issuer, so only they are read, and a long line costs no more
  // than a short one (K3).
  const first = kept.slice(0, LONGEST_ISSUER).map((word) => word.toLowerCase());
  const bank = kept
    .slice(0, LONGEST_ISSUER)
    .filter(
      (_, index) => !first.slice(0, index).some((before) => first[index]?.startsWith(before)),
    );
  if (bank.length === 0) return { bank: "" };
  return { bank: issuerOf(bank) };
}

// The card issuers the rules know by name. The words after an issuer's name may be the payer, as
// in `CHASE CREDIT CRD EPAY 260105 8273645101 JAMIE RIVERA`, so they go. A line that starts with
// any other word is not sure to name a bank, so the name goes to AI cleanup. Each issuer maps to
// the form the bank itself writes, such as "WF" or "Bank of America".
const CARD_ISSUERS = new Map([
  ["alliant", "Alliant"],
  ["american express", "American Express"],
  ["amex", "Amex"],
  ["bank of america", "Bank of America"],
  ["barclaycard", "Barclaycard"],
  ["barclays", "Barclays"],
  ["bmo", "BMO"],
  ["boa", "BoA"],
  ["bofa", "BofA"],
  ["capital one", "Capital One"],
  ["chase", "Chase"],
  ["citi", "Citi"],
  ["citibank", "Citibank"],
  ["citizens", "Citizens"],
  ["comenity", "Comenity"],
  ["credit one", "Credit One"],
  ["credit one bank", "Credit One Bank"],
  ["discover", "Discover"],
  ["elan", "Elan"],
  ["fifth third", "Fifth Third"],
  ["first national bank of omaha", "First National Bank of Omaha"],
  ["first premier", "First Premier"],
  ["fnbo", "FNBO"],
  ["goldman sachs", "Goldman Sachs"],
  ["hsbc", "HSBC"],
  ["huntington", "Huntington"],
  ["jpmorgan chase", "JPMorgan Chase"],
  ["merrick bank", "Merrick Bank"],
  ["mission lane", "Mission Lane"],
  ["navy federal", "Navy Federal"],
  ["penfed", "PenFed"],
  ["pnc", "PNC"],
  ["regions", "Regions"],
  ["synchrony", "Synchrony"],
  ["synchrony bank", "Synchrony Bank"],
  ["td bank", "TD Bank"],
  ["truist", "Truist"],
  ["us bank", "US Bank"],
  ["usaa", "USAA"],
  ["usbank", "USBank"],
  ["wells fargo", "Wells Fargo"],
  ["wf", "WF"],
]);
const LONGEST_ISSUER = Math.max(...[...CARD_ISSUERS.keys()].map((name) => name.split(" ").length));

// The known card issuer the first words name, longest first, in its own form, or null.
function issuerOf(bank: readonly string[]): string | null {
  const folded = bank.map((word) => word.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase());
  for (let count = Math.min(LONGEST_ISSUER, folded.length); count > 0; count--) {
    const issuer = CARD_ISSUERS.get(folded.slice(0, count).join(" "));
    if (issuer !== undefined) return issuer;
  }
  return null;
}

// A card payment line, which Plaid files under its credit card payment code, is named
// "<bank> card payment", such as "Chase card payment", or "Card payment" when it names no bank
// (spec 04, Names). When the rules are not sure of the bank, the name is "Card payment" and is
// marked for AI cleanup. The card's last 4 never stays in the name.
function cardPaymentName(txn: {
  description: string;
  counterparties?: readonly { name: string; type: string }[];
}): { name: string; needsAi: boolean } {
  const { bank } = cardPaymentBank(txn);
  if (bank === null) return { name: "Card payment", needsAi: true };
  return { name: bank === "" ? "Card payment" : `${bank} card payment`, needsAi: false };
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
    const { name, needsAi } = cardPaymentName(txn);
    return { merchant: { id, name }, needsAi };
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
