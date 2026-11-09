import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  dollarTick,
  dollarTicks,
  isCurrentMonth,
  monthTick,
  monthWords,
  ReportTooltipBox,
  tooltipContent,
} from "./ReportChart.tsx";

// What the Reports page's charts share (spec 07, Reports): the hover label and the axis words.

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("a report's hover label", () => {
  const stack = tooltipContent({
    month: "2026-10",
    items: [
      { name: "Leisure", cents: 5_000, color: "#7B5CD6" },
      { name: "Shopping", cents: 45_049, color: "#0A9182" },
      { name: "Transportation", cents: null, color: "#C2770E" },
      { name: "Bills", cents: 200_000, color: "#3B6FD8" },
    ],
    total: "Spending",
  });

  it("names the month in words, each series with its color and dollars, and a stack's total", () => {
    expect(stack).toEqual({
      title: "October 2026",
      rows: [
        { name: "Leisure", amount: "$50", color: "#7B5CD6" },
        { name: "Shopping", amount: "$450", color: "#0A9182" },
        { name: "Bills", amount: "$2,000", color: "#3B6FD8" },
      ],
      total: { name: "Spending", amount: "$2,500" },
    });
  });

  it("draws as a small card: the month, a swatch, name and amount per series, then the total", () => {
    const html = renderToString(<ReportTooltipBox {...stack} />);

    expect(text(html)).toBe("October 2026 Leisure $50 Shopping $450 Bills $2,000 Spending $2,500");
    expect(html).toContain('data-slot="report-tooltip"');
    expect(html.match(/style="background-color:#[0-9A-F]{6}"/g)).toHaveLength(3);
    expect(html).toMatch(/border-t[^>]*><span class="flex-1">Spending<\/span>/);
  });

  it("says the current month is so far, and takes another format, such as cents", () => {
    const content = tooltipContent({
      month: "2026-11",
      current: true,
      items: [{ name: "Streamly", cents: 1_799 }],
      format: (cents) => `${cents} cents`,
    });

    expect(content).toEqual({
      title: "November 2026 so far",
      rows: [{ name: "Streamly", amount: "1799 cents" }],
    });
    // A series with no color has no swatch.
    expect(renderToString(<ReportTooltipBox {...content} />)).not.toContain("background-color");
  });

  it("writes negative amounts with a true minus sign", () => {
    expect(
      tooltipContent({ month: "2026-01", items: [{ name: "Left over", cents: -130_000 }] }).rows,
    ).toEqual([{ name: "Left over", amount: "−$1,300" }]);
  });
});

describe("a report's axes", () => {
  it("writes months short, with the year on the first mark and on January", () => {
    expect(["2025-11", "2025-12", "2026-01", "2026-02"].map(monthTick)).toEqual([
      "Nov 2025",
      "Dec",
      "Jan 2026",
      "Feb",
    ]);
    expect(monthWords("2026-03")).toBe("March 2026");
  });

  it("writes dollars short: $500, $4k, $1.5k, $40k, and below $0", () => {
    expect([0, 50_000, 400_000, 150_000, 4_000_000, -200_000, 99_960].map(dollarTick)).toEqual([
      "$0",
      "$500",
      "$4k",
      "$1.5k",
      "$40k",
      "−$2k",
      "$1k",
    ]);
  });

  it("marks a value axis in round dollar steps from $0 past the largest value", () => {
    const words = (maxCents: number) => dollarTicks(maxCents).map(dollarTick);

    // Recurring charges of $2,450 at most: $500 steps, never $650.
    expect(words(245_000)).toEqual(["$0", "$500", "$1k", "$1.5k", "$2k", "$2.5k"]);
    expect(words(400_000)).toEqual(["$0", "$1k", "$2k", "$3k", "$4k"]);
    expect(words(90_000)).toEqual(["$0", "$200", "$400", "$600", "$800", "$1k"]);
    expect(words(1_100_000)).toEqual(["$0", "$2.5k", "$5k", "$7.5k", "$10k", "$12.5k"]);
    expect(words(1_200)).toEqual(["$0", "$5", "$10", "$15"]);
    expect(words(0)).toEqual(["$0", "$1"]);
  });

  it("takes the range's last month as the current one", () => {
    expect(isCurrentMonth(["2026-10", "2026-11"], "2026-11")).toBe(true);
    expect(isCurrentMonth(["2026-10", "2026-11"], "2026-10")).toBe(false);
  });
});
