import { describe, expect, it } from "vitest";
import { isKnownTimeZone, lookUpZipCode, zipTableSources } from "./index.ts";
import { ZIP_TABLE_DATA } from "./zip-table.data.ts";

// The shipped ZIP table, through its lookup.

describe("the ZIP table", () => {
  it.each([
    ["10001", "NY", "America/New_York"],
    ["85001", "AZ", "America/Phoenix"],
    ["96813", "HI", "Pacific/Honolulu"],
    ["99501", "AK", "America/Anchorage"],
  ])("maps %s to %s and %s", (zipCode, state, timeZone) => {
    expect(lookUpZipCode(zipCode)).toEqual({ state, timeZone });
  });

  it.each(["00000", "1000", "100011", "1000a", "", " 10001"])("knows no ZIP code %j", (zipCode) => {
    expect(lookUpZipCode(zipCode)).toBeUndefined();
  });

  it("gives only time zones the runtime knows", () => {
    const zones = Object.keys({ ...ZIP_TABLE_DATA.zipCodes, ...ZIP_TABLE_DATA.prefixes }).map(
      (group) => group.split(" ")[1] ?? "",
    );

    expect(zones.filter((zone) => !isKnownTimeZone(zone))).toEqual([]);
  });

  it("names each source with its data date, for docs/data-sources.md", () => {
    expect(zipTableSources().map(({ agency }) => agency)).toEqual([
      "U.S. Census Bureau",
      "National Weather Service",
    ]);
    for (const source of zipTableSources()) {
      expect(source.dataDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(source.url).toMatch(/^https:\/\/www2?\.(census|weather)\.gov\//);
    }
  });
});
