import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addShoppingListItem, deletePriceReadsBefore } from "./deal-finder.ts";
import * as schema from "./schema.ts";
import { newTestDatabase, type TestDatabase } from "./testing.ts";

// The deal finder's tables in app.db (spec 15): the Shopping list's cap, price history's 400 days,
// and app.db's own checks on a price.

const AT = new Date("2026-11-11T15:00:00.000Z");
const DAY = 86_400_000;

let test: TestDatabase;

beforeEach(async () => {
  test = await newTestDatabase();
  await test.database.insert(schema.dealFinderStores).values({
    id: "kroger",
    name: "Kroger",
    kind: "in person",
    reader: "Store API",
    on: true,
    nearby: true,
    locations: [],
    foundAt: AT,
  });
  await test.database.insert(schema.dealFinderProducts).values({
    id: "product-1",
    storeId: "kroger",
    readKey: "0001111000101",
    name: "Fake Farms Ground Beef",
    addedAt: AT,
  });
});

afterEach(() => {
  test.close();
});

const item = (n: number) => ({
  id: `item-${n}`,
  words: `item ${n}`,
  quantity: 1,
  unit: "each" as const,
  brandLock: null,
  note: null,
  addedAt: AT,
  addedBy: null,
});

const count = async (table: string) =>
  Number((await test.database.$client.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n);

describe("addShoppingListItem", () => {
  it("adds each List item at the end, and none past the cap", async () => {
    expect(await addShoppingListItem(test.database, item(1), 2)).toBe(true);
    expect(await addShoppingListItem(test.database, item(2), 2)).toBe(true);
    expect(await addShoppingListItem(test.database, item(3), 2)).toBe(false);

    const rows = await test.database.select().from(schema.shoppingListItems);
    expect(rows.map((row) => [row.id, row.place])).toEqual([
      ["item-1", 0],
      ["item-2", 1],
    ]);
  });

  it("never passes the cap when adds run at once (K18)", async () => {
    const added = await Promise.all(
      Array.from({ length: 8 }, (_, n) => addShoppingListItem(test.database, item(n), 5)),
    );

    expect(added.filter(Boolean)).toHaveLength(5);
    expect(await count("shopping_list_items")).toBe(5);
  });
});

describe("deletePriceReadsBefore", () => {
  it("deletes only the price reads older than the date", async () => {
    const cutoff = new Date(AT.getTime() - 400 * DAY);
    await test.database.insert(schema.dealFinderPriceReads).values(
      [401, 400, 10].map((days) => ({
        productId: "product-1",
        readAt: new Date(AT.getTime() - days * DAY),
        regularPrice: 549,
      })),
    );

    expect(await deletePriceReadsBefore(test.database, cutoff)).toBe(1);

    const left = await test.database.select().from(schema.dealFinderPriceReads);
    expect(left.map((read) => read.readAt.getTime()).sort()).toEqual(
      [cutoff.getTime(), AT.getTime() - 10 * DAY].sort(),
    );
  });
});

describe("app.db's checks on the deal finder tables", () => {
  it("refuses a price under 1 cent or over $9,999.99", async () => {
    for (const regularPrice of [0, -1, 1_000_000]) {
      await expect(
        test.database
          .insert(schema.dealFinderPriceReads)
          .values({ productId: "product-1", readAt: AT, regularPrice }),
      ).rejects.toThrow();
    }
    expect(await count("deal_finder_price_reads")).toBe(0);
  });

  it("deletes a Store's Products and their price reads with the Store (K6)", async () => {
    await test.database
      .insert(schema.dealFinderPriceReads)
      .values({ productId: "product-1", readAt: AT, regularPrice: 549 });

    await test.database.$client.execute("DELETE FROM deal_finder_stores WHERE id = 'kroger'");

    expect(await count("deal_finder_products")).toBe(0);
    expect(await count("deal_finder_price_reads")).toBe(0);
  });
});
