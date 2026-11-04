// The schedules of a Recurring charge (spec 06, Finding a series). Dates are calendar dates written
// YYYY-MM-DD, as the bank gives them; the app does not shift them by time zone.

export const SCHEDULES = ["weekly", "every 2 weeks", "monthly", "yearly"] as const;
export type Schedule = (typeof SCHEDULES)[number];

// The margin around an expected date, in days, for every schedule but yearly.
const MARGIN_DAYS = 2;

const DAY_MS = 86_400_000;

function utcOf(date: string): number {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function dateOf(utc: number): string {
  return new Date(utc).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return dateOf(utcOf(date) + days * DAY_MS);
}

// The same day `months` months later. A day the month lacks means its last day: Jan 31 plus one
// month is Feb 28, or Feb 29 in a leap year.
export function addMonths(date: string, months: number): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  return dateOf(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, lastDay.getUTCDate())),
  );
}

// The date `count` intervals after `date`.
function intervalsAfter(schedule: Schedule, date: string, count: number): string {
  switch (schedule) {
    case "weekly":
      return addDays(date, 7 * count);
    case "every 2 weeks":
      return addDays(date, 14 * count);
    case "monthly":
      return addMonths(date, count);
    case "yearly":
      return addMonths(date, 12 * count);
  }
}

// The next expected date: the last Transaction's date plus one interval.
export function nextExpected(schedule: Schedule, last: string): string {
  return intervalsAfter(schedule, last, 1);
}

// The first and last date within the margin of `count` intervals after `date`. Weekly, every 2
// weeks, and monthly allow 2 days each way. Yearly allows 11 to 13 months after the previous one,
// so a month each way.
export function window(schedule: Schedule, date: string, count = 1): { from: string; to: string } {
  if (schedule === "yearly") {
    return { from: addMonths(date, 12 * count - 1), to: addMonths(date, 12 * count + 1) };
  }
  const expected = intervalsAfter(schedule, date, count);
  return { from: addDays(expected, -MARGIN_DAYS), to: addDays(expected, MARGIN_DAYS) };
}

export function inWindow(range: { from: string; to: string }, date: string): boolean {
  return range.from <= date && date <= range.to;
}

// The last day a Recurring charge stays active with no new Transaction: the next expected date
// plus 2 days, or, for a yearly one, 13 months after its last Transaction. It goes inactive the
// day after.
export function lastActiveDay(schedule: Schedule, last: string): string {
  return window(schedule, last, 1).to;
}

// Whether `date` is within the margin of `last` plus a whole number of intervals, as a revival
// must be.
export function onSchedule(schedule: Schedule, last: string, date: string): boolean {
  if (date <= last) return false;
  const days = (utcOf(date) - utcOf(last)) / DAY_MS;
  const roughCount =
    schedule === "weekly"
      ? days / 7
      : schedule === "every 2 weeks"
        ? days / 14
        : schedule === "monthly"
          ? days / 30.44
          : days / 365.25;
  const near = Math.round(roughCount);
  for (const count of [near - 1, near, near + 1]) {
    if (count >= 1 && inWindow(window(schedule, last, count), date)) return true;
  }
  return false;
}
