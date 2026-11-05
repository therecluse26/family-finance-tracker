import { isValidElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecurringChargeView } from "../../server/recurring-views.ts";
import {
  type ChargeActions,
  chargeLine,
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
  merchantName,
  category: "Subscriptions",
  schedule: "monthly",
  nextExpectedDate,
  latestAmount: 1_549,
  priceHistory: [
    { date: "2026-09-03", amount: 1_399 },
    { date: "2026-10-03", amount: 1_549 },
  ],
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
    if (node.type === "button" && node.props.onClick !== undefined) {
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
    expect(html).toContain('Streamly · <span class="whitespace-nowrap">−$15.49</span> · monthly');
    const rows = [...html.matchAll(/<button[^>]*aria-expanded[^>]*>(.*?)<\/button>/gs)].map(
      (match) => text(match[1] ?? ""),
    );

    expect(rows).toEqual([
      "Streamly · −$15.49 · monthly · next Nov 8 · Subscriptions · on card",
      "Brightwave · −$65.00 · yearly · next Nov 12 · Subscriptions",
      "Tunebox · −$15.49 · every 2 weeks · next Nov 18 · Subscriptions · on card",
      "Ironworks Gym · −$15.49 · monthly · next Sep 1 · ended",
      "Daily Paper · −$15.49 · weekly · next Oct 20 · Subscriptions",
    ]);
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
    expect(chargeLine(charge("old", "Old Co", "2025-12-30"), TODAY)).toBe(
      "Old Co · −$15.49 · monthly · next Dec 30, 2025 · Subscriptions",
    );
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
    buttonsOf(closed).get(chargeLine(streamly, TODAY))?.();
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
      "Oct 3 · −$15.49",
      "Sep 3 · −$13.99",
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
