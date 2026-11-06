// Typed values in a tool's result and in a Quick batch row (spec 08, Privacy filter). A typed value
// is one the app computes and formats itself: an amount from whole cents, a date, a month, or a
// count. It holds only digits, "-", and ".", so it can hold no Member name, no account number, no
// ZIP code, and no age by construction, and the privacy filter does not run on it: the AI reads
// "-48.21" as the app built it, even when an Account's last 4 is 4821. Every text field, such as a
// Merchant name, a description, or an Account label, still goes through the full filter. A typed
// value is not Member-typed text, which is the other way round: a Member wrote it, and the filter
// does its best on it.
//
// Only the functions here make a typed value. Each checks its input at run time: an amount and a
// count take a whole number of a capped size, and a date and a month take text in that form, so
// text a provider or a Member wrote is never marked typed: a Merchant name passed as a date
// throws. The caps keep a typed value under 12 digits, shorter than any card number. In a tool's
// result and in a batch row, a typed value is a plain object with one field, the mark, so it stays
// marked as the AI SDK copies the result as JSON and as the row is written as JSON. The mark's
// field name holds random digits made at start-up, so no text can spell it. The privacy filter
// checks its form again on the way out, keeps it unfiltered only inside a tool result or a batch
// row, and sends its bare value: the AI never reads the mark.

// The mark's field name, new each time the app starts. Only this file reads it.
const MARK = `typed value ${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
  byte.toString(16).padStart(2, "0"),
).join("")}`;

declare const typedBrand: unique symbol;

// A typed value as a tool's result holds it.
export type TypedValue = Readonly<Record<string, string | number>> & {
  readonly [typedBrand]: true;
};

// An amount under 10^12 cents, and a count under 10^9.
const AMOUNT_CAP = 10 ** 12;
const COUNT_CAP = 10 ** 9;

// Up to 10 dollar digits and 2 cents digits: under 10^12 cents.
const AMOUNT = /^-?(?:0|[1-9]\d{0,9})\.\d{2}$/;
const DATE = /^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const MONTH = /^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])$/;

const isDate = (text: unknown): text is string =>
  typeof text === "string" &&
  DATE.test(text) &&
  new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text;
const isMonth = (text: unknown): text is string => typeof text === "string" && MONTH.test(text);
const isCount = (count: unknown): count is number =>
  typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && count < COUNT_CAP;

// Whether a bare value has a typed value's form: an amount with 2 decimals, a real date, a month,
// or a count.
function isTypedForm(value: unknown): value is string | number {
  if (typeof value === "number") return isCount(value);
  return typeof value === "string" && (AMOUNT.test(value) || isDate(value) || isMonth(value));
}

const typed = (value: string | number) => ({ [MARK]: value }) as unknown as TypedValue;

// Whole cents as dollars, with 2 decimals and no thousands separator, such as "-1234.50".
export function typedAmount(cents: number): TypedValue {
  if (typeof cents !== "number" || !Number.isSafeInteger(cents) || Math.abs(cents) >= AMOUNT_CAP) {
    throw new TypeError("An amount is a whole number of cents under 10^12.");
  }
  const size = Math.abs(cents);
  const sign = cents < 0 ? "-" : "";
  return typed(`${sign}${Math.floor(size / 100)}.${String(size % 100).padStart(2, "0")}`);
}

// A real date, written YYYY-MM-DD.
export function typedDate(date: string): TypedValue {
  if (!isDate(date)) throw new TypeError("A date is written YYYY-MM-DD.");
  return typed(date);
}

// A month, written YYYY-MM.
export function typedMonth(month: string): TypedValue {
  if (!isMonth(month)) throw new TypeError("A month is written YYYY-MM.");
  return typed(month);
}

// A count of rows, such as Transactions that match.
export function typedCount(count: number): TypedValue {
  if (!isCount(count)) throw new TypeError("A count is a whole number under 10^9.");
  return typed(count);
}

// The bare value of a typed value, or undefined for anything else. A value marked typed with
// another form, or with another field next to the mark, is refused.
export function typedValueOf(value: unknown): string | number | undefined {
  if (value === null || typeof value !== "object" || !Object.hasOwn(value, MARK)) {
    return undefined;
  }
  const bare = (value as Record<string, unknown>)[MARK];
  if (Object.keys(value).length !== 1 || !isTypedForm(bare)) {
    throw new TypeError("A typed value holds one amount, date, month, or count.");
  }
  return bare;
}
