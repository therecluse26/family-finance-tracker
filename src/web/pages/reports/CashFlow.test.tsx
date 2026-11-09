import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { CashFlowReportView } from "../../../server/reports-views.ts";
import { CashFlowReportBody } from "./CashFlow.tsx";

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
