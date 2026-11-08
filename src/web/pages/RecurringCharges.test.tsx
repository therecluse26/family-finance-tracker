import { isValidElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecurringChargeView } from "../../server/recurring-views.ts";
import { Button } from "../components/Button.tsx";
import {
  draftOf,
  editsOf,
  priceLines,
  RecurringChargeEdit,
  recurringChargeEditRequests,
} from "./RecurringChargeEdit.tsx";
import {
  type ChargeActions,
  chargeFacts,
  chargeName,
  RecurringChargeList,
  RecurringChargeRow,
  recurringChargeRequests,
  recurringSections,
} from "./RecurringCharges.tsx";

// The Recurring charges page (spec 07, Recurring charges page).

const TODAY = "2026-11-05";

const charge = (
  id: string,
  merchantName: string,
  nextExpectedDate: string,
  fields: Partial<RecurringChargeView> = {},
): RecurringChargeView => ({
  id,
  name: null,
  merchantName,
  category: "Subscriptions",
  categoryByHand: false,
  priceBand: null,
  defaultPriceBand: 7.5,
  schedule: "monthly",
  nextExpectedDate,
  latestAmount: 1_549,
  priceHistory: [
    { transactionId: "t-sep", date: "2026-09-03", amount: 1_399, addedByHand: false },
    { transactionId: "t-oct", date: "2026-10-03", amount: 1_549, addedByHand: false },
  ],
  priceChanges: [],
  accountId: "acc-checking",
  onCard: false,
  status: "active",
  ...fields,
});

// Out of order, as no list should rely on.
const CHARGES: RecurringChargeView[] = [
  charge("tunebox", "Tunebox", "2026-11-18", { onCard: true, schedule: "every 2 weeks" }),
  charge("gym", "Ironworks Gym", "2026-09-01", { status: "ended", category: null }),
  charge("streamly", "Streamly", "2026-11-08", { onCard: true }),
  charge("paper", "Daily Paper", "2026-10-20", { status: "inactive", schedule: "weekly" }),
  charge("phone", "Brightwave", "2026-11-12", { latestAmount: 6_500, schedule: "yearly" }),
];

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const noActions: ChargeActions = {
  toggle: () => {},
  askEnd: () => {},
  end: () => {},
  keep: () => {},
  changed: () => {},
};

// The buttons in a row, by their words, with what each does when tapped.
function buttonsOf(element: ReactNode): Map<string, () => void> {
  const found = new Map<string, () => void>();
  const words = (node: ReactNode): string =>
    typeof node === "string"
      ? node
      : Array.isArray(node)
        ? node.map(words).join("")
        : isValidElement<{ children?: ReactNode }>(node)
          ? words(node.props.children)
          : "";
  const walk = (node: ReactNode) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return;
    // A native button, or the shared Button, which renders one.
    if ((node.type === "button" || node.type === Button) && node.props.onClick !== undefined) {
      found.set(words(node.props.children), node.props.onClick);
    }
    walk(node.props.children);
  };
  walk(element);
  return found;
}

describe("the Recurring charges page", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs active rows by next date, and puts inactive and ended ones in the Inactive section", () => {
    const { active, inactive } = recurringSections(CHARGES);

    expect(active.map((each) => each.id)).toEqual(["streamly", "phone", "tunebox"]);
    expect(inactive.map((each) => each.id)).toEqual(["gym", "paper"]);
  });

  it("shows each row's Merchant, amount, interval, next date, Category, and on card", () => {
    const html = renderToString(
      <RecurringChargeList charges={CHARGES} states={{}} today={TODAY} actions={noActions} />,
    );
    // A signed amount never breaks after its sign (spec 07, Number formats).
    expect(html).toMatch(/<span class="whitespace-nowrap [^"]*">−\$15\.49<\/span>/);
    const rows = [...html.matchAll(/<button[^>]*aria-expanded[^>]*>(.*?)<\/button>/gs)].map(
      (match) => text(match[1] ?? ""),
    );

    // The next date, the Merchant and its marks, the interval and Category, and the amount.
    expect(rows).toEqual([
      "next Nov 8 Streamly on card monthly · Subscriptions −$15.49",
      "next Nov 12 Brightwave yearly · Subscriptions −$65.00",
      "next Nov 18 Tunebox on card every 2 weeks · Subscriptions −$15.49",
      "next Sep 1 Ironworks Gym ended monthly −$15.49",
      "next Oct 20 Daily Paper weekly · Subscriptions −$15.49",
    ]);
    // "On card" is explained once, under the active rows.
    expect(text(html)).toContain("&quot;On card&quot; means the charge lands on a credit card.");
    // The Inactive section is collapsed, after the active rows.
    expect(html).toMatch(/<details class="[^"]*"><summary[^>]*>Inactive \(<!-- -->2<!-- -->\)/);
    expect(html.indexOf("Tunebox")).toBeLessThan(html.indexOf("<details"));
    expect(html.indexOf("<details")).toBeLessThan(html.indexOf("Ironworks Gym"));
    // An ended one cannot be ended again.
    expect(text(html).match(/Mark ended/g)).toHaveLength(4);
  });

  it("has no Inactive section when every Recurring charge is active", () => {
    const html = renderToString(
      <RecurringChargeList
        charges={[charge("streamly", "Streamly", "2026-11-08")]}
        states={{}}
        today={TODAY}
        actions={noActions}
      />,
    );

    expect(html).not.toContain("<details");
    expect(html).not.toContain("means the charge lands on a credit card");
    expect(chargeFacts(charge("old", "Old Co", "2025-12-30", { category: null }))).toBe("monthly");
    const old = renderToString(
      <RecurringChargeRow
        charge={charge("old", "Old Co", "2025-12-30")}
        state={{}}
        today={TODAY}
        actions={noActions}
      />,
    );
    expect(text(old)).toContain("next Dec 30, 2025 Old Co monthly · Subscriptions −$15.49");
  });

  it("shows a name a Member gave, with the Merchant under it", () => {
    const named = charge("visible", "Privacy.com", "2026-11-08", {
      name: "Visible Wireless",
      category: "Phone and internet",
      categoryByHand: true,
    });
    const row = text(
      renderToString(
        <RecurringChargeRow charge={named} state={{}} today={TODAY} actions={noActions} />,
      ),
    );

    expect(row).toContain("next Nov 8 Visible Wireless Privacy.com monthly · Phone and internet");
    expect(chargeName(named)).toBe("Visible Wireless");
    expect(chargeName(charge("streamly", "Streamly", "2026-11-08"))).toBe("Streamly");
  });

  it("marks each price change in the price history, and each Transaction a Member added", () => {
    const visible = charge("visible", "Privacy.com", "2026-12-03", {
      latestAmount: 4_500,
      priceHistory: [
        { transactionId: "t1", date: "2026-09-03", amount: 2_500, addedByHand: false },
        { transactionId: "t2", date: "2026-10-03", amount: 2_500, addedByHand: true },
        { transactionId: "t3", date: "2026-11-03", amount: 4_500, addedByHand: false },
      ],
      priceChanges: [
        { id: "pc-found", fromDate: "2026-11-03", amount: 4_500, byHand: false },
        { id: "pc-member", fromDate: "2026-11-01", amount: 4_500, byHand: true },
      ],
    });

    expect(
      priceLines(visible).map((line) =>
        line.kind === "charge" ? line.transactionId : `change ${line.id}`,
      ),
    ).toEqual(["change pc-found", "t3", "change pc-member", "t2", "t1"]);
    const html = renderToString(
      <RecurringChargeEdit charge={visible} today={TODAY} onChange={() => {}} />,
    );
    const history = /<ul[^>]*aria-label="Price history"[^>]*>(.*?)<\/ul>/s.exec(html)?.[1] ?? "";
    expect([...history.matchAll(/<li[^>]*>(.*?)<\/li>/gs)].map((m) => text(m[1] ?? ""))).toEqual([
      "price change −$45.00 from Nov 3",
      "Nov 3 · −$45.00 Remove",
      "price change −$45.00 from Nov 1 (set by a Member) Delete",
      "Oct 3 · −$25.00 added Remove",
      "Sep 3 · −$25.00 Remove",
    ]);
    // An ended one takes a name and a Category, and shows its history with no other edits.
    const endedHtml = renderToString(
      <RecurringChargeEdit
        charge={{ ...visible, status: "ended" }}
        today={TODAY}
        onChange={() => {}}
      />,
    );
    const ended = text(endedHtml);
    expect(ended).toMatch(/Name/);
    expect(ended).toMatch(/Category/);
    expect(ended).toMatch(/Save/);
    expect(ended).not.toMatch(/Price band|Remove|Delete|Add a charge|Set price change/);
    expect(text(html)).toMatch(/Price band/);
  });

  it("sends only what the edit form changed, and refuses a bad name or band", () => {
    const streamly = charge("streamly", "Streamly", "2026-11-08", {
      name: "Movies",
      priceBand: 10,
    });
    const draft = draftOf(streamly);
    expect(draft).toEqual({ name: "Movies", category: "", priceBand: "10" });

    expect(editsOf(streamly, draft)).toEqual({});
    expect(editsOf(streamly, { ...draft, name: "  Film night " })).toEqual({ name: "Film night" });
    expect(editsOf(streamly, { ...draft, name: "" })).toEqual({ name: null });
    expect(editsOf(streamly, { ...draft, category: "Phone and internet" })).toEqual({
      category: "Phone and internet",
    });
    expect(editsOf(streamly, { ...draft, priceBand: "12.5%" })).toEqual({ priceBand: 12.5 });
    expect(editsOf(streamly, { ...draft, priceBand: "" })).toEqual({ priceBand: null });
    expect(editsOf(streamly, { ...draft, name: "x".repeat(61) })).toMatch(/at most 60/);
    for (const band of ["12.55", "101", "-1", "abc"]) {
      expect(editsOf(streamly, { ...draft, priceBand: band })).toMatch(/price band/);
    }
  });

  it("sends each edit to its route", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://app.test");
      const body = typeof init?.body === "string" ? init.body : "";
      sent.push(`${init?.method ?? "GET"} ${url.pathname}${url.search} ${body}`.trim());
      return Response.json({});
    });

    await recurringChargeEditRequests.edit("c1", { name: "Visible Wireless" });
    await recurringChargeEditRequests.setPriceChange("c1", {
      fromDate: "2026-11-01",
      amount: 4_500,
    });
    await recurringChargeEditRequests.deletePriceChange("c1", "pc1");
    await recurringChargeEditRequests.add("c1", "t1");
    await recurringChargeEditRequests.remove("c1", "t2");
    await recurringChargeEditRequests.candidates("c1");
    await recurringChargeEditRequests.candidates("c1", { amount: 2_500, before: "t9" });

    expect(sent).toEqual([
      'PUT /api/recurring-charges/c1 {"name":"Visible Wireless"}',
      'POST /api/recurring-charges/c1/price-changes {"fromDate":"2026-11-01","amount":4500}',
      "DELETE /api/recurring-charges/c1/price-changes/pc1",
      'POST /api/recurring-charges/c1/transactions {"transactionId":"t1"}',
      "DELETE /api/recurring-charges/c1/transactions/t2",
      "GET /api/recurring-charges/c1/candidates",
      "GET /api/recurring-charges/c1/candidates?amount=2500&before=t9",
    ]);
  });

  it("opens the price history on a tap: each Transaction's date and amount, newest first", () => {
    const streamly = charge("streamly", "Streamly", "2026-11-08");
    const toggle = vi.fn();
    const closed = RecurringChargeRow({
      charge: streamly,
      state: {},
      today: TODAY,
      actions: { ...noActions, toggle },
    });
    buttonsOf(closed).get("next Nov 8Streamlymonthly · Subscriptions−$15.49")?.();
    expect(toggle).toHaveBeenCalledWith(streamly);
    expect(renderToString(closed)).not.toContain("Price history");

    const html = renderToString(
      <RecurringChargeRow
        charge={streamly}
        state={{ open: true }}
        today={TODAY}
        actions={noActions}
      />,
    );
    const history = /<ul[^>]*aria-label="Price history"[^>]*>(.*?)<\/ul>/s.exec(html)?.[1] ?? "";
    expect([...history.matchAll(/<li[^>]*>(.*?)<\/li>/gs)].map((m) => text(m[1] ?? ""))).toEqual([
      "Oct 3 · −$15.49 Remove",
      "Sep 3 · −$13.99 Remove",
    ]);
    expect(html).toContain('aria-expanded="true"');
  });

  it("asks before a Member marks one ended, then sends it", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://app.test");
      sent.push(`${init?.method ?? "GET"} ${url.pathname}`);
      return Response.json({});
    });
    const streamly = charge("streamly", "Streamly", "2026-11-08");
    const askEnd = vi.fn();
    const keep = vi.fn();
    const end = vi.fn((each: RecurringChargeView) => void recurringChargeRequests.end(each.id));
    const actions = { ...noActions, askEnd, keep, end };

    const first = buttonsOf(
      RecurringChargeRow({ charge: streamly, state: {}, today: TODAY, actions }),
    );
    expect([...first.keys()]).not.toContain("Yes, it ended");
    first.get("Mark ended")?.();
    expect(askEnd).toHaveBeenCalledWith(streamly);
    expect(end).not.toHaveBeenCalled();

    const asking = buttonsOf(
      RecurringChargeRow({ charge: streamly, state: { confirming: true }, today: TODAY, actions }),
    );
    asking.get("Keep it")?.();
    expect(keep).toHaveBeenCalledWith(streamly);
    asking.get("Yes, it ended")?.();
    await vi.waitFor(() => expect(sent).toEqual(["POST /api/recurring-charges/streamly/end"]));
  });
});
