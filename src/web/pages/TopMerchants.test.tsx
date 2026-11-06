import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TopMerchantView } from "../../server/top-merchants-views.ts";
import {
  merchantFacts,
  PeriodSwitch,
  TopMerchantList,
  topMerchantRequests,
} from "./TopMerchants.tsx";

// Top Merchants (spec 07, Top Merchants).

const MERCHANTS: TopMerchantView[] = [
  {
    id: "name cornergrocer",
    merchantName: "Corner Grocer",
    spending: 1_248_049,
    transactions: 142,
    category: "Groceries",
  },
  { id: "id m-1", merchantName: "Streamly", spending: 1_549, transactions: 1, category: null },
];

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("the Top Merchants page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows each Merchant's rank, Spending, number of Transactions, and Category, in order", () => {
    const html = renderToString(
      <MemoryRouter>
        <TopMerchantList merchants={MERCHANTS} />
      </MemoryRouter>,
    );
    const rows = [...html.matchAll(/<li[^>]*>(.*?)<\/li>/gs)].map((match) => text(match[1] ?? ""));

    expect(rows).toEqual([
      "1 Corner Grocer 142 Transactions · Groceries $12,480",
      "2 Streamly 1 Transaction $15",
    ]);
    expect(merchantFacts(MERCHANTS[1] as TopMerchantView)).toBe("1 Transaction");
  });

  it("opens the Transactions page for the Merchant on a tap", () => {
    const html = renderToString(
      <MemoryRouter>
        <TopMerchantList merchants={MERCHANTS} />
      </MemoryRouter>,
    );

    expect([...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1])).toEqual([
      "/transactions?merchant=Corner+Grocer",
      "/transactions?merchant=Streamly",
    ]);
  });

  it('says "No Spending yet." with no Merchants', () => {
    expect(text(renderToString(<TopMerchantList merchants={[]} />))).toBe("No Spending yet.");
  });

  it('switches between "This month" and "Last 12 months", and asks for that period', async () => {
    const html = renderToString(<PeriodSwitch period="This month" onChange={() => {}} />);
    expect(
      [...html.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>(.*?)<\/button>/g)].map(
        (match) => `${match[2]} ${match[1]}`,
      ),
    ).toEqual(["This month true", "Last 12 months false"]);

    const onChange = vi.fn();
    // The switch's children: its legend, then one button for each period.
    const [, choices] = PeriodSwitch({ period: "This month", onChange }).props.children as [
      unknown,
      { props: { onClick(): void } }[],
    ];
    choices[1]?.props.onClick();
    expect(onChange).toHaveBeenCalledWith("Last 12 months");

    const sent: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://app.test");
      sent.push(`${init?.method ?? "GET"} ${url.pathname} ${url.searchParams.get("period")}`);
      return Response.json({ merchants: [] });
    });
    await topMerchantRequests.view("Last 12 months");
    await topMerchantRequests.view("This month");
    expect(sent).toEqual([
      "GET /api/top-merchants Last 12 months",
      "GET /api/top-merchants This month",
    ]);
  });
});
