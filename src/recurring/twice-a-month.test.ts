import { describe, expect, it } from "vitest";
import { addBusinessDays, isBusinessDay } from "../money-movement/index.ts";
import { addMonths, lastActiveDay } from "./schedules.ts";
import { INCOME_RULE, replayMerchant, type SeriesTxn } from "./series.ts";

// Twice-a-month Income series across pay days, start months, and how a payer moves a payday that
// is not a business day (spec 05, Steady Income; spec 06, Monthly series). Each payer pays the same
// amount on its two days for 16 months. At each payday the payer's Transactions so far are
// replayed, as the checks do, and the payday fails unless exactly one series is active, it holds
// that payday, and the next payday comes by its last active day.

// Day `day` of `month`, written YYYY-MM. A day the month lacks means its last day.
const dayOf = (month: string, day: number) => {
  const [year = 0, number = 1] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return `${month}-${String(Math.min(day, last)).padStart(2, "0")}`;
};

const PAY_RULES = {
  "on the day": (date: string) => date,
  "the business day before": (date: string) =>
    isBusinessDay(date) ? date : addBusinessDays(date, -1),
  "the business day after": (date: string) =>
    isBusinessDay(date) ? date : addBusinessDays(date, 1),
};
const PAY_DAYS: [number, number][] = [
  [1, 15],
  [1, 16],
  [15, 31],
  [15, 30],
  [15, 28],
  [10, 25],
  [5, 20],
  [7, 21],
  [14, 28],
  [16, 31],
  [13, 28],
  [12, 26],
];
const STARTS = Array.from({ length: 12 }, (_, index) => addMonths("2025-01-01", index).slice(0, 7));

// The paydays that failed before twice-a-month series got the business-day shift and picked their
// days again (X20), for each run that had any. A payer whose first 3 paydays are 14 days apart is
// found as every 2 weeks, which lapses when the month's days stop lining up. No run may fail more.
const FAILED_BEFORE: Record<string, number> = {
  "1,15 2025-01 the business day after": 2,
  "1,15 2025-02 on the day": 3,
  "1,15 2025-02 the business day before": 4,
  "1,15 2025-02 the business day after": 9,
  "1,15 2025-03 the business day before": 1,
  "1,15 2025-04 the business day before": 1,
  "1,15 2025-06 the business day before": 1,
  "1,15 2025-07 the business day before": 1,
  "1,15 2025-08 the business day before": 3,
  "1,15 2025-11 the business day after": 3,
  "1,15 2025-12 the business day before": 1,
  "1,16 2025-01 the business day before": 1,
  "1,16 2025-02 the business day before": 6,
  "1,16 2025-03 the business day before": 1,
  "1,16 2025-04 the business day before": 2,
  "1,16 2025-05 the business day before": 1,
  "1,16 2025-06 the business day before": 2,
  "1,16 2025-07 the business day before": 2,
  "1,16 2025-08 the business day before": 5,
  "1,16 2025-09 the business day before": 1,
  "1,16 2025-10 the business day before": 1,
  "1,16 2025-10 the business day after": 1,
  "1,16 2025-11 the business day after": 5,
  "1,16 2025-12 the business day before": 1,
  "1,16 2025-12 the business day after": 2,
  "15,31 2025-02 the business day before": 3,
  "15,31 2025-11 the business day before": 11,
  "15,31 2025-11 the business day after": 3,
  "15,31 2025-12 the business day before": 1,
  "15,30 2025-01 the business day after": 2,
  "15,30 2025-02 the business day before": 3,
  "15,30 2025-05 the business day after": 2,
  "15,30 2025-06 the business day before": 1,
  "15,30 2025-07 the business day after": 2,
  "15,30 2025-08 the business day after": 6,
  "15,30 2025-09 the business day before": 1,
  "15,30 2025-11 the business day before": 1,
  "15,30 2025-11 the business day after": 8,
  "15,30 2025-12 the business day before": 1,
  "15,28 2025-02 on the day": 8,
  "15,28 2025-02 the business day before": 3,
  "15,28 2025-02 the business day after": 6,
  "15,28 2025-06 the business day after": 7,
  "15,28 2025-11 the business day before": 1,
  "15,28 2025-12 the business day before": 1,
  "10,25 2025-03 the business day before": 1,
  "10,25 2025-04 the business day before": 1,
  "10,25 2025-06 the business day before": 1,
  "10,25 2025-07 the business day before": 1,
  "10,25 2025-08 the business day before": 1,
  "10,25 2025-08 the business day after": 2,
  "10,25 2025-09 the business day before": 1,
  "10,25 2025-09 the business day after": 3,
  "10,25 2025-10 the business day after": 2,
  "10,25 2025-11 the business day before": 1,
  "10,25 2025-11 the business day after": 4,
  "5,20 2025-01 the business day before": 21,
  "5,20 2025-04 the business day after": 3,
  "5,20 2025-07 the business day after": 2,
  "5,20 2025-08 the business day after": 2,
  "5,20 2025-09 the business day before": 3,
  "5,20 2025-10 the business day after": 2,
  "5,20 2025-11 the business day after": 2,
  "5,20 2025-12 the business day after": 2,
  "7,21 2025-02 on the day": 3,
  "7,21 2025-02 the business day before": 3,
  "7,21 2025-02 the business day after": 3,
  "7,21 2025-04 the business day before": 1,
  "7,21 2025-05 the business day before": 1,
  "7,21 2025-06 the business day before": 1,
  "7,21 2025-06 the business day after": 3,
  "7,21 2025-07 the business day before": 2,
  "7,21 2025-08 the business day before": 1,
  "7,21 2025-09 the business day before": 1,
  "7,21 2025-10 the business day before": 2,
  "7,21 2025-11 the business day before": 4,
  "7,21 2025-12 the business day before": 1,
  "14,28 2025-01 the business day after": 2,
  "14,28 2025-02 on the day": 3,
  "14,28 2025-02 the business day before": 3,
  "14,28 2025-02 the business day after": 5,
  "14,28 2025-03 the business day after": 2,
  "14,28 2025-04 the business day after": 2,
  "14,28 2025-06 the business day after": 3,
  "14,28 2025-07 the business day after": 2,
  "14,28 2025-09 the business day after": 2,
  "14,28 2025-10 the business day after": 2,
  "14,28 2025-11 the business day before": 3,
  "14,28 2025-12 the business day after": 2,
  "16,31 2025-02 the business day before": 5,
  "16,31 2025-03 the business day before": 1,
  "16,31 2025-04 the business day before": 1,
  "16,31 2025-05 the business day before": 1,
  "16,31 2025-06 the business day before": 1,
  "16,31 2025-08 the business day before": 1,
  "16,31 2025-09 the business day before": 1,
  "16,31 2025-11 the business day before": 11,
  "16,31 2025-11 the business day after": 2,
  "16,31 2025-12 the business day before": 1,
  "16,31 2025-12 the business day after": 2,
  "13,28 2025-01 the business day before": 1,
  "13,28 2025-02 on the day": 8,
  "13,28 2025-02 the business day before": 11,
  "13,28 2025-02 the business day after": 6,
  "13,28 2025-04 the business day before": 1,
  "13,28 2025-05 the business day before": 1,
  "13,28 2025-06 the business day before": 4,
  "13,28 2025-06 the business day after": 7,
  "13,28 2025-07 the business day before": 1,
  "13,28 2025-09 the business day before": 3,
  "13,28 2025-12 the business day after": 2,
  "12,26 2025-02 on the day": 3,
  "12,26 2025-02 the business day before": 5,
  "12,26 2025-02 the business day after": 14,
  "12,26 2025-03 the business day before": 1,
  "12,26 2025-04 the business day after": 3,
  "12,26 2025-07 the business day before": 1,
  "12,26 2025-08 the business day before": 1,
  "12,26 2025-09 the business day before": 4,
  "12,26 2025-10 the business day before": 1,
  "12,26 2025-11 the business day before": 1,
  "12,26 2025-12 the business day before": 1,
};

// The paydays of one run that fail.
function failedPaydays(days: [number, number], start: string, rule: (date: string) => string) {
  const dates = Array.from({ length: 16 }, (_, index) => addMonths(`${start}-01`, index))
    .flatMap((first) => days.map((day) => rule(dayOf(first.slice(0, 7), day))))
    .sort();
  const txns: SeriesTxn[] = dates.map((date, index) => ({
    id: `pay-${String(index).padStart(2, "0")}`,
    date,
    amount: 100_000,
    accountId: "checking",
    category: null,
  }));
  const failed: string[] = [];
  for (let paid = 2; paid < txns.length - 1; paid += 1) {
    const today = txns[paid]?.date ?? "";
    const next = txns[paid + 1]?.date ?? "";
    const active = replayMerchant(txns.slice(0, paid + 1), new Set(), today, INCOME_RULE).filter(
      (series) => series.status === "active",
    );
    const [series] = active;
    if (
      active.length !== 1 ||
      series === undefined ||
      series.txns.at(-1)?.date !== today ||
      next > lastActiveDay(series.schedule, today)
    ) {
      failed.push(today);
    }
  }
  return failed;
}

describe("twice-a-month Income series", () => {
  it("fails no more paydays in any run than before, and fewer in all", { timeout: 300_000 }, () => {
    const worse: string[] = [];
    let total = 0;
    for (const days of PAY_DAYS) {
      for (const start of STARTS) {
        for (const [name, rule] of Object.entries(PAY_RULES)) {
          const run = `${days.join(",")} ${start} ${name}`;
          const failed = failedPaydays(days, start, rule);
          total += failed.length;
          if (failed.length > (FAILED_BEFORE[run] ?? 0)) worse.push(`${run}: ${failed.join(" ")}`);
        }
      }
    }

    expect(worse).toEqual([]);
    const before = Object.values(FAILED_BEFORE).reduce((sum, each) => sum + each, 0);
    expect(total).toBeLessThan(before / 3);
  });

  it("keeps a payer on the 15th and the last day who pays the business day before, from May", () => {
    // May 15, Fri May 30, Fri Jun 13, Mon Jun 30: found on Jun 13, it must not lapse before Jun 30.
    expect(failedPaydays([15, 31], "2025-05", PAY_RULES["the business day before"])).toEqual([]);
  });

  it("keeps a payer on the 1st and the 15th who pays the business day after, from March", () => {
    // Mon Mar 3, Mon Mar 17, Apr 1, Apr 15, ...
    expect(failedPaydays([1, 15], "2025-03", PAY_RULES["the business day after"])).toEqual([]);
  });
});
