import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LineItemView } from "../../server/amazon-views.ts";
import type { TransactionRowView } from "../../server/money-movement-views.ts";
import { itemsLabel, LineItemsCard, readLineItems } from "./LineItemsList.tsx";
import { TransactionRows } from "./Transactions.tsx";

// The Line items on the Transactions page (spec 14, Pages): the count on a row, and the list on
// the detail view.

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const ROW: TransactionRowView = {
  id: "t-1",
  accountId: "a-card",
  amount: -4_250,
  postedDate: "2026-10-12",
  authorizedDate: null,
  pending: false,
  description: "AMAZON MKTPL*0000000",
  merchantName: "Amazon",
  merchant: "Amazon",
  recurringChargeName: null,
  itemCount: 0,
  parts: [
    {
      type: "Spending",
      amount: -4_250,
      category: "Shopping",
      categoryChosenBy: "Plaid",
      linked: false,
    },
  ],
};

const ITEM: LineItemView = {
  id: "li-1",
  name: "Paper towels, 12 rolls",
  quantity: 2,
  total: 1_350,
  category: "Home and garden",
  aiUnsure: false,
  orderId: "111-0000001-0000001",
  orderDate: "2026-10-10",
  linkKind: "app",
};

describe("Line items on the Transactions page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the item count on a row with linked Line items, and nothing on one without", () => {
    const html = text(
      renderToString(
        <MemoryRouter>
          <TransactionRows
            transactions={[
              ROW,
              { ...ROW, id: "t-2", itemCount: 3 },
              { ...ROW, id: "t-3", itemCount: 1 },
            ]}
            accounts={new Map()}
            today="2026-11-09"
          />
        </MemoryRouter>,
      ),
    );

    expect(html.match(/items?\b/g)).toEqual(["items", "item"]);
    expect(html).toContain("−$42.50 · 3 items Shopping");
    expect(html).toContain("−$42.50 · 1 item Shopping");
    expect(itemsLabel(12)).toBe("12 items");
  });

  it("lists each Line item with its quantity, total, and Category, under its order", () => {
    const html = text(
      renderToString(
        <LineItemsCard
          items={[
            ITEM,
            { ...ITEM, id: "li-2", name: "Dish soap", quantity: 1, total: 499, category: null },
            {
              ...ITEM,
              id: "li-3",
              name: "Batteries",
              quantity: 1,
              total: 2_401,
              orderId: "111-0000002-0000002",
              orderDate: "2025-12-30",
              linkKind: "hand",
            },
          ]}
          today="2026-11-09"
        />,
      ),
    );

    expect(html).toBe(
      [
        "Items · 3 items",
        "Amazon order 111-0000001-0000001 · Oct 10 · Linked by the app",
        "2 × Paper towels, 12 rolls Home and garden $13.50",
        "Dish soap No Category yet $4.99",
        "Amazon order 111-0000002-0000002 · Dec 30, 2025 · Linked by hand",
        "Batteries Home and garden $24.01",
      ].join(" "),
    );
  });

  it("reads a Transaction's Line items from its own route", async () => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      paths.push(String(input));
      return new Response('{"lineItems":[]}', { headers: { "content-type": "application/json" } });
    });

    await readLineItems("t-1");

    expect(paths).toEqual(["/api/transactions/t-1/line-items"]);
  });
});
