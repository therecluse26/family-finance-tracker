import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CATEGORIES, type Category } from "../categories/index.ts";
import { loginTables, storeCpiValues } from "../db/index.ts";
import { newTestDatabase, type TestDatabase } from "../db/testing.ts";
import { type HouseholdFactsInput, saveHouseholdFacts } from "../household/index.ts";
import { typeSteadyIncome } from "../recurring/index.ts";
import {
  type BenchmarkInputs,
  type BenchmarkSnapshot,
  benchmarkContextLine,
  benchmarkSnapshot,
  type CategoryBenchmark,
  CE_LINES,
  CE_NOTES,
  type CeLine,
  type CeTable,
  categoryBenchmarks,
  computeCategoryBenchmarks,
  type FoodPlan,
  foodPlanCost,
} from "./index.ts";

// Each Category's Benchmark (spec 05, The Benchmark for a Category, The Groceries and Superstores
// Benchmark, Which Categories have a Benchmark, and Context for Bills Budgets), on a made-up
// snapshot whose figures make each rule easy to see.

type Lines = Partial<Record<CeLine, number | null>>;

// One CE column with $100,000 of total Spending, so a line's dollars over 1,000 are its percent.
function column(label: string, incomeAfterTaxes: number, lines: Lines = {}) {
  const zero = Object.fromEntries(CE_LINES.map((line) => [line, 0])) as Record<CeLine, number>;
  return { label, incomeAfterTaxes, totalSpending: 100_000, lines: { ...zero, ...lines } };
}

function ceTable(columns: CeTable["columns"]): CeTable {
  return {
    title: "Made-up CE table",
    years: "2025",
    pricedAt: { series: "CUUR0000SA0", period: "2025", value: 330 },
    columns,
  };
}

// The size × income table for `size` people. Restaurants (Food away from home) is `size`% of
// Spending in the lower column and twice that in the upper one, so each table and column shows.
const sizeTable = (size: number) =>
  ceTable([
    // Exactly I × 12 for I = $6,000. It is no income column, so it is never picked.
    column("All consumer units", 72_000, { "Food away from home": 9_000 }),
    column("$40,000 to $69,999", 60_000, {
      "Food away from home": size * 1_000,
      "Housekeeping supplies": 1_500,
      "Personal care products": 500,
    }),
    column("$70,000 to $99,999", 90_000, { "Food away from home": size * 2_000 }),
  ]);

const FOOD_MONTH = "2026-09";
const FOOD_CPI = 335;

const cost = (age: string, fromAge: number, toAge: number | null, monthly: number) =>
  ({ age, fromAge, toAge, sex: null, monthly }) as const;
const split = (
  age: string,
  fromAge: number,
  toAge: number | null,
  male: number,
  female: number,
) => [
  { age, fromAge, toAge, sex: "male" as const, monthly: male },
  { age, fromAge, toAge, sex: "female" as const, monthly: female },
];

function foodPlan(plan: FoodPlan["plan"], area: string, adult: number): FoodPlan {
  return {
    plan,
    area,
    month: FOOD_MONTH,
    pricedAt: { series: "CUUR0000SAF11", period: FOOD_MONTH, value: FOOD_CPI },
    costs: [
      cost("1 year", 1, 1, 100),
      cost("2-11 years", 2, 11, 200),
      ...split("12-70 years", 12, 70, adult - 20, adult + 20),
      ...split("71+ years", 71, null, 300, 260),
    ],
  };
}

const TEST: BenchmarkSnapshot = {
  ...benchmarkSnapshot(),
  ce: {
    dataYear: 2025,
    byIncome: ceTable([
      column("All consumer units", 72_000, { "Food away from home": 9_000 }),
      column("Less than $50,000", 40_000, { "Food away from home": 7_000 }),
      column("$50,000 and more", 100_000, { "Food away from home": 8_000 }),
    ]),
    bySizeAndIncome: [1, 2, 3, 4, 5].map((size) => ({ size, table: sizeTable(size) })),
  },
  food: {
    moderate: foodPlan("Moderate-Cost", "U.S. average", 400),
    thrifty: {
      us: foodPlan("Thrifty", "U.S. average", 300),
      alaska: foodPlan("Thrifty", "Alaska", 390),
      hawaii: foodPlan("Thrifty", "Hawaii", 360),
    },
    sizeAdjustment: [
      { fromSize: 1, toSize: 1, percent: 20 },
      { fromSize: 2, toSize: 2, percent: 10 },
      { fromSize: 3, toSize: 4, percent: 0 },
      { fromSize: 5, toSize: 6, percent: -5 },
      { fromSize: 7, toSize: null, percent: -10 },
    ],
  },
};

// Two adults and one child, renting in New York, with I = $6,000.
const FAMILY: BenchmarkInputs = {
  income: 600_000,
  ages: [40, 38, 7],
  rentOrOwn: "rent",
  state: "NY",
  foodAtHomeNow: FOOD_CPI,
};

const compute = (inputs: Partial<BenchmarkInputs> = {}, snapshot = TEST) =>
  computeCategoryBenchmarks({ ...FAMILY, ...inputs }, snapshot);

const benchmarkOf = (category: Category, inputs: Partial<BenchmarkInputs> = {}, snapshot = TEST) =>
  compute(inputs, snapshot).categories.find((benchmark) => benchmark.category === category);

const withSnapshot = (change: (snapshot: BenchmarkSnapshot) => void) => {
  const changed = structuredClone(TEST);
  change(changed);
  return changed;
};

describe("the CE column", () => {
  it("picks the income column nearest I × 12 in the size × income table, never All consumer units", () => {
    // $72,000 a year: All consumer units matches exactly, but is skipped. $60,000 is nearer than
    // $90,000.
    expect(compute().ceColumn).toEqual({ table: "size and income", label: "$40,000 to $69,999" });
    expect(benchmarkOf("Restaurants")?.amount).toBe(18_000);

    // $90,000 a year.
    expect(compute({ income: 750_000 }).ceColumn.label).toBe("$70,000 to $99,999");
  });

  it("uses the table for the Household's size, and the five-or-more table above five people", () => {
    expect(benchmarkOf("Restaurants", { ages: [30] })?.share).toBe(0.01);
    expect(benchmarkOf("Restaurants", { ages: [30, 30] })?.share).toBe(0.02);
    expect(benchmarkOf("Restaurants", { ages: [30, 30, 5, 5, 5] })?.share).toBe(0.05);
    expect(benchmarkOf("Restaurants", { ages: [30, 30, 5, 5, 5, 5, 5] })?.share).toBe(0.05);
  });

  it("falls back to the one-year income table when the size has no income column", () => {
    const onlyAllUnits = withSnapshot((snapshot) => {
      const sizeThree = snapshot.ce.bySizeAndIncome[2];
      if (sizeThree !== undefined) sizeThree.table.columns.splice(1);
    });
    expect(compute({}, onlyAllUnits).ceColumn).toEqual({
      table: "income",
      label: "$50,000 and more",
    });
    expect(benchmarkOf("Restaurants", {}, onlyAllUnits)?.share).toBe(0.08);

    const noSizeTable = withSnapshot((snapshot) => {
      snapshot.ce.bySizeAndIncome = snapshot.ce.bySizeAndIncome.filter(({ size }) => size !== 3);
    });
    expect(compute({ income: 300_000 }, noSizeTable).ceColumn).toEqual({
      table: "income",
      label: "Less than $50,000",
    });
  });
});

describe("the Benchmark for a Category", () => {
  it("is the column's share of Spending times I: 5% and I = $6,000 give $300 a month", () => {
    const restaurants = benchmarkOf("Restaurants", { ages: [40, 38, 7, 5, 3] });

    expect(restaurants).toEqual({
      category: "Restaurants",
      role: "drafts",
      amount: 30_000,
      share: 0.05,
      ceNote: null,
    });
  });

  it("sums the Category's CE lines, and counts a suppressed line as 0", () => {
    const snapshot = withSnapshot((changed) => {
      const lines = changed.ce.bySizeAndIncome[2]?.table.columns[1]?.lines;
      if (lines === undefined) throw new Error("No column.");
      Object.assign(lines, {
        "Vehicle insurance": 1_000,
        "Health insurance": 2_000,
        "Life and other personal insurance": null,
        "Medical services": null,
        Drugs: null,
        "Medical supplies": null,
      });
    });

    // (1% + 2%) × $6,000.
    expect(benchmarkOf("Insurance", {}, snapshot)?.amount).toBe(18_000);
    // Every line suppressed: no Benchmark.
    expect(benchmarkOf("Health", {}, snapshot)).toMatchObject({ amount: null, share: null });
  });

  it("takes rented dwellings for a Household that rents and owned dwellings for one that owns", () => {
    const snapshot = withSnapshot((changed) => {
      const lines = changed.ce.bySizeAndIncome[2]?.table.columns[1]?.lines;
      if (lines === undefined) throw new Error("No column.");
      Object.assign(lines, { "Rented dwellings": 20_000, "Owned dwellings": 30_000 });
    });

    expect(benchmarkOf("Housing", { rentOrOwn: "rent" }, snapshot)?.amount).toBe(120_000);
    expect(benchmarkOf("Housing", { rentOrOwn: "own" }, snapshot)?.amount).toBe(180_000);
  });

  it("gives Personal care only the CE personal care services", () => {
    const snapshot = withSnapshot((changed) => {
      const lines = changed.ce.bySizeAndIncome[2]?.table.columns[1]?.lines;
      if (lines === undefined) throw new Error("No column.");
      Object.assign(lines, { "Personal care services": 1_000, "Personal care products": 4_000 });
    });

    expect(benchmarkOf("Personal care", {}, snapshot)?.amount).toBe(6_000);
  });

  it("is $0 with I at $0, with no share", () => {
    expect(benchmarkOf("Restaurants", { income: 0 })).toMatchObject({ amount: 0, share: null });
  });
});

describe("the Groceries and Superstores Benchmark", () => {
  it("is F plus the supplies and personal-care products share of I: $1,000 + 2% of $6,000 = $1,120", () => {
    // Two adults at $400 (the mean of $380 and $420) and a child at $200: F = $1,000. Housekeeping
    // supplies 1.5% and personal care products 0.5% of $6,000: $120.
    const { food, categories } = compute();

    expect(food).toBe(100_000);
    for (const category of ["Groceries", "Superstores"] as const) {
      expect(categories.find((benchmark) => benchmark.category === category)).toEqual({
        category,
        role: "drafts shared",
        amount: 112_000,
        share: 112_000 / 600_000,
        ceNote: null,
      });
    }
  });

  it("takes the mean of the male and female costs, the 1-year cost under 1, and the open last age group", () => {
    // $100 for the baby; $280 for the 80-year-old, the mean of $300 and $260; then +10% for two.
    expect(foodPlanCost(TEST, [0, 80], "NY", FOOD_CPI)).toBeCloseTo(418, 9);
    expect(foodPlanCost(TEST, [1, 80], "NY", FOOD_CPI)).toBeCloseTo(418, 9);
    // 12 and 70 sit at the ends of the split group: $400 each, then +10%.
    expect(foodPlanCost(TEST, [12, 70], "NY", FOOD_CPI)).toBeCloseTo(880, 9);
  });

  it("applies USDA's household-size adjustment", () => {
    // One adult: +20%.
    expect(foodPlanCost(TEST, [40], "NY", FOOD_CPI)).toBeCloseTo(480, 9);
    // Seven people, in the open last size group: -10%.
    expect(foodPlanCost(TEST, [40, 40, 9, 9, 9, 9, 9], "NY", FOOD_CPI)).toBeCloseTo(1_620, 9);
  });

  it("prices F at the CPI food at home now", () => {
    expect(foodPlanCost(TEST, [40, 38, 7], "NY", FOOD_CPI * 1.1)).toBeCloseTo(1_100, 9);
  });

  it("scales F by the state's Thrifty cost ÷ the US Thrifty cost for an Alaska or Hawaii ZIP code", () => {
    // Thrifty adults: US $300, Alaska $390, Hawaii $360; the child is $200 in each.
    expect(foodPlanCost(TEST, [40, 38, 7], "AK", FOOD_CPI)).toBeCloseTo((1_000 * 980) / 800, 9);
    expect(foodPlanCost(TEST, [40, 38, 7], "HI", FOOD_CPI)).toBeCloseTo((1_000 * 920) / 800, 9);
  });

  it("prices the Alaska and US Thrifty costs at one month when their months differ", () => {
    // Alaska's plan is from an earlier month, when food at home cost 10% less: its costs then are
    // worth 10/9 as much at the US plan's month.
    const earlierAlaska = withSnapshot((changed) => {
      changed.food.thrifty.alaska.month = "2026-03";
      changed.food.thrifty.alaska.pricedAt = {
        series: "CUUR0000SAF11",
        period: "2026-03",
        value: FOOD_CPI * 0.9,
      };
    });

    expect(foodPlanCost(earlierAlaska, [40, 38, 7], "AK", FOOD_CPI)).toBeCloseTo(
      (1_000 * 980) / 800 / 0.9,
      9,
    );
  });
});

describe("which Categories have a Benchmark", () => {
  const ROLES: Record<CategoryBenchmark["role"], Category[]> = {
    drafts: [
      "Clothing",
      "Home and garden",
      "Alcohol and tobacco",
      "Gas",
      "Car",
      "Transit and rideshare",
      "Health",
      "Personal care",
      "Childcare",
      "Pets",
      "Fitness",
      "Restaurants",
      "Entertainment",
      "Hobbies",
      "Books and education",
    ],
    "drafts shared": ["Groceries", "Superstores"],
    context: ["Housing", "Utilities", "Phone and internet", "Insurance"],
    none: [
      "Taxes and government",
      "Interest and fees",
      "Travel",
      "General goods",
      "Gifts and donations",
      "Services",
      "Cash",
      "Payments to people",
      "Miscellaneous",
    ],
  };

  it("gives every Category its role from the spec's table, and no Benchmark to the ones with none", () => {
    const filled = withSnapshot((changed) => {
      for (const { table } of changed.ce.bySizeAndIncome) {
        for (const each of table.columns) {
          for (const line of CE_LINES) each.lines[line] = 1_000;
        }
      }
    });
    const { categories } = compute({}, filled);

    expect(categories.map(({ category }) => category)).toEqual(CATEGORIES.map(({ name }) => name));
    for (const [role, names] of Object.entries(ROLES)) {
      for (const name of names) {
        const benchmark = categories.find(({ category }) => category === name);
        expect(benchmark?.role, name).toBe(role);
        if (role === "none") expect(benchmark?.amount, name).toBeNull();
        else expect(benchmark?.amount, name).toBeGreaterThan(0);
      }
    }
    expect(Object.values(ROLES).flat()).toHaveLength(CATEGORIES.length);
  });
});

describe("the CE notes", () => {
  it("stores the Housing and Car notes as text for the AI, and gives no other Category one", () => {
    expect(CE_NOTES.Housing).toContain("mortgage principal");
    expect(CE_NOTES.Car).toContain("financed car at its full price");
    const withNote = compute().categories.filter(({ ceNote }) => ceNote !== null);
    expect(withNote.map(({ category, ceNote }) => [category, ceNote])).toEqual([
      ["Housing", CE_NOTES.Housing],
      ["Car", CE_NOTES.Car],
    ]);
  });
});

describe("the context line for a Bills Budget", () => {
  const housing: CategoryBenchmark = {
    category: "Housing",
    role: "context",
    amount: 198_000,
    share: 0.33,
    ceNote: CE_NOTES.Housing ?? null,
  };

  it("compares the Budget and the Benchmark with I", () => {
    expect(benchmarkContextLine(housing, 246_000, 600_000)).toBe(
      "Housing is 41% of Income; typical is 33%",
    );
  });

  it("is shown only for a context Benchmark, and not with I at $0", () => {
    expect(benchmarkContextLine({ ...housing, amount: null }, 246_000, 600_000)).toBeUndefined();
    expect(benchmarkContextLine({ ...housing, role: "drafts" }, 246_000, 600_000)).toBeUndefined();
    expect(benchmarkContextLine(housing, 246_000, 0)).toBeUndefined();
  });
});

describe("the Benchmarks for the Household now", () => {
  let test: TestDatabase;
  const memberId = "member-a";
  const now = new Date("2026-11-04T12:00:00Z");

  beforeEach(async () => {
    test = await newTestDatabase();
    await test.database.insert(loginTables.user).values({
      id: memberId,
      name: "Alice",
      email: "alice@example.com",
      createdAt: now,
      updatedAt: now,
    });
    await typeSteadyIncome(test.database, 600_000, memberId, now);
  });

  afterEach(() => {
    test.close();
  });

  const saveFacts = (facts: Partial<HouseholdFactsInput> = {}) =>
    saveHouseholdFacts(
      test.database,
      { zipCode: "10001", ages: [40, 38, 7], rentOrOwn: "rent", ...facts },
      memberId,
      now,
    );
  const foodNow = async () => (await categoryBenchmarks(test.database, now, TEST))?.food;

  it("has none until the wizard records the Household facts", async () => {
    expect(await categoryBenchmarks(test.database, now, TEST)).toBeUndefined();
  });

  it("reads Steady Income and the facts", async () => {
    await saveFacts();

    expect(await categoryBenchmarks(test.database, now, TEST)).toEqual(compute());
  });

  it("applies the Alaska rule to an Alaska ZIP code and the Hawaii rule to a Hawaii ZIP code", async () => {
    await saveFacts({ zipCode: "99501" });
    expect(await foodNow()).toBe(122_500);

    await saveFacts({ zipCode: "96813" });
    expect(await foodNow()).toBe(115_000);

    await saveFacts({ zipCode: "10001" });
    expect(await foodNow()).toBe(100_000);
  });

  it("changes B_GS when a newer CPI food at home is fetched", async () => {
    await saveFacts();
    await storeCpiValues(
      test.database,
      [{ series: "CUUR0000SAF11", month: "2026-10", value: FOOD_CPI * 1.02 }],
      now,
    );

    expect(await foodNow()).toBe(102_000);
  });
});
