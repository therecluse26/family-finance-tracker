import { describe, expect, it } from "vitest";
import { REPORT_RANGES, reportMonths } from "./range.ts";

// A report's range (spec 07, Reports), on a Household whose current month is November 2026.

const NOW = "2026-11";
const LONG_AGO = "2020-01";

describe("a report's months", () => {
  it("ends each range with the current month, oldest first", () => {
    expect(reportMonths("3m", NOW, LONG_AGO)).toEqual(["2026-09", "2026-10", "2026-11"]);
    const twelve = reportMonths("12m", NOW, LONG_AGO);
    expect(twelve).toHaveLength(12);
    expect(twelve[0]).toBe("2025-12");
    expect(twelve.at(-1)).toBe(NOW);
    const twentyFour = reportMonths("24m", NOW, LONG_AGO);
    expect(twentyFour).toHaveLength(24);
    expect(twentyFour[0]).toBe("2024-12");
    expect(twentyFour.at(-1)).toBe(NOW);
  });

  it("starts all of the history at the first posted month", () => {
    const all = reportMonths("all", NOW, "2025-05");
    expect(all).toHaveLength(19);
    expect(all[0]).toBe("2025-05");
    expect(all.at(-1)).toBe(NOW);
    expect(reportMonths("all", NOW, LONG_AGO)).toHaveLength(83);
    expect(reportMonths("all", NOW, NOW)).toEqual([NOW]);
  });

  it("cuts a range longer than the history at the first posted month", () => {
    expect(reportMonths("12m", NOW, "2026-10")).toEqual(["2026-10", "2026-11"]);
    const twentyFour = reportMonths("24m", NOW, "2025-05");
    expect(twentyFour).toEqual(reportMonths("all", NOW, "2025-05"));
    expect(reportMonths("3m", NOW, NOW)).toEqual([NOW]);
  });

  it("gives no months with no history", () => {
    for (const range of REPORT_RANGES) expect(reportMonths(range, NOW, null)).toEqual([]);
  });

  it("crosses a year end", () => {
    expect(reportMonths("3m", "2027-01", LONG_AGO)).toEqual(["2026-11", "2026-12", "2027-01"]);
  });
});
