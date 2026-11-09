import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { MerchantsReportView, RecurringReportView } from "../../../server/reports-views.ts";
import { MerchantsReportCard, merchantFilterHref } from "./Merchants.tsx";
import { merchantMonthHref, merchantWords } from "./merchant-words.ts";
import { RecurringReportCard, recurringTooltip } from "./Recurring.tsx";

// The Merchants and Recurring charges sections (spec 07, Reports). Server rendering draws no chart,
// so these read their lists, tables and words.

const MONTHS = ["2026-09", "2026-10", "2026-11"];

const TOP: MerchantsReportView = {
  range: "3m",
  months: MONTHS,
  merchant: null,
  choices: [
    { key: "name bluebirdbooks", merchantName: "Bluebird Books" },
    { key: "id m-1", merchantName: "Morgan Lee" },
  ],
  series: [
    {
      key: "name bluebirdbooks",
      merchantId: null,
      merchantName: "Bluebird Books",
      total: 6_500,
      byMonth: [4_000, 2_500, 0],
    },
    {
      key: "id m-1",
      merchantId: "m-1",
      merchantName: "Morgan Lee",
      total: 2_000,
      byMonth: [0, 2_000, 0],
    },
  ],
  usual: null,
};

const RECURRING: RecurringReportView = {
  range: "3m",
  months: MONTHS,
  charges: [
    {
      id: "c1",
      name: "Brightwave",
      merchantId: null,
      merchantName: "Brightwave",
      total: 19_500,
      byMonth: [6_500, 6_500, 6_500],
    },
    {
      id: "c2",
      name: "Movie nights",
      merchantId: "m-streamly",
      merchantName: "Streamly",
      total: 5_147,
      byMonth: [1_549, 1_799, 1_799],
    },
  ],
  other: { count: 1, byMonth: [0, 500, 0] },
  totals: [8_049, 8_799, 8_299],
  priceChanges: [
    {
      chargeId: "c2",
      name: "Movie nights",
      merchantName: "Streamly",
      month: "2026-10",
      fromDate: "2026-10-03",
      amount: 1_799,
      before: 1_549,
    },
  ],
  changes: [
    {
      id: "c1",
      name: "Brightwave",
      merchantName: "Brightwave",
      status: "active",
      now: 6_500,
      yearAgo: null,
      change: null,
    },
    {
      id: "c2",
      name: "Movie nights",
      merchantName: "Streamly",
      status: "active",
      now: 1_799,
      yearAgo: 1_549,
      change: 250,
    },
    {
      id: "c3",
      name: "Gym",
      merchantName: "Gym",
      status: "ended",
      now: null,
      yearAgo: 500,
      change: null,
    },
  ],
};

const render = (path: string, merchants: MerchantsReportView | undefined) =>
  renderToString(
    <MemoryRouter initialEntries={[path]}>
      <MerchantsReportCard
        params={new URL(path, "http://nas.local").searchParams}
        merchants={merchants}
      />
    </MemoryRouter>,
  );

const renderRecurring = (recurring: RecurringReportView | undefined) =>
  renderToString(
    <MemoryRouter>
      <RecurringReportCard recurring={recurring} />
    </MemoryRouter>,
  );

const tableSlot = (html: string) => /data-slot="report-table">(.*)$/s.exec(html)?.[1] ?? "";
const table = (html: string, slot: string) =>
  new RegExp(`<table[^>]*data-slot="${slot}"[^>]*>(.*?)</table>`, "s").exec(html)?.[1] ?? "";
const hrefs = (html: string) =>
  [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((match) =>
    (match[1] ?? "").replace(/&amp;/g, "&"),
  );
const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
const rows = (html: string) =>
  [...html.matchAll(/<tr>(.*?)<\/tr>/gs)].map((match) => text(match[1] ?? ""));
const slot = (html: string, name: string) =>
  text(new RegExp(`data-slot="${name}"[^>]*>(.*?)</p>`, "s").exec(html)?.[1] ?? "");
const ranks = (html: string) => /<ol data-slot="merchant-ranks">(.*?)<\/ol>/s.exec(html)?.[1] ?? "";

describe("the Merchants section", () => {
  it("ranks the top Merchants, each row opening its own view, and keeps them for screen readers", () => {
    const html = render("/reports?range=3m", TOP);
    const list = ranks(html);

    expect(
      [...list.matchAll(/<li[^>]*>(.*?)<\/li>/gs)].map((match) => text(match[1] ?? "")),
    ).toEqual(["1 Bluebird Books $65", "2 Morgan Lee $20"]);
    expect(hrefs(list)).toEqual([
      "/reports?range=3m&merchant=name+bluebirdbooks#merchants",
      "/reports?range=3m&merchant=id+m-1#merchants",
    ]);
    // Each row draws its months as a small line, and its bar against the top Merchant's.
    expect(list.match(/data-slot="sparkline"/g)).toHaveLength(2);
    expect(list).toMatch(/style="width:100%" data-slot="meter-fill"/);
    // The list says its own numbers, so it is not hidden from screen readers.
    expect(html).not.toMatch(/aria-hidden="true"[^>]*data-slot="report-chart"/);
  });

  it("opens with the top Merchant's total and the top 10's", () => {
    const html = render("/reports?range=3m", TOP);

    expect(slot(html, "report-headline")).toBe("$65 at Bluebird Books");
    expect(slot(html, "report-line")).toBe("The top 2 Merchants: $85 over 3 months");
  });

  it("lists the top Merchants by month, each month a link to its Transactions", () => {
    const merchants = table(tableSlot(render("/reports?range=3m", TOP)), "merchants-table");

    expect(rows(merchants)).toEqual([
      "Month Bluebird Books Morgan Lee",
      "Sep 2026 $40 $0",
      "Oct 2026 $25 $20",
      "Nov 2026 $0 $0",
    ]);
    expect(hrefs(merchants).slice(0, 4)).toEqual([
      "/transactions?merchant=%22Bluebird+Books%22&month=2026-09",
      "/transactions?merchantId=m-1&month=2026-09",
      "/transactions?merchant=%22Bluebird+Books%22&month=2026-10",
      "/transactions?merchantId=m-1&month=2026-10",
    ]);
  });

  it("gives no link to a month of a Merchant no filter names alone", () => {
    const quote: MerchantsReportView = {
      ...TOP,
      choices: [{ key: 'name "', merchantName: '"' }],
      series: [
        { key: 'name "', merchantId: null, merchantName: '"', total: 900, byMonth: [900, 0, 0] },
      ],
    };
    const merchants = table(tableSlot(render("/reports?range=3m", quote)), "merchants-table");

    expect(rows(merchants)).toEqual(['Month "', "Sep 2026 $9", "Oct 2026 $0", "Nov 2026 $0"]);
    expect(hrefs(merchants)).toEqual([]);
  });

  it("shows one Merchant's months with its usual month, and its last full month against it", () => {
    const one: MerchantsReportView = {
      ...TOP,
      merchant: "id m-1",
      series: TOP.series.slice(1),
      usual: 1_000,
    };
    const html = render("/reports?range=3m&merchant=id+m-1", one);
    const merchants = table(tableSlot(html), "merchants-table");

    expect(text(merchants)).toContain("Spending at Morgan Lee, by month");
    expect(rows(merchants).at(-1)).toBe("Usual month $10");
    expect(html).toMatch(/<option value="id m-1" selected="">Morgan Lee<\/option>/);
    expect(slot(html, "report-headline")).toBe("$20 at Morgan Lee");
    expect(slot(html, "report-line")).toBe("Over 3 months · October $20, ▲ $10 above usual");
    // Its bars are a chart, hidden from screen readers; the table holds the numbers.
    expect(html).not.toContain("merchant-ranks");
    expect(html).toMatch(/aria-hidden="true"[^>]*data-slot="report-chart"/);
  });

  it("offers the top Merchants as its filter, which keeps the range", () => {
    const html = render("/reports?range=3m", TOP);

    expect(text(/<select[^>]*>(.*?)<\/select>/s.exec(html)?.[1] ?? "")).toBe(
      "Top 10 Bluebird Books Morgan Lee",
    );
    expect(text(/<label[^>]*>(.*?)<select/s.exec(html)?.[1] ?? "")).toBe("Merchant");
    const params = new URLSearchParams("range=24m&group=Bills");
    expect(merchantFilterHref(params, "name bluebirdbooks")).toBe(
      "/reports?range=24m&group=Bills&merchant=name+bluebirdbooks#merchants",
    );
    expect(merchantFilterHref(new URLSearchParams("range=24m&merchant=id+m-1"), "")).toBe(
      "/reports?range=24m#merchants",
    );
  });

  it("says so when there is nothing to show", () => {
    const none: MerchantsReportView = {
      range: "12m",
      months: [],
      merchant: null,
      choices: [],
      series: [],
      usual: null,
    };
    const html = render("/reports", none);
    expect(text(html)).toContain("No Spending yet.");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("report-headline");

    const unknown = render("/reports?merchant=name+nosuch", {
      ...TOP,
      merchant: "name nosuch",
      series: [],
    });
    expect(text(unknown)).toContain("No Spending at this Merchant.");
    expect(unknown).toMatch(/<option value="name nosuch" selected="">No such Merchant<\/option>/);
  });

  it("searches the Transactions page for the Merchant's exact words", () => {
    expect(merchantWords("Bluebird Books")).toBe('"Bluebird Books"');
    expect(merchantWords('The "Best" Diner')).toBe('"The  Best  Diner"');
    expect(merchantWords('"')).toBeNull();
    expect(merchantWords(' " " ')).toBeNull();
    expect(merchantMonthHref({ merchantId: null, merchantName: "Corner Grocer" }, "2026-10")).toBe(
      "/transactions?merchant=%22Corner+Grocer%22&month=2026-10",
    );
    // A provider Merchant ID names the Merchant alone, whatever its name.
    expect(merchantMonthHref({ merchantId: "m-quote", merchantName: '"' }, "2026-10")).toBe(
      "/transactions?merchantId=m-quote&month=2026-10",
    );
    expect(merchantMonthHref({ merchantId: null, merchantName: '"' }, "2026-10")).toBeNull();
  });
});

describe("the Recurring charges section", () => {
  it("is its own card, with its own section", () => {
    const html = renderRecurring(RECURRING);

    expect(html).toMatch(/<section[^>]*id="recurring"[^>]*aria-labelledby="recurring-heading"/);
    expect(html).toMatch(/<h2 id="recurring-heading"[^>]*>Recurring charges<\/h2>/);
  });

  it("opens with the last full month's charges and how prices moved from a year ago", () => {
    const html = renderRecurring(RECURRING);

    expect(slot(html, "report-headline")).toBe("$88 in October");
    // Only Movie nights had a price a year ago and now: $2.50 more.
    expect(slot(html, "report-line")).toBe("▲ Prices $2.50 higher than a year ago");
    expect(html).toMatch(/class="text-serious">▲ Prices/);
    expect(slot(html, "report-caption")).toBe(
      "Pale bar: November so far. A ring marks a price change. Choose a charge to see its Transactions.",
    );
  });

  it("stacks the Recurring charges with Other, the total and the month's price changes", () => {
    const recurring = table(tableSlot(renderRecurring(RECURRING)), "recurring-table");

    expect(rows(recurring)).toEqual([
      "Month Brightwave Movie nights Other (1) Total Price changes",
      "Sep 2026 $65 $15 $0 $80",
      "Oct 2026 $65 $18 $5 $88 Movie nights $15.49 to $17.99",
      "Nov 2026 $65 $18 $0 $83",
    ]);
    // A charge's bar opens its Merchant's Transactions, not its Member's name.
    expect(hrefs(recurring).slice(0, 2)).toEqual([
      "/transactions?merchant=%22Brightwave%22&month=2026-09",
      "/transactions?merchantId=m-streamly&month=2026-09",
    ]);
  });

  it("leaves out the price changes column in a range with none", () => {
    const recurring = table(
      tableSlot(renderRecurring({ ...RECURRING, priceChanges: [] })),
      "recurring-table",
    );

    expect(rows(recurring)[0]).toBe("Month Brightwave Movie nights Other (1) Total");
  });

  it("compares each Recurring charge now with a year ago, always in view", () => {
    const html = renderRecurring(RECURRING);
    const summary = /data-slot="report-summary">(.*?)data-slot="table-switch"/s.exec(html)?.[1];

    expect(rows(table(summary ?? "", "charge-changes"))).toEqual([
      "Charge Now A year ago Change",
      "Brightwave $65.00 None",
      "Movie nights $17.99 $15.49 +$2.50",
      "Gym Ended $5.00",
    ]);
  });

  it("names a segment's charge in its hover label, with the month's total", () => {
    expect(recurringTooltip(RECURRING, "2026-10", "c1")).toEqual({
      title: "October 2026",
      rows: [
        { name: "Movie nights", amount: "$17.99" },
        { name: "Price change", amount: "$15.49 to $17.99" },
      ],
      total: { name: "All Recurring charges", amount: "$87.99" },
    });
    expect(recurringTooltip(RECURRING, "2026-11", "other")).toEqual({
      title: "November 2026 so far",
      rows: [{ name: "Other (1)", amount: "$0.00" }],
      total: { name: "All Recurring charges", amount: "$82.99" },
    });
  });

  it("says so when there is nothing to show", () => {
    const html = renderRecurring({
      range: "12m",
      months: [],
      charges: [],
      other: { count: 0, byMonth: [] },
      totals: [],
      priceChanges: [],
      changes: [],
    });
    expect(text(html)).toContain("No Recurring charge payments yet.");
    expect(html).not.toContain("<table");
  });
});
