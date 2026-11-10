import { describe, expect, it } from "vitest";
import { CATEGORIES, type Category } from "../categories/index.ts";
import { partsFromLineItems } from "./line-item-parts.ts";

// Part amounts from Line items (spec 14, Splits from Line items): shares in proportion to the Line
// items' totals, rounded to the cent, with the leftover cents to the largest remainders.

const totals = (entries: [Category, number][]) => new Map<Category, number>(entries);
const sum = (parts: readonly { amount: number }[]) =>
  parts.reduce((all, part) => all + part.amount, 0);

describe("partsFromLineItems", () => {
  it("spreads tax and shipping over the parts: $65.40 for $40.00 and $20.00 is $43.60 and $21.80", () => {
    expect(
      partsFromLineItems(
        -6_540,
        totals([
          ["Groceries", 4_000],
          ["Home and garden", 2_000],
        ]),
      ),
    ).toEqual([
      { amount: -4_360, category: "Groceries" },
      { amount: -2_180, category: "Home and garden" },
    ]);
  });

  it("shrinks the parts when a promotion or gift card pays part, and drops a Category at $0 or less", () => {
    // A $50.00 charge for $40.00 and $20.00 of items, and a free item a discount took below $0.
    const parts = partsFromLineItems(
      -5_000,
      totals([
        ["Groceries", 4_000],
        ["Home and garden", 2_000],
        ["Hobbies", -150],
        ["Pets", 0],
      ]),
    );
    expect(parts).toEqual([
      { amount: -3_333, category: "Groceries" },
      { amount: -1_667, category: "Home and garden" },
    ]);
    expect(sum(parts)).toBe(-5_000);
  });

  it("gives 1 cent over three equal Categories to one part only, and drops the parts it rounds to 0", () => {
    const parts = partsFromLineItems(
      -1,
      totals([
        ["Groceries", 100],
        ["Home and garden", 100],
        ["Pets", 100],
      ]),
    );
    expect(parts).toEqual([{ amount: -1, category: "Groceries" }]);
  });

  it("gives the leftover cents to the largest remainders, so the parts always add up", () => {
    // $10.00 over three equal Categories: 333.33 cents each, so one part takes the cent left.
    const parts = partsFromLineItems(
      -1_000,
      totals([
        ["Groceries", 1],
        ["Home and garden", 1],
        ["Pets", 1],
      ]),
    );
    expect(parts.map((part) => part.amount)).toEqual([-334, -333, -333]);
    expect(sum(parts)).toBe(-1_000);
  });

  it("makes many parts that add up to the amount, largest first", () => {
    const many = CATEGORIES.slice(0, 30).map((category, index): [Category, number] => [
      category.name,
      (index + 1) * 137,
    ]);
    const parts = partsFromLineItems(-98_765, totals(many));
    expect(parts).toHaveLength(30);
    expect(sum(parts)).toBe(-98_765);
    for (const [index, part] of parts.entries()) {
      expect(part.amount).toBeLessThan(0);
      if (index > 0) expect(part.amount).toBeGreaterThanOrEqual(parts[index - 1]?.amount ?? 0);
    }
  });

  it("gives one part for one Category, and none for money in or no total above $0", () => {
    expect(partsFromLineItems(-1_350, totals([["Groceries", 1_250]]))).toEqual([
      { amount: -1_350, category: "Groceries" },
    ]);
    expect(partsFromLineItems(1_350, totals([["Groceries", 1_250]]))).toEqual([]);
    expect(partsFromLineItems(-1_350, totals([["Groceries", 0]]))).toEqual([]);
    expect(partsFromLineItems(-1_350, totals([]))).toEqual([]);
  });
});
