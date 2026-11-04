import { describe, expect, it } from "vitest";
import { CATEGORIES, type Category } from "../categories/index.ts";
import { type CategoryTerms, type DraftTerms, draftBudgets } from "./index.ts";

// The draft formulas (spec 05, Drafting Budgets): each worked example in the spec, and each rule of
// Which Categories get a Budget, on terms given by hand. Amounts are whole cents.

const $ = (dollars: number) => dollars * 100;

type Given = Partial<Omit<DraftTerms, "categories">> & {
  categories?: Partial<Record<Category, Partial<CategoryTerms>>>;
};

// Terms with nothing in any Category, 12 months of history, and I = $6,000.
function terms(given: Given = {}): DraftTerms {
  const categories = Object.fromEntries(
    CATEGORIES.map(({ name }) => [
      name,
      { spent: 0, a: 0, aOther: 0, aFlex: 0, k: 0, y: 0, kLoans: 0, ...given.categories?.[name] },
    ]),
  ) as Record<Category, CategoryTerms>;
  return {
    n: 12,
    income: $(6_000),
    split: { groceries: 0, superstores: 0 },
    benchmarks: {},
    ...given,
    categories,
  };
}

// Each drafted Budget as "Category: amount period", for one Category or all.
const drafted = (given: Given, only?: Category) =>
  draftBudgets(terms(given))
    .filter(({ category }) => only === undefined || category === only)
    .map(({ category, amount, period }) => `${category}: ${amount / 100} ${period}`);

// Spending of `monthly` dollars a month over a window of n months.
const history = (monthly: number, n = 12) => ({
  spent: $(monthly) * n,
  a: $(monthly),
  aOther: $(monthly),
  aFlex: $(monthly),
});

describe("the draft formulas", () => {
  describe("Bills: K + A_other", () => {
    it("drafts Utilities at $150: the $120 electric Recurring charge, plus water at $360 ÷ 12", () => {
      expect(
        drafted({
          categories: { Utilities: { spent: $(1_800), a: $(150), aOther: $(30), k: $(120) } },
        }),
      ).toEqual(["Utilities: 150 monthly", "Interest and fees: 0 monthly"]);
    });

    it("drafts Insurance at $1,200 in June, the yearly car insurance, and $0 every other month", () => {
      const insurance = { spent: $(1_200), a: $(100), aOther: $(0), aFlex: $(0) };
      expect(
        drafted(
          { categories: { Insurance: { ...insurance, k: $(1_200), y: $(1_200) } } },
          "Insurance",
        ),
      ).toEqual(["Insurance: 1200 monthly"]);
      expect(drafted({ categories: { Insurance: insurance } }, "Insurance")).toEqual([
        "Insurance: 0 monthly",
      ]);
    });

    it("never uses the Benchmark, and needs no 3 months of history", () => {
      expect(
        drafted(
          {
            n: 1,
            benchmarks: { Housing: $(2_000) },
            categories: { Housing: { spent: $(1_500), a: $(1_500), aOther: $(0), k: $(1_500) } },
          },
          "Housing",
        ),
      ).toEqual(["Housing: 1500 monthly"]);
    });
  });

  describe("Interest and fees", () => {
    it("drafts the $100 interest expected on the Larkspur payment, never card interest or fees", () => {
      expect(
        drafted(
          {
            categories: {
              "Interest and fees": { ...history(60), k: $(135), kLoans: $(100) },
            },
          },
          "Interest and fees",
        ),
      ).toEqual(["Interest and fees: 100 monthly"]);
    });

    it("always gets a Budget, $0 with no tracked loans, even with no history", () => {
      expect(drafted({ n: 0 })).toEqual(["Interest and fees: 0 monthly"]);
    });
  });

  describe("Groceries and Superstores", () => {
    const shopping = (groceries: number, superstores: number, n = 12): Given => ({
      n,
      benchmarks: { Groceries: $(1_120), Superstores: $(1_120) },
      split: { groceries: $(groceries) * n, superstores: $(superstores) * n },
      categories: { Groceries: history(groceries, n), Superstores: history(superstores, n) },
    });
    const both = (given: Given) =>
      drafted(given).filter((line) => /^(Groceries|Superstores)/.test(line));

    it("drafts $600 and $400 when history is below B_GS", () => {
      expect(both(shopping(600, 400))).toEqual([
        "Groceries: 600 monthly",
        "Superstores: 400 monthly",
      ]);
    });

    it("drafts $672 and $448 when history is $1,500: T = B_GS, split 60% and 40%", () => {
      expect(both(shopping(900, 600))).toEqual([
        "Groceries: 672 monthly",
        "Superstores: 448 monthly",
      ]);
    });

    it("takes T = B_GS with n < 3", () => {
      expect(both(shopping(300, 200, 2))).toEqual([
        "Groceries: 672 monthly",
        "Superstores: 448 monthly",
      ]);
    });

    it("splits by the Spending given when n = 0", () => {
      expect(
        both({
          n: 0,
          benchmarks: { Groceries: $(1_000), Superstores: $(1_000) },
          split: { groceries: $(300), superstores: $(100) },
          categories: { Groceries: { k: $(10) }, Superstores: { k: $(10) } },
        }),
      ).toEqual(["Groceries: 750 monthly", "Superstores: 250 monthly"]);
    });

    it("keeps each Category's own floor K and adds its own Y", () => {
      const given = shopping(600, 400);
      expect(
        both({
          ...given,
          categories: {
            ...given.categories,
            Groceries: { ...history(600), k: $(700) },
            Superstores: { ...history(400), k: $(120), y: $(120) },
          },
        }),
      ).toEqual(["Groceries: 700 monthly", "Superstores: 520 monthly"]);
    });
  });

  describe("Categories with a Benchmark: max(K, Y + min(B, A_flex))", () => {
    it("drafts Restaurants at $300: B = $300, A_flex = $450, K = $0", () => {
      expect(
        drafted(
          { benchmarks: { Restaurants: $(300) }, categories: { Restaurants: history(450) } },
          "Restaurants",
        ),
      ).toEqual(["Restaurants: 300 monthly"]);
    });

    it("drafts Fitness at $50: the $50 gym floors B = $40", () => {
      expect(
        drafted(
          { benchmarks: { Fitness: $(40) }, categories: { Fitness: { ...history(60), k: $(50) } } },
          "Fitness",
        ),
      ).toEqual(["Fitness: 50 monthly"]);
    });

    it("drafts Car in March at $640: K = $400 + $240 beats Y + min = $540", () => {
      expect(
        drafted(
          {
            benchmarks: { Car: $(300) },
            categories: { Car: { ...history(500), k: $(640), y: $(240) } },
          },
          "Car",
        ),
      ).toEqual(["Car: 640 monthly"]);
    });

    it("takes the lower history over the Benchmark", () => {
      expect(
        drafted(
          { benchmarks: { Restaurants: $(300) }, categories: { Restaurants: history(180) } },
          "Restaurants",
        ),
      ).toEqual(["Restaurants: 180 monthly"]);
    });

    it("uses B in place of the lower one with n < 3", () => {
      expect(
        drafted(
          {
            n: 2,
            benchmarks: { Restaurants: $(300) },
            categories: { Restaurants: history(180, 2) },
          },
          "Restaurants",
        ),
      ).toEqual(["Restaurants: 300 monthly"]);
    });

    it("drafts as if it had no Benchmark when I is $0", () => {
      const given = {
        income: 0,
        benchmarks: { Restaurants: 0, Groceries: $(1_000), Superstores: $(1_000) },
        split: { groceries: $(4_800), superstores: $(2_400) },
        categories: {
          Restaurants: history(450),
          Groceries: history(400),
          Superstores: history(200),
        },
      };
      expect(drafted(given).filter((line) => !line.startsWith("Interest"))).toEqual([
        "Groceries: 400 monthly",
        "Superstores: 200 monthly",
        "Restaurants: 450 monthly",
      ]);
      expect(drafted({ ...given, n: 2 }).filter((line) => !line.startsWith("Interest"))).toEqual(
        [],
      );
    });

    it("drafts as if it had no Benchmark when every CE line is suppressed", () => {
      expect(
        drafted({ benchmarks: { Pets: null }, categories: { Pets: history(75) } }, "Pets"),
      ).toEqual(["Pets: 75 monthly"]);
      expect(
        drafted({ n: 2, benchmarks: { Pets: null }, categories: { Pets: history(75, 2) } }, "Pets"),
      ).toEqual([]);
    });
  });

  describe("Categories with no good Benchmark: max(K, Y + A_flex), once n ≥ 3", () => {
    it("drafts General goods at $250", () => {
      expect(drafted({ categories: { "General goods": history(250) } }, "General goods")).toEqual([
        "General goods: 250 monthly",
      ]);
    });

    it("keeps the floor K, and adds Y", () => {
      expect(
        drafted({
          categories: {
            Services: { ...history(40), k: $(60) },
            Miscellaneous: { ...history(40), k: $(100), y: $(100) },
          },
        }).filter((line) => !line.startsWith("Interest")),
      ).toEqual(["Services: 60 monthly", "Miscellaneous: 140 monthly"]);
    });

    it("drafts nothing until n ≥ 3, even with known amounts", () => {
      expect(
        drafted({ n: 2, categories: { Cash: { ...history(200, 2), k: $(50) } } }, "Cash"),
      ).toEqual([]);
    });
  });

  describe("Travel, and Gifts and donations: yearly A × 12, once n ≥ 3", () => {
    it("drafts Travel at $4,800 from $4,800 in 12 months, and $3,600 from $1,800 in 6", () => {
      expect(drafted({ categories: { Travel: { spent: $(4_800), a: $(400) } } }, "Travel")).toEqual(
        ["Travel: 4800 yearly"],
      );
      expect(
        drafted({ n: 6, categories: { Travel: { spent: $(1_800), a: $(300) } } }, "Travel"),
      ).toEqual(["Travel: 3600 yearly"]);
    });

    it("drafts Gifts and donations from A, with yearly Recurring charges, and nothing with n < 3", () => {
      const gifts = { spent: $(1_200), a: $(100), aFlex: $(50) };
      expect(
        drafted({ categories: { "Gifts and donations": gifts } }, "Gifts and donations"),
      ).toEqual(["Gifts and donations: 1200 yearly"]);
      expect(
        drafted({ n: 2, categories: { "Gifts and donations": gifts } }, "Gifts and donations"),
      ).toEqual([]);
    });
  });

  describe("which Categories get a Budget", () => {
    it("gives none, never $0, to a Category with no Spending in the window and no K", () => {
      expect(
        drafted({ benchmarks: { Restaurants: $(300) }, categories: { Restaurants: {} } }),
      ).toEqual(["Interest and fees: 0 monthly"]);
    });

    it("gives a Budget from K alone, with no Spending in the window", () => {
      expect(
        drafted(
          { benchmarks: { Entertainment: $(80) }, categories: { Entertainment: { k: $(15) } } },
          "Entertainment",
        ),
      ).toEqual(["Entertainment: 15 monthly"]);
    });

    it("exempts Bills from the 3 months of history", () => {
      expect(
        drafted({ n: 0, categories: { "Phone and internet": { k: $(85) } } }, "Phone and internet"),
      ).toEqual(["Phone and internet: 85 monthly"]);
    });
  });

  it("rounds every Budget to the nearest whole dollar", () => {
    expect(
      drafted({
        benchmarks: { Restaurants: 30_049 },
        categories: {
          Utilities: { spent: 1, k: 12_050 },
          Restaurants: history(400),
          Hobbies: { spent: 1, a: 0, aFlex: 4_249 },
          Travel: { spent: 1, a: 4_004 },
        },
      }).filter((line) => !line.startsWith("Interest")),
    ).toEqual([
      "Utilities: 121 monthly",
      "Restaurants: 300 monthly",
      "Hobbies: 42 monthly",
      "Travel: 480 yearly",
    ]);
  });
});
