import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { CATEGORY_GROUPS } from "../../categories/list.ts";
import { GROUP_COLORS } from "../chart-colors.ts";
import { REPORT_SECTIONS, reportsPath } from "../reports.ts";
import { Reports } from "./Reports.tsx";
import { drillDownHref } from "./reports/drill-down.ts";
import { ReportFrame } from "./reports/ReportFrame.tsx";
import { ReportTable } from "./reports/ReportTable.tsx";

// The Reports page's frame (spec 07, Reports): its range presets, its jump links, its five
// sections, the shared report card and table, and the drill-down links. Each report's own tests
// are in pages/reports/.

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
  it("shows its five reports, each in its own section", () => {
    const html = render("/reports");

    expect([...html.matchAll(/<h1[^>]*>(.*?)<\/h1>/g)].map((match) => match[1])).toEqual([
      "Reports",
    ]);
    expect([...html.matchAll(/<section[^>]* id="([^"]*)"/g)].map((match) => match[1])).toEqual([
      ...REPORT_SECTIONS,
    ]);
    expect(REPORT_SECTIONS).toEqual([
      "spending",
      "cash-flow",
      "balances",
      "merchants",
      "recurring",
    ]);
    expect([...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((match) => match[1])).toEqual([
      "Spending over time",
      "Cash flow",
      "Balances and debt",
      "Merchants",
      "Recurring charges",
    ]);
    // Every report loads its view after the page draws; none says "Coming soon".
    expect(html).not.toContain("Coming soon");
  });

  it("jumps to each report from one row of links under the heading", () => {
    const html = render("/reports?range=3m");
    const nav = /<nav aria-label="Reports on this page"[^>]*>(.*?)<\/nav>/s.exec(html)?.[1] ?? "";

    expect(text(nav)).toBe(
      "Spending over time Cash flow Balances and debt Merchants Recurring charges",
    );
    // A bare hash keeps the range and every filter in the address.
    expect(hrefs(nav)).toEqual([
      "#spending",
      "#cash-flow",
      "#balances",
      "#merchants",
      "#recurring",
    ]);
    // On a phone the row scrolls inside itself.
    expect(nav).toMatch(/<ul class="[^"]*overflow-x-auto[^"]*" data-slot="jump-links">/);
    // It comes after the range presets and before the first report.
    expect(html.indexOf('aria-label="Range"')).toBeLessThan(html.indexOf("Reports on this page"));
    expect(html.indexOf("Reports on this page")).toBeLessThan(html.indexOf('id="spending"'));
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

  it("keeps the table for screen readers under the chart, with the numbers closed", () => {
    const html = frame();

    expect(html).toMatch(/<section[^>]*id="cash-flow"[^>]*aria-labelledby="cash-flow-heading"/);
    expect(html).toMatch(/aria-hidden="true"[^>]*data-slot="report-chart"/);
    expect(html).toContain('data-slot="chart-drawing"');
    expect(html).toMatch(
      /<button type="button" aria-controls="cash-flow-numbers" aria-expanded="false"[^>]*>Show the numbers<\/button>/,
    );
    expect(html).toMatch(
      /id="cash-flow-numbers" class="sr-only" data-slot="report-table"><table aria-label="Cash flow/,
    );
    expect(html).not.toContain('type="checkbox"');
  });

  it("shows the table under the chart, with the numbers open", () => {
    const html = frame(true);

    expect(html).toMatch(/aria-hidden="true"[^>]*data-slot="report-chart"/);
    expect(html).toMatch(/aria-expanded="true"[^>]*>Hide the numbers<\/button>/);
    expect(html).toMatch(/class="mt-3" data-slot="report-table"><table/);
    expect(html.indexOf("report-chart")).toBeLessThan(html.indexOf("report-table"));
  });

  it("has no button without a table, and hides no chart", () => {
    const html = renderToString(<ReportFrame id="spending" title="Spending" chart="Coming soon" />);

    expect(html).not.toContain("the numbers");
    expect(html).not.toContain("aria-hidden");
  });

  it("reads as a dashboard card: grey label, big number, colored line, filter, chart, caption", () => {
    const html = renderToString(
      <ReportFrame
        id="cash-flow"
        title="Cash flow"
        filter={<select data-slot="the-filter" />}
        headline={{
          amount: "$1,752",
          unit: "left over",
          line: ["From ", { tone: "good", text: "$5,087 Income" }],
        }}
        chart={<svg data-slot="chart-drawing" />}
        caption="Pale bar: November so far."
        table={<table aria-label="Cash flow by month" />}
      />,
    );

    expect(html).toMatch(
      /<h2 id="cash-flow-heading" class="text-small font-semibold text-muted">Cash flow<\/h2>/,
    );
    expect(text(/data-slot="report-headline">(.*?)<\/p>/s.exec(html)?.[1] ?? "")).toBe(
      "$1,752 left over",
    );
    expect(html).toMatch(/data-slot="report-line"><span>From <\/span><span class="text-good">/);
    expect(html).toMatch(/data-slot="report-caption">Pale bar: November so far.<\/p>/);
    const order = ["cash-flow-heading", "report-headline", "the-filter", "report-chart"];
    expect(order.map((slot) => html.indexOf(slot))).toEqual(
      order.map((slot) => html.indexOf(slot)).sort((a, b) => a - b),
    );
  });

  it("chart that reads its own numbers, such as a ranked list, stays for screen readers", () => {
    const html = renderToString(
      <ReportFrame
        id="merchants"
        title="Merchants"
        chart={<ol />}
        chartReads
        table={<table aria-label="By month" />}
      />,
    );
    expect(html).not.toMatch(/aria-hidden="true"[^>]*data-slot="report-chart"/);
  });
});

describe("a report's table", () => {
  const draw = (change: (number | null)[]) =>
    renderToString(
      <ReportTable
        label="Spending over the range"
        head="Category group"
        columns={[
          { key: "total", name: "Total" },
          { key: "change", name: "Change from the range before" },
        ]}
        rows={change.map((cents, at) => ({
          key: String(at),
          head: `Group ${at}`,
          cells: ["$10", cents === null ? "" : `$${cents}`],
        }))}
      />,
    );

  it("leaves out a column with no words in any row, and keeps one with words in any", () => {
    expect(text(draw([null, null]))).toBe("Category group Total Group 0 $10 Group 1 $10");
    expect(text(draw([null, 5]))).toBe(
      "Category group Total Change from the range before Group 0 $10 Group 1 $10 $5",
    );
  });

  it("scrolls sideways inside its card, with its first column in view, and amounts at the right", () => {
    const html = draw([5]);

    expect(html).toMatch(/^<div class="max-w-full overflow-x-auto"/);
    expect(html).toMatch(/<th scope="col" class="[^"]*sticky left-0[^"]*">Category group/);
    expect(html).toMatch(/<th scope="row" class="[^"]*sticky left-0[^"]*">Group 0/);
    expect(html).toMatch(/<td class="[^"]*tabular-nums[^"]*text-right[^"]*">\$10<\/td>/);
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
