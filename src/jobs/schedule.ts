// When a scheduled task runs, in the Household time zone.
export type Schedule = {
  // The first run time after `after`, which a moment in UTC gives.
  next(after: Date, timeZone: string): Date;
};

type WallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
};

const HOUR_MS = 60 * 60 * 1000;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formats = new Map<string, Intl.DateTimeFormat>();

function formatFor(timeZone: string): Intl.DateTimeFormat {
  let format = formats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formats.set(timeZone, format);
  }
  return format;
}

// The date and time a wall clock in `timeZone` shows at `instant`.
function wallClockAt(instant: number, timeZone: string): Required<WallClock> {
  const parts = formatFor(timeZone).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
  };
}

// Date.UTC carries a day past the month's end into the next month.
function asUtc(wall: WallClock): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second ?? 0);
}

// How far the wall clock in `timeZone` is ahead of UTC at `instant`, in milliseconds.
function offsetAt(instant: number, timeZone: string): number {
  return asUtc(wallClockAt(instant, timeZone)) - Math.floor(instant / 1000) * 1000;
}

// The instant a wall clock in `timeZone` shows this time. Clock changes follow the usual rule:
// a time that a change skips moves forward by the change, and a time that happens twice takes the
// first.
function instantOf(wall: WallClock, timeZone: string): number {
  const shown = asUtc(wall);
  const before = offsetAt(shown - 12 * HOUR_MS, timeZone);
  const after = offsetAt(shown + 12 * HOUR_MS, timeZone);
  const shows = (instant: number) => instant + offsetAt(instant, timeZone) === shown;
  const matches = [shown - before, shown - after].filter(shows);
  return matches.length > 0 ? Math.min(...matches) : shown - before;
}

// Every day at `time`, a 24-hour time such as "03:00".
export function daily(time: string): Schedule {
  const match = TIME.exec(time);
  if (match === null) throw new RangeError(`A daily time must be written HH:MM, not "${time}".`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return {
    next(after, timeZone) {
      const today = wallClockAt(after.getTime(), timeZone);
      const at = (day: number) =>
        instantOf({ year: today.year, month: today.month, day, hour, minute }, timeZone);
      const sameDay = at(today.day);
      return new Date(sameDay > after.getTime() ? sameDay : at(today.day + 1));
    },
  };
}
