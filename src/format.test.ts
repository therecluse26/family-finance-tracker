import { describe, expect, it } from "vitest";
import {
  calendarDateIn,
  dateLabel,
  directionAgainstUsual,
  dollarsAndCents,
  MINUS,
  monthLabel,
  percent,
  STATUS_ICON,
  statusText,
  timeLabel,
  wholeDollars,
} from "./format.ts";

// Spec 07, Number formats and Status: color, icon, and word together.

describe("money", () => {
  it("writes US dollars with $ and thousands commas, never k or M", () => {
    expect(wholeDollars(1_248_000)).toBe("$12,480");
    expect(wholeDollars(123_456_789_00)).toBe("$123,456,789");
    expect(wholeDollars(99_900)).toBe("$999");
    expect(dollarsAndCents(123_456_789)).toBe("$1,234,567.89");
  });

  it("rounds whole dollars to the nearest dollar", () => {
    expect(wholeDollars(1249)).toBe("$12");
    expect(wholeDollars(1250)).toBe("$13");
    expect(wholeDollars(49)).toBe("$0");
    expect(wholeDollars(-1250)).toBe(`${MINUS}$13`);
  });

  it("shows cents where one Transaction shows", () => {
    expect(dollarsAndCents(1248)).toBe("$12.48");
    expect(dollarsAndCents(5)).toBe("$0.05");
    expect(dollarsAndCents(0)).toBe("$0.00");
  });

  it("marks money out with a true minus sign, not a hyphen", () => {
    expect(wholeDollars(-1_248_000)).toBe("−$12,480");
    expect(dollarsAndCents(-450)).toBe("−$4.50");
    expect(dollarsAndCents(-450)).not.toContain("-");
  });

  it('marks money in with "+" only where both appear together', () => {
    expect(wholeDollars(320_000)).toBe("$3,200");
    expect(wholeDollars(320_000, { signed: true })).toBe("+$3,200");
    expect(dollarsAndCents(1599, { signed: true })).toBe("+$15.99");
    expect(dollarsAndCents(-1599, { signed: true })).toBe(`${MINUS}$15.99`);
  });

  it("gives no sign to zero, even when a negative amount rounds to it", () => {
    expect(wholeDollars(0, { signed: true })).toBe("$0");
    expect(wholeDollars(-49, { signed: true })).toBe("$0");
  });

  it("refuses an amount that is not whole cents", () => {
    expect(() => wholeDollars(12.5)).toThrow(RangeError);
    expect(() => dollarsAndCents(Number.NaN)).toThrow(RangeError);
  });
});

describe("percent", () => {
  it("writes whole numbers", () => {
    expect(percent(0.41)).toBe("41%");
    expect(percent(0.412)).toBe("41%");
    expect(percent(0.415)).toBe("42%");
    expect(percent(1.5)).toBe("150%");
    expect(percent(-0.08)).toBe(`${MINUS}8%`);
    expect(percent(0)).toBe("0%");
  });

  it("refuses a ratio that is not a number", () => {
    expect(() => percent(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("dates and times", () => {
  it('writes "Oct 9" within the current year, and "Oct 9, 2025" otherwise', () => {
    expect(dateLabel("2026-10-09", "2026-11-03")).toBe("Oct 9");
    expect(dateLabel("2025-10-09", "2026-11-03")).toBe("Oct 9, 2025");
    expect(dateLabel("2027-01-01", "2026-11-03")).toBe("Jan 1, 2027");
  });

  it('labels a chart month "Oct 2025"', () => {
    expect(monthLabel("2025-10-01")).toBe("Oct 2025");
    expect(monthLabel("2026-05-31")).toBe("May 2026");
  });

  it("refuses a date not written YYYY-MM-DD", () => {
    expect(() => dateLabel("10/09/2025", "2026-11-03")).toThrow(RangeError);
    expect(() => monthLabel("2025-13-01")).toThrow(RangeError);
  });

  it("writes 12-hour times in the Household time zone", () => {
    const moment = new Date("2026-11-03T13:15:00Z");
    expect(timeLabel(moment, "America/New_York")).toBe("8:15 AM");
    expect(timeLabel(moment, "America/Los_Angeles")).toBe("5:15 AM");
    expect(timeLabel(new Date("2026-07-04T23:05:00Z"), "America/Chicago")).toBe("6:05 PM");
    expect(timeLabel(new Date("2026-07-04T04:00:00Z"), "America/New_York")).toBe("12:00 AM");
    expect(timeLabel(new Date("2026-07-04T16:00:00Z"), "America/New_York")).toBe("12:00 PM");
  });

  it("finds the Household's calendar date for a moment", () => {
    const moment = new Date("2026-11-03T03:00:00Z");
    expect(calendarDateIn(moment, "UTC")).toBe("2026-11-03");
    expect(calendarDateIn(moment, "America/New_York")).toBe("2026-11-02");
  });
});

describe("status", () => {
  it("pairs each tone with its icon and a word", () => {
    expect(STATUS_ICON).toEqual({
      critical: "▲",
      serious: "◆",
      good: "✓",
      accent: "●",
      muted: "●",
    });
    expect(statusText("critical", "Over Budget")).toBe("▲ Over Budget");
    expect(statusText("critical", "$40 over")).toBe("▲ $40 over");
    expect(statusText("serious", "on pace for $620")).toBe("◆ on pace for $620");
    expect(statusText("good", "On track")).toBe("✓ On track");
    expect(statusText("accent", "Heads up")).toBe("● Heads up");
    expect(statusText("muted", "about usual")).toBe("● about usual");
  });

  it("shows direction against usual: green when good, orange when bad", () => {
    // More Spending is bad; less is good.
    expect(directionAgainstUsual(4000, "bad")).toEqual({
      tone: "serious",
      text: "▲ $40 above usual",
    });
    expect(directionAgainstUsual(-4000, "bad")).toEqual({
      tone: "good",
      text: "▼ $40 below usual",
    });
    // More Income is good; less is bad.
    expect(directionAgainstUsual(12_000, "good")).toEqual({
      tone: "good",
      text: "▲ $120 above usual",
    });
    expect(directionAgainstUsual(-12_000, "good")).toEqual({
      tone: "serious",
      text: "▼ $120 below usual",
    });
  });

  it('says "about usual" in grey when there is no real change', () => {
    expect(directionAgainstUsual(0, "bad")).toEqual({ tone: "muted", text: "● about usual" });
    expect(directionAgainstUsual(-30, "good")).toEqual({ tone: "muted", text: "● about usual" });
  });
});
