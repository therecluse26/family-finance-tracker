// Business days on the Federal Reserve calendar (spec 03, Windows): weekends and Federal Reserve
// holidays are closed. Dates are calendar dates, written YYYY-MM-DD.
// - A holiday that falls on a Sunday is observed on the Monday after.
// - A holiday that falls on a Saturday is not moved: the Federal Reserve stays open on the Friday
//   before.

const DAY_MS = 86_400_000;

const toDay = (date: string) => Date.parse(`${date}T00:00:00.000Z`) / DAY_MS;
const fromDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

export function addDays(date: string, days: number): string {
  return fromDay(toDay(date) + days);
}

// Calendar days from `from` to `to`; negative when `to` is earlier.
export function daysBetween(from: string, to: string): number {
  return toDay(to) - toDay(from);
}

const pad = (n: number) => String(n).padStart(2, "0");
const dateOf = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;

// The same day `months` months later. A day the month lacks means its last day: Dec 31 plus two
// months is Feb 28, or Feb 29 in a leap year.
export function addMonths(date: string, months: number): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return dateOf(first.getUTCFullYear(), first.getUTCMonth() + 1, Math.min(day, last));
}
const weekday = (date: string) => new Date(`${date}T00:00:00.000Z`).getUTCDay();

// The nth given weekday (0 is Sunday) of a month, or the last one when n is -1.
function nthWeekday(year: number, month: number, day: number, n: number): string {
  if (n === -1) {
    const last = addDays(dateOf(month === 12 ? year + 1 : year, (month % 12) + 1, 1), -1);
    return addDays(last, -((weekday(last) - day + 7) % 7));
  }
  const first = dateOf(year, month, 1);
  return addDays(first, ((day - weekday(first) + 7) % 7) + (n - 1) * 7);
}

// A fixed-date holiday, moved to Monday when it falls on a Sunday.
function observed(date: string): string {
  return weekday(date) === 0 ? addDays(date, 1) : date;
}

const holidaysByYear = new Map<number, Set<string>>();

// The Federal Reserve's holidays in a year, as it observes them.
export function federalReserveHolidays(year: number): Set<string> {
  let holidays = holidaysByYear.get(year);
  if (holidays === undefined) {
    holidays = new Set([
      observed(dateOf(year, 1, 1)), // New Year's Day
      nthWeekday(year, 1, 1, 3), // Birthday of Martin Luther King, Jr.
      nthWeekday(year, 2, 1, 3), // Washington's Birthday
      nthWeekday(year, 5, 1, -1), // Memorial Day
      observed(dateOf(year, 6, 19)), // Juneteenth National Independence Day
      observed(dateOf(year, 7, 4)), // Independence Day
      nthWeekday(year, 9, 1, 1), // Labor Day
      nthWeekday(year, 10, 1, 2), // Columbus Day
      observed(dateOf(year, 11, 11)), // Veterans Day
      nthWeekday(year, 11, 4, 4), // Thanksgiving Day
      observed(dateOf(year, 12, 25)), // Christmas Day
    ]);
    holidaysByYear.set(year, holidays);
  }
  return holidays;
}

export function isBusinessDay(date: string): boolean {
  const day = weekday(date);
  if (day === 0 || day === 6) return false;
  return !federalReserveHolidays(Number(date.slice(0, 4))).has(date);
}

// The date `count` business days after `date`, or before it when `count` is negative. The count
// starts on the next day, so a date on a weekend or holiday is no head start.
export function addBusinessDays(date: string, count: number): string {
  const key = `${date} ${count}`;
  const known = businessDaysFrom.get(key);
  if (known !== undefined) return known;
  const step = count < 0 ? -1 : 1;
  let at = date;
  for (let left = Math.abs(count); left > 0; ) {
    at = addDays(at, step);
    if (isBusinessDay(at)) left -= 1;
  }
  businessDaysFrom.set(key, at);
  return at;
}

// Pairing asks the same few counts from the same dates many times. The calendar never changes.
const businessDaysFrom = new Map<string, string>();
