import { addBusinessDays, isBusinessDay } from "../money-movement/index.ts";

// The schedules of a Recurring charge (spec 06, Finding a series), and the twice-a-month schedule
// that only Income series use (spec 05, Steady Income). Dates are calendar dates written
// YYYY-MM-DD, as the bank gives them; the app does not shift them by time zone.

export const SCHEDULES = ["weekly", "every 2 weeks", "monthly", "yearly"] as const;
export type Schedule = (typeof SCHEDULES)[number];

// A monthly series' fixed day of the month (spec 06, Monthly series). A day the month lacks means
// its last day, so 31 is the last day of every month.
export type Monthly = { readonly fixedDay: number };

// Twice a month: two fixed days of the month, the earlier first. A day the month lacks means its
// last day, so 31 is the last day of every month.
export type TwiceAMonth = { readonly days: readonly [number, number] };

// The schedule of a Recurring charge, as its dates are worked out: a monthly one's from its fixed
// day.
export type ChargeSchedule = Exclude<Schedule, "monthly"> | Monthly;

// The schedule of a series: a Recurring charge's, or an Income series' own.
export type SeriesSchedule = ChargeSchedule | TwiceAMonth;

export const isMonthly = (schedule: SeriesSchedule): schedule is Monthly =>
  typeof schedule === "object" && "fixedDay" in schedule;

// The name a schedule is stored and shown with.
export function scheduleName(schedule: ChargeSchedule): Schedule;
export function scheduleName(schedule: SeriesSchedule): Schedule | "twice a month";
export function scheduleName(schedule: SeriesSchedule): Schedule | "twice a month" {
  if (typeof schedule !== "object") return schedule;
  return isMonthly(schedule) ? "monthly" : "twice a month";
}

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

// A schedule on fixed days of the month: monthly, or twice a month.
type FixedDays = Monthly | TwiceAMonth;

const onFixedDays = (schedule: SeriesSchedule): schedule is FixedDays =>
  typeof schedule === "object";

// The fixed dates of a schedule on fixed days in the month before `date`'s, its own month, and the
// month after, oldest first.
function fixedDatesAround(schedule: FixedDays, date: string): string[] {
  const days = isMonthly(schedule) ? [schedule.fixedDay] : schedule.days;
  return [-1, 0, 1].flatMap((months) => days.map((day) => dayOfMonth(date, months, day)));
}

// The fixed date nearest `date`: the expected date `date` met. The margin and the business-day
// shift reach at most 5 days from it, and fixed dates are at least 10 days apart.
function nearestFixedDate(schedule: FixedDays, date: string): string {
  let nearest = date;
  let gap = Number.POSITIVE_INFINITY;
  for (const fixed of fixedDatesAround(schedule, date)) {
    const each = Math.abs(daysBetween(fixed, date));
    if (each < gap) [nearest, gap] = [fixed, each];
  }
  return nearest;
}

// For one date, on each fixed day 1 to 31: the days from the expected date it met to it (negative
// when early), and whether it lands within that date's margin and business-day shift. Finding a
// series on fixed days asks this of the same dates on every fixed day many times, so each date's answers
// are worked out once. They never change: the dates and the business days are fixed. The cache
// starts over when it holds more dates than about 50 years.
type FixedDayTable = { readonly off: Int8Array; readonly fits: Uint8Array };

const FIXED_DAY_TABLES_MOST = 20_000;
const fixedDayTables = new Map<string, FixedDayTable>();

// The margin and the business-day shift reach at most 5 days from an expected date: at most 3
// days in a row are closed.
const SHIFT_REACH_DAYS = 5;

function fixedDayTableOf(date: string): FixedDayTable {
  const cached = fixedDayTables.get(date);
  if (cached !== undefined) return cached;
  // The first day and the length of the month before `date`'s, its own, and the one after, as
  // days since 1970, so each fixed day's date there is plain arithmetic.
  const [year = 0, month = 1] = date.split("-").map(Number);
  const day = utcOf(date) / DAY_MS;
  const months = [-1, 0, 1].map((step) => ({
    first: Date.UTC(year, month - 1 + step, 1) / DAY_MS,
    length: new Date(Date.UTC(year, month + step, 0)).getUTCDate(),
  }));
  const off = new Int8Array(32);
  const fits = new Uint8Array(32);
  for (let fixedDay = 1; fixedDay <= 31; fixedDay += 1) {
    // The nearest fixed date, the earlier one on a tie, as nearestFixedDate picks it.
    let gap = Number.POSITIVE_INFINITY;
    for (const { first, length } of months) {
      const each = day - (first + Math.min(fixedDay, length) - 1);
      if (Math.abs(each) < Math.abs(gap)) gap = each;
    }
    off[fixedDay] = gap;
    const within =
      Math.abs(gap) <= MARGIN_DAYS ||
      (Math.abs(gap) <= SHIFT_REACH_DAYS &&
        inWindow(marginOf({ fixedDay }, addDays(date, -gap)), date));
    fits[fixedDay] = within ? 1 : 0;
  }
  if (fixedDayTables.size >= FIXED_DAY_TABLES_MOST) fixedDayTables.clear();
  const table = { off, fits };
  fixedDayTables.set(date, table);
  return table;
}

function fixedDateOf(schedule: FixedDays, date: string): string {
  if (!isMonthly(schedule)) return nearestFixedDate(schedule, date);
  return addDays(date, -(fixedDayTableOf(date).off[schedule.fixedDay] ?? 0));
}

// The fixed date `count` fixed dates after the one nearest `date`. Finding twice-a-month series
// asks this of the same dates on every pair of days many times, so each answer is kept, as the
// fixed-day tables are. The cache starts over at about 100 pairs of days on 1,000 dates.
const FIXED_DATES_AFTER_MOST = 100_000;
const fixedDatesAfter = new Map<string, string>();

function fixedDateAfter(schedule: FixedDays, date: string, count: number): string {
  const key = `${isMonthly(schedule) ? schedule.fixedDay : schedule.days.join(",")} ${date} ${count}`;
  const cached = fixedDatesAfter.get(key);
  if (cached !== undefined) return cached;
  let fixed = fixedDateOf(schedule, date);
  for (let step = 0; step < count; step += 1) {
    const current = fixed;
    fixed = fixedDatesAround(schedule, current).find((each) => each > current) ?? current;
  }
  if (fixedDatesAfter.size >= FIXED_DATES_AFTER_MOST) fixedDatesAfter.clear();
  fixedDatesAfter.set(key, fixed);
  return fixed;
}

// The first and last date a Transaction expected on `expected` may land on: within the margin of
// it. On fixed days, monthly or twice a month, an expected date that is not a business day also
// allows the margin of the business day before it and of the business day after it (spec 06,
// Monthly series; spec 05, Steady Income). At most 3 days in a row are closed, so those margins
// overlap: the dates run from 2 days before the business day before to 2 days after the business
// day after.
function marginOf(schedule: SeriesSchedule, expected: string): { from: string; to: string } {
  if (onFixedDays(schedule) && !isBusinessDay(expected)) {
    return {
      from: addDays(addBusinessDays(expected, -1), -MARGIN_DAYS),
      to: addDays(addBusinessDays(expected, 1), MARGIN_DAYS),
    };
  }
  return { from: addDays(expected, -MARGIN_DAYS), to: addDays(expected, MARGIN_DAYS) };
}

// The date `count` intervals after `date`. On fixed days, the fixed date `count` after the one
// `date` met, so an early or late Transaction does not move it.
function intervalsAfter(schedule: SeriesSchedule, date: string, count: number): string {
  if (onFixedDays(schedule)) return fixedDateAfter(schedule, date, count);
  switch (schedule) {
    case "weekly":
      return addDays(date, 7 * count);
    case "every 2 weeks":
      return addDays(date, 14 * count);
    case "yearly":
      return addMonths(date, 12 * count);
  }
}

export function inWindow(range: { from: string; to: string }, date: string): boolean {
  return range.from <= date && date <= range.to;
}

// Whether `date` can be part of a series on this schedule. Each Transaction of a series on fixed
// days lands within the margin of a fixed date, with the business-day shift; any date fits the
// other schedules.
export function fitsSchedule(schedule: SeriesSchedule, date: string): boolean {
  if (!onFixedDays(schedule)) return true;
  const { fits } = fixedDayTableOf(date);
  if (isMonthly(schedule)) return fits[schedule.fixedDay] === 1;
  return fits[schedule.days[0]] === 1 || fits[schedule.days[1]] === 1;
}

// The total days from each of `dates` to the nearest date of `fixedDay`: the expected date each
// one met.
export function daysOffFixedDay(fixedDay: number, dates: readonly string[]): number {
  let total = 0;
  for (const date of dates) total += Math.abs(fixedDayTableOf(date).off[fixedDay] ?? 0);
  return total;
}

// A monthly series' fixed day (spec 06, Monthly series): the day of the month whose expected dates
// are the fewest total days from the series' Transactions, `dates`; a tie takes the earlier day.
// The fixed day is one that every Transaction lands within the margin of, with the business-day
// shift, so the series keeps each one; the day it was found on is always such a day. A series
// stored before this rule may fit none until the next checks find it again: then any day counts.
export function fixedDayOf(dates: readonly string[]): number {
  const tables = dates.map(fixedDayTableOf);
  let best: { fixedDay: number; days: number; fits: boolean } | undefined;
  for (let fixedDay = 1; fixedDay <= 31; fixedDay += 1) {
    let fits = true;
    let days = 0;
    for (const table of tables) {
      fits &&= table.fits[fixedDay] === 1;
      days += Math.abs(table.off[fixedDay] ?? 0);
    }
    if (best === undefined || (fits && !best.fits) || (fits === best.fits && days < best.days)) {
      best = { fixedDay, days, fits };
    }
  }
  return best?.fixedDay ?? 1;
}

// The two days of a twice-a-month schedule are 12 to 18 days apart, such as the 1st and the 15th,
// or the 15th and the last day.
const TWICE_A_MONTH_DAYS_APART = [12, 18] as const;

// Every pair of fixed days a twice-a-month schedule may have, later days first.
const TWICE_A_MONTH_PAIRS: readonly TwiceAMonth[] = (() => {
  const pairs: TwiceAMonth[] = [];
  const [fewest, most] = TWICE_A_MONTH_DAYS_APART;
  for (let later = 31; later >= 1; later -= 1) {
    for (let apart = fewest; apart <= most && later - apart >= 1; apart += 1) {
      pairs.push({ days: [later - apart, later] });
    }
  }
  return pairs.sort((a, b) => b.days[1] - a.days[1] || b.days[0] - a.days[0]);
})();

// The twice-a-month schedules whose fixed dates `date` lands within the margin of, with the
// business-day shift, later days first.
export const twiceAMonthSchedulesOf = (date: string): TwiceAMonth[] =>
  TWICE_A_MONTH_PAIRS.filter((pair) => fitsSchedule(pair, date));

// A twice-a-month series' two fixed days (spec 05, Steady Income): the pairs whose expected dates
// are the fewest total days from the series' Transactions, `dates`, as for a monthly series' fixed
// day. Each is a pair every Transaction lands within the margin of, with the business-day shift,
// when one is. More than one pair ties when the Transactions cannot tell them apart: in February,
// the 28th and the last day. The first, which the series takes, has the later days, so the next
// expected date and the last active day are the latest the tied pairs give; the next Transaction
// may land on any of them, and then the pair is picked again.
export function twiceAMonthDaysOf(dates: readonly string[]): TwiceAMonth[] {
  const tables = dates.map(fixedDayTableOf);
  let best: { pairs: TwiceAMonth[]; days: number; fits: boolean } | undefined;
  for (const pair of TWICE_A_MONTH_PAIRS) {
    const [first, second] = pair.days;
    let fits = true;
    let days = 0;
    for (const { off, fits: fitsDay } of tables) {
      fits &&= fitsDay[first] === 1 || fitsDay[second] === 1;
      days += Math.min(Math.abs(off[first] ?? 0), Math.abs(off[second] ?? 0));
    }
    if (best === undefined || (fits && !best.fits) || (fits === best.fits && days < best.days)) {
      best = { pairs: [pair], days, fits };
    } else if (fits === best.fits && days === best.days) {
      best.pairs.push(pair);
    }
  }
  return best?.pairs ?? [];
}

// The next expected date: the last Transaction's date plus one interval. On fixed days, the fixed
// date after the one the last Transaction met: for a monthly series, the fixed day in the month
// after.
export function nextExpected(schedule: SeriesSchedule, last: string): string {
  return intervalsAfter(schedule, last, 1);
}

// The first and last date within the margin of `count` intervals after `date`. Weekly, every 2
// weeks, twice a month, and monthly allow 2 days each way, and twice a month and monthly also the
// business-day shift. Yearly allows 11 to 13 months after the previous one, so a month each way.
export function window(
  schedule: SeriesSchedule,
  date: string,
  count = 1,
): { from: string; to: string } {
  if (schedule === "yearly") {
    return { from: addMonths(date, 12 * count - 1), to: addMonths(date, 12 * count + 1) };
  }
  return marginOf(schedule, intervalsAfter(schedule, date, count));
}

// The last day a series stays active with no new Transaction: the next expected date plus 2 days;
// for one on fixed days, monthly or twice a month, 2 days after the latest date the business-day
// shift allows; for a yearly one, 13 months after its last Transaction. It goes inactive the day
// after.
export function lastActiveDay(schedule: SeriesSchedule, last: string): string {
  return window(schedule, last, 1).to;
}

// Whether `date` is within the margin of `last` plus a whole number of intervals, as a revival
// must be. On fixed days, within the margin of a later fixed date than the one `last` met.
export function onSchedule(schedule: SeriesSchedule, last: string, date: string): boolean {
  if (date <= last) return false;
  if (onFixedDays(schedule)) {
    return (
      fitsSchedule(schedule, date) && fixedDateOf(schedule, date) > fixedDateOf(schedule, last)
    );
  }
  const days = daysBetween(last, date);
  const roughCount =
    schedule === "weekly" ? days / 7 : schedule === "every 2 weeks" ? days / 14 : days / 365.25;
  const near = Math.round(roughCount);
  for (const count of [near - 1, near, near + 1]) {
    if (count >= 1 && inWindow(window(schedule, last, count), date)) return true;
  }
  return false;
}
