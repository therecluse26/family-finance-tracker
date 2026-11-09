import { DEFAULT_REPORT_RANGE, REPORT_RANGES, type ReportRange } from "../reports/range.ts";

// The Reports page's address (spec 07, Reports). The range and each report's filter live in the
// query, so a link can open a report as set; the hash names the report's section.

// The page's sections, in order, as their ids.
export const REPORT_SECTIONS = ["spending", "cash-flow", "balances", "merchants"] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];

// The range presets' words.
export const RANGE_LABELS: Readonly<Record<ReportRange, string>> = Object.freeze({
  "3m": "3 months",
  "12m": "12 months",
  "24m": "24 months",
  all: "All",
});

// What every section gets: the page's range, and its address's query for the section's filter.
export type ReportSectionProps = { range: ReportRange; params: URLSearchParams };

// Each report's one filter: a Category group, an Account, or a Merchant group.
export type ReportFilters = {
  range?: ReportRange;
  group?: string;
  account?: string;
  merchant?: string;
};

const isRange = (value: string): value is ReportRange =>
  (REPORT_RANGES as readonly string[]).includes(value);

// The range in the address. A missing or unknown one is the default, 12 months.
export function rangeOf(params: URLSearchParams): ReportRange {
  const range = params.get("range") ?? "";
  return isRange(range) ? range : DEFAULT_REPORT_RANGE;
}

// The Reports page, opened at a section with its range and filter set, such as
// "/reports?range=12m&group=Bills#spending".
export function reportsPath(section: ReportSection, filters: ReportFilters = {}): string {
  const query = new URLSearchParams();
  for (const name of ["range", "group", "account", "merchant"] as const) {
    const value = filters[name];
    if (value !== undefined && value !== "") query.set(name, value);
  }
  const search = query.toString();
  return `/reports${search === "" ? "" : `?${search}`}#${section}`;
}

// A range preset's link: the page with `range` set, keeping every other parameter.
export function rangeHref(params: URLSearchParams, range: ReportRange): string {
  const query = new URLSearchParams(params);
  query.set("range", range);
  return `/reports?${query.toString()}`;
}
