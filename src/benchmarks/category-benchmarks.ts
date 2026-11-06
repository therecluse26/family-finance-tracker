import { CATEGORIES, type Category } from "../categories/index.ts";
import type { Database } from "../db/index.ts";
import { readHouseholdFacts } from "../household/index.ts";
import { steadyIncome } from "../recurring/index.ts";
import {
  B_GS_CE_LINES,
  BENCHMARK_ROLES,
  type BenchmarkRole,
  CE_LINE_MAP,
  type CeLine,
  type CeLineChoice,
} from "./ce-lines.ts";
import { cpiNow } from "./cpi.ts";
import {
  type BenchmarkSnapshot,
  benchmarkSnapshot,
  type CeTable,
  type FoodPlan,
  type ThriftyPlan,
} from "./snapshot.ts";

// Each Category's Benchmark (spec 05, The Benchmark for a Category, and The Groceries and
// Superstores Benchmark). A Benchmark is a share of Steady Income: the CE column for similar
// households gives the share, and B(c) = s(c) × I. Shares are ratios, so the CE figures need no
// CPI aging. Groceries and Superstores share B_GS, which adds the USDA Moderate-Cost food plan for
// the Household's people, priced at the CPI food at home now.

// The column every CE table keeps beside its income columns: "All consumer units" in the table by
// income, and "Total one person" to "Total five or more people" in the size tables. It is no income
// column, so the pick skips it.
const ALL_UNITS_COLUMN = /^(?:All consumer units|Total\b)/i;

// The largest size × income table: five or more people.
const LARGEST_CE_SIZE = 5;

// What CE leaves out or counts in a way the Household's Spending does not, so Housing and Car
// Spending can sit above their Benchmarks for this reason alone (spec 05, Context for Bills
// Budgets). The app gives the AI this text with any Housing or Car comparison.
export const CE_NOTES: Readonly<Partial<Record<Category, string>>> = Object.freeze({
  Housing:
    "CE leaves mortgage principal out, as a reduction of debt. So Housing Spending can sit above its Benchmark for this reason alone.",
  Car: "CE counts a financed car at its full price in the year of purchase. So Car Spending can sit above its Benchmark for this reason alone.",
});

// The facts a Benchmark reads. Ages and the state never leave the server.
export type BenchmarkInputs = {
  // I, in whole cents per month.
  income: number;
  // Each person's age, in years.
  ages: readonly number[];
  rentOrOwn: "rent" | "own";
  // The ZIP code's state, such as "NY".
  state: string;
  // The CPI food at home now.
  foodAtHomeNow: number;
};

// The CE column a Household's Benchmarks come from: one income column of the size × income table
// for its size, or of the one-year income table.
export type CeColumnPick = { table: "size and income" | "income"; label: string };

export type CategoryBenchmark = {
  category: Category;
  role: BenchmarkRole;
  // B(c), in whole cents per month, or null when the Category has no Benchmark.
  amount: number | null;
  // B(c) ÷ I, or null with no Benchmark or with I at $0.
  share: number | null;
  // The CE note the AI gets with any comparison for this Category, or null.
  ceNote: string | null;
  // True for Housing in a Household that rents (spec 05, Context for Bills Budgets). It has no
  // Benchmark, and its context line shows the Budget's share of Income with no typical figure.
  shareOnly: boolean;
};

export type CategoryBenchmarks = {
  // I, in whole cents per month.
  income: number;
  ceColumn: CeColumnPick;
  // F, the food plan part of B_GS, in whole cents per month.
  food: number;
  categories: CategoryBenchmark[];
};

type CeColumn = CeTable["columns"][number];

const incomeColumns = (table: CeTable) =>
  table.columns.filter(({ label }) => !ALL_UNITS_COLUMN.test(label));

// Step 1: the income column whose mean income before taxes is nearest the Household's yearly
// Income, I × 12, in the size × income table for its size. With no column for the size, the
// one-year income table.
function pickCeColumn(
  snapshot: BenchmarkSnapshot,
  people: number,
  yearlyIncome: number,
): { pick: CeColumnPick; column: CeColumn } {
  const size = Math.min(people, LARGEST_CE_SIZE);
  const bySize = snapshot.ce.bySizeAndIncome.find((entry) => entry.size === size)?.table;
  const sized = bySize === undefined ? [] : incomeColumns(bySize);
  const table = sized.length > 0 ? "size and income" : "income";
  const columns = sized.length > 0 ? sized : incomeColumns(snapshot.ce.byIncome);
  let nearest: CeColumn | undefined;
  for (const column of columns) {
    const distance = Math.abs(column.incomeBeforeTaxes - yearlyIncome);
    if (nearest === undefined || distance < Math.abs(nearest.incomeBeforeTaxes - yearlyIncome)) {
      nearest = column;
    }
  }
  if (nearest === undefined) throw new Error("The CE table by income has no income column.");
  return { pick: { table, label: nearest.label }, column: nearest };
}

// Step 2: s = the column's mean yearly Spending on the lines ÷ its mean total yearly Spending. A
// line BLS suppresses counts as 0, unless it suppresses every line, when there is no share.
function shareOf(column: CeColumn, lines: readonly CeLine[]): number | null {
  const figures = lines.map((line) => column.lines[line]);
  if (figures.every((figure) => figure === null)) return null;
  const spent = figures.reduce<number>((sum, figure) => sum + (figure ?? 0), 0);
  return spent / column.totalSpending;
}

// One person's monthly cost in a plan. Where USDA splits by sex, the mean of the male and female
// costs. A child under 1 uses the 1-year cost.
function personCost(plan: FoodPlan, age: number): number | undefined {
  const planAge = Math.max(age, 1);
  const costs = plan.costs.filter(
    ({ fromAge, toAge }) => fromAge <= planAge && (toAge === null || planAge <= toAge),
  );
  if (costs.length === 0) return undefined;
  return costs.reduce((sum, { monthly }) => sum + monthly, 0) / costs.length;
}

// The sum of the people's costs in a plan, in dollars per month, at the plan's month.
function peopleCost(plan: FoodPlan, ages: readonly number[]): number {
  let sum = 0;
  for (const age of ages) {
    const cost = personCost(plan, age);
    if (cost === undefined) throw new Error(`The ${plan.plan} food plan has no cost for an age.`);
    sum += cost;
  }
  return sum;
}

// USDA's household-size adjustment, as a factor.
function sizeFactor(snapshot: BenchmarkSnapshot, people: number): number {
  const adjustment = snapshot.food.sizeAdjustment.find(
    ({ fromSize, toSize }) => fromSize <= people && (toSize === null || people <= toSize),
  );
  return 1 + (adjustment?.percent ?? 0) / 100;
}

// The Alaska and Hawaii food rule: that state's Thrifty cost ÷ the US Thrifty cost, for USDA's
// reference family, the only family USDA prices the state plans for. The plans may be from
// different months, so each cost is first divided by the CPI food at home in its own plan's month,
// which prices both at one month.
const STATE_THRIFTY = { AK: "alaska", HI: "hawaii" } as const;

function stateFactor(snapshot: BenchmarkSnapshot, state: string): number {
  const area = state === "AK" || state === "HI" ? STATE_THRIFTY[state] : undefined;
  if (area === undefined) return 1;
  const { us, [area]: statePlan } = snapshot.food.thrifty;
  const atOneMonth = (plan: ThriftyPlan) => plan.family.monthly / plan.pricedAt.value;
  return atOneMonth(statePlan) / atOneMonth(us);
}

// F, in dollars per month: the people's Moderate-Cost costs, summed, with USDA's household-size
// adjustment, × the CPI food at home now ÷ the CPI food at home in the plan's month, and for an
// Alaska or Hawaii ZIP code × that state's Thrifty cost ÷ the US Thrifty cost.
export function foodPlanCost(
  snapshot: BenchmarkSnapshot,
  ages: readonly number[],
  state: string,
  foodAtHomeNow: number,
): number {
  const { moderate } = snapshot.food;
  return (
    peopleCost(moderate, ages) *
    sizeFactor(snapshot, ages.length) *
    (foodAtHomeNow / moderate.pricedAt.value) *
    stateFactor(snapshot, state)
  );
}

// A Household that rents has no Housing Benchmark (spec 05, Context for Bills Budgets). The CE mean
// for rented dwellings is an average over all households, owners included, so it reads far too low
// for a renter.
const rentedHousing = (choice: CeLineChoice | undefined, rentOrOwn: "rent" | "own") =>
  choice?.kind === "by tenure" && rentOrOwn === "rent";

function linesOf(choice: CeLineChoice): readonly CeLine[] {
  return choice.kind === "by tenure" ? choice.own : choice.lines;
}

const toCents = (dollars: number) => Math.round(dollars * 100);

// Every Category's Benchmark and role, from the facts and the snapshot.
export function computeCategoryBenchmarks(
  inputs: BenchmarkInputs,
  snapshot: BenchmarkSnapshot = benchmarkSnapshot(),
): CategoryBenchmarks {
  const { income, ages, rentOrOwn, state, foodAtHomeNow } = inputs;
  const { pick, column } = pickCeColumn(snapshot, ages.length, (income * 12) / 100);
  const food = toCents(foodPlanCost(snapshot, ages, state, foodAtHomeNow));
  const gsShare = shareOf(column, B_GS_CE_LINES);
  const bGs = food + Math.round((gsShare ?? 0) * income);

  const categories = CATEGORIES.map(({ name }): CategoryBenchmark => {
    const role = BENCHMARK_ROLES[name];
    const choice = CE_LINE_MAP[name];
    const shareOnly = rentedHousing(choice, rentOrOwn);
    let amount: number | null = null;
    if (role === "drafts shared") {
      amount = bGs;
    } else if (role !== "none" && choice !== undefined && !shareOnly) {
      const share = shareOf(column, linesOf(choice));
      amount = share === null ? null : Math.round(share * income);
    }
    return {
      category: name,
      role,
      amount,
      share: amount === null || income <= 0 ? null : amount / income,
      // With no Benchmark there is no comparison, so the AI gets no CE note either.
      ceNote: shareOnly ? null : (CE_NOTES[name] ?? null),
      shareOnly,
    };
  });
  return { income, ceColumn: pick, food, categories };
}

// Every Category's Benchmark for the Household now: its facts, Steady Income, and the newest CPI
// food at home. Undefined until the wizard records the Household facts.
export async function categoryBenchmarks(
  database: Database,
  now = new Date(),
  snapshot: BenchmarkSnapshot = benchmarkSnapshot(),
): Promise<CategoryBenchmarks | undefined> {
  const facts = await readHouseholdFacts(database);
  if (facts === undefined) return undefined;
  const income = await steadyIncome(database, now);
  const foodAtHome = await cpiNow(database, "CUUR0000SAF11", snapshot);
  return computeCategoryBenchmarks(
    {
      income: income.amount,
      ages: facts.ages,
      rentOrOwn: facts.rentOrOwn,
      state: facts.state,
      foodAtHomeNow: foodAtHome.value,
    },
    snapshot,
  );
}

const percent = (part: number, whole: number) => Math.round((part / whole) * 100);

// The context line a Bills Budget with a Benchmark shows (spec 05, Context for Bills Budgets):
// "<Category> is X% of Income; typical is Y%", X = the Budget ÷ I and Y = B(c) ÷ I. Housing in a
// Household that rents shows "Housing is X% of Income", with no typical figure. Undefined for any
// other Category, or with I at $0. The Budget is in whole cents per month.
export function benchmarkContextLine(
  benchmark: CategoryBenchmark,
  budget: number,
  income: number,
): string | undefined {
  if (benchmark.role !== "context" || income <= 0) return undefined;
  const line = `${benchmark.category} is ${percent(budget, income)}% of Income`;
  if (benchmark.shareOnly) return line;
  if (benchmark.amount === null) return undefined;
  return `${line}; typical is ${percent(benchmark.amount, income)}%`;
}
