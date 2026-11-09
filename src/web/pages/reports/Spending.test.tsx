import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { NO_CATEGORY_YET, type SpendingReportView } from "../../../server/reports-views.ts";
import { groupHref, loneBudget, SpendingReportBody, spendingTooltip } from "./Spending.tsx";

type SpendingBar = SpendingReportView["bars"][number];

// Spending over time on the Reports page (spec 07, Reports). Server rendering draws no chart, so
// these read the table, which holds the chart's numbers and links.

const ALL: SpendingReportView = {
  range: "12m",
  months: ["2026-10", "2026-11"],
  group: null,
  segments: [
    "Bills",
    "Shopping",
    "Transportation",
    "Health and care",
    "Leisure",
    "Other",
    NO_CATEGORY_YET,
  ],
  bars: [
    {
      month: "2026-10",
      spending: 252_500,
      segments: {
        Bills: 200_000,
        Shopping: 45_000,
        Transportation: 0,
        "Health and care": 0,
        Leisure: 5_000,
        Other: 0,
        [NO_CATEGORY_YET]: 2_500,
      },
      budget: 260_000,
    },
    {
      month: "2026-11",
      spending: 10_000,
      segments: {
        Bills: 0,
        Shopping: 10_000,
        Transportation: 0,
        "Health and care": 0,
        Leisure: 0,
        Other: 0,
        [NO_CATEGORY_YET]: 0,
      },
      budget: null,
    },
  ],
  usual: 240_000,
  rows: [
    { name: "Bills", total: 200_000, average: 100_000, change: 10_000 },
    { name: "Shopping", total: 55_000, average: 27_500, change: -4_000 },
    { name: "Transportation", total: 0, average: 0, change: 0 },
    { name: "Health and care", total: 0, average: 0, change: 0 },
    { name: "Leisure", total: 5_000, average: 2_500, change: null },
    { name: "Other", total: 0, average: 0, change: 0 },
    { name: NO_CATEGORY_YET, total: 2_500, average: 1_250, change: 2_500 },
  ],
};

const GROUP: SpendingReportView = {
  range: "3m",
  months: ["2026-11"],
  group: "Leisure",
  segments: ["Restaurants", "Entertainment", "Hobbies", "Travel", "Books and education"],
  bars: [
    {
      month: "2026-11",
      spending: 6_000,
      segments: {
        Restaurants: 5_000,
        Entertainment: 1_000,
        Hobbies: 0,
        Travel: 0,
        "Books and education": 0,
      },
      budget: 30_000,
    },
  ],
  usual: null,
  rows: [
    { name: "Restaurants", total: 5_000, average: 5_000, change: null },
    { name: "Entertainment", total: 1_000, average: 1_000, change: null },
    { name: "Hobbies", total: 0, average: 0, change: null },
    { name: "Travel", total: 0, average: 0, change: null },
    { name: "Books and education", total: 0, average: 0, change: null },
  ],
};

const render = (view: SpendingReportView | undefined, path = "/reports?range=12m") =>
  renderToString(
    <MemoryRouter>
      <SpendingReportBody
        view={view}
        params={new URLSearchParams(path.split("?")[1] ?? "")}
        group={view?.group ?? null}
      />
    </MemoryRouter>,
  );

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// The text of each row of the table named `label`.
const rows = (html: string, label: string) => {
  const table = new RegExp(`<table[^>]*aria-label="${label}"[^>]*>(.*?)</table>`, "s").exec(
    html,
  )?.[1];
  return [...(table ?? "").matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map((match) => text(match[1] ?? ""));
};

const hrefs = (html: string) =>
  [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((match) =>
    (match[1] ?? "").replace(/&amp;/g, "&"),
  );

describe("Spending over time", () => {
  it("holds each month's groups, Spending and Budget in its table, and the usual month", () => {
    const html = render(ALL);

    expect(rows(html, "Spending by month")).toEqual([
      "Month Bills Shopping Transportation Health and care Leisure Other No Category yet Spending Budget",
      "Oct 2026 $2,000 $450 $0 $0 $50 $0 $25 $2,525 $2,600",
      "Nov 2026 $0 $100 $0 $0 $0 $0 $0 $100",
    ]);
    expect(text(html)).toContain("Usual month: $2,400");
    expect(html).toContain('data-slot="report-table"');
  });

  it("shows each group's total, average per month, and change from the range before", () => {
    expect(rows(render(ALL), "Spending over the range")).toEqual([
      "Category group Total Per month Change from the range before",
      "Bills $2,000 $1,000 +$100",
      "Shopping $550 $275 −$40",
      "Transportation $0 $0 $0",
      "Health and care $0 $0 $0",
      "Leisure $50 $25",
      "Other $0 $0 $0",
      "No Category yet $25 $13 +$25",
    ]);
    // With no change in any row, as with no whole range before, the column is left out.
    expect(rows(render(GROUP), "Spending over the range")[0]).toBe("Category Total Per month");
  });

  it("opens a group's segment at the month's Spending, and a Category's at its Category", () => {
    // Each month's 7 segments and its Spending.
    expect(hrefs(render(ALL))).toEqual([
      ...Array.from({ length: 8 }, () => "/transactions?type=Spending&month=2026-10"),
      ...Array.from({ length: 8 }, () => "/transactions?type=Spending&month=2026-11"),
    ]);

    expect(hrefs(render(GROUP))).toEqual([
      "/transactions?category=Restaurants&month=2026-11",
      "/transactions?category=Entertainment&month=2026-11",
      "/transactions?category=Hobbies&month=2026-11",
      "/transactions?category=Travel&month=2026-11",
      "/transactions?category=Books+and+education&month=2026-11",
      "/transactions?type=Spending&month=2026-11",
    ]);
    expect(rows(render(GROUP), "Spending by month")).toEqual([
      "Month Restaurants Entertainment Hobbies Travel Books and education Spending Budget",
      "Nov 2026 $50 $10 $0 $0 $0 $60 $300",
    ]);
  });

  it("offers every Category group as its filter, which keeps the range", () => {
    const html = render(GROUP, "/reports?range=3m&group=Leisure");
    const options = [...html.matchAll(/<option[^>]*>(.*?)<\/option>/g)].map((match) => match[1]);

    expect(options).toEqual([
      "All groups",
      "Bills",
      "Shopping",
      "Transportation",
      "Health and care",
      "Leisure",
      "Other",
    ]);
    expect(html).toMatch(/<option value="Leisure" selected="">/);
    const params = new URLSearchParams("range=3m&account=acc-1");
    expect(groupHref(params, "Health and care")).toBe(
      "/reports?range=3m&account=acc-1&group=Health+and+care#spending",
    );
    expect(groupHref(new URLSearchParams("range=all&group=Bills"), "")).toBe(
      "/reports?range=all#spending",
    );
  });

  it("says so with no history or no Spending, and draws no chart", () => {
    const none = render({ ...ALL, months: [], segments: [], bars: [], usual: null, rows: [] });
    expect(text(none)).toContain("No posted Transactions yet.");
    expect(none).not.toContain("report-table");

    const quiet = render({
      ...GROUP,
      bars: GROUP.bars.map((bar) => ({ ...bar, spending: 0, segments: {} })),
    });
    expect(text(quiet)).toContain("No Spending yet.");
    expect(quiet).not.toContain("report-table");
  });
});

describe("Spending over time's card", () => {
  const slot = (html: string, name: string) =>
    text(new RegExp(`data-slot="${name}"[^>]*>(.*?)</p>`, "s").exec(html)?.[1] ?? "");

  it("opens with the average month, the range's total, and the last full month against usual", () => {
    const html = render(ALL);

    expect(slot(html, "report-headline")).toBe("$1,313 a month on average");
    expect(slot(html, "report-line")).toBe(
      "$2,625 over 2 months · October $2,525, ▲ $125 above usual",
    );
    // More Spending than usual is the bad direction.
    expect(html).toMatch(/class="text-serious">▲ \$125 above usual/);
    expect(slot(html, "report-caption")).toBe(
      "Pale bar: November so far. Choose a bar to see its Transactions.",
    );
  });

  it("gives no comparison without a full month or a usual month", () => {
    expect(slot(render(GROUP), "report-line")).toBe("$60 over 1 month");
  });

  it("labels its filter in one short word", () => {
    expect(text(/<label[^>]*>(.*?)<select/s.exec(render(ALL))?.[1] ?? "")).toBe("Group");
  });

  it("hovers a month with its groups, top first, their total, and its Budget", () => {
    expect(spendingTooltip(ALL, "2026-10")).toEqual({
      title: "October 2026",
      rows: [
        { name: NO_CATEGORY_YET, amount: "$25", color: "#9AA3AE" },
        { name: "Leisure", amount: "$50", color: "#7B5CD6" },
        { name: "Shopping", amount: "$450", color: "#0A9182" },
        { name: "Bills", amount: "$2,000", color: "#3B6FD8" },
        { name: "Budget", amount: "$2,600" },
      ],
      total: { name: "Spending", amount: "$2,525" },
    });
    expect(spendingTooltip(ALL, "2026-11")?.title).toBe("November 2026 so far");
    expect(spendingTooltip(ALL, "2026-09")).toBeNull();
  });

  it("marks a Budget with no Budget beside it, which has no line to draw", () => {
    const budgets = (cents: (number | null)[]) => ({
      ...ALL,
      bars: cents.map((budget, at) => ({
        ...(ALL.bars[0] as SpendingBar),
        month: `m${at}`,
        budget,
      })),
    });

    // A Budget set this month only.
    expect([0, 1].map((at) => loneBudget(budgets([null, 375_700]), at))).toEqual([false, true]);
    // A line runs between two months with a Budget.
    expect([0, 1, 2].map((at) => loneBudget(budgets([260_000, 260_000, null]), at))).toEqual([
      false,
      false,
      false,
    ]);
    expect(loneBudget(budgets([260_000, null, 260_000]), 2)).toBe(true);
    expect(loneBudget(ALL, undefined)).toBe(false);
  });
});
