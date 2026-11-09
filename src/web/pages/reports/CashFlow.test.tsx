import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { CashFlowReportView } from "../../../server/reports-views.ts";
import { CashFlowReportBody, cashFlowRows, cashFlowTooltip } from "./CashFlow.tsx";

// Cash flow on the Reports page (spec 07, Reports). Server rendering draws no chart, so these read
// the table, which holds the chart's numbers and links.

const VIEW: CashFlowReportView = {
  range: "3m",
  months: ["2026-10", "2026-11"],
  bars: [
    { month: "2026-10", income: 500_000, spending: 320_000, saving: 50_000, leftOver: 130_000 },
    { month: "2026-11", income: 100_000, spending: 250_000, saving: -20_000, leftOver: -130_000 },
  ],
  total: { income: 600_000, spending: 570_000, saving: 30_000, leftOver: 0 },
  average: { income: 300_000, spending: 285_000, saving: 15_000, leftOver: 0 },
};

const render = (view: CashFlowReportView | undefined) =>
  renderToString(
    <MemoryRouter>
      <CashFlowReportBody view={view} />
    </MemoryRouter>,
  );

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const rows = (html: string, label: string) => {
  const table = new RegExp(`<table[^>]*aria-label="${label}"[^>]*>(.*?)</table>`, "s").exec(
    html,
  )?.[1];
  return [...(table ?? "").matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map((match) => text(match[1] ?? ""));
};

describe("Cash flow", () => {
  it("holds each month's Income, Spending, Saving and Left over in its table, below $0 too", () => {
    expect(rows(render(VIEW), "Cash flow by month")).toEqual([
      "Month Income Spending Saving Left over",
      "Oct 2026 $5,000 $3,200 $500 $1,300",
      "Nov 2026 $1,000 $2,500 −$200 −$1,300",
    ]);
  });

  it("shows the range's totals and averages per month of the four", () => {
    expect(rows(render(VIEW), "Cash flow over the range")).toEqual([
      "Over the range Income Spending Saving Left over",
      "Total $6,000 $5,700 $300 $0",
      "Per month $3,000 $2,850 $150 $0",
    ]);
  });

  it("opens each bar's type in its month, and a Left over point's month", () => {
    const hrefs = [...render(VIEW).matchAll(/<a [^>]*href="([^"]*)"/g)].map((match) =>
      (match[1] ?? "").replace(/&amp;/g, "&"),
    );

    expect(hrefs).toEqual([
      "/transactions?type=Income&month=2026-10",
      "/transactions?type=Spending&month=2026-10",
      "/transactions?type=Saving&month=2026-10",
      "/transactions?month=2026-10",
      "/transactions?type=Income&month=2026-11",
      "/transactions?type=Spending&month=2026-11",
      "/transactions?type=Saving&month=2026-11",
      "/transactions?month=2026-11",
    ]);
  });

  it("says so with no history, and draws no chart", () => {
    const html = render({ ...VIEW, months: [], bars: [] });

    expect(text(html)).toContain("No posted Transactions yet.");
    expect(html).not.toContain("recharts");
    expect(html).not.toContain("report-table");
  });
});

describe("Cash flow's card", () => {
  const slot = (html: string, name: string) =>
    text(new RegExp(`data-slot="${name}"[^>]*>(.*?)</p>`, "s").exec(html)?.[1] ?? "");

  it("opens with Left over across the range, and what it is left over from", () => {
    const html = render({ ...VIEW, total: { ...VIEW.total, leftOver: 30_000 } });

    expect(slot(html, "report-headline")).toBe("$300 left over");
    expect(slot(html, "report-line")).toBe("$6,000 Income, less $5,700 Spending, less $300 Saving");
    expect(html).toMatch(/class="text-good">\$6,000 Income/);
    expect(render({ ...VIEW, total: { ...VIEW.total, leftOver: -1 } })).toMatch(
      /class="text-serious">\$6,000 Income/,
    );
  });

  it("hovers a month with its three bars and its Left over", () => {
    expect(cashFlowTooltip(VIEW, "2026-11")).toEqual({
      title: "November 2026 so far",
      rows: [
        { name: "Income", amount: "$1,000", color: "#C6CBD2" },
        { name: "Spending", amount: "$2,500", color: "#5B6470" },
        { name: "Saving", amount: "−$200", color: "#0A9182" },
      ],
      total: { name: "Left over", amount: "−$1,300" },
    });
  });

  it("joins the current month's Left over to the line by a dotted stretch, never as a fall", () => {
    expect(cashFlowRows(VIEW).map(({ month, full, soFar }) => ({ month, full, soFar }))).toEqual([
      { month: "2026-10", full: 130_000, soFar: 130_000 },
      { month: "2026-11", full: null, soFar: -130_000 },
    ]);
  });
});
