import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ZIP_TABLE_DATA } from "../src/household/zip-table.data.ts";
import type { ZipSource } from "../src/household/zip-table.ts";
import {
  buildBenchmarkSnapshot,
  missingFilesMessage,
  type ReadSource,
  renderDataSources,
  SOURCE_FILES,
} from "./benchmark-snapshot.ts";
import { readFixture } from "./fixtures/benchmarks/fixtures.ts";
import {
  buildZipTable,
  currentCountyFile,
  NWS_COUNTIES_FOLDER,
  parseDbf,
  readZipEntry,
  ZCTA_COUNTY_URL,
} from "./zip-table.ts";

// The release script for the Benchmark snapshot (spec 05, The shipped data). It reads only local
// files, which the owner downloads by hand as docs/data-sources.md says, and makes no network
// request. It writes:
// - src/benchmarks/snapshot.data.ts, the Benchmark snapshot;
// - src/household/zip-table.data.ts, the ZIP table;
// - the generated parts of docs/data-sources.md.
//
// `node scripts/build-benchmark-snapshot.ts [folder]` reads the real files from the folder, by
// default benchmark-sources/ at the repo root.
// `node scripts/build-benchmark-snapshot.ts --sample` reads the made-up fixture files in
// scripts/fixtures/benchmarks/ instead, marks the snapshot as a sample, and keeps the ZIP table.
// The release must not ship a sample: scripts/check-benchmark-snapshot.ts fails on one.
//
// The source files it expects in the folder, each saved under the name on the left. Download each
// by hand, in a browser; docs/data-sources.md has the same list with links.
// - ce-income-before-taxes.xlsx: BLS, Consumer Expenditure Survey. https://www.bls.gov/cex/tables.htm,
//   "Calendar year tables", "Income before taxes": the means, shares, and standard errors table
//   (XLSX) for the newest year, such as cu-income-before-taxes-2025.xlsx.
// - ce-size-1-by-income.xlsx to ce-size-5-by-income.xlsx: BLS, Consumer Expenditure Survey. The
//   same page, "Cross-tabulated tables", "Size of consumer unit by income before taxes": one XLSX
//   for each size, from one person (1) to five or more persons (5).
//   BLS no longer publishes income after taxes, so the build picks the income column whose mean
//   income before taxes is nearest the Household's Income × 12 (spec 05, step 1).
//   BLS joins personal care into one row, "Personal care products and services": it feeds the
//   Personal care Benchmark, and B_GS = F + s(housekeeping supplies) × I (spec 05).
// - usda-moderate-cost.xlsx: USDA, Food and Nutrition Service.
//   https://www.fns.usda.gov/research/cnpp/usda-food-plans/cost-food-monthly-reports: the newest
//   Moderate-Cost plan XLSX, such as usda-moderatecostplan-sept2007-sept2026.xlsx.
// - usda-thrifty-us.xlsx: USDA, the same page: the newest Thrifty plan XLSX, such as
//   usda-thriftyplan-june2021-sept2026.xlsx.
// - usda-thrifty-alaska.xlsx: USDA, the same page: the newest Alaska XLSX, such as
//   usda-alaska-june2023-sept2026.xlsx.
// - usda-thrifty-hawaii.xlsx: USDA, the same page: the newest Hawaii XLSX, such as
//   usda-hawaii-june2023-sept2026.xlsx.
// - cpi-all-items.json: BLS, Consumer Price Index. The page
//   https://api.bls.gov/publicAPI/v1/timeseries/data/CUUR0000SA0?startyear=<first CE year>&endyear=<this year>,
//   saved as it is. The first CE year is the first year of the size tables, such as 2023.
//   This page gives only the newest three years. For an older first year, send a POST to
//   https://api.bls.gov/publicAPI/v1/timeseries/data/ with the body
//   {"seriesid":["CUUR0000SA0"],"startyear":"2023","endyear":"2023"} and join its months in.
//   BLS published no CPI for October 2025, during the 2025 lapse in appropriations: the build
//   prices the 2025 table at the mean of the other 11 months, and fails on any other missing month.
// - cpi-food-at-home.json: BLS, Consumer Price Index. The same, for the series CUUR0000SAF11.
// - census-zcta-county-<YYYY-MM-DD>.txt: U.S. Census Bureau.
//   https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/: tab20_zcta520_county20_natl.txt,
//   with the "Last modified" date that page gives it in the name.
// - c_<DDmmYY>.zip: National Weather Service. https://www.weather.gov/gis/Counties: the county
//   shapefile in effect today, under its own name, such as c_16ap26.zip.

const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const SNAPSHOT_OUT = root("src/benchmarks/snapshot.data.ts");
const ZIP_OUT = root("src/household/zip-table.data.ts");
const DOC = root("docs/data-sources.md");
const CENSUS_FILE = /^census-zcta-county-(\d{4}-\d{2}-\d{2})\.txt$/;
const NWS_FILE = /^c_\d{2}[a-z]{2}\d{2}\.zip$/;

const { values, positionals } = parseArgs({
  options: { sample: { type: "boolean", default: false } },
  allowPositionals: true,
});
const sample = values.sample === true;
const folder = resolve(positionals[0] ?? root("benchmark-sources"));

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const names = !sample && existsSync(folder) ? readdirSync(folder) : [];
const census = names.filter((name) => CENSUS_FILE.test(name)).sort();
const counties = names.filter((name) => NWS_FILE.test(name));
if (!sample) {
  const missing: string[] = Object.values(SOURCE_FILES)
    .map(({ file }) => file)
    .filter((file) => !names.includes(file));
  if (census.length === 0) missing.push("census-zcta-county-<YYYY-MM-DD>.txt");
  if (counties.length === 0) missing.push("c_<DDmmYY>.zip");
  if (missing.length > 0) fail(missingFilesMessage(missing, folder));
}

function writeFormatted(path: string, lines: string[]) {
  writeFileSync(path, lines.join("\n"));
  execFileSync("pnpm", ["exec", "biome", "format", "--write", path], { stdio: "inherit" });
}

// ---- The ZIP table, from the Census and NWS files.

let zipSources: ZipSource[] = ZIP_TABLE_DATA.sources;
if (!sample) {
  const today = new Date().toISOString().slice(0, 10);
  const censusName = census.at(-1) ?? "";
  const censusDate = censusName.match(CENSUS_FILE)?.[1] ?? "";
  let county: { file: string; date: string };
  try {
    county = currentCountyFile(counties.join(" "), today);
  } catch {
    fail(`The folder ${folder} holds no NWS county file in effect today.`);
  }
  let nwsRows: Record<string, string>[];
  try {
    const archive = new Uint8Array(readFileSync(join(folder, county.file)));
    nwsRows = parseDbf(readZipEntry(archive, (name) => name.toLowerCase().endsWith(".dbf")));
  } catch (error) {
    fail(`${county.file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  zipSources = [
    {
      agency: "U.S. Census Bureau",
      table: "2020 ZCTA to County Relationship File",
      url: ZCTA_COUNTY_URL,
      dataDate: censusDate,
    },
    {
      agency: "National Weather Service",
      table: "U.S. Counties, time zone field",
      url: `${NWS_COUNTIES_FOLDER}${county.file}`,
      dataDate: county.date,
    },
  ];
  let table: ReturnType<typeof buildZipTable>;
  try {
    table = buildZipTable(readFileSync(join(folder, censusName), "utf8"), nwsRows, zipSources);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  writeFormatted(ZIP_OUT, [
    "// Built by scripts/build-benchmark-snapshot.ts from US federal public-domain data. Do not edit by hand.",
    'import type { ZipTableData } from "./zip-table.ts";',
    "",
    `export const ZIP_TABLE_DATA: ZipTableData = ${JSON.stringify(table, null, 2)};`,
    "",
  ]);
  const count = Object.values(table.zipCodes).reduce(
    (sum, zips) => sum + zips.split(" ").length,
    0,
  );
  console.log(`Wrote ${count} ZIP codes to ${ZIP_OUT}.`);
}

// ---- The Benchmark snapshot.

const readFile: ReadSource = (key) =>
  new Uint8Array(readFileSync(join(folder, SOURCE_FILES[key].file)));
let snapshot: ReturnType<typeof buildBenchmarkSnapshot>;
try {
  snapshot = buildBenchmarkSnapshot(sample ? readFixture : readFile, zipSources, sample);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
writeFormatted(SNAPSHOT_OUT, [
  "// Built by scripts/build-benchmark-snapshot.ts from US federal public-domain data. Do not edit by hand.",
  ...(sample
    ? [
        "// SAMPLE: built from the made-up files in scripts/fixtures/benchmarks/. Sample numbers, not real data.",
      ]
    : []),
  'import type { BenchmarkSnapshot } from "./snapshot.ts";',
  "",
  `export const BENCHMARK_SNAPSHOT_DATA: BenchmarkSnapshot = ${JSON.stringify(snapshot, null, 2)};`,
  "",
]);
writeFileSync(DOC, renderDataSources(readFileSync(DOC, "utf8"), snapshot));

console.log(`Wrote the ${sample ? "SAMPLE " : ""}Benchmark snapshot to ${SNAPSHOT_OUT}.`);
for (const source of snapshot.sources) {
  console.log(`  ${source.agency}, ${source.table}: data date ${source.dataDate}`);
}
