import { describe, expect, it } from "vitest";
import { CATEGORIES, type Category } from "../categories/index.ts";
import { type CategoryTerms, type DraftedBudget, type DraftTerms, fitToIncome } from "./index.ts";

// The total must fit (spec 05, The total must fit), on drafts and terms given by hand. Amounts are
// whole cents.

const $ = (dollars: number) => dollars * 100;

// Terms with nothing in any Category but the K, Y, and yearly Recurring charges given, and I.
function terms(
  income: number,
  given: Partial<Record<Category, Partial<CategoryTerms>>> = {},
): DraftTerms {
  const categories = Object.fromEntries(
    CATEGORIES.map(({ name }) => [
      name,
      {
        spent: 0,
        a: 0,
        aOther: 0,
        aFlex: 0,
        k: 0,
        y: 0,
        kLoans: 0,
        yearlyCharges: 0,
        ...given[name],
      },
    ]),
  ) as Record<Category, CategoryTerms>;
  return { n: 12, income, categories, split: { groceries: 0, superstores: 0 }, benchmarks: {} };
}

const monthly = (category: Category, dollars: number): DraftedBudget => ({
  category,
  amount: $(dollars),
  period: "monthly",
});
const yearly = (category: Category, dollars: number): DraftedBudget => ({
  category,
  amount: $(dollars),
  period: "yearly",
});

// Each Budget as "Category: dollars period".
const shown = (budgets: readonly DraftedBudget[]) =>
  budgets.map(({ category, amount, period }) => `${category}: ${amount / 100} ${period}`);

describe("the total must fit", () => {
  it("cuts Restaurants from $400 to $300 and Travel from $4,800 to $3,600 a year: I = $6,000, total $6,200", () => {
    const draft = [monthly("Housing", 5_400), monthly("Restaurants", 400), yearly("Travel", 4_800)];

    const fitted = fitToIncome(draft, terms($(6_000)));

    expect(shown(fitted.budgets)).toEqual([
      "Housing: 5400 monthly",
      "Restaurants: 300 monthly",
      "Travel: 3600 yearly",
    ]);
    expect(fitted.fixedCostsPassIncome).toBe(false);
  });

  it("cuts nothing at or below I", () => {
    const draft = [monthly("Housing", 5_200), monthly("Restaurants", 400), yearly("Travel", 4_800)];

    expect(fitToIncome(draft, terms($(6_000)))).toEqual({
      budgets: draft,
      fixedCostsPassIncome: false,
    });
  });

  it("counts each yearly Recurring charge at 1/12 of its amount, not in its due month", () => {
    // June's Insurance Budget is the $1,200 car insurance; the total counts $100 of it. $5,800 +
    // $100 + $50 is within I, though June's Budgets sum to $7,050.
    const draft = [monthly("Housing", 5_800), monthly("Insurance", 1_200), monthly("Hobbies", 50)];
    const given = terms($(6_000), {
      Insurance: { k: $(1_200), y: $(1_200), yearlyCharges: $(1_200) },
    });

    expect(shown(fitToIncome(draft, given).budgets)).toEqual(shown(draft));
    // Every other month, the same charge still counts at $100: $5,950 + $100 + $50 passes I.
    const other = [monthly("Housing", 5_950), monthly("Insurance", 0), monthly("Hobbies", 50)];
    const otherTerms = terms($(6_000), { Insurance: { yearlyCharges: $(1_200) } });
    expect(shown(fitToIncome(other, otherTerms).budgets)).toContain("Hobbies: 25 monthly");
  });

  it("keeps the larger of 50% of the draft and K, so a fixed cost is never cut", () => {
    // Entertainment's room is $400 − $300 = $100; Restaurants' is $200. G = $600 takes all of both.
    const draft = [
      monthly("Housing", 6_000),
      monthly("Entertainment", 400),
      monthly("Restaurants", 400),
      monthly("Clothing", 600),
    ];
    const given = terms($(6_800), { Entertainment: { k: $(300) } });

    expect(shown(fitToIncome(draft, given).budgets)).toEqual([
      "Housing: 6000 monthly",
      "Entertainment: 300 monthly",
      "Restaurants: 200 monthly",
      // Step 2 takes the last $300 of G from Clothing's $300 of room.
      "Clothing: 300 monthly",
    ]);
  });

  it("cuts Shopping only after Leisure, and never Groceries or Superstores", () => {
    const draft = [
      monthly("Housing", 6_000),
      monthly("Restaurants", 200),
      monthly("Groceries", 800),
      monthly("Superstores", 400),
      monthly("Clothing", 200),
      monthly("Home and garden", 200),
    ];

    // G = $150: Restaurants' $100 of room, then f = $50 ÷ $200 in Shopping.
    expect(shown(fitToIncome(draft, terms($(7_650))).budgets)).toEqual([
      "Housing: 6000 monthly",
      "Restaurants: 100 monthly",
      "Groceries: 800 monthly",
      "Superstores: 400 monthly",
      "Clothing: 175 monthly",
      "Home and garden: 175 monthly",
    ]);
    // G = $50: Leisure alone covers it.
    expect(shown(fitToIncome(draft, terms($(7_750))).budgets)).toContain("Clothing: 200 monthly");
  });

  it("leaves the gap above $0 when both steps run out of room, and says the fixed costs pass Steady Income", () => {
    const draft = [
      monthly("Housing", 7_000),
      monthly("Interest and fees", 300),
      monthly("Groceries", 900),
      monthly("Gas", 200),
      monthly("Health", 150),
      yearly("Gifts and donations", 1_200),
      monthly("Restaurants", 400),
      monthly("Clothing", 200),
    ];

    const fitted = fitToIncome(draft, terms($(6_000)));

    expect(fitted.fixedCostsPassIncome).toBe(true);
    expect(shown(fitted.budgets)).toEqual([
      // Bills, Interest and fees, Groceries, Transportation, Health and care, and Other: never cut.
      "Housing: 7000 monthly",
      "Interest and fees: 300 monthly",
      "Groceries: 900 monthly",
      "Gas: 200 monthly",
      "Health: 150 monthly",
      "Gifts and donations: 1200 yearly",
      // Each cut by all of its room.
      "Restaurants: 200 monthly",
      "Clothing: 100 monthly",
    ]);
  });

  it("does not run when I is $0", () => {
    const draft = [monthly("Housing", 2_000), monthly("Restaurants", 400)];

    expect(fitToIncome(draft, terms(0))).toEqual({ budgets: draft, fixedCostsPassIncome: false });
  });
});
