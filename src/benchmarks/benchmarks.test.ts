import { describe, expect, it } from "vitest";
import { CATEGORIES } from "../categories/index.ts";
import {
  B_GS_CE_LINES,
  BENCHMARK_ROLES,
  type BenchmarkSnapshot,
  benchmarkNotice,
  benchmarkSnapshot,
  benchmarkSnapshotSchema,
  CE_LINE_MAP,
  type CeLine,
  ceLinesOf,
  SAMPLE_NOTICE,
} from "./index.ts";

// The Benchmark snapshot and the Category-to-CE-line map (spec 05, Benchmarks).

const withBenchmark = CATEGORIES.filter(({ name }) => BENCHMARK_ROLES[name] !== "none");

function everyColumn(snapshot: BenchmarkSnapshot) {
  return [snapshot.ce.byIncome, ...snapshot.ce.bySizeAndIncome.map(({ table }) => table)].flatMap(
    (table) => table.columns,
  );
}

describe("the Benchmark snapshot", () => {
  it("passes its schema", () => {
    expect(() => benchmarkSnapshotSchema.parse(benchmarkSnapshot())).not.toThrow();
  });

  it("holds the CE tables by income and by size × income, the food plans, and the CPI", () => {
    const { ce, food } = benchmarkSnapshot();

    expect(ce.bySizeAndIncome.map(({ size }) => size)).toEqual([1, 2, 3, 4, 5]);
    expect(String(ce.dataYear)).toBe(ce.byIncome.years);
    expect(food.moderate.plan).toBe("Moderate-Cost");
    expect(food.moderate.pricedAt.series).toBe("CUUR0000SAF11");
    expect(ce.byIncome.pricedAt.series).toBe("CUUR0000SA0");
    expect([food.thrifty.us, food.thrifty.alaska, food.thrifty.hawaii].map((p) => p.plan)).toEqual([
      "Thrifty",
      "Thrifty",
      "Thrifty",
    ]);
    expect(food.sizeAdjustment).toContainEqual({ fromSize: 1, toSize: 1, percent: 20 });
  });

  it("has a figure or a suppressed mark for every CE line the map uses, in every column", () => {
    for (const column of everyColumn(benchmarkSnapshot())) {
      for (const { name } of withBenchmark) {
        const choice = CE_LINE_MAP[name];
        for (const line of choice === undefined ? [] : ceLinesOf(choice)) {
          expect(column.lines, `${name}: ${line}`).toHaveProperty([line]);
        }
      }
    }
  });

  it("has the housekeeping supplies line for B_GS", () => {
    expect(B_GS_CE_LINES).toEqual(["Housekeeping supplies"]);
    for (const column of everyColumn(benchmarkSnapshot())) {
      expect(column.lines["Housekeeping supplies"]).toEqual(expect.any(Number));
    }
  });

  it("admits no agency but BLS, USDA, the Census Bureau, and NWS", () => {
    const snapshot = benchmarkSnapshot();
    const [source] = snapshot.sources;
    if (source === undefined) throw new Error("The snapshot has no sources.");

    for (const agency of [
      "Internal Revenue Service",
      "U.S. Department of Housing and Urban Development",
      "U.S. Department of Labor",
    ]) {
      const sources = [...snapshot.sources, { ...source, agency }];
      expect(benchmarkSnapshotSchema.safeParse({ ...snapshot, sources }).success).toBe(false);
    }
    expect(new Set(snapshot.sources.map(({ agency }) => agency))).toEqual(
      new Set([
        "Bureau of Labor Statistics",
        "U.S. Department of Agriculture",
        "U.S. Census Bureau",
        "National Weather Service",
      ]),
    );
  });

  it("holds no IRS, HUD, Census ACS, or DOL data", () => {
    const snapshot = benchmarkSnapshot();

    for (const extra of [
      { irsCollectionStandards: {} },
      { hudFairMarketRents: {} },
      { acs: {} },
      { dolChildcarePrices: {} },
    ]) {
      expect(benchmarkSnapshotSchema.safeParse({ ...snapshot, ...extra }).success).toBe(false);
    }
    expect(JSON.stringify(snapshot)).not.toMatch(
      /Internal Revenue|Collection Financial|Fair Market Rent|American Community Survey|Department of Labor|childcare price/i,
    );
  });
});

describe("the sample label", () => {
  it("labels every Benchmark of a sample snapshot as sample numbers", () => {
    const snapshot = benchmarkSnapshot();

    expect(benchmarkNotice({ ...snapshot, sample: true })).toBe("Sample numbers, not real data");
    expect(SAMPLE_NOTICE).toBe("Sample numbers, not real data");
  });

  it("gives a snapshot built from the real files no label", () => {
    expect(benchmarkNotice({ ...benchmarkSnapshot(), sample: false })).toBeUndefined();
  });

  it("labels the shipped snapshot while it is the sample", () => {
    const snapshot = benchmarkSnapshot();

    expect(benchmarkNotice()).toBe(snapshot.sample ? SAMPLE_NOTICE : undefined);
  });
});

describe("the Category-to-CE-line map", () => {
  it("gives CE lines to every Category that drafts from a Benchmark, or has a context line", () => {
    for (const { name } of withBenchmark) {
      const choice = CE_LINE_MAP[name];
      expect(choice, name).toBeDefined();
      if (choice === undefined) continue;
      expect(ceLinesOf(choice).length, name).toBeGreaterThan(0);
      if (choice.kind === "by tenure") {
        expect(choice.rent.length, name).toBeGreaterThan(0);
        expect(choice.own.length, name).toBeGreaterThan(0);
      }
    }
  });

  it("follows spec 05 for each Category's Benchmark", () => {
    const byRole = (role: string) =>
      CATEGORIES.filter(({ name }) => BENCHMARK_ROLES[name] === role).map(({ name }) => name);

    expect(byRole("drafts shared")).toEqual(["Groceries", "Superstores"]);
    expect(byRole("context")).toEqual(["Housing", "Utilities", "Phone and internet", "Insurance"]);
    expect(byRole("none").sort()).toEqual(
      [
        "Taxes and government",
        "Interest and fees",
        "Travel",
        "General goods",
        "Gifts and donations",
        "Services",
        "Cash",
        "Payments to people",
        "Miscellaneous",
      ].sort(),
    );
    expect(byRole("drafts")).toHaveLength(15);
  });

  it("drafts Groceries and Superstores from the food plan and the B_GS lines", () => {
    expect(CE_LINE_MAP.Groceries).toEqual({ kind: "food plan and lines", lines: B_GS_CE_LINES });
    expect(CE_LINE_MAP.Superstores).toEqual(CE_LINE_MAP.Groceries);
  });

  it("gives Personal care the joined personal care products and services row", () => {
    expect(CE_LINE_MAP["Personal care"]).toEqual({
      kind: "lines",
      lines: ["Personal care products and services"],
    });
  });

  it("gives Gas the gasoline and other fuels row", () => {
    expect(CE_LINE_MAP.Gas).toEqual({ kind: "lines", lines: ["Gasoline and other fuels"] });
  });

  it("takes rented dwellings for a renter's Housing and owned dwellings for an owner's", () => {
    expect(CE_LINE_MAP.Housing).toEqual({
      kind: "by tenure",
      rent: ["Rented dwellings"],
      own: ["Owned dwellings"],
    });
  });

  it("sums several CE lines for Travel and Insurance", () => {
    for (const name of ["Travel", "Insurance"] as const) {
      const choice = CE_LINE_MAP[name];
      expect(choice === undefined ? [] : ceLinesOf(choice), name).toHaveLength(
        name === "Travel" ? 2 : 3,
      );
    }
  });

  it("gives each CE line to at most one Category with a Benchmark", () => {
    const owners = new Map<CeLine, string>();
    for (const { name } of withBenchmark) {
      const choice = CE_LINE_MAP[name];
      // Groceries and Superstores share B_GS, so they count as one.
      const owner = choice?.kind === "food plan and lines" ? "B_GS" : name;
      for (const line of choice === undefined ? [] : ceLinesOf(choice)) {
        const known = owners.get(line);
        expect(known === undefined || known === owner, `${line}: ${known} and ${owner}`).toBe(true);
        owners.set(line, owner);
      }
    }
  });
});
