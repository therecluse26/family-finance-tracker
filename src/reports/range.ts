import { monthsBefore } from "../server/usual.ts";

// A report's range (spec 07, Reports): the last 3, 12 or 24 months, or all of the history. Each
// range ends with the Household's current month and starts no earlier than the month of the first
// posted Transaction. This file imports no server code, so the web app's type check can follow it.

export const REPORT_RANGES = ["3m", "12m", "24m", "all"] as const;
export type ReportRange = (typeof REPORT_RANGES)[number];

// The range a report opens with.
export const DEFAULT_REPORT_RANGE: ReportRange = "12m";

const RANGE_MONTHS = { "3m": 3, "12m": 12, "24m": 24 } as const;

// How many months from `from` to `to`, both written YYYY-MM: "2026-01" to "2026-03" is 2.
function monthsFrom(from: string, to: string): number {
  const months = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7));
  return months(to) - months(from);
}

// The months a range covers, each written YYYY-MM, oldest first. `currentMonth` is the Household's
// current month; `firstPostedMonth` is the month of the first posted Transaction, or null with
// none. With no history there are no months.
export function reportMonths(
  range: ReportRange,
  currentMonth: string,
  firstPostedMonth: string | null,
): string[] {
  if (firstPostedMonth === null || firstPostedMonth > currentMonth) return [];
  const count =
    range === "all" ? monthsFrom(firstPostedMonth, currentMonth) + 1 : RANGE_MONTHS[range];
  return [...monthsBefore(currentMonth, count - 1), currentMonth].filter(
    (month) => month >= firstPostedMonth,
  );
}
