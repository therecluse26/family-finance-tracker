import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BENCHMARK_SNAPSHOT_DATA } from "../src/benchmarks/snapshot.data.ts";
import { benchmarkSnapshot } from "../src/benchmarks/snapshot.ts";
import { ZIP_TABLE_DATA } from "../src/household/zip-table.data.ts";
import {
  buildBenchmarkSnapshot,
  checkFoodPlanState,
  checkSizeAdjustment,
  parseCeTable,
  parseCpi,
  parseFoodPlan,
  releaseProblem,
  renderDataSources,
  SOURCE_FILES,
} from "./benchmark-snapshot.ts";
import { readFixture } from "./fixtures/benchmarks/fixtures.ts";
import { makeXlsx } from "./fixtures/benchmarks/make-xlsx.ts";
import { readXlsx } from "./xlsx.ts";

// The Benchmark snapshot build, on the made-up fixture files. No test reads a real source file or
// makes a network request.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TITLE = "Income before taxes: Annual expenditure means, Consumer Expenditure Surveys, 2025";

// A small CE table with every row the map needs, each at `value` in both columns.
function ceSheet(value: number, drop: string[] = []): string[][] {
  const lines = [
    "Food away from home",
    "Alcoholic beverages",
    "Tobacco products and smoking supplies",
    "Owned dwellings",
    "Rented dwellings",
    "Other lodging",
    "Natural gas",
    "Electricity",
    "Fuel oil and other fuels",
    "Water and other public services",
    "Telephone services",
    "Personal services",
    "Other household expenses",
    "Housekeeping supplies",
    "Household furnishings and equipment",
    "Apparel and services",
    "Gasoline, other fuels, and motor oil",
    "Maintenance and repairs",
    "Vehicle rental, leases, licenses, and other charges",
    "Vehicle insurance",
    "Public and other transportation",
    "Health insurance",
    "Medical services",
    "Drugs",
    "Medical supplies",
    "Fees and admissions",
    "Audio and visual equipment and services",
    "Pets",
    "Toys, hobbies, and playground equipment",
    "Other entertainment supplies, equipment, and services",
    "Personal care products",
    "Personal care services",
    "Reading",
    "Education",
    "Life and other personal insurance",
  ].filter((line) => !drop.includes(line));
  return [
    [TITLE],
    ["Item", "All", "Less than", "$100,000"],
    ["", "consumer units", "$100,000", "and more"],
    ["Income after taxes"],
    ["Mean", "70,000", "40000", "b/"],
    ["SE", "700", "400", "900"],
    ["Average annual expenditures"],
    ["Mean", "60000", "45000", "90000"],
    ...lines.flatMap((line) => [[line], ["Mean", String(value), String(value), String(value)]]),
  ];
}

describe("the CE table parser", () => {
  it("reads each column's income after taxes, total, and CE lines by their labels", () => {
    const table = parseCeTable(ceSheet(10), "ce.xlsx");

    expect(table.title).toBe(TITLE);
    expect(table.years).toBe("2025");
    expect(table.columns.map(({ label }) => label)).toEqual([
      "All consumer units",
      "Less than $100,000",
    ]);
    expect(table.columns[0]).toMatchObject({ incomeAfterTaxes: 70000, totalSpending: 60000 });
    expect(table.columns[0]?.lines["Personal care products"]).toBe(10);
  });

  it("leaves out a column whose income after taxes BLS suppresses", () => {
    const table = parseCeTable(ceSheet(10), "ce.xlsx");

    expect(table.columns.map(({ label }) => label)).not.toContain("$100,000 and more");
  });

  it("matches a label with a footnote mark or a closing colon", () => {
    const sheet = ceSheet(10).map((row) =>
      row[0] === "Pets" ? ["Pets 2/"] : row[0] === "Drugs" ? ["Drugs (3):"] : row,
    );

    expect(parseCeTable(sheet, "ce.xlsx").columns[0]?.lines.Pets).toBe(10);
    expect(parseCeTable(sheet, "ce.xlsx").columns[0]?.lines.Drugs).toBe(10);
  });

  it("keeps a figure BLS suppresses in a CE line as null", () => {
    const sheet = ceSheet(10).map((row, at, rows) =>
      rows[at - 1]?.[0] === "Reading" ? ["Mean", "5", "b/", "5"] : row,
    );

    expect(parseCeTable(sheet, "ce.xlsx").columns[1]?.lines.Reading).toBeNull();
  });

  it("fails naming every row it cannot find", () => {
    const sheet = ceSheet(10, ["Housekeeping supplies", "Personal care products"]);

    expect(() => parseCeTable(sheet, "ce-size-2-by-income.xlsx")).toThrow(
      'ce-size-2-by-income.xlsx: it has no figures for these rows: "Housekeeping supplies", "Personal care products".',
    );
  });

  it("fails on a table with no Item header or no survey year", () => {
    const noHeader = ceSheet(10).filter((row) => row[0] !== "Item");
    const noYear = ceSheet(10).map((row) => (row[0] === TITLE ? ["Income before taxes"] : row));

    expect(() => parseCeTable(noHeader, "a.xlsx")).toThrow(
      'a.xlsx: it has no header row starting with "Item".',
    );
    expect(() => parseCeTable(noYear, "b.xlsx")).toThrow(
      "b.xlsx: its title names no Consumer Expenditure Surveys year.",
    );
  });

  it("fails when a label appears twice with different figures", () => {
    const sheet = [...ceSheet(10), ["Pets"], ["Mean", "1", "1", "1"]];

    expect(() => parseCeTable(sheet, "ce.xlsx")).toThrow(
      'ce.xlsx: it has more than one "Pets" row, with different figures.',
    );
  });
});

const README =
  "The costs given are for individuals in 4-person households. For individuals in other size households, the following adjustments for economies of scale are suggested: 1-person—add 20 percent; 2-person—add 10 percent; 3-person—add 5 percent; 4-person—no adjustment; 5- or 6-person—subtract 5 percent; 7- (or more) person—subtract 10 percent.";
const FOOD_HEADER = [
  "geographic_area",
  "fam_indv",
  "group",
  "age",
  "year",
  "month",
  "food_plan",
  "frequency",
  "cost",
];

// A monthly US average Thrifty cost for an individual, in September 2026.
function september(group: string, age: string, cost: string): string[] {
  return [
    "U.S. average",
    "Individual",
    group,
    age,
    "2026",
    "September",
    "Thrifty",
    "Monthly",
    cost,
  ];
}

// With the 1-year, 19-50 male, and 71+ female groups, these cover every age for both sexes.
const OTHER_AGES = [
  september("Child", "2-18 years", "200.0"),
  september("Male", "51+ years", "290.0"),
  september("Female", "19-70 years", "260.0"),
];

function foodSheets(rows: string[][], readMe = README) {
  return readXlsx(
    makeXlsx([
      { name: "ReadMe", rows: [[readMe]] },
      { name: "Data", rows: [FOOD_HEADER, ...rows] },
    ]),
  );
}

describe("the USDA food plan parser", () => {
  it("reads the latest month's monthly cost per person, by age group and sex", () => {
    const sheets = foodSheets([
      [
        "U.S. average",
        "Individual",
        "Male",
        "19-50 years",
        "2026",
        "August",
        "Thrifty",
        "Monthly",
        "300.0",
      ],
      [
        "U.S. average",
        "Individual",
        "Male",
        "19-50 years",
        "2026",
        "September",
        "Thrifty",
        "Monthly",
        "310.5",
      ],
      [
        "U.S. average",
        "Individual",
        "Male",
        "19-50 years",
        "2026",
        "September",
        "Thrifty",
        "Weekly",
        "71.7",
      ],
      [
        "U.S. average",
        "Individual",
        "Female",
        "71+ years",
        "2026",
        "September",
        "Thrifty",
        "Monthly",
        "250.0",
      ],
      ["U.S. average", "Individual", "Child", "1 year", "2026", "9", "Thrifty", "Monthly", "150.0"],
      [
        "U.S. average",
        "Family",
        "Family of 4",
        "6-8 and 9-11",
        "2026",
        "September",
        "Thrifty",
        "Monthly",
        "999.9",
      ],
      ...OTHER_AGES,
    ]);

    expect(parseFoodPlan(sheets, "t.xlsx", "Thrifty")).toEqual({
      plan: "Thrifty",
      area: "U.S. average",
      month: "2026-09",
      costs: [
        { age: "19-50 years", fromAge: 19, toAge: 50, sex: "male", monthly: 310.5 },
        { age: "71+ years", fromAge: 71, toAge: null, sex: "female", monthly: 250 },
        { age: "1 year", fromAge: 1, toAge: 1, sex: null, monthly: 150 },
        { age: "2-18 years", fromAge: 2, toAge: 18, sex: null, monthly: 200 },
        { age: "51+ years", fromAge: 51, toAge: null, sex: "male", monthly: 290 },
        { age: "19-70 years", fromAge: 19, toAge: 70, sex: "female", monthly: 260 },
      ],
    });
  });

  it.each([
    ["a gap between two groups", "Child", "2-18 years", "a male aged 2"],
    ["no open group at the end", "Male", "51+ years", "a male aged 51"],
    ["a group for one sex only", "Female", "19-70 years", "a female aged 19"],
  ])("fails when the age groups leave an age out: %s", (_, group, age, who) => {
    const sheets = foodSheets([
      september("Male", "19-50 years", "310.5"),
      september("Female", "71+ years", "250.0"),
      september("Child", "1 year", "150.0"),
      ...OTHER_AGES.filter((row) => row[2] !== group || row[3] !== age),
    ]);

    expect(() => parseFoodPlan(sheets, "t.xlsx", "Thrifty")).toThrow(
      `t.xlsx: its 2026-09 costs have no age group for ${who}.`,
    );
  });

  it("fails when the Alaska and Hawaii files are swapped", () => {
    const plan = (area: string) =>
      foodSheets([
        [area, "Individual", "Child", "1+ years", "2026", "9", "Thrifty", "Monthly", "1"],
      ]);
    const alaska = plan("Alaska");
    const hawaii = plan("Hawaii");
    const check = (sheets: typeof alaska, state: "Alaska" | "Hawaii") =>
      checkFoodPlanState(sheets, parseFoodPlan(sheets, "f.xlsx", "Thrifty"), "f.xlsx", state);

    expect(() => check(alaska, "Alaska")).not.toThrow();
    expect(() => check(hawaii, "Hawaii")).not.toThrow();
    expect(() => check(hawaii, "Alaska")).toThrow(
      'f.xlsx: it is not the Alaska food plan: its costs are for "Hawaii". Check that the Alaska and Hawaii files are not swapped.',
    );
    expect(() => check(alaska, "Hawaii")).toThrow("f.xlsx: it is not the Hawaii food plan");
    // A file that names neither state, such as a US average file saved under the Alaska name.
    expect(() => check(foodSheets([september("Child", "1+ years", "1")]), "Alaska")).toThrow(
      "f.xlsx: it is not the Alaska food plan",
    );
  });

  it("fails when the latest month covers more than one area", () => {
    const sheets = foodSheets([
      [
        "Anchorage",
        "Individual",
        "Child",
        "1 year",
        "2026",
        "September",
        "Thrifty",
        "Monthly",
        "1",
      ],
      ["Rural", "Individual", "Child", "1 year", "2026", "September", "Thrifty", "Monthly", "2"],
    ]);

    expect(() => parseFoodPlan(sheets, "ak.xlsx", "Thrifty")).toThrow(
      "ak.xlsx: its 2026-09 costs cover more than one area: Anchorage, Rural.",
    );
  });

  it("fails when the ReadMe no longer gives USDA's household-size adjustment", () => {
    const sheets = foodSheets([], README.replace("add 20 percent", "add 25 percent"));

    expect(() => checkSizeAdjustment(sheets, "m.xlsx")).toThrow(
      'm.xlsx: its ReadMe no longer says "1-person—add 20 percent".',
    );
    expect(() => checkSizeAdjustment(foodSheets([]), "m.xlsx")).not.toThrow();
  });

  it("fails when no sheet has the food plan columns", () => {
    const sheets = readXlsx(makeXlsx([{ name: "Data", rows: [["area", "cost"]] }]));

    expect(() => parseFoodPlan(sheets, "m.xlsx", "Moderate-Cost")).toThrow(
      "m.xlsx: no sheet has the columns",
    );
  });
});

function cpiAnswer(series: string, months: [string, string, string][]) {
  return JSON.stringify({
    status: "REQUEST_SUCCEEDED",
    Results: {
      series: [
        {
          seriesID: series,
          data: months.map(([year, period, value]) => ({ year, period, value })),
        },
      ],
    },
  });
}

describe("the CPI parser", () => {
  it("reads each month's value of the series", () => {
    const text = cpiAnswer("CUUR0000SA0", [
      ["2026", "M09", "330.123"],
      ["2026", "M13", "999"],
    ]);

    expect(parseCpi(text, "cpi.json", "CUUR0000SA0")).toEqual(new Map([["2026-09", 330.123]]));
  });

  it("fails on another series, or an answer with no data", () => {
    const text = cpiAnswer("CUUR0000SAF11", []);

    expect(() => parseCpi(text, "cpi.json", "CUUR0000SA0")).toThrow(
      "cpi.json: it does not hold the series CUUR0000SA0.",
    );
    expect(() => parseCpi('{"status":"REQUEST_NOT_PROCESSED"}', "cpi.json", "x")).toThrow(
      "cpi.json: BLS did not answer the request with data.",
    );
    expect(() => parseCpi("<html>", "cpi.json", "x")).toThrow("not a BLS API answer");
  });
});

describe("the snapshot build", () => {
  it("builds the shipped snapshot from the source files", () => {
    const built = buildBenchmarkSnapshot(readFixture, ZIP_TABLE_DATA.sources, true);

    expect(built).toEqual(BENCHMARK_SNAPSHOT_DATA);
  });

  it("prices each CE table at the mean CPI over its years, and each food plan at its month", () => {
    const { ce, food } = buildBenchmarkSnapshot(readFixture, [], true);
    // The fixture CPI for all items is 300 + 12 × (year - 2023) + month.
    const mean2025 = 300 + 24 + 6.5;

    expect(ce.byIncome.pricedAt).toEqual({
      series: "CUUR0000SA0",
      period: "2025",
      value: mean2025,
    });
    expect(ce.bySizeAndIncome[0]?.table.pricedAt.value).toBe(300 + 6 + 6.5);
    expect(food.moderate.pricedAt).toEqual({
      series: "CUUR0000SAF11",
      period: "2026-09",
      value: 290 + 36 + 9,
    });
  });

  it("fails naming the CPI months a table's years need and the file lacks", () => {
    const read = (key: keyof typeof SOURCE_FILES) =>
      key === "cpiAllItems"
        ? new TextEncoder().encode(cpiAnswer("CUUR0000SA0", [["2025", "M01", "1"]]))
        : readFixture(key);

    expect(() => buildBenchmarkSnapshot(read, [], true)).toThrow(
      "cpi-all-items.json: it has no CUUR0000SA0 value for 2025-02,",
    );
  });

  it("marks a snapshot from the real files as no sample", () => {
    expect(buildBenchmarkSnapshot(readFixture, [], false).sample).toBe(false);
  });

  it.each(["ceSize3", "thriftyAlaska"] as const)(
    "fails naming %s when its download is an error page, not an .xlsx",
    (key) => {
      const read = (wanted: keyof typeof SOURCE_FILES) =>
        wanted === key ? new TextEncoder().encode(ACCESS_DENIED) : readFixture(wanted);

      expect(() => buildBenchmarkSnapshot(read, [], false)).toThrow(
        `${SOURCE_FILES[key].file}: it is not a real .xlsx or .zip file. The download may be an error page, such as "Access Denied"`,
      );
    },
  );

  it("fails when the Alaska and Hawaii files are saved under each other's names", () => {
    const read = (key: keyof typeof SOURCE_FILES) =>
      readFixture(
        key === "thriftyAlaska" ? "thriftyHawaii" : key === "thriftyHawaii" ? "thriftyAlaska" : key,
      );

    expect(() => buildBenchmarkSnapshot(read, [], false)).toThrow(
      "usda-thrifty-alaska.xlsx: it is not the Alaska food plan",
    );
  });
});

// What a .gov site may send in place of a file to a download it refuses.
const ACCESS_DENIED =
  "<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY>You don't have permission to access this file.</BODY></HTML>";

describe("the release check", () => {
  it("fails on a sample snapshot and passes one built from the real files", () => {
    const snapshot = benchmarkSnapshot();

    expect(releaseProblem({ ...snapshot, sample: true })).toContain(
      "sample numbers, not real data",
    );
    expect(releaseProblem({ ...snapshot, sample: false })).toBeUndefined();
  });

  it("fails `pnpm check:benchmarks` while the shipped snapshot is the sample", () => {
    const run = spawnSync("node", ["scripts/check-benchmark-snapshot.ts"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    const problem = releaseProblem(benchmarkSnapshot());

    // The check's own words, so a check that crashes, or passes everything, fails this test.
    expect({ status: run.status, stdout: run.stdout, stderr: run.stderr }).toEqual(
      problem === undefined
        ? {
            status: 0,
            stdout: "The Benchmark snapshot was built from the real source files.\n",
            stderr: "",
          }
        : { status: 1, stdout: "", stderr: `${problem}\n` },
    );
  });
});

describe("the release script", () => {
  it("fails naming every source file the folder lacks", () => {
    const folder = mkdtempSync(join(tmpdir(), "benchmark-sources-"));
    try {
      const run = spawnSync("node", ["scripts/build-benchmark-snapshot.ts", folder], {
        cwd: ROOT,
        encoding: "utf8",
      });

      expect(run.status).toBe(1);
      for (const { file } of Object.values(SOURCE_FILES)) expect(run.stderr).toContain(file);
      expect(run.stderr).toContain("census-zcta-county-<YYYY-MM-DD>.txt");
      expect(run.stderr).toContain("c_<DDmmYY>.zip");
    } finally {
      rmSync(folder, { recursive: true });
    }
  });

  it("fails naming the NWS county file when its download is an error page, and writes nothing", () => {
    const folder = mkdtempSync(join(tmpdir(), "benchmark-sources-"));
    const shipped = readFileSync(join(ROOT, "src/household/zip-table.data.ts"), "utf8");
    try {
      for (const [key, { file }] of Object.entries(SOURCE_FILES)) {
        writeFileSync(join(folder, file), readFixture(key as keyof typeof SOURCE_FILES));
      }
      writeFileSync(join(folder, "census-zcta-county-2021-12-09.txt"), "GEOID_ZCTA5_20|\n");
      writeFileSync(join(folder, "c_01ja26.zip"), ACCESS_DENIED);
      const run = spawnSync("node", ["scripts/build-benchmark-snapshot.ts", folder], {
        cwd: ROOT,
        encoding: "utf8",
      });

      expect(run.status).toBe(1);
      expect(run.stderr).toBe(
        'c_01ja26.zip: it is not a real .xlsx or .zip file. The download may be an error page, such as "Access Denied": download it again in a browser.\n',
      );
      expect(readFileSync(join(ROOT, "src/household/zip-table.data.ts"), "utf8")).toBe(shipped);
    } finally {
      rmSync(folder, { recursive: true });
    }
  });
});

describe("docs/data-sources.md", () => {
  const doc = readFileSync(join(ROOT, "docs/data-sources.md"), "utf8");

  it("holds the sources table and the map the release script writes from the snapshot", () => {
    expect(renderDataSources(doc, benchmarkSnapshot())).toBe(doc);
  });

  it("names each agency and table with its data date", () => {
    for (const { agency, table, dataDate } of benchmarkSnapshot().sources) {
      expect(doc).toContain(`| ${agency} | [${table}](`);
      expect(doc).toContain(`) | ${dataDate} |`);
    }
  });

  it("says no agency endorses the app, and holds the BLS sentence", () => {
    expect(doc).toContain("No agency named on this page endorses this app");
    expect(doc).toContain(
      "BLS.gov cannot vouch for the data or analyses derived from these data after the data have been retrieved from BLS.gov.",
    );
  });

  it("marks the government numbers as public domain and our own work as AGPL", () => {
    expect(doc).toMatch(/government numbers are public domain.*outside the AGPL/s);
    expect(doc).toMatch(/Category-to-CE-line map.*under the GNU Affero General Public License/s);
  });

  it("names every file the release script reads", () => {
    for (const { file } of Object.values(SOURCE_FILES)) {
      expect(doc).toContain(file.replace(/^ce-size-\d/, "ce-size-1"));
    }
  });
});
