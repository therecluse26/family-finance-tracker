import { inflateRawSync } from "node:zlib";
import type { ZipSource, ZipTableData } from "../src/household/zip-table.ts";

// The ZIP table (spec 05, Household facts and The shipped data): each ZIP code's state and IANA time
// zone. It is built from two US federal works in the public domain: the Census Bureau's 2020 ZCTA
// to county relationship file, and the time zone field of the National Weather Service's county
// file. scripts/build-benchmark-snapshot.ts reads both from files the owner downloads, and writes
// src/household/zip-table.data.ts.

export const ZCTA_COUNTY_URL =
  "https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt";
export const NWS_COUNTIES_PAGE = "https://www.weather.gov/gis/Counties";
export const NWS_COUNTIES_FOLDER = "https://www.weather.gov/source/gis/Shapefiles/County/";

// The NWS time zone letters (the TIME_ZONE field) of the places the Census file covers. Each zone
// is the one IANA lists for most of the area.
export const NWS_TIME_ZONES: Readonly<Record<string, string>> = {
  // Atlantic: Puerto Rico and the US Virgin Islands.
  V: "America/Puerto_Rico",
  E: "America/New_York",
  C: "America/Chicago",
  M: "America/Denver",
  // Mountain Standard with no daylight time.
  m: "America/Phoenix",
  P: "America/Los_Angeles",
  A: "America/Anchorage",
  H: "Pacific/Honolulu",
  // Hawaii-Aleutian with daylight time: the western Aleutians.
  h: "America/Adak",
  // Guam and the Northern Mariana Islands.
  G: "Pacific/Guam",
  S: "Pacific/Pago_Pago",
};

// One file from a .zip archive, found by its name.
export function readZipEntry(archive: Uint8Array, wanted: (name: string) => boolean): Uint8Array {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let end = archive.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("The archive has no .zip directory.");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("The .zip directory is broken.");
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const skip = nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const name = new TextDecoder().decode(archive.subarray(at + 46, at + 46 + nameLength));
    if (wanted(name)) {
      const local = view.getUint32(at + 42, true);
      const start =
        local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = archive.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return new Uint8Array(inflateRawSync(data));
      throw new Error(`${name} uses .zip method ${method}, which this script cannot read.`);
    }
    at += 46 + skip;
  }
  throw new Error("The archive holds no such file.");
}

// The records of a dBase file, such as a shapefile's .dbf, each field as trimmed text. Deleted
// records are left out.
export function parseDbf(bytes: Uint8Array): Record<string, string>[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records = view.getUint32(4, true);
  const headerLength = view.getUint16(8, true);
  const recordLength = view.getUint16(10, true);
  const text = new TextDecoder("latin1");
  const fields: { name: string; length: number }[] = [];
  for (let at = 32; bytes[at] !== 0x0d; at += 32) {
    const name = text.decode(bytes.subarray(at, at + 11)).replace(/\0.*$/s, "");
    fields.push({ name, length: bytes[at + 16] ?? 0 });
  }
  const rows: Record<string, string>[] = [];
  for (let i = 0; i < records; i++) {
    const start = headerLength + i * recordLength;
    if (bytes[start] === 0x2a) continue;
    const row: Record<string, string> = {};
    let at = start + 1;
    for (const field of fields) {
      row[field.name] = text.decode(bytes.subarray(at, at + field.length)).trim();
      at += field.length;
    }
    rows.push(row);
  }
  return rows;
}

const MONTHS = ["ja", "fe", "mr", "ap", "my", "jn", "jl", "au", "se", "oc", "no", "de"];

// The NWS county file in effect on `today`: the newest one the page links whose effective date,
// in its name such as c_16ap26.zip, is not after today.
export function currentCountyFile(page: string, today: string): { file: string; date: string } {
  const files = [...page.matchAll(/c_(\d{2})([a-z]{2})(\d{2})\.zip/g)].flatMap((match) => {
    const [file, day, month, year] = match;
    const index = MONTHS.indexOf(month ?? "");
    if (index < 0) return [];
    const date = `20${year}-${String(index + 1).padStart(2, "0")}-${day}`;
    return date <= today ? [{ file, date }] : [];
  });
  const newest = files.sort((a, b) => b.date.localeCompare(a.date))[0];
  if (newest === undefined) throw new Error("The NWS page links no county file in effect today.");
  return newest;
}

type County = { state: string; zones: string };

// Each county's state and NWS time zone letters, by its 5-digit FIPS code.
function countiesOf(rows: readonly Record<string, string>[]): Map<string, County> {
  const counties = new Map<string, County>();
  for (const { FIPS: fips, STATE: state, TIME_ZONE: zones } of rows) {
    if (fips === undefined || state === undefined || zones === undefined) {
      throw new Error("The NWS county file needs the FIPS, STATE, and TIME_ZONE fields.");
    }
    // Records of one county that disagree, such as in the Federated States of Micronesia, give it
    // no zone. Building the table fails only when a ZIP code needs that county.
    const known = counties.get(fips);
    counties.set(fips, { state, zones: known === undefined || known.zones === zones ? zones : "" });
  }
  return counties;
}

function mostCommon(values: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

// Each county's state and IANA time zone, by its 5-digit FIPS code.
// - NWS gives two letters to a county that a time zone line divides, and to an Arizona county where
//   only the Navajo Nation keeps daylight time. Such a county takes the zone of most of its state's
//   other counties, since the files do not say which part of the county a ZIP code is in.
// - A county NWS does not list, such as Kalawao in Hawaii, takes its state's zone when every
//   county NWS lists in that state has that one zone.
export function countyTimeZones(
  rows: readonly Record<string, string>[],
): (fips: string) => { state: string; timeZone: string } | undefined {
  const counties = countiesOf(rows);
  const single = new Map<string, string[]>();
  const states = new Map<string, { state: string; letters: Set<string> }>();
  for (const [fips, { state, zones }] of counties) {
    if (zones.length === 1) single.set(state, [...(single.get(state) ?? []), zones]);
    const known = states.get(fips.slice(0, 2)) ?? { state, letters: new Set() };
    states.set(fips.slice(0, 2), { state, letters: known.letters.add(zones) });
  }
  const place = (state: string, letter: string | undefined) => {
    const timeZone = letter === undefined ? undefined : NWS_TIME_ZONES[letter];
    return timeZone === undefined ? undefined : { state, timeZone };
  };
  return (fips) => {
    const county = counties.get(fips);
    if (county !== undefined) {
      const { state, zones } = county;
      return place(state, zones.length === 1 ? zones : mostCommon(single.get(state) ?? []));
    }
    const state = states.get(fips.slice(0, 2));
    if (state === undefined || state.letters.size !== 1) return undefined;
    return place(state.state, [...state.letters][0]);
  };
}

// Each ZCTA's counties, with the land area of the ZCTA in each, from the Census file. The file is
// pipe-separated, with a header row.
export function zctaCounties(text: string): Map<string, { county: string; land: number }[]> {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const header = (lines[0] ?? "").split("|");
  const column = (name: string) => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`The Census file has no ${name} column.`);
    return index;
  };
  const zctaAt = column("GEOID_ZCTA5_20");
  const countyAt = column("GEOID_COUNTY_20");
  const landAt = column("AREALAND_PART");
  const zctas = new Map<string, { county: string; land: number }[]>();
  for (const line of lines.slice(1)) {
    const cells = line.split("|");
    const zcta = cells[zctaAt] ?? "";
    // A row with no ZCTA is a part of a county that no ZCTA covers.
    if (!/^\d{5}$/.test(zcta)) continue;
    const county = cells[countyAt] ?? "";
    const land = Number(cells[landAt]);
    if (!/^\d{5}$/.test(county) || !Number.isFinite(land)) {
      throw new Error(`The Census file has a bad row for ZCTA ${zcta}.`);
    }
    zctas.set(zcta, [...(zctas.get(zcta) ?? []), { county, land }]);
  }
  return zctas;
}

function grouped(entries: Iterable<[string, string]>): Record<string, string> {
  const groups = new Map<string, string[]>();
  for (const [key, group] of [...entries].sort((a, b) => a[0].localeCompare(b[0]))) {
    groups.set(group, [...(groups.get(group) ?? []), key]);
  }
  return Object.fromEntries(
    [...groups]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([group, keys]) => [group, keys.join(" ")]),
  );
}

// The ZIP table. A ZIP code whose ZCTA spans several counties takes the county with the largest
// share of its land area, so one in two time zones takes the zone where most of its land is.
export function buildZipTable(
  census: string,
  nwsRows: readonly Record<string, string>[],
  sources: ZipSource[],
): ZipTableData {
  const counties = countyTimeZones(nwsRows);
  const zips = new Map<string, string>();
  for (const [zcta, parts] of zctaCounties(census)) {
    const largest = [...parts].sort(
      (a, b) => b.land - a.land || a.county.localeCompare(b.county),
    )[0];
    const county = largest === undefined ? undefined : counties(largest.county);
    if (county === undefined) {
      throw new Error(`ZCTA ${zcta} lies in county ${largest?.county}, which NWS gives no zone.`);
    }
    zips.set(zcta, `${county.state} ${county.timeZone}`);
  }
  const byPrefix = new Map<string, Set<string>>();
  for (const [zip, group] of zips) {
    const prefix = zip.slice(0, 3);
    byPrefix.set(prefix, (byPrefix.get(prefix) ?? new Set()).add(group));
  }
  const prefixes = [...byPrefix].flatMap(([prefix, groups]): [string, string][] => {
    const [only] = groups;
    return groups.size === 1 && only !== undefined ? [[prefix, only]] : [];
  });
  return { sources, zipCodes: grouped(zips), prefixes: grouped(prefixes) };
}
