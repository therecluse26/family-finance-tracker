import { isValidElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AmazonShipmentView } from "../../server/amazon-links-views.ts";
import type { ReviewItemView, ReviewTransactionView } from "../../server/review-views.ts";
import {
  amazonLinkRequests,
  ShipmentsToLink,
  shipmentLine,
  UndoAmazonLink,
} from "./AmazonLink.tsx";
import { AMAZON_SHIPMENT, AmazonShipmentItem } from "./AmazonShipmentItem.tsx";
import { type ItemActions, ReviewItems } from "./ReviewList.tsx";

// A Transaction's Amazon links on its detail view, and the Amazon shipment card on the Review list
// page (spec 14, Hand links; Review list items). Every order ID and name is made up.

const TODAY = "2026-05-12";

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

// The buttons in a tree with no hooks, in order: their words and what each does when tapped.
function buttonsOf(node: ReactNode): { words: string; tap: () => void }[] {
  const found: { words: string; tap: () => void }[] = [];
  const words = (each: ReactNode): string =>
    typeof each === "string" || typeof each === "number"
      ? String(each)
      : Array.isArray(each)
        ? each.map(words).join("")
        : isValidElement<{ children?: ReactNode }>(each)
          ? words(each.props.children)
          : "";
  const walk = (each: ReactNode) => {
    if (Array.isArray(each)) return each.forEach(walk);
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(each)) return;
    if (typeof each.type === "function") {
      return walk((each.type as (props: unknown) => ReactNode)(each.props));
    }
    if (each.type === "button" && each.props.onClick !== undefined) {
      found.push({ words: words(each.props.children), tap: each.props.onClick });
    }
    walk(each.props.children);
  };
  walk(node);
  return found;
}

const SHIPMENT: AmazonShipmentView = {
  orderId: "111-0000002-0000002",
  shipTime: "2026-05-02T09:15:00Z",
  orderDate: "2026-05-01",
  shipDate: "2026-05-02",
  total: 2_000,
  items: 4,
  names: ["Paper towels, 12 rolls", "Dish soap", "Batteries", "Sponges"],
  giftCard: false,
};

const txn = (id: string, fields: Partial<ReviewTransactionView> = {}): ReviewTransactionView => ({
  id,
  amount: -2_000,
  postedDate: "2026-05-03",
  authorizedDate: null,
  description: "AMZN Mktp US*EXAMPLE",
  merchantName: "Amazon",
  accountName: "Birch card",
  categories: ["Shopping"],
  ...fields,
});

const ITEM: ReviewItemView = {
  id: "item-1",
  kind: AMAZON_SHIPMENT,
  subject: { type: "transactions", transactionIds: ["t-one", "t-two"] },
  transactions: [txn("t-one"), txn("t-two", { postedDate: "2026-05-04" })],
  loanName: null,
  cardName: null,
  decided:
    "Amazon shipment of order 111-0000002-0000002, shipped May 2: Paper towels, 12 rolls and 3 more items. 2 charges of $20.00 fit it.",
  bestAnswer: { value: "none|111-0000002-0000002|2026-05-02T09:15:00Z", label: "None of these" },
  createdAt: "2026-05-12T14:00:00.000Z",
  needsAi: false,
  group: null,
  lineItems: [],
};

describe("Amazon links", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists the unlinked shipments to link by hand, each with Link", () => {
    const linked: AmazonShipmentView[] = [];
    const list = (
      <ShipmentsToLink
        shipments={[
          SHIPMENT,
          {
            ...SHIPMENT,
            shipTime: "2026-05-03T10:00:00Z",
            items: 1,
            names: ["Tape"],
            giftCard: true,
          },
        ]}
        today={TODAY}
        busy={false}
        link={(shipment) => linked.push(shipment)}
      />
    );
    expect(text(renderToString(list))).toBe(
      [
        "Link Amazon items",
        "2 unlinked Amazon shipments were ordered around this date.",
        "Order 111-0000002-0000002 · shipped May 2 · 4 items · $20.00",
        "Paper towels, 12 rolls, Dish soap, Batteries, and 1 more Link",
        "Order 111-0000002-0000002 · shipped May 2 · 1 item · $20.00",
        "Tape · paid in part by gift card Link",
      ].join(" "),
    );
    const [first, second] = buttonsOf(list);
    second?.tap();
    first?.tap();
    expect(linked.map((one) => one.shipTime)).toEqual([
      "2026-05-03T10:00:00Z",
      "2026-05-02T09:15:00Z",
    ]);
    expect(shipmentLine({ ...SHIPMENT, items: 1 }, TODAY)).toBe(
      "Order 111-0000002-0000002 · shipped May 2 · 1 item · $20.00",
    );
  });

  it("shows Undo under the Line items", () => {
    let undone = 0;
    const undo = <UndoAmazonLink busy={false} undo={() => (undone += 1)} />;
    expect(text(renderToString(undo))).toBe(
      "Amazon link Undo unlinks these items. The app will not link them to this Transaction again. Undo",
    );
    for (const button of buttonsOf(undo)) button.tap();
    expect(undone).toBe(1);
  });

  it("sends the list, the hand link, and Undo to their routes", async () => {
    const sent: { method: string; path: string; type: string | null; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      sent.push({
        method: init?.method ?? "GET",
        path: String(input),
        type: headers.get("content-type"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });

    await amazonLinkRequests.shipments("t-1");
    await amazonLinkRequests.link("t-1", {
      orderId: SHIPMENT.orderId,
      shipTime: SHIPMENT.shipTime,
    });
    await amazonLinkRequests.undo("t-1");

    expect(sent).toEqual([
      { method: "GET", path: "/api/transactions/t-1/amazon-shipments", type: null, body: null },
      {
        method: "POST",
        path: "/api/transactions/t-1/amazon-link",
        type: "application/json",
        body: { orderId: SHIPMENT.orderId, shipTime: SHIPMENT.shipTime },
      },
      { method: "DELETE", path: "/api/transactions/t-1/amazon-link", type: null, body: null },
    ]);
  });

  it("shows one Review list card per shipment, with This one on each charge and None of these", () => {
    const answers: string[] = [];
    const actions: ItemActions = {
      answer: (_item, value) => answers.push(value),
      notThis: () => {},
      changeOne: async () => undefined,
    };
    const card = <AmazonShipmentItem item={ITEM} state={{}} today={TODAY} actions={actions} />;
    expect(text(renderToString(card))).toBe(
      [
        "Amazon shipment",
        ITEM.decided,
        "Which charge paid for it?",
        "May 3 · Amazon · −$20.00 · Birch card This one",
        "May 4 · Amazon · −$20.00 · Birch card This one",
        "None of these",
      ].join(" "),
    );
    for (const button of buttonsOf(card)) button.tap();
    expect(answers).toEqual(["link|t-one", "link|t-two", ITEM.bestAnswer.value]);
    expect(
      text(
        renderToString(
          <AmazonShipmentItem
            item={ITEM}
            state={{ error: "That is not a choice for this item." }}
            today={TODAY}
            actions={actions}
          />,
        ),
      ),
    ).toContain("That is not a choice for this item.");
    // The Review list page shows the card for the kind.
    const page = text(
      renderToString(
        <MemoryRouter>
          <ReviewItems items={[ITEM]} states={{}} today={TODAY} actions={actions} />
        </MemoryRouter>,
      ),
    );
    expect(page).toContain("Which charge paid for it?");
    expect(page).not.toContain("Not this");
  });
});
