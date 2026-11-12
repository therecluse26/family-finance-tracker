import { isValidElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ShoppingPlanDealView, ShoppingPlanView } from "../../server/shopping-plan-views.ts";
import { dealLine, PLAN_NOTE, ShoppingPlanSections } from "./ShoppingPlan.tsx";

// The Shopping plan on the Shopping list page (spec 15, What the plan shows). Every Store, Product
// and price is made up.

const TODAY = "2026-11-11";

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

const TARGET_DEAL: ShoppingPlanDealView = {
  storeId: "target",
  storeName: "Target",
  productId: "target-eggs",
  productName: "Large Eggs, 12 ct",
  packages: 1,
  price: 359,
  total: 359,
  endsOn: "2026-11-14",
  saves: 90,
  readOn: "2026-11-10",
};

const PLAN: ShoppingPlanView = {
  planId: "plan-1",
  builtOn: "2026-11-10",
  today: TODAY,
  tripSaving: 1000,
  stores: [
    {
      storeId: "amazon",
      name: "Amazon",
      kind: "online",
      lines: [
        {
          place: 2,
          words: "paper towels",
          productName: "Paper Towels, 6 rolls",
          packages: 1,
          price: 1299,
          total: 1299,
          priceKind: "regular",
          readOn: "2026-11-10",
          dealEndsOn: null,
          deals: [],
        },
      ],
      subtotal: 1299,
      deliveryFee: 599,
    },
    {
      storeId: "walmart",
      name: "Walmart",
      kind: "in person",
      lines: [
        {
          place: 0,
          words: "eggs",
          productName: "Great Value Large Eggs, 12 ct",
          packages: 1,
          price: 449,
          total: 449,
          priceKind: "regular",
          readOn: "2026-11-09",
          dealEndsOn: null,
          deals: [TARGET_DEAL],
        },
        {
          place: 1,
          words: "ground beef",
          productName: "Ground Beef 80% Lean, 1 lb",
          packages: 2,
          price: 449,
          total: 898,
          priceKind: "deal",
          readOn: "2026-11-10",
          dealEndsOn: "2026-11-16",
          deals: [],
        },
      ],
      subtotal: 1347,
      deliveryFee: 0,
    },
  ],
  notFound: [{ place: 3, words: "saffron" }],
  total: 3245,
  trips: 1,
  saving: 410,
  elsewhere: [
    {
      storeId: "aldi",
      name: "Aldi",
      kind: "in person",
      saving: 300,
      paysForTrip: false,
      deals: [
        {
          ...TARGET_DEAL,
          storeId: "aldi",
          storeName: "Aldi",
          productId: "aldi-milk",
          productName: "Milk, 1 gal",
          place: 4,
          words: "milk",
          saves: 300,
        },
      ],
    },
    {
      storeId: "costco",
      name: "Costco",
      kind: "in person",
      saving: 1500,
      paysForTrip: true,
      deals: [
        {
          ...TARGET_DEAL,
          storeId: "costco",
          storeName: "Costco",
          productId: "costco-coffee",
          productName: "Coffee, 3 lb",
          place: 5,
          words: "coffee",
          endsOn: null,
          saves: 1500,
        },
      ],
    },
  ],
  failures: [{ storeId: "kroger", name: "Kroger", reason: "Could not read this store" }],
};

describe("the Shopping plan", () => {
  it("writes a Deal as the spec does", () => {
    expect(dealLine(TARGET_DEAL, TODAY)).toBe("Deal: $3.59 at Target until Nov 14, saves $0.90");
    expect(dealLine({ ...TARGET_DEAL, endsOn: null }, TODAY)).toBe(
      "Deal: $3.59 at Target, saves $0.90",
    );
  });

  it("shows each Store's List items with packages, prices and dates, the total, trips, saving, and the Stores not read", () => {
    const shown = text(
      renderToString(
        <ShoppingPlanSections plan={PLAN} busy={false} takeDeal={() => {}} dropDeal={() => {}} />,
      ),
    );
    expect(shown).toContain(`Built Nov 10. ${PLAN_NOTE}`);
    expect(shown).toContain("Total $32.45 · 1 trip");
    expect(shown).toContain("Saves $4.10 against the best one-Store plan.");
    expect(shown).toContain(
      "Amazon (online) paper towels Paper Towels, 6 rolls 1 package × $12.99 = $12.99 · Price from Nov 10",
    );
    expect(shown).toContain("Subtotal $12.99 · Delivery fee $5.99");
    expect(shown).toContain("1 package × $4.49 = $4.49 · Price from Nov 9");
    expect(shown).toContain("2 packages × $4.49 = $8.98 · Price from Nov 10 · Deal until Nov 16");
    expect(shown).toContain("Deal: $3.59 at Target until Nov 14, saves $0.90 Use this Deal");
    expect(shown).toContain("Not found saffron");
    expect(shown).toContain(
      "Aldi: saves $3.00. An extra trip must save more than $10.00. milk: Milk, 1 gal.",
    );
    expect(shown).toContain(
      "Costco: saves $15.00 coffee: Coffee, 3 lb. Deal: $3.59 at Costco, saves $15.00 Use this Deal",
    );
    expect(shown).toContain("Stores not read Kroger: Could not read this store");
  });

  it("uses a Deal beside a List item or at a Store whose saving pays for the trip, and goes back to the regular price", () => {
    const takeDeal = vi.fn();
    const dropDeal = vi.fn();
    const buttons = buttonsOf(
      ShoppingPlanSections({ plan: PLAN, busy: false, takeDeal, dropDeal }),
    );
    expect(buttons.map((button) => button.words)).toEqual([
      "Use this Deal",
      "Use the regular price",
      "Use this Deal",
    ]);
    buttons[0]?.tap();
    expect(takeDeal).toHaveBeenLastCalledWith(0, "target-eggs");
    buttons[1]?.tap();
    expect(dropDeal).toHaveBeenLastCalledWith(1);
    buttons[2]?.tap();
    expect(takeDeal).toHaveBeenLastCalledWith(5, "costco-coffee");
  });

  it("shows no saving when no one Store finds as many List items", () => {
    const shown = text(
      renderToString(
        <ShoppingPlanSections
          plan={{ ...PLAN, saving: null, failures: [], elsewhere: [] }}
          busy={false}
          takeDeal={() => {}}
          dropDeal={() => {}}
        />,
      ),
    );
    expect(shown).not.toContain("best one-Store plan");
    expect(shown).not.toContain("Stores not read");
    expect(shown).not.toContain("Deals at other Stores");
  });
});
