import * as z from "zod";
import { CE_LINES, type CeLine } from "./ce-lines.ts";
import { BENCHMARK_SNAPSHOT_DATA } from "./snapshot.data.ts";

// The Benchmark snapshot (spec 05, The shipped data). scripts/build-benchmark-snapshot.ts builds
// snapshot.data.ts from US federal public-domain files: the BLS Consumer Expenditure Survey (CE)
// tables, the USDA food plans, and the CPI each figure was priced at. The ZIP table it lists by
// its sources ships in the household module. v1 ships no IRS, HUD, Census ACS, or DOL data, so the
// schema admits no other agency.

// The shown label of a snapshot built from the made-up fixture files, not from the real tables.
export const SAMPLE_NOTICE = "Sample numbers, not real data";

const AGENCIES = [
  "Bureau of Labor Statistics",
  "U.S. Department of Agriculture",
  "U.S. Census Bureau",
  "National Weather Service",
] as const;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const sourceSchema = z.strictObject({
  agency: z.enum(AGENCIES),
  table: z.string().min(1),
  url: z.url({ protocol: /^https$/ }),
  // A day, a month, or the CE year or years, such as "2025" or "2023-2024".
  dataDate: z.string().regex(/^\d{4}(?:-\d{2}(?:-\d{2})?|-\d{4})?$/),
});

// A CPI-U value, US city average, not seasonally adjusted. The period is a month, such as
// "2026-09", or the CE year or years the value averages, such as "2025".
const cpiSchema = z.strictObject({
  series: z.enum(["CUUR0000SA0", "CUUR0000SAF11"]),
  period: z.string().regex(/^\d{4}(?:-(?:0[1-9]|1[0-2])|-\d{4})?$/),
  value: z.number().positive(),
});

const linesSchema = z.strictObject(
  Object.fromEntries(CE_LINES.map((line) => [line, z.number().nonnegative().nullable()])) as Record<
    CeLine,
    z.ZodNullable<z.ZodNumber>
  >,
);

// One income column of a CE table: its mean income after taxes, its mean total yearly Spending,
// and its mean yearly Spending on each CE line. A line BLS suppresses is null.
const ceColumnSchema = z.strictObject({
  label: z.string().min(1),
  incomeAfterTaxes: z.number(),
  totalSpending: z.number().positive(),
  lines: linesSchema,
});

const ceTableSchema = z.strictObject({
  title: z.string().min(1),
  years: z.string().regex(/^\d{4}(?:-\d{4})?$/),
  pricedAt: cpiSchema,
  columns: z.array(ceColumnSchema).min(1),
});

// One person's monthly cost in a food plan, for an age group and, where USDA splits by it, a sex.
// toAge is null for an open group, such as "71+ years".
const foodCostSchema = z.strictObject({
  age: z.string().min(1),
  fromAge: z.int().nonnegative(),
  toAge: z.int().nonnegative().nullable(),
  sex: z.enum(["male", "female"]).nullable(),
  monthly: z.number().positive(),
});

const foodPlanSchema = z.strictObject({
  plan: z.enum(["Moderate-Cost", "Thrifty"]),
  area: z.string().min(1),
  month: z.string().regex(MONTH),
  pricedAt: cpiSchema,
  costs: z.array(foodCostSchema).min(1),
});

// USDA's household-size adjustment: the percent to add to the sum of the people's costs, for a
// household of fromSize to toSize people. toSize is null for "or more".
const sizeAdjustmentSchema = z.strictObject({
  fromSize: z.int().positive(),
  toSize: z.int().positive().nullable(),
  percent: z.number(),
});

export const benchmarkSnapshotSchema = z.strictObject({
  // True when the release script built the snapshot from the made-up fixture files.
  sample: z.boolean(),
  ce: z.strictObject({
    // The year of the one-year income table, the CE data year.
    dataYear: z.int().min(2000),
    byIncome: ceTableSchema,
    // The size × income tables: one person, two, three, four, and five or more.
    bySizeAndIncome: z
      .array(z.strictObject({ size: z.int().min(1).max(5), table: ceTableSchema }))
      .length(5),
  }),
  food: z.strictObject({
    moderate: foodPlanSchema,
    thrifty: z.strictObject({ us: foodPlanSchema, alaska: foodPlanSchema, hawaii: foodPlanSchema }),
    sizeAdjustment: z.array(sizeAdjustmentSchema).min(1),
  }),
  sources: z.array(sourceSchema).min(1),
});

export type BenchmarkSnapshot = z.infer<typeof benchmarkSnapshotSchema>;
export type BenchmarkSource = z.infer<typeof sourceSchema>;
export type CeTable = z.infer<typeof ceTableSchema>;
export type FoodPlan = z.infer<typeof foodPlanSchema>;

let parsed: BenchmarkSnapshot | undefined;

// The shipped snapshot, checked against its schema.
export function benchmarkSnapshot(): BenchmarkSnapshot {
  parsed ??= benchmarkSnapshotSchema.parse(BENCHMARK_SNAPSHOT_DATA);
  return parsed;
}

// The label every Benchmark the app shows must carry: SAMPLE_NOTICE for a sample snapshot, so the
// app never shows made-up numbers as real ones. Undefined for a snapshot built from the real files.
export function benchmarkNotice(snapshot: BenchmarkSnapshot = benchmarkSnapshot()) {
  return snapshot.sample ? SAMPLE_NOTICE : undefined;
}
