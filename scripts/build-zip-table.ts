import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildZipTable,
  currentCountyFile,
  NWS_COUNTIES_FOLDER,
  NWS_COUNTIES_PAGE,
  parseDbf,
  readZipEntry,
  ZCTA_COUNTY_URL,
} from "./zip-table.ts";

// Builds the ZIP table from the Census and NWS files and writes src/household/zip-table.data.ts.
// Run it with `node scripts/build-zip-table.ts`. The file records each source's data date, for
// docs/data-sources.md.

const OUT = fileURLToPath(new URL("../src/household/zip-table.data.ts", import.meta.url));

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}.`);
  return res;
}

const today = new Date().toISOString().slice(0, 10);
const county = currentCountyFile(await (await fetchOk(NWS_COUNTIES_PAGE)).text(), today);
const countyUrl = `${NWS_COUNTIES_FOLDER}${county.file}`;
const archive = new Uint8Array(await (await fetchOk(countyUrl)).arrayBuffer());
const nwsRows = parseDbf(readZipEntry(archive, (name) => name.toLowerCase().endsWith(".dbf")));

const censusRes = await fetchOk(ZCTA_COUNTY_URL);
const modified = censusRes.headers.get("last-modified");
const censusDate = modified === null ? today : new Date(modified).toISOString().slice(0, 10);
const census = await censusRes.text();

const table = buildZipTable(census, nwsRows, [
  {
    agency: "U.S. Census Bureau",
    table: "2020 ZCTA to County Relationship File",
    url: ZCTA_COUNTY_URL,
    dataDate: censusDate,
  },
  {
    agency: "National Weather Service",
    table: "U.S. Counties, time zone field",
    url: countyUrl,
    dataDate: county.date,
  },
]);

writeFileSync(
  OUT,
  [
    "// Built by scripts/build-zip-table.ts from US federal public-domain data. Do not edit by hand.",
    'import type { ZipTableData } from "./zip-table.ts";',
    "",
    `export const ZIP_TABLE_DATA: ZipTableData = ${JSON.stringify(table, null, 2)};`,
    "",
  ].join("\n"),
);
execFileSync("pnpm", ["exec", "biome", "format", "--write", OUT], { stdio: "inherit" });

const count = Object.values(table.zipCodes).reduce((sum, zips) => sum + zips.split(" ").length, 0);
console.log(`Wrote ${count} ZIP codes to ${OUT}.`);
for (const source of table.sources) {
  console.log(`  ${source.agency}, ${source.table}: data date ${source.dataDate}`);
}
