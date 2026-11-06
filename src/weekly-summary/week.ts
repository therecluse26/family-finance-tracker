import { calendarDateIn } from "../format.ts";
import { daily, type Schedule } from "../jobs/index.ts";
import { addDays } from "../recurring/index.ts";

// The weekly summary email's week (spec 06, Weekly summary email): it goes out on Sunday at 8:00
// AM, Household time, and covers the 7 days from Sunday to Saturday that end the night before.

// The summary's time on Sunday, Household time.
export const SUMMARY_TIME = "08:00";
const SUMMARY_MINUTE = 8 * 60;

// The weekday of a calendar date, 0 for Sunday.
const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

// Sunday at 8:00 AM, Household time, each week.
export const SUNDAY_MORNING: Schedule = {
  next(after, timeZone) {
    const morning = daily(SUMMARY_TIME);
    let at = after;
    for (let day = 0; day < 8; day += 1) {
      at = morning.next(at, timeZone);
      if (weekdayOf(calendarDateIn(at, timeZone)) === 0) return at;
    }
    throw new RangeError("No Sunday within 8 days.");
  },
};

// The minute of the day a clock in `timeZone` shows at `moment`, 0 to 1439.
function minuteIn(moment: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(moment);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((each) => each.type === type)?.value);
  return part("hour") * 60 + part("minute");
}

export type SummaryWeek = {
  // The 7 days the summary covers: a Sunday and the Saturday after it, written YYYY-MM-DD.
  from: string;
  to: string;
  // The 7 days after them, Sunday to Saturday, for the Recurring charges coming up.
  nextFrom: string;
  nextTo: string;
};

// The week of the latest Sunday 8:00 AM at or before `now`, Household time. A run late in the week,
// as after the app was off on Sunday morning, gets the same week, until the next Sunday 8:00 AM.
export function summaryWeek(now: Date, timeZone: string): SummaryWeek {
  const today = calendarDateIn(now, timeZone);
  const weekday = weekdayOf(today);
  const beforeTheTime = weekday === 0 && minuteIn(now, timeZone) < SUMMARY_MINUTE;
  const sunday = addDays(today, beforeTheTime ? -7 : -weekday);
  return {
    from: addDays(sunday, -7),
    to: addDays(sunday, -1),
    nextFrom: sunday,
    nextTo: addDays(sunday, 6),
  };
}
