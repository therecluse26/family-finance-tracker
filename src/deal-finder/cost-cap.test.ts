import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addPriceSourceCost, type Database, readPriceSourceCost } from "../db/index.ts";
import { newTestDatabase, type TestDatabase } from "../db/testing.ts";
import { FIND_STORES_RUNS, priceSourceCostCap, RUN_WORST_NANOS } from "./cost-cap.ts";

// The Price source cost cap before each Actor run (spec 15, Cost and limits).

const MONTH = "2026-11";
const CAP_CENTS = 500;

describe("the Price source cost cap", () => {
  let test: TestDatabase;
  let database: Database;

  beforeEach(async () => {
    test = await newTestDatabase();
    database = test.database;
  });

  afterEach(() => {
    test.close();
  });

  it("holds each run's $1.00 worst case, so runs stop starting past $4.00 of a $5.00 cap", async () => {
    const cap = priceSourceCostCap(database);
    await addPriceSourceCost(database, MONTH, 4_000_000_000);
    const place = await cap.hold(MONTH, CAP_CENTS);
    expect(place).not.toBeNull();
    await place?.end(1);
    expect(await cap.hold(MONTH, CAP_CENTS)).toBeNull();
    expect(await readPriceSourceCost(database, MONTH)).toBe(4_000_000_001);
  });

  it("lets only one of two runs fired in parallel take its place at $3.50 (K18)", async () => {
    const cap = priceSourceCostCap(database);
    await addPriceSourceCost(database, MONTH, 3_500_000_000);
    const places = await Promise.all([cap.hold(MONTH, CAP_CENTS), cap.hold(MONTH, CAP_CENTS)]);
    const taken = places.filter((place) => place !== null);
    expect(taken).toHaveLength(1);
    // The run's place is given back when it ends, with its real cost counted.
    await taken[0]?.end(200_000_000);
    expect(await readPriceSourceCost(database, MONTH)).toBe(3_700_000_000);
    expect(await cap.hold(MONTH, CAP_CENTS)).not.toBeNull();
  });

  it("is one cap for the database, so Find Stores near us and a plan run share it", async () => {
    await addPriceSourceCost(database, MONTH, 1_000_000_000);
    const find = await priceSourceCostCap(database).hold(MONTH, CAP_CENTS, FIND_STORES_RUNS);
    expect(find).not.toBeNull();
    // $1.00 spent and $3.00 held: one more run fits, and a second does not.
    expect(await priceSourceCostCap(database).hold(MONTH, CAP_CENTS)).not.toBeNull();
    expect(await priceSourceCostCap(database).hold(MONTH, CAP_CENTS)).toBeNull();
  });

  it("ends a place once: its cost counts once, and its hold is given back once", async () => {
    const cap = priceSourceCostCap(database);
    const first = await cap.hold(MONTH, CAP_CENTS, 4);
    const second = await cap.hold(MONTH, CAP_CENTS);
    expect([first, second].every((place) => place !== null)).toBe(true);
    await first?.end(RUN_WORST_NANOS);
    await first?.end(RUN_WORST_NANOS);
    expect(await readPriceSourceCost(database, MONTH)).toBe(RUN_WORST_NANOS);
    // $1.00 spent and the second run's $1.00 held: 3 more runs fit, and 4 do not.
    expect(await cap.hold(MONTH, CAP_CENTS, 4)).toBeNull();
    expect(await cap.hold(MONTH, CAP_CENTS, 3)).not.toBeNull();
  });

  it("holds nothing for a free call, and still counts its cost", async () => {
    const cap = priceSourceCostCap(database);
    await cap.free(MONTH).end(5);
    expect(await readPriceSourceCost(database, MONTH)).toBe(5);
    expect(await cap.hold(MONTH, CAP_CENTS, 4)).not.toBeNull();
  });
});
