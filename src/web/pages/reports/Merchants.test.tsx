import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { MerchantsReportView, RecurringReportView } from "../../../server/reports-views.ts";
import { MerchantsReportCard, merchantFilterHref } from "./Merchants.tsx";
import { merchantMonthHref, merchantWords } from "./merchant-words.ts";

// The Merchants and Recurring charges section (spec 07, Reports). Server rendering draws no chart,
// so these read its tables.

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

const render = (
  path: string,
  views: { merchants?: MerchantsReportView; recurring?: RecurringReportView },
) =>
  renderToString(
    <MemoryRouter initialEntries={[path]}>
      <MerchantsReportCard
        params={new URL(path, "http://nas.local").searchParams}
        merchants={views.merchants}
        recurring={views.recurring}
      />
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
    .replace(/\s+/g, " ")
    .trim();
const rows = (html: string) =>
  [...html.matchAll(/<tr>(.*?)<\/tr>/gs)].map((match) => text(match[1] ?? ""));

describe("the Merchants and Recurring charges section", () => {
  it("lists the top Merchants by month, each month a link to its Transactions", () => {
    const merchants = table(
      tableSlot(render("/reports?range=3m", { merchants: TOP, recurring: RECURRING })),
      "merchants-table",
    );

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
    const merchants = table(
      tableSlot(render("/reports?range=3m", { merchants: quote, recurring: RECURRING })),
      "merchants-table",
    );

    expect(rows(merchants)).toEqual(['Month "', "Sep 2026 $9", "Oct 2026 $0", "Nov 2026 $0"]);
    expect(hrefs(merchants)).toEqual([]);
  });

  it("shows one Merchant's months with its usual month", () => {
    const one: MerchantsReportView = {
      ...TOP,
      merchant: "id m-1",
      series: TOP.series.slice(1),
      usual: 1_000,
    };
    const html = render("/reports?range=3m&merchant=id+m-1", {
      merchants: one,
      recurring: RECURRING,
    });
    const merchants = table(tableSlot(html), "merchants-table");

    expect(text(merchants)).toContain("Spending at Morgan Lee, by month");
    expect(rows(merchants).at(-1)).toBe("Usual month $10");
    expect(html).toMatch(/<option value="id m-1" selected="">Morgan Lee<\/option>/);
  });

  it("offers the top Merchants as its filter, which keeps the range", () => {
    const html = render("/reports?range=3m", { merchants: TOP, recurring: RECURRING });

    expect(text(/<select[^>]*>(.*?)<\/select>/s.exec(html)?.[1] ?? "")).toBe(
      "Top 10 Bluebird Books Morgan Lee",
    );
    const params = new URLSearchParams("range=24m&group=Bills");
    expect(merchantFilterHref(params, "name bluebirdbooks")).toBe(
      "/reports?range=24m&group=Bills&merchant=name+bluebirdbooks#merchants",
    );
    expect(merchantFilterHref(new URLSearchParams("range=24m&merchant=id+m-1"), "")).toBe(
      "/reports?range=24m#merchants",
    );
  });

  it("stacks the Recurring charges with Other, the total and the month's price changes", () => {
    const recurring = table(
      tableSlot(render("/reports?range=3m", { merchants: TOP, recurring: RECURRING })),
      "recurring-table",
    );

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

  it("compares each Recurring charge now with a year ago", () => {
    const changes = table(
      tableSlot(render("/reports?range=3m", { merchants: TOP, recurring: RECURRING })),
      "charge-changes",
    );

    expect(rows(changes)).toEqual([
      "Charge Now A year ago Change",
      "Brightwave $65.00 None",
      "Movie nights $17.99 $15.49 +$2.50",
      "Gym Ended $5.00",
    ]);
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
    const noCharges: RecurringReportView = {
      range: "12m",
      months: [],
      charges: [],
      other: { count: 0, byMonth: [] },
      totals: [],
      priceChanges: [],
      changes: [],
    };
    const html = render("/reports", { merchants: none, recurring: noCharges });
    expect(text(html)).toContain("No Spending yet.");
    expect(text(html)).toContain("No Recurring charge payments yet.");
    expect(html).not.toContain("<table");

    const unknown = render("/reports?merchant=name+nosuch", {
      merchants: { ...TOP, merchant: "name nosuch", series: [] },
      recurring: RECURRING,
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
