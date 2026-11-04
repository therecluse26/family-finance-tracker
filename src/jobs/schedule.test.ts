import { describe, expect, it } from "vitest";
import { daily, everyMinute } from "./index.ts";

describe("a daily schedule", () => {
  it.each([
    ["later the same day", "03:00", "2026-11-03T01:00:00Z", "UTC", "2026-11-03T03:00:00Z"],
    [
      "the next day once the time has passed",
      "03:00",
      "2026-11-03T03:00:00Z",
      "UTC",
      "2026-11-04T03:00:00Z",
    ],
    ["across a month's end", "03:00", "2026-11-30T05:00:00Z", "UTC", "2026-12-01T03:00:00Z"],
    ["across a year's end", "00:00", "2026-12-31T12:00:00Z", "UTC", "2027-01-01T00:00:00Z"],
    [
      "in the Household time zone",
      "03:00",
      "2026-11-03T01:00:00Z",
      "America/New_York",
      "2026-11-03T08:00:00Z",
    ],
    // At 23:00 UTC on Nov 3 it is still the evening of Nov 3 in Los Angeles.
    [
      "on the Household's date, not UTC's",
      "23:30",
      "2026-11-03T23:00:00Z",
      "America/Los_Angeles",
      "2026-11-04T07:30:00Z",
    ],
    ["east of UTC", "03:00", "2026-11-03T12:00:00Z", "Asia/Tokyo", "2026-11-03T18:00:00Z"],
    ["in summer time", "03:00", "2026-07-01T00:00:00Z", "America/New_York", "2026-07-01T07:00:00Z"],
    // Clocks in New York skip from 02:00 to 03:00 on Mar 8, 2026.
    [
      "at a skipped time, moved forward by the change",
      "02:30",
      "2026-03-08T05:00:00Z",
      "America/New_York",
      "2026-03-08T07:30:00Z",
    ],
    // Clocks in New York go back from 02:00 to 01:00 on Nov 1, 2026, so 01:30 happens twice.
    [
      "at a repeated time, the first of the two",
      "01:30",
      "2026-11-01T04:00:00Z",
      "America/New_York",
      "2026-11-01T05:30:00Z",
    ],
    [
      "once on the day clocks go back",
      "01:30",
      "2026-11-01T05:30:00Z",
      "America/New_York",
      "2026-11-02T06:30:00Z",
    ],
  ])("runs %s", (_case, time, after, timeZone, next) => {
    expect(daily(time).next(new Date(after), timeZone)).toEqual(new Date(next));
  });

  it.each(["3:00", "24:00", "12:60", "noon", ""])("refuses the time %j", (time) => {
    expect(() => daily(time)).toThrow(RangeError);
  });

  it("refuses an unknown time zone", () => {
    expect(() => daily("03:00").next(new Date(), "Mars/Olympus_Mons")).toThrow(RangeError);
  });
});

describe("the every-minute schedule", () => {
  it.each([
    ["mid-minute", "2026-11-03T01:00:30.250Z", "2026-11-03T01:01:00.000Z"],
    ["on the minute, the next one", "2026-11-03T01:00:00.000Z", "2026-11-03T01:01:00.000Z"],
    ["across a day's end", "2026-11-03T23:59:59.999Z", "2026-11-04T00:00:00.000Z"],
  ])("runs %s", (_case, after, next) => {
    expect(everyMinute.next(new Date(after), "America/New_York")).toEqual(new Date(next));
  });
});
