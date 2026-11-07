import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  buildZipTable,
  countyTimeZones,
  currentCountyFile,
  NOT_A_ZIP,
  parseDbf,
  readZipEntry,
} from "./zip-table.ts";

// The ZIP table build, on small made-up copies of the Census and NWS files.

const HEADER =
  "OID_ZCTA5_20|GEOID_ZCTA5_20|NAMELSAD_ZCTA5_20|AREALAND_ZCTA5_20|AREAWATER_ZCTA5_20|" +
  "MTFCC_ZCTA5_20|CLASSFP_ZCTA5_20|FUNCSTAT_ZCTA5_20|OID_COUNTY_20|GEOID_COUNTY_20|" +
  "NAMELSAD_COUNTY_20|AREALAND_COUNTY_20|AREAWATER_COUNTY_20|MTFCC_COUNTY_20|CLASSFP_COUNTY_20|" +
  "FUNCSTAT_COUNTY_20|AREALAND_PART|AREAWATER_PART";

// One Census row: a ZCTA, a county, and the ZCTA's land area in that county.
const row = (zcta: string, county: string, land: number) =>
  `1|${zcta}|ZCTA5 ${zcta}|0|0|G6350|B5|S|2|${county}|A County|0|0|G4020|H1|A|${land}|0`;

const county = (STATE: string, FIPS: string, TIME_ZONE: string) => ({ STATE, FIPS, TIME_ZONE });

const NWS = [
  county("NY", "36061", "E"),
  county("ID", "16049", "MP"),
  county("ID", "16001", "M"),
  county("ID", "16003", "M"),
  county("ID", "16069", "P"),
  county("AZ", "04013", "m"),
  county("HI", "15003", "H"),
  county("HI", "15009", "H"),
];

const SOURCES = [
  { agency: "Agency", table: "Table", url: "https://example.gov/", dataDate: "2026-04-16" },
];

describe("the ZIP table build", () => {
  it("gives a ZIP code in two counties the county with the largest share of its land", () => {
    const census = [
      HEADER,
      row("10001", "36061", 100),
      // A ZIP code mostly in Idaho County (16049), and a little in Ada County (16001).
      row("83530", "16069", 400),
      row("83530", "16001", 900),
      row("85003", "04013", 10),
      "||||||||27590114112812|01003|A County|0|0|G4020|H1|A|339765765|927218265",
    ].join("\n");

    const table = buildZipTable(census, NWS, SOURCES);

    expect(table.zipCodes).toEqual({
      "AZ America/Phoenix": "85003",
      "ID America/Denver": "83530",
      "NY America/New_York": "10001",
    });
    expect(table.sources).toEqual(SOURCES);
  });

  it("gives a 3-digit prefix a place only when every ZCTA with it has the same one", () => {
    const census = [
      HEADER,
      row("85003", "04013", 10),
      row("85004", "04013", 10),
      row("83530", "16069", 10),
      row("83531", "16001", 10),
    ].join("\n");

    expect(buildZipTable(census, NWS, SOURCES).prefixes).toEqual({ "AZ America/Phoenix": "850" });
  });

  it("gives a county that a time zone line divides the zone of most of its state's counties", () => {
    const zones = countyTimeZones(NWS);

    expect(zones("16049")).toEqual({ state: "ID", timeZone: "America/Denver" });
  });

  it("gives a county NWS does not list its state's zone, when the state has one zone", () => {
    const zones = countyTimeZones(NWS);

    // Kalawao County, Hawaii, which NWS counts with Maui.
    expect(zones("15005")).toEqual({ state: "HI", timeZone: "Pacific/Honolulu" });
    // Idaho has two zones, so an unlisted Idaho county has none.
    expect(zones("16999")).toBeUndefined();
  });

  it("fails when a ZIP code lies in a county with no zone", () => {
    const census = [HEADER, row("83599", "16999", 10)].join("\n");

    expect(() => buildZipTable(census, NWS, SOURCES)).toThrow(
      "ZCTA 83599 lies in county 16999, which NWS gives no zone.",
    );
  });

  it("picks the NWS county file in effect today", () => {
    const page =
      '<a href="/source/gis/Shapefiles/County/c_18mr25.zip">' +
      '<a href="/source/gis/Shapefiles/County/c_16ap26.zip">' +
      '<a href="/source/gis/Shapefiles/County/c_01de26.zip">';

    expect(currentCountyFile(page, "2026-11-03")).toEqual({
      file: "c_16ap26.zip",
      date: "2026-04-16",
    });
  });

  it("reads the county records from the .dbf inside the .zip archive", () => {
    const dbf = makeDbf(
      [
        ["STATE", 2],
        ["FIPS", 5],
        ["TIME_ZONE", 2],
      ],
      [
        ["NY", "36061", "E"],
        ["AZ", "04013", "m"],
      ],
    );
    const archive = makeZip([
      { name: "c_16ap26.prj", data: new TextEncoder().encode("GEOGCS") },
      { name: "c_16ap26.dbf", data: dbf },
    ]);

    const rows = parseDbf(readZipEntry(archive, (name) => name.endsWith(".dbf")));

    expect(rows).toEqual([county("NY", "36061", "E"), county("AZ", "04013", "m")]);
  });
});

describe("the .zip reader", () => {
  const isDbf = (name: string) => name.endsWith(".dbf");

  it("says a file that is not a .zip archive, such as an error page, may be one", () => {
    const page = new TextEncoder().encode("<html><title>Access Denied</title></html>");

    expect(() => readZipEntry(page, isDbf)).toThrow(NOT_A_ZIP);
    expect(() => readZipEntry(new Uint8Array(0), isDbf)).toThrow(NOT_A_ZIP);
  });

  it("refuses a file that unpacks to more than the limit", () => {
    const data = new Uint8Array(1000);
    const archive = makeZip([{ name: "c.dbf", data }]);

    expect(readZipEntry(archive, isDbf, 1000)).toEqual(data);
    expect(() => readZipEntry(archive, isDbf, 999)).toThrow(
      "c.dbf unpacks to more than 999 bytes, so it was not read.",
    );
  });

  it("stops unpacking at the limit a file that claims less than it holds", () => {
    // 64 MB of zeros packs to about 64 KB, but claims 1 KB.
    const archive = makeZip([{ name: "c.dbf", data: new Uint8Array(64 * 1024 * 1024) }], 1024);

    expect(() => readZipEntry(archive, isDbf, 1024 * 1024)).toThrow(
      "c.dbf unpacks to more than 1048576 bytes, so it was not read.",
    );
  });

  it("refuses a file that unpacks to another size than it claims", () => {
    const archive = makeZip([{ name: "c.dbf", data: new Uint8Array(10) }], 11);

    expect(() => readZipEntry(archive, isDbf)).toThrow(
      "c.dbf in the .zip archive is broken: it unpacks to 10 bytes, not the 11 it claims.",
    );
  });
});

// A dBase III file with text fields only.
function makeDbf(fields: [string, number][], records: string[][]): Uint8Array {
  const recordLength = 1 + fields.reduce((sum, [, length]) => sum + length, 0);
  const headerLength = 32 + fields.length * 32 + 1;
  const bytes = new Uint8Array(headerLength + records.length * recordLength + 1);
  const view = new DataView(bytes.buffer);
  bytes[0] = 3;
  view.setUint32(4, records.length, true);
  view.setUint16(8, headerLength, true);
  view.setUint16(10, recordLength, true);
  fields.forEach(([name, length], index) => {
    const at = 32 + index * 32;
    bytes.set(new TextEncoder().encode(name), at);
    bytes[at + 11] = "C".charCodeAt(0);
    bytes[at + 16] = length;
  });
  bytes[headerLength - 1] = 0x0d;
  records.forEach((record, index) => {
    let at = headerLength + index * recordLength;
    bytes[at++] = 0x20;
    fields.forEach(([, length], field) => {
      bytes.set(new TextEncoder().encode((record[field] ?? "").padEnd(length)), at);
      at += length;
    });
  });
  bytes[bytes.length - 1] = 0x1a;
  return bytes;
}

// A .zip archive whose files are deflated. Each file claims to unpack to `claims` bytes, by default
// its true size.
function makeZip(files: { name: string; data: Uint8Array }[], claims?: number): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name);
    const packed = deflateRawSync(file.data);
    const local = new Uint8Array(30 + name.length + packed.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(18, packed.length, true);
    lv.setUint32(22, claims ?? file.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(packed, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(20, packed.length, true);
    cv.setUint32(24, claims ?? file.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directorySize = centrals.reduce((sum, central) => sum + central.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const archive = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    archive.set(part, at);
    at += part.length;
  }
  return archive;
}
