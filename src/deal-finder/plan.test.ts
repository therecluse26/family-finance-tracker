import { describe, expect, it } from "vitest";
import {
  buildShoppingPlan,
  findDeals,
  type PlanInput,
  type PlanListItem,
  type PlanMatch,
  type PlanPrice,
  type PlanProduct,
  type PlanStore,
  packagesToBuy,
  type ShoppingPlanResult,
} from "./plan.ts";

// The Shopping plan's math (spec 15, How app code builds the plan; What the plan shows). Every
// Store, Product and price is made up.

const READ_AT = new Date("2026-11-10T15:00:00.000Z");

const store = (id: string, extra: Partial<PlanStore> = {}): PlanStore => ({
  id,
  name: id[0]?.toUpperCase() + id.slice(1),
  kind: "in person",
  on: true,
  deliveryFee: null,
  freeDeliveryFrom: null,
  ...extra,
});

const item = (id: string, extra: Partial<PlanListItem> = {}): PlanListItem => ({
  id,
  place: Number(id.replace(/\D/g, "")) || 0,
  words: id,
  quantity: 1,
  unit: "each",
  ticked: false,
  ...extra,
});

type Priced = { regular?: number; deal?: number; endsOn?: string; online?: number };

// One Product per List item and Store, each a `match` with one package, at these prices: a number
// is a regular price.
function scenario(
  stores: PlanStore[],
  prices: Record<string, Record<string, number | Priced>>,
  tripSaving: number,
  items: PlanListItem[] = Object.keys(prices).map((id) => item(id)),
): PlanInput {
  const products: PlanProduct[] = [];
  const reads: PlanPrice[] = [];
  const matches: PlanMatch[] = [];
  for (const [itemId, byStore] of Object.entries(prices)) {
    for (const [storeId, written] of Object.entries(byStore)) {
      const price = typeof written === "number" ? { regular: written } : written;
      const productId = `${storeId}-${itemId}`;
      products.push({ id: productId, storeId, name: `${storeId} ${itemId}`, size: null });
      reads.push({
        productId,
        readAt: READ_AT,
        regularPrice: price.regular ?? null,
        dealPrice: price.deal ?? null,
        dealEndsOn: price.endsOn ?? null,
        onlinePrice: price.online ?? null,
      });
      matches.push({ listItemId: itemId, productId, answer: "match" });
    }
  }
  return { stores, items, products, prices: reads, matches, choices: [], tripSaving };
}

// Where each List item went: "item → Store", or "item → Not found".
const placed = (plan: ShoppingPlanResult) =>
  plan.lines.map((line) => `${line.words} → ${line.storeId ?? "Not found"}`);

describe("packages to buy", () => {
  it.each([
    [{ quantity: 2, unit: "lb" }, { size: "1 lb", name: "Ground beef" }, 2],
    [{ quantity: 2, unit: "lb" }, { size: "16 oz", name: "Ground beef" }, 2],
    [{ quantity: 1.5, unit: "lb" }, { size: null, name: "Ground Beef 80/20, 1 lb" }, 2],
    [{ quantity: 40, unit: "oz" }, { size: "2.5 lb", name: "Beef" }, 1],
    [{ quantity: 1, unit: "gal" }, { size: "64 fl oz", name: "Milk" }, 2],
    [{ quantity: 1, unit: "gal" }, { size: "1 gal", name: "Milk" }, 1],
    [{ quantity: 18, unit: "each" }, { size: "12 ct", name: "Eggs" }, 2],
    [{ quantity: 12, unit: "ct" }, { size: null, name: "Large Eggs, 1 dozen" }, 1],
    [{ quantity: 3, unit: "each" }, { size: "1 lb", name: "Beef" }, 3],
    [{ quantity: 2, unit: "pack" }, { size: "6 ct", name: "Rolls" }, 2],
    [{ quantity: 32, unit: "oz" }, { size: "2 x 16 oz", name: "Peanut butter twin pack" }, 1],
  ] as const)("%o of %o is %i packages", (wanted, product, count) => {
    expect(packagesToBuy(wanted, product)).toBe(count);
  });

  it("refuses sizes that do not compare, and a size it cannot read for a weight", () => {
    expect(packagesToBuy({ quantity: 1, unit: "lb" }, { size: "64 fl oz", name: "Milk" })).toBe(
      undefined,
    );
    expect(packagesToBuy({ quantity: 1, unit: "lb" }, { size: null, name: "Ground beef" })).toBe(
      undefined,
    );
    expect(packagesToBuy({ quantity: 12, unit: "ct" }, { size: "1 lb", name: "Beef" })).toBe(
      undefined,
    );
  });
});

describe("the Shopping plan", () => {
  // A alone is $65.00 and B alone $69.00. Milk at A, bread at B, eggs at A is $53.00 in 2 trips:
  // $12.00 less than A alone.
  const prices = {
    milk1: { a: 2000, b: 3500 },
    bread2: { a: 3000, b: 1800 },
    eggs3: { a: 1500, b: 1600 },
  };

  it.each([
    [0, ["milk1 → a", "bread2 → b", "eggs3 → a"], 5300, 2, 1200],
    [1000, ["milk1 → a", "bread2 → b", "eggs3 → a"], 5300, 2, 1200],
    [100_000, ["milk1 → a", "bread2 → a", "eggs3 → a"], 6500, 1, 0],
  ])(
    "with $X at %i cents, puts the List items %o, for %i cents in %i trips, saving %i",
    (tripSaving, where, total, trips, saving) => {
      const plan = buildShoppingPlan(scenario([store("a"), store("b")], prices, tripSaving));
      expect(placed(plan)).toEqual(where);
      expect({ total: plan.total, trips: plan.trips, saving: plan.saving }).toEqual({
        total,
        trips,
        saving,
      });
      expect(plan.bestOneStore).toEqual({ storeId: "a", total: 6500 });
      expect(plan.lines.every((line) => Number.isSafeInteger(line.total))).toBe(true);
    },
  );

  it("takes an extra trip only when it saves more than $X: a tie goes to fewer trips", () => {
    // Bread at B saves exactly $12.00 against A alone. At $X = $12.00 the scores tie.
    expect(placed(buildShoppingPlan(scenario([store("a"), store("b")], prices, 1200)))).toEqual([
      "milk1 → a",
      "bread2 → a",
      "eggs3 → a",
    ]);
    expect(placed(buildShoppingPlan(scenario([store("a"), store("b")], prices, 1199)))).toEqual([
      "milk1 → a",
      "bread2 → b",
      "eggs3 → a",
    ]);
  });

  it("breaks a tie between two Stores with the same total by the Store listed first", () => {
    const same = { milk1: { a: 400, b: 400 }, bread2: { a: 300, b: 300 } };
    const plan = buildShoppingPlan(scenario([store("a"), store("b")], same, 0));
    expect(placed(plan)).toEqual(["milk1 → a", "bread2 → a"]);
    expect(plan.trips).toBe(1);
  });

  it("charges an online Store's delivery fee below its free-delivery amount, and not above", () => {
    const stores = (freeDeliveryFrom: number) => [
      store("a"),
      store("amazon", { kind: "online", deliveryFee: 599, freeDeliveryFrom }),
    ];
    const two = { milk1: { a: 1000, amazon: 900 }, bread2: { a: 1000, amazon: 900 } };
    // $18.00 is below $35.00, so Amazon costs $23.99: A alone is $20.00.
    const below = buildShoppingPlan(scenario(stores(3500), two, 0));
    expect(placed(below)).toEqual(["milk1 → a", "bread2 → a"]);
    expect(below.total).toBe(2000);
    // From $15.00 delivery is free: Amazon alone is $18.00, and no trip.
    const above = buildShoppingPlan(scenario(stores(1500), two, 0));
    expect(placed(above)).toEqual(["milk1 → amazon", "bread2 → amazon"]);
    expect(above.stores).toEqual([{ storeId: "amazon", subtotal: 1800, deliveryFee: 0 }]);
    expect({ total: above.total, trips: above.trips }).toEqual({ total: 1800, trips: 0 });
    // An online Store is not a trip, so A and Amazon together pay no $X.
    const mixed = buildShoppingPlan(
      scenario(
        stores(0),
        { milk1: { a: 1000, amazon: 2000 }, bread2: { a: 2000, amazon: 900 } },
        100_000,
      ),
    );
    expect(placed(mixed)).toEqual(["milk1 → a", "bread2 → amazon"]);
    expect(mixed.trips).toBe(1);
  });

  it("charges a fee with no free-delivery amount on every order, and none when the fee is empty", () => {
    const stores = (deliveryFee: number | null) => [
      store("a"),
      store("amazon", { kind: "online", deliveryFee, freeDeliveryFrom: null }),
    ];
    const one = { milk1: { a: 1000, amazon: 900 } };
    expect(placed(buildShoppingPlan(scenario(stores(200), one, 0)))).toEqual(["milk1 → a"]);
    expect(placed(buildShoppingPlan(scenario(stores(null), one, 0)))).toEqual(["milk1 → amazon"]);
  });

  it("shows a List item with no match at any Store as Not found", () => {
    const plan = buildShoppingPlan(
      scenario([store("a"), store("b")], { milk1: { a: 500 }, saffron2: {} }, 1000, [
        item("milk1"),
        item("saffron2"),
      ]),
    );
    expect(placed(plan)).toEqual(["milk1 → a", "saffron2 → Not found"]);
    expect(plan.notFound).toBe(1);
    expect(plan.lines[1]).toMatchObject({ storeId: null, productId: null, total: null });
    expect(plan.saving).toBe(0);
  });

  it("never picks a set that leaves more List items not found, whatever $X", () => {
    const plan = buildShoppingPlan(
      scenario(
        [store("a"), store("b")],
        { milk1: { a: 100, b: 1000 }, bread2: { b: 1000 } },
        100_000,
      ),
    );
    expect(placed(plan)).toEqual(["milk1 → b", "bread2 → b"]);
    expect(plan.notFound).toBe(0);
    // A alone finds fewer, so B is the best one-Store plan.
    expect(plan.bestOneStore).toEqual({ storeId: "b", total: 2000 });
  });

  it("has no saving when no one Store finds as many List items as the plan", () => {
    const plan = buildShoppingPlan(
      scenario([store("a"), store("b")], { milk1: { a: 100 }, bread2: { b: 200 } }, 0),
    );
    expect(placed(plan)).toEqual(["milk1 → a", "bread2 → b"]);
    expect({ saving: plan.saving, bestOneStore: plan.bestOneStore }).toEqual({
      saving: null,
      bestOneStore: null,
    });
  });

  it("starts from regular prices: a Deal never decides which Stores the plan visits", () => {
    const plan = buildShoppingPlan(
      scenario([store("a"), store("b")], { milk1: { a: 500, b: { regular: 600, deal: 100 } } }, 0),
    );
    expect(placed(plan)).toEqual(["milk1 → a"]);
    expect(plan.lines[0]).toMatchObject({ price: 500, priceKind: "regular", priceReadAt: READ_AT });
  });

  it("uses Costco's online price when it has no warehouse price, and labels it", () => {
    const plan = buildShoppingPlan(
      scenario([store("costco")], { milk1: { costco: { online: 899 } } }, 0),
    );
    expect(plan.lines[0]).toMatchObject({ storeId: "costco", price: 899, priceKind: "online" });
  });

  it("never puts a weekly-ad-only Store in the plan: it has only Deals", () => {
    const plan = buildShoppingPlan(
      scenario(
        [store("a"), store("ad-fresh", { kind: "weekly ad only" })],
        { milk1: { a: 500, "ad-fresh": { regular: 300, deal: 200 } } },
        0,
      ),
    );
    expect(placed(plan)).toEqual(["milk1 → a"]);
  });

  it("buys whole packages, and picks the cheapest total, not the cheapest package", () => {
    const input: PlanInput = {
      stores: [store("a")],
      items: [item("beef1", { quantity: 2, unit: "lb", words: "ground beef" })],
      products: [
        { id: "small", storeId: "a", name: "Beef", size: "1 lb" },
        { id: "big", storeId: "a", name: "Beef", size: "3 lb" },
      ],
      prices: [
        { ...noDeal, productId: "small", regularPrice: 549 },
        { ...noDeal, productId: "big", regularPrice: 999 },
      ],
      matches: [
        { listItemId: "beef1", productId: "small", answer: "match" },
        { listItemId: "beef1", productId: "big", answer: "match" },
      ],
      choices: [],
      tripSaving: 0,
    };
    expect(buildShoppingPlan(input).lines[0]).toMatchObject({
      productId: "big",
      packages: 1,
      total: 999,
    });
    input.prices = [
      { ...noDeal, productId: "small", regularPrice: 449 },
      { ...noDeal, productId: "big", regularPrice: 999 },
    ];
    expect(buildShoppingPlan(input).lines[0]).toMatchObject({
      productId: "small",
      packages: 2,
      price: 449,
      total: 898,
    });
  });

  it("refuses a trip setting that is not whole cents", () => {
    expect(() => buildShoppingPlan(scenario([store("a")], prices, 10.5))).toThrow(RangeError);
    expect(() => buildShoppingPlan(scenario([store("a")], prices, -1))).toThrow(RangeError);
  });
});

const noDeal = { readAt: READ_AT, dealPrice: null, dealEndsOn: null, onlinePrice: null };

describe("the plan's filters (K2)", () => {
  const prices = { milk1: { a: 500, b: 300 } };

  it("uses only a `match`: a substitute or a `no` never goes in the plan by itself", () => {
    for (const answer of ["substitute", "no"] as const) {
      const input = scenario([store("a"), store("b")], prices, 0);
      input.matches = input.matches.map((match) =>
        match.productId === "b-milk1" ? { ...match, answer } : match,
      );
      expect(placed(buildShoppingPlan(input))).toEqual(["milk1 → a"]);
    }
  });

  it("uses a substitute a Member picked, and never a match a Member rejected", () => {
    const input = scenario([store("a"), store("b")], prices, 0);
    input.matches = input.matches.map((match) =>
      match.productId === "b-milk1" ? { ...match, answer: "substitute" } : match,
    );
    input.choices = [{ words: " MILK1 ", productId: "b-milk1", choice: "confirmed" }];
    expect(placed(buildShoppingPlan(input))).toEqual(["milk1 → b"]);
    input.matches = input.matches.map((match) => ({ ...match, answer: "match" }));
    input.choices = [{ words: "milk1", productId: "b-milk1", choice: "rejected" }];
    expect(placed(buildShoppingPlan(input))).toEqual(["milk1 → a"]);
  });

  it("uses only Stores that are on", () => {
    const plan = buildShoppingPlan(scenario([store("a"), store("b", { on: false })], prices, 0));
    expect(placed(plan)).toEqual(["milk1 → a"]);
    const none = buildShoppingPlan(scenario([store("a", { on: false })], { milk1: { a: 500 } }, 0));
    expect(placed(none)).toEqual(["milk1 → Not found"]);
  });

  it("makes sets of the Stores that are on only, so Stores that are off add none", () => {
    const off = Array.from({ length: 20 }, (_, s) => store(`off${s}`, { on: false }));
    const plan = buildShoppingPlan(scenario([store("a"), ...off], { milk1: { a: 500 } }, 0));
    expect(placed(plan)).toEqual(["milk1 → a"]);
    const thirteen = Array.from({ length: 13 }, (_, s) => store(`on${s}`));
    expect(() => buildShoppingPlan(scenario(thirteen, { milk1: { on0: 500 } }, 0))).toThrow(
      RangeError,
    );
  });

  it("leaves out a ticked List item", () => {
    const plan = buildShoppingPlan(
      scenario([store("a")], { milk1: { a: 500 }, bread2: { a: 300 } }, 0, [
        item("milk1", { ticked: true }),
        item("bread2"),
      ]),
    );
    expect(placed(plan)).toEqual(["bread2 → a"]);
  });

  it("never uses a Product whose match names another List item", () => {
    const input = scenario([store("a"), store("b")], { milk1: { a: 500 }, bread2: { b: 100 } }, 0);
    input.matches = [
      ...input.matches,
      { listItemId: "bread2", productId: "a-milk1", answer: "match" },
    ];
    expect(placed(buildShoppingPlan(input))).toEqual(["milk1 → a", "bread2 → b"]);
  });
});

describe("Deals", () => {
  const stores = [store("a"), store("b"), store("c"), store("amazon", { kind: "online" })];
  const prices = {
    milk1: {
      a: 500,
      b: { regular: 2000, deal: 359, endsOn: "2026-11-14" },
      c: { regular: 700, deal: 300, endsOn: "2026-11-20" },
    },
    bread2: { b: 400, a: { regular: 2000, deal: 2000 } },
  };

  it("shows a Deal at a Store in the plan beside its List item, until it ends", () => {
    const input = scenario(stores, prices, 1000);
    const plan = buildShoppingPlan(input);
    expect(placed(plan)).toEqual(["milk1 → a", "bread2 → b"]);
    const onLastDay = findDeals(input, plan.lines, "2026-11-14");
    expect(onLastDay.beside).toEqual([
      expect.objectContaining({
        listItemId: "milk1",
        storeId: "b",
        price: 359,
        total: 359,
        saves: 141,
        endsOn: "2026-11-14",
        readAt: READ_AT,
      }),
    ]);
    expect(findDeals(input, plan.lines, "2026-11-15").beside).toEqual([]);
  });

  it("lists a Deal at a Store not in the plan below it, and lets it move the plan only when the saving pays for the trip", () => {
    const input = scenario(stores, prices, 1000);
    const plan = buildShoppingPlan(input);
    // C saves $2.00 on milk: less than the $10.00 an extra trip must save.
    const deals = findDeals(input, plan.lines, "2026-11-15");
    expect(deals.elsewhere).toEqual([
      expect.objectContaining({ storeId: "c", saving: 200, paysForTrip: false }),
    ]);
    input.tripSaving = 199;
    expect(findDeals(input, plan.lines, "2026-11-15").elsewhere).toEqual([
      expect.objectContaining({ storeId: "c", saving: 200, paysForTrip: true }),
    ]);
    // A Deal that is no better than the plan price is not shown.
    expect(deals.beside.some((deal) => deal.listItemId === "bread2")).toBe(false);
  });

  it("counts an online Store's delivery fee against its Deals' saving", () => {
    const input = scenario(
      [store("a"), store("amazon", { kind: "online", deliveryFee: 150, freeDeliveryFrom: 3500 })],
      { milk1: { a: 500, amazon: { regular: 900, deal: 300 } } },
      1000,
    );
    const plan = buildShoppingPlan(input);
    const [amazon] = findDeals(input, plan.lines, "2026-11-10").elsewhere;
    // An online Store is not a trip: $2.00 saved less a $1.50 fee pays.
    expect(amazon).toEqual(expect.objectContaining({ saving: 50, paysForTrip: true }));
  });

  it("shows no Deal beside a List item that uses one already, nor for a Store that is off", () => {
    const input = scenario(stores, prices, 1000);
    const plan = buildShoppingPlan(input);
    const used = plan.lines.map((line) =>
      line.words === "milk1" ? { ...line, priceKind: "deal" as const } : line,
    );
    expect(findDeals(input, used, "2026-11-10").beside).toEqual([]);
    input.stores = input.stores.map((each) => (each.id === "b" ? { ...each, on: false } : each));
    expect(findDeals(input, plan.lines, "2026-11-10").beside).toEqual([]);
  });

  it("shows a weekly-ad-only Store's Deals below the plan", () => {
    const input = scenario(
      [store("a"), store("ad-fresh", { kind: "weekly ad only" })],
      { milk1: { a: 500, "ad-fresh": { deal: 199, endsOn: "2026-11-16" } } },
      0,
    );
    const plan = buildShoppingPlan(input);
    expect(findDeals(input, plan.lines, "2026-11-10").elsewhere).toEqual([
      expect.objectContaining({ storeId: "ad-fresh", saving: 301, paysForTrip: true }),
    ]);
  });
});

describe("the plan's speed (K3)", () => {
  it("builds the plan for 100 List items and 12 Stores, 4,096 sets, in under 1 s", () => {
    const stores = Array.from({ length: 12 }, (_, s) =>
      store(
        `store${String(s).padStart(2, "0")}`,
        s === 11 ? { kind: "online", deliveryFee: 599, freeDeliveryFrom: 3500 } : {},
      ),
    );
    const items = Array.from({ length: 100 }, (_, i) =>
      item(`item${i}`, { place: i, quantity: 2, unit: "lb" }),
    );
    const products: PlanProduct[] = [];
    const prices: PlanPrice[] = [];
    const matches: PlanMatch[] = [];
    // 15 Products per List item at each Store: 18,000 matches.
    for (const [i, each] of items.entries()) {
      for (const [s, at] of stores.entries()) {
        for (let p = 0; p < 15; p += 1) {
          const id = `${at.id}-${each.id}-${p}`;
          products.push({ id, storeId: at.id, name: `Product ${id}`, size: `${1 + (p % 3)} lb` });
          const regular = 300 + ((i * 7 + s * 13 + p * 17) % 900);
          prices.push({
            ...noDeal,
            productId: id,
            regularPrice: regular,
            dealPrice: p % 4 === 0 ? regular - 50 : null,
          });
          matches.push({
            listItemId: each.id,
            productId: id,
            answer: p % 5 === 0 ? "no" : "match",
          });
        }
      }
    }
    const input: PlanInput = {
      stores,
      items,
      products,
      prices,
      matches,
      choices: [],
      tripSaving: 1000,
    };
    const started = performance.now();
    const plan = buildShoppingPlan(input);
    const deals = findDeals(input, plan.lines, "2026-11-10");
    const took = performance.now() - started;
    expect(plan.notFound).toBe(0);
    expect(plan.lines).toHaveLength(100);
    expect(deals.beside.length + deals.elsewhere.length).toBeGreaterThan(0);
    expect(took).toBeLessThan(1000);
  });
});
