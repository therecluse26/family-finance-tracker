// Numbers the app makes for the AI, in the one form the AI reads them: an amount from whole cents,
// a date, a month, or a count. Each checks its input at run time, so a call never holds a
// half-built number: an amount and a count take a whole number of a capped size, and a date and a
// month take text in that form.

// A number the app made, as a call's pieces and a tool's result hold it.
export type TypedValue = string | number;

// An amount under 10^12 cents, and a count under 10^9.
const AMOUNT_CAP = 10 ** 12;
const COUNT_CAP = 10 ** 9;

const DATE = /^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const MONTH = /^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])$/;

const isDate = (text: unknown): text is string =>
  typeof text === "string" &&
  DATE.test(text) &&
  new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text;
const isMonth = (text: unknown): text is string => typeof text === "string" && MONTH.test(text);
const isCount = (count: unknown): count is number =>
  typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && count < COUNT_CAP;

// Whole cents as dollars, with 2 decimals and no thousands separator, such as "-1234.50".
export function typedAmount(cents: number): string {
  if (typeof cents !== "number" || !Number.isSafeInteger(cents) || Math.abs(cents) >= AMOUNT_CAP) {
    throw new TypeError("An amount is a whole number of cents under 10^12.");
  }
  const size = Math.abs(cents);
  const sign = cents < 0 ? "-" : "";
  return `${sign}${Math.floor(size / 100)}.${String(size % 100).padStart(2, "0")}`;
}

// A real date, written YYYY-MM-DD.
export function typedDate(date: string): string {
  if (!isDate(date)) throw new TypeError("A date is written YYYY-MM-DD.");
  return date;
}

// A month, written YYYY-MM.
export function typedMonth(month: string): string {
  if (!isMonth(month)) throw new TypeError("A month is written YYYY-MM.");
  return month;
}

// A count of rows, such as Transactions that match.
export function typedCount(count: number): number {
  if (!isCount(count)) throw new TypeError("A count is a whole number under 10^9.");
  return count;
}
