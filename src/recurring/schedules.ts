// The schedules of a Recurring charge (spec 06, Finding a series), and the twice-a-month schedule
// that only Income series use (spec 05, Steady Income). Dates are calendar dates written
// YYYY-MM-DD, as the bank gives them; the app does not shift them by time zone.

export const SCHEDULES = ["weekly", "every 2 weeks", "monthly", "yearly"] as const;
export type Schedule = (typeof SCHEDULES)[number];

// Twice a month: two fixed days of the month, the earlier first. A day the month lacks means its
// last day, so 31 is the last day of every month.
export type TwiceAMonth = { readonly days: readonly [number, number] };

// The schedule of a series: a Recurring charge's, or an Income series' own.
export type SeriesSchedule = Schedule | TwiceAMonth;

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

// The days from `from` to `to`, negative when `to` is earlier.
export function daysBetween(from: string, to: string): number {
  return Math.round((utcOf(to) - utcOf(from)) / DAY_MS);
}

// Day `day` of the month `months` months after `date`'s month. A day the month lacks means its
// last day.
function dayOfMonth(date: string, months: number, day: number): string {
  const [year = 0, month = 1] = date.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  return dateOf(
    Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, lastDay.getUTCDate())),
  );
}

// The same day `months` months later. A day the month lacks means its last day: Jan 31 plus one
// month is Feb 28, or Feb 29 in a leap year.
export function addMonths(date: string, months: number): string {
  return dayOfMonth(date, months, Number(date.slice(8, 10)));
}

export const isLastDayOfMonth = (date: string) => addDays(date, 1).endsWith("-01");

// The fixed dates of a twice-a-month schedule in the month before `date`'s, its own month, and
// the month after, oldest first.
function fixedDatesAround({ days }: TwiceAMonth, date: string): string[] {
  return [-1, 0, 1].flatMap((months) => days.map((day) => dayOfMonth(date, months, day)));
}

// The fixed date nearest `date`.
function fixedDateOf(schedule: TwiceAMonth, date: string): string {
  let nearest = date;
  let gap = Number.POSITIVE_INFINITY;
  for (const fixed of fixedDatesAround(schedule, date)) {
    const each = Math.abs(daysBetween(fixed, date));
    if (each < gap) [nearest, gap] = [fixed, each];
  }
  return nearest;
}

// The fixed date `count` fixed dates after the one nearest `date`.
function fixedDateAfter(schedule: TwiceAMonth, date: string, count: number): string {
  let fixed = fixedDateOf(schedule, date);
  for (let step = 0; step < count; step += 1) {
    const current = fixed;
    fixed = fixedDatesAround(schedule, current).find((each) => each > current) ?? current;
  }
  return fixed;
}

// The date `count` intervals after `date`.
function intervalsAfter(schedule: SeriesSchedule, date: string, count: number): string {
  if (typeof schedule === "object") return fixedDateAfter(schedule, date, count);
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

// Whether `date` can be part of a series on this schedule. Each Transaction of a twice-a-month
// series lands within the margin of a fixed date; any date fits the other schedules.
export function fitsSchedule(schedule: SeriesSchedule, date: string): boolean {
  if (typeof schedule !== "object") return true;
  return Math.abs(daysBetween(fixedDateOf(schedule, date), date)) <= MARGIN_DAYS;
}

// The next expected date: the last Transaction's date plus one interval. On a twice-a-month
// schedule, the fixed date after the last Transaction's own.
export function nextExpected(schedule: SeriesSchedule, last: string): string {
  return intervalsAfter(schedule, last, 1);
}

// The first and last date within the margin of `count` intervals after `date`. Weekly, every 2
// weeks, twice a month, and monthly allow 2 days each way. Yearly allows 11 to 13 months after the
// previous one, so a month each way.
export function window(
  schedule: SeriesSchedule,
  date: string,
  count = 1,
): { from: string; to: string } {
  if (schedule === "yearly") {
    return { from: addMonths(date, 12 * count - 1), to: addMonths(date, 12 * count + 1) };
  }
  const expected = intervalsAfter(schedule, date, count);
  return { from: addDays(expected, -MARGIN_DAYS), to: addDays(expected, MARGIN_DAYS) };
}

export function inWindow(range: { from: string; to: string }, date: string): boolean {
  return range.from <= date && date <= range.to;
}

// The last day a series stays active with no new Transaction: the next expected date plus 2 days,
// or, for a yearly one, 13 months after its last Transaction. It goes inactive the day after.
export function lastActiveDay(schedule: SeriesSchedule, last: string): string {
  return window(schedule, last, 1).to;
}

// Whether `date` is within the margin of `last` plus a whole number of intervals, as a revival
// must be.
export function onSchedule(schedule: SeriesSchedule, last: string, date: string): boolean {
  if (date <= last) return false;
  if (typeof schedule === "object") {
    return (
      fitsSchedule(schedule, date) && fixedDateOf(schedule, date) > fixedDateOf(schedule, last)
    );
  }
  const days = daysBetween(last, date);
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
