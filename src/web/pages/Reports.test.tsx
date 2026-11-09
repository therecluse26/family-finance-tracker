import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { CATEGORY_GROUPS } from "../../categories/list.ts";
import { GROUP_COLORS } from "../chart-colors.ts";
import { reportsPath } from "../reports.ts";
import { Reports } from "./Reports.tsx";
import { drillDownHref } from "./reports/drill-down.ts";
import { ReportFrame } from "./reports/ReportFrame.tsx";

// The Reports page's frame (spec 07, Reports): its range presets, its four sections, the shared
// report card, and the drill-down links. The reports themselves are not built yet.

const render = (path: string) => {
  const router = createMemoryRouter([{ path: "/reports", element: <Reports /> }], {
    initialEntries: [path],
  });
  return renderToString(<RouterProvider router={router} />);
};

// The `href` of each link in `html`, in order.
const hrefs = (html: string) =>
  [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((match) =>
    (match[1] ?? "").replace(/&amp;/g, "&"),
  );

const rangeNav = (html: string) =>
  /<nav aria-label="Range"[^>]*>(.*?)<\/nav>/s.exec(html)?.[1] ?? "";

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("the Reports page", () => {
  it("shows its four reports, each in its own section", () => {
    const html = render("/reports");

    expect([...html.matchAll(/<h1[^>]*>(.*?)<\/h1>/g)].map((match) => match[1])).toEqual([
      "Reports",
    ]);
    expect([...html.matchAll(/<section[^>]* id="([^"]*)"/g)].map((match) => match[1])).toEqual([
      "spending",
      "cash-flow",
      "balances",
      "merchants",
    ]);
    expect([...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((match) => match[1])).toEqual([
      "Spending over time",
      "Cash flow",
      "Balances and debt",
      "Merchants and Recurring charges",
    ]);
    // Spending over time and Cash flow load their views after the page draws.
    expect(html.match(/Coming soon/g)).toHaveLength(2);
  });

  it("offers the range presets as links that keep every other parameter", () => {
    const nav = rangeNav(render("/reports?range=3m&group=Health+and+care&account=acc-1"));

    expect(text(nav)).toBe("3 months 12 months 24 months All");
    expect(hrefs(nav)).toEqual([
      "/reports?range=3m&group=Health+and+care&account=acc-1",
      "/reports?range=12m&group=Health+and+care&account=acc-1",
      "/reports?range=24m&group=Health+and+care&account=acc-1",
      "/reports?range=all&group=Health+and+care&account=acc-1",
    ]);
    expect(nav).toMatch(/aria-current="true"[^>]*href="\/reports\?range=3m&amp;/);
    expect(nav.match(/aria-current/g)).toHaveLength(1);

    // With no range, a link adds one.
    expect(hrefs(rangeNav(render("/reports?merchant=streamly")))[3]).toBe(
      "/reports?merchant=streamly&range=all",
    );
  });

  it("opens at 12 months with no range or an unknown one", () => {
    for (const path of ["/reports", "/reports?range=6m", "/reports?range="]) {
      expect(rangeNav(render(path))).toMatch(/aria-current="true"[^>]*>12 months</);
    }
  });

  it("builds a link to a report's section, its range and its filter", () => {
    expect(reportsPath("spending")).toBe("/reports#spending");
    expect(reportsPath("spending", { range: "12m", group: "Health and care" })).toBe(
      "/reports?range=12m&group=Health+and+care#spending",
    );
    expect(reportsPath("balances", { range: "all", account: "acc-1", group: "" })).toBe(
      "/reports?range=all&account=acc-1#balances",
    );
  });
});

describe("a report's drill-down", () => {
  it("opens the Transactions page with the filters of the bar or point", () => {
    expect(drillDownHref({})).toBe("/transactions");
    expect(drillDownHref({ category: "Groceries", month: "2026-10" })).toBe(
      "/transactions?category=Groceries&month=2026-10",
    );
    expect(drillDownHref({ type: "Income", month: "2026-09" })).toBe(
      "/transactions?type=Income&month=2026-09",
    );
    // A span of months, oldest first, runs from its first day to its last.
    expect(
      drillDownHref({ merchant: "Corner Grocer", months: ["2025-12", "2026-01", "2026-02"] }),
    ).toBe("/transactions?merchant=Corner+Grocer&from=2025-12-01&to=2026-02-28");
    expect(drillDownHref({ account: "acc-1", months: ["2024-02"] })).toBe(
      "/transactions?account=acc-1&from=2024-02-01&to=2024-02-29",
    );
    expect(drillDownHref({ account: "acc-1", months: [] })).toBe("/transactions?account=acc-1");
  });
});

describe("a report's card", () => {
  const frame = (initialTable?: boolean) =>
    renderToString(
      <ReportFrame
        id="cash-flow"
        title="Cash flow"
        chart={<svg data-slot="chart-drawing" />}
        table={<table aria-label="Cash flow by month" />}
        {...(initialTable === undefined ? {} : { initialTable })}
      />,
    );

  it("keeps the table for screen readers under the chart, with the switch off", () => {
    const html = frame();

    expect(html).toMatch(/<section[^>]*id="cash-flow"[^>]*aria-labelledby="cash-flow-heading"/);
    expect(html).toMatch(/aria-hidden="true"[^>]*data-slot="report-chart"/);
    expect(html).toContain('data-slot="chart-drawing"');
    expect(html).toMatch(/<input type="checkbox"\/>Show as table/);
    expect(html).toMatch(/class="sr-only" data-slot="report-table"><table aria-label="Cash flow/);
  });

  it("shows the table in the chart's place, with the switch on", () => {
    const html = frame(true);

    expect(html).not.toContain('data-slot="report-chart"');
    expect(html).toMatch(/<input type="checkbox" checked=""\/>Show as table/);
    expect(html).toMatch(/class="mt-3" data-slot="report-table"><table/);
  });

  it("has no switch without a table", () => {
    const html = renderToString(<ReportFrame id="spending" title="Spending" chart="Coming soon" />);

    expect(html).not.toContain("Show as table");
    expect(html).not.toContain("aria-hidden");
  });
});

// WCAG's relative luminance of a #RRGGBB color.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

const contrast = (a: string, b: string) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
};

describe("the Category group colors", () => {
  it("gives each Category group its own color, which reads on white and on the ink color", () => {
    const colors = CATEGORY_GROUPS.map((group) => GROUP_COLORS[group.name]);

    expect(new Set(colors).size).toBe(CATEGORY_GROUPS.length);
    for (const color of colors) {
      expect(contrast(color, "#FFFFFF")).toBeGreaterThanOrEqual(3.5);
      expect(contrast(color, "#14171C")).toBeGreaterThanOrEqual(3.5);
    }
  });
});
