import { renderToString } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import type { BalancesReportView } from "../../../server/reports-views.ts";
import { accountHref, BalancesReportBody } from "./Balances.tsx";

// Balances and debt's section (spec 07, Reports), drawn from a fake answer. Server rendering draws
// no chart, so these read the tables, which hold the charts' numbers, and their links.

const MONTHS = ["2026-09", "2026-10"];
const end = (month: string, estimated = false) => ({
  month,
  date: month === "2026-10" ? "2026-10-20" : "2026-09-30",
  estimated,
});

const VIEW: BalancesReportView = {
  range: "3m",
  months: MONTHS,
  today: "2026-10-20",
  accounts: [
    { id: "acc-checking", name: "Interest Checking", kind: "depository" },
    { id: "acc-card", name: "Rewards Card", kind: "credit" },
    { id: "acc-loan", name: "Car loan", kind: "loan" },
  ],
  account: null,
  cashOnHand: [
    { ...end("2026-09", true), amount: 412_550 },
    { ...end("2026-10"), amount: 398_000 },
  ],
  debt: [
    { ...end("2026-09", true), amount: 2_150_000 },
    { ...end("2026-10"), amount: 2_120_000 },
  ],
  creditUse: {
    cards: [
      {
        id: "acc-card",
        name: "Rewards Card",
        kind: "credit",
        points: [
          { ...end("2026-09", true), share: 0.42 },
          { ...end("2026-10"), share: null },
        ],
      },
    ],
    all: [
      { ...end("2026-09", true), share: 0.42 },
      { ...end("2026-10"), share: null },
    ],
  },
  loans: [
    {
      id: "acc-loan",
      name: "Car loan",
      kind: "loan",
      points: [
        { ...end("2026-09"), principal: null },
        { ...end("2026-10"), principal: 2_000_000 },
      ],
    },
  ],
};

const render = (view: BalancesReportView, search = "?range=3m") => {
  const params = new URLSearchParams(search);
  const router = createMemoryRouter(
    [{ path: "/reports", element: <BalancesReportBody view={view} params={params} /> }],
    { initialEntries: [`/reports${search}`] },
  );
  return renderToString(<RouterProvider router={router} />);
};

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

// Each table's caption, and each row's words, in order.
const tables = (html: string) =>
  [...html.matchAll(/<table[^>]*>(.*?)<\/table>/gs)].map((match) =>
    [...(match[1] ?? "").matchAll(/<(?:caption|tr)[^>]*>(.*?)<\/(?:caption|tr)>/gs)].map((row) =>
      text(row[1] ?? ""),
    ),
  );

const hrefs = (html: string) =>
  [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((match) =>
    (match[1] ?? "").replace(/&amp;/g, "&"),
  );

describe("Balances and debt", () => {
  it("holds each line's month-ends in a table, estimated ones marked", () => {
    expect(tables(render(VIEW))).toEqual([
      [
        "Cash on hand and Debt by month",
        "Month Cash on hand Debt",
        "Sep 2026 $4,125.50 (estimated) $21,500.00 (estimated)",
        "Oct 2026 $3,980.00 $21,200.00",
      ],
      [
        "Credit use by month",
        "Month Rewards Card All cards",
        "Sep 2026 42% (estimated) 42% (estimated)",
        "Oct 2026 no limit no limit",
      ],
      ["Loan pay-down by month", "Month Car loan", "Sep 2026 none", "Oct 2026 $20,000.00"],
    ]);
  });

  it("links each month-end to its Transactions: the month, and the Account for a card or loan", () => {
    expect(hrefs(render(VIEW))).toEqual([
      "/transactions?month=2026-09",
      "/transactions?month=2026-09",
      "/transactions?month=2026-10",
      "/transactions?month=2026-10",
      "/transactions?account=acc-card&month=2026-09",
      "/transactions?account=acc-card&month=2026-10",
      "/transactions?account=acc-loan&month=2026-09",
      "/transactions?account=acc-loan&month=2026-10",
    ]);
  });

  it("offers every Account in its filter, and keeps the range and the other filters", () => {
    const html = render(VIEW);
    expect([...html.matchAll(/<option[^>]*>(.*?)<\/option>/g)].map((match) => match[1])).toEqual([
      "All Accounts",
      "Interest Checking",
      "Rewards Card",
      "Car loan",
    ]);
    const params = new URLSearchParams("range=24m&group=Bills&account=acc-card");
    expect(accountHref(params, "acc-loan")).toBe(
      "/reports?range=24m&group=Bills&account=acc-loan#balances",
    );
    expect(accountHref(params, "")).toBe("/reports?range=24m&group=Bills#balances");
    expect(accountHref(new URLSearchParams(), "acc-loan")).toBe(
      "/reports?account=acc-loan#balances",
    );
  });

  it("says so with no card that has a limit, and no loan", () => {
    const html = render({ ...VIEW, creditUse: { cards: [], all: [] }, loans: [] });
    expect(text(html)).toContain("No credit card with a credit limit.");
    expect(text(html)).toContain("No loan to show.");
    expect(tables(html)).toHaveLength(1);
  });

  it("gives an empty history a short line, not an empty chart", () => {
    const html = render({ ...VIEW, months: [], cashOnHand: [], debt: [] });
    expect(text(html)).toContain("No balances yet.");
    expect(html).not.toContain("<table");
    expect(html).not.toContain("Show as table");
  });

  it("shows one Account's balance line and its month-ends", () => {
    const html = render(
      {
        ...VIEW,
        cashOnHand: [],
        debt: [],
        creditUse: { cards: [], all: [] },
        loans: [],
        account: {
          id: "acc-checking",
          name: "Interest Checking",
          kind: "depository",
          points: [
            {
              date: "2026-09-30",
              currentBalance: 120_000,
              availableBalance: null,
              estimated: true,
            },
            {
              date: "2026-10-20",
              currentBalance: 98_000,
              availableBalance: 98_000,
              estimated: false,
            },
          ],
          monthEnds: [
            { month: "2026-09", date: "2026-09-30", currentBalance: 120_000, estimated: true },
            { month: "2026-10", date: "2026-10-20", currentBalance: 98_000, estimated: false },
          ],
        },
      },
      "?range=3m&account=acc-checking",
    );
    expect(tables(html)).toEqual([
      [
        "Interest Checking by month",
        "Month Balance",
        "Sep 2026 $1,200.00 (estimated)",
        "Oct 2026 $980.00",
      ],
    ]);
    expect(hrefs(html)).toEqual([
      "/transactions?account=acc-checking&month=2026-09",
      "/transactions?account=acc-checking&month=2026-10",
    ]);
    expect(html).toMatch(/<option value="acc-checking" selected="">Interest Checking<\/option>/);
  });
});
