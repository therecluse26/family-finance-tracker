import { customType } from "drizzle-orm/sqlite-core";

// Column helpers for the data conventions. Each one refuses a value it cannot store as written.

// An amount in US dollars, as whole cents in an integer column: 1234 is $12.34.
export const cents = customType<{ data: number; driverData: number }>({
  dataType: () => "integer",
  toDriver(value) {
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`An amount must be whole cents, not ${value}.`);
    }
    return value;
  },
});

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

// A calendar date with no time or time zone, such as a posted date, as `YYYY-MM-DD` text.
export const calendarDate = customType<{ data: string; driverData: string }>({
  dataType: () => "text",
  toDriver(value) {
    if (!isCalendarDate(value)) {
      throw new RangeError(
        `A calendar date must be a real date written YYYY-MM-DD, not "${value}".`,
      );
    }
    return value;
  },
});

const UTC_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// A moment in time, in UTC, as ISO 8601 text such as `2026-11-03T14:05:09.000Z`.
export const moment = customType<{ data: Date; driverData: string }>({
  dataType: () => "text",
  toDriver(value) {
    if (Number.isNaN(value.getTime())) throw new RangeError("A moment must be a valid Date.");
    return value.toISOString();
  },
  fromDriver(value) {
    if (!UTC_MOMENT.test(value)) throw new RangeError(`"${value}" is not a moment in UTC.`);
    return new Date(value);
  },
});
