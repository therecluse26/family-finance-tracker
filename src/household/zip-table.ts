import { ZIP_TABLE_DATA } from "./zip-table.data.ts";

// The shipped ZIP table (spec 05, Household facts): each ZIP code's state and IANA time zone.
// scripts/build-zip-table.ts builds zip-table.data.ts from the Census ZCTA to county relationship
// file and the NWS county time zones.

// One source of the table, with its data date, for docs/data-sources.md.
export type ZipSource = { agency: string; table: string; url: string; dataDate: string };

export type ZipTableData = {
  sources: ZipSource[];
  // ZIP codes, space-separated, under "<state> <time zone>", such as "NY America/New_York".
  zipCodes: Record<string, string>;
  // 3-digit ZIP prefixes, the same way. A ZIP code that is no ZCTA, such as a PO box ZIP code,
  // takes its prefix's state and time zone, when every ZCTA with that prefix has the same ones.
  prefixes: Record<string, string>;
};

export type ZipPlace = { state: string; timeZone: string };

function placesOf(groups: Record<string, string>): Map<string, ZipPlace> {
  const places = new Map<string, ZipPlace>();
  for (const [group, keys] of Object.entries(groups)) {
    const [state = "", timeZone = ""] = group.split(" ");
    const place = { state, timeZone };
    for (const key of keys.split(" ")) places.set(key, place);
  }
  return places;
}

let table: { zipCodes: Map<string, ZipPlace>; prefixes: Map<string, ZipPlace> } | undefined;

// The state and time zone of a 5-digit ZIP code, or undefined for a ZIP code the table does not
// know.
export function lookUpZipCode(zipCode: string): ZipPlace | undefined {
  if (!/^\d{5}$/.test(zipCode)) return undefined;
  table ??= {
    zipCodes: placesOf(ZIP_TABLE_DATA.zipCodes),
    prefixes: placesOf(ZIP_TABLE_DATA.prefixes),
  };
  return table.zipCodes.get(zipCode) ?? table.prefixes.get(zipCode.slice(0, 3));
}

// The table's sources, with their data dates.
export function zipTableSources(): readonly ZipSource[] {
  return ZIP_TABLE_DATA.sources;
}
