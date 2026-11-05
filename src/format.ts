// The shared number formats and status words (spec 07, Shared visual rules). The server and the
// web app both use this file, for pages and for Alert templates, so it uses no Node or browser API.

// A true minus sign, never a hyphen.
export const MINUS = "−";

function checkCents(cents: number): void {
  if (!Number.isSafeInteger(cents))
    throw new RangeError(`An amount must be whole cents, not ${cents}.`);
}

// Thousands commas, such as 12,480.
function withCommas(whole: number): string {
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// "−" for money out. "+" for money in only when `signed` is set, where both appear together.
function sign(negative: boolean, positive: boolean, signed: boolean): string {
  if (negative) return MINUS;
  return signed && positive ? "+" : "";
}

export type MoneyOptions = {
  // Shows "+" on money in, where money in and money out appear together, as in Coming up.
  signed?: boolean;
};

// Whole dollars, rounded to the nearest dollar: for totals, Budgets, balances, projections, and AI
// text. 1248000 cents is "$12,480". A half dollar rounds away from zero.
export function wholeDollars(cents: number, options: MoneyOptions = {}): string {
  checkCents(cents);
  const dollars = Math.floor((Math.abs(cents) + 50) / 100);
  return `${sign(cents < 0 && dollars > 0, dollars > 0, options.signed ?? false)}$${withCommas(dollars)}`;
}

// Dollars and cents, where one Transaction or one charge shows. 124850 cents is "$1,248.50".
export function dollarsAndCents(cents: number, options: MoneyOptions = {}): string {
  checkCents(cents);
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, "0");
  return `${sign(cents < 0, cents > 0, options.signed ?? false)}$${withCommas(dollars)}.${rest}`;
}

// A whole-number percent: 0.412 is "41%". A half rounds away from zero.
export function percent(ratio: number): string {
  if (!Number.isFinite(ratio))
    throw new RangeError(`A percent needs a finite ratio, not ${ratio}.`);
  const whole = Math.floor(Math.abs(ratio) * 100 + 0.5);
  return `${ratio < 0 && whole > 0 ? MINUS : ""}${whole}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// A calendar date written YYYY-MM-DD, as app.db stores it.
function partsOf(date: string): { year: string; month: string; day: number } {
  const [, year, month, day] = CALENDAR_DATE.exec(date) ?? [];
  const name = MONTHS[Number(month) - 1];
  if (year === undefined || name === undefined || day === undefined || Number(day) < 1) {
    throw new RangeError(`A calendar date must be written YYYY-MM-DD, not "${date}".`);
  }
  return { year, month: name, day: Number(day) };
}

// "Oct 9" within the current year, and "Oct 9, 2025" otherwise. `today` is the Household's
// date, YYYY-MM-DD.
export function dateLabel(date: string, today: string): string {
  const { year, month, day } = partsOf(date);
  return year === partsOf(today).year ? `${month} ${day}` : `${month} ${day}, ${year}`;
}

// A chart label: "Oct 2025".
export function monthLabel(date: string): string {
  const { year, month } = partsOf(date);
  return `${month} ${year}`;
}

function partsIn(
  moment: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): Map<string, string> {
  const parts = new Intl.DateTimeFormat("en-US", { ...options, timeZone }).formatToParts(moment);
  return new Map(parts.map((part) => [part.type, part.value]));
}

// The calendar date of a moment in a time zone, such as the Household's, written YYYY-MM-DD.
export function calendarDateIn(moment: Date, timeZone: string): string {
  const parts = partsIn(moment, timeZone, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
}

// A 12-hour time in a time zone, such as the Household's: "8:15 AM".
export function timeLabel(moment: Date, timeZone: string): string {
  const parts = partsIn(moment, timeZone, { hour: "numeric", minute: "2-digit", hour12: true });
  return `${parts.get("hour")}:${parts.get("minute")} ${parts.get("dayPeriod")?.toUpperCase()}`;
}

// Status: color, icon, and word together. Color never carries meaning alone, so each tone has
// its icon, and each status shows a word from the spec's table.
export type StatusTone = "critical" | "serious" | "good" | "accent" | "muted";

export const STATUS_ICON: Record<StatusTone, string> = {
  critical: "▲",
  serious: "◆",
  good: "✓",
  accent: "●",
  muted: "●",
};

// The words each tone may show.
export type StatusWord<Tone extends StatusTone> = {
  critical: "Over Budget" | `${string} over`;
  serious:
    | "On pace to go over"
    | `${number} on pace to go over`
    | `on pace for ${string}`
    | "Behind"
    | "Worth acting on";
  good: "On track" | "on track" | "under Budget" | "Done" | "Good news";
  accent: "Heads up";
  muted: "about usual";
}[Tone];

// The status as plain text, such as "▲ Over Budget", for an Alert or a System notice.
export function statusText<Tone extends StatusTone>(tone: Tone, word: StatusWord<Tone>): string {
  return `${STATUS_ICON[tone]} ${word}`;
}

// Direction against usual: "▲ $40 above usual". More Spending or Debt is bad; more Income or Cash
// on hand is good. A good change is green and a bad one orange; no change is grey.
export type Direction = { tone: "good" | "serious" | "muted"; text: string };

export function directionAgainstUsual(changeCents: number, moreIs: "good" | "bad"): Direction {
  const amount = wholeDollars(Math.abs(changeCents));
  if (amount === "$0") return { tone: "muted", text: statusText("muted", "about usual") };
  const up = changeCents > 0;
  const good = up === (moreIs === "good");
  return {
    tone: good ? "good" : "serious",
    text: `${up ? "▲" : "▼"} ${amount} ${up ? "above" : "below"} usual`,
  };
}
