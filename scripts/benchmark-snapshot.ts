import {
  B_GS_CE_LINES,
  BENCHMARK_ROLES,
  CE_LINE_MAP,
  CE_LINES,
  type CeLine,
  ceLinesOf,
} from "../src/benchmarks/ce-lines.ts";
import {
  type BenchmarkSnapshot,
  benchmarkSnapshotSchema,
  type CeTable,
  type FoodPlan,
  SAMPLE_NOTICE,
} from "../src/benchmarks/snapshot.ts";
import { CATEGORIES } from "../src/categories/index.ts";
import { readXlsx, type Sheet } from "./xlsx.ts";

// The Benchmark snapshot build (spec 05, The shipped data). It reads files the owner downloads by
// hand: no agent and no script fetches from BLS or USDA. docs/data-sources.md says which file to
// download from which page, and the name to save it under. scripts/build-benchmark-snapshot.ts
// runs this build and writes src/benchmarks/snapshot.data.ts.

export const CE_TABLES_PAGE = "https://www.bls.gov/cex/tables.htm";
export const USDA_REPORTS_PAGE =
  "https://www.fns.usda.gov/research/cnpp/usda-food-plans/cost-food-monthly-reports";
export const CPI_ALL_ITEMS = "CUUR0000SA0";
export const CPI_FOOD_AT_HOME = "CUUR0000SAF11";
const cpiPage = (series: string) => `https://api.bls.gov/publicAPI/v1/timeseries/data/${series}`;

// The files the build reads, by the name each is saved under, with the page it comes from.
export const SOURCE_FILES = {
  ceByIncome: { file: "ce-income-before-taxes.xlsx", page: CE_TABLES_PAGE },
  ceSize1: { file: "ce-size-1-by-income.xlsx", page: CE_TABLES_PAGE },
  ceSize2: { file: "ce-size-2-by-income.xlsx", page: CE_TABLES_PAGE },
  ceSize3: { file: "ce-size-3-by-income.xlsx", page: CE_TABLES_PAGE },
  ceSize4: { file: "ce-size-4-by-income.xlsx", page: CE_TABLES_PAGE },
  ceSize5: { file: "ce-size-5-by-income.xlsx", page: CE_TABLES_PAGE },
  moderate: { file: "usda-moderate-cost.xlsx", page: USDA_REPORTS_PAGE },
  thriftyUs: { file: "usda-thrifty-us.xlsx", page: USDA_REPORTS_PAGE },
  thriftyAlaska: { file: "usda-thrifty-alaska.xlsx", page: USDA_REPORTS_PAGE },
  thriftyHawaii: { file: "usda-thrifty-hawaii.xlsx", page: USDA_REPORTS_PAGE },
  cpiAllItems: { file: "cpi-all-items.json", page: cpiPage(CPI_ALL_ITEMS) },
  cpiFoodAtHome: { file: "cpi-food-at-home.json", page: cpiPage(CPI_FOOD_AT_HOME) },
} as const;

export type SourceKey = keyof typeof SOURCE_FILES;

// The files a folder lacks, each with the page to download it from, as one message.
export function missingFilesMessage(missing: readonly string[], folder: string): string {
  return [
    `The folder ${folder} lacks ${missing.length} source file(s). docs/data-sources.md says how to get each one:`,
    ...missing.map((file) => `  ${file}`),
  ].join("\n");
}

// USDA's household-size adjustment, from the ReadMe of each food plan file. The build checks that
// the ReadMe still says it.
export const SIZE_ADJUSTMENT = [
  { fromSize: 1, toSize: 1, percent: 20, words: "1-person—add 20 percent" },
  { fromSize: 2, toSize: 2, percent: 10, words: "2-person—add 10 percent" },
  { fromSize: 3, toSize: 3, percent: 5, words: "3-person—add 5 percent" },
  { fromSize: 4, toSize: 4, percent: 0, words: "4-person—no adjustment" },
  { fromSize: 5, toSize: 6, percent: -5, words: "5- or 6-person—subtract 5 percent" },
  { fromSize: 7, toSize: null, percent: -10, words: "7- (or more) person—subtract 10 percent" },
] as const;

// ---- CE tables

// A row label without its footnote marks, such as "(1)" or "b/", and its closing colon, in lower
// case, so "Pets 2/" and "pets" match.
function labelKey(text: string): string {
  let key = text.replace(/\s+/g, " ").trim();
  for (;;) {
    const next = key.replace(/\s*(?:\(\d+\)|\b[a-z0-9]{1,2}\/|:)$/i, "").trim();
    if (next === key) return key.toLowerCase();
    key = next;
  }
}

// A cell's number, or null for a blank, a suppressed figure, or a footnote mark.
function cellNumber(text: string | undefined): number | null {
  const plain = (text ?? "").replace(/[$,\s]/g, "");
  return /^-?\d+(?:\.\d+)?$/.test(plain) ? Number(plain) : null;
}

const STAT_ROWS = new Set(["share", "se", "standard error", "cv(%)", "cv (%)", "cv"]);

const INCOME_AFTER_TAXES = "Income after taxes";
const TOTAL_SPENDING = "Average annual expenditures";

// One CE table: its income columns, with the mean income after taxes, the mean total yearly
// Spending, and the mean yearly Spending on each CE line. Rows are found by their labels in the
// first column: an item's label row, then its "Mean", "Share", "SE", and "CV(%)" rows. Columns are
// found under the "Item" header. A column whose income or total BLS suppresses is left out.
export function parseCeTable(sheet: Sheet, file: string): Omit<CeTable, "pricedAt"> {
  const fail = (problem: string): never => {
    throw new Error(`${file}: ${problem}`);
  };
  const headerAt = sheet.findIndex((row) => labelKey(row[0] ?? "") === "item");
  if (headerAt < 0) fail('it has no header row starting with "Item".');
  const titleCell = sheet
    .slice(0, headerAt)
    .flat()
    .find((cell) => /Consumer Expenditure Surveys?,?\s*\d{4}/i.test(cell));
  const yearsMatch = titleCell?.match(/(\d{4})(?:\s*[-–]\s*(\d{4}))?\s*$/);
  if (titleCell === undefined || yearsMatch === null || yearsMatch === undefined) {
    return fail("its title names no Consumer Expenditure Surveys year.");
  }
  const [, first = "", last] = yearsMatch;
  const years = last === undefined ? first : `${first}-${last}`;
  const width = Math.max(...sheet.map((row) => row.length));
  // The header runs on until the first row with a label. Its column names, such as "$40,000",
  // can look like figures, so only the label marks where the rows begin.
  let dataAt = headerAt + 1;
  while (dataAt < sheet.length && labelKey(sheet[dataAt]?.[0] ?? "") === "") dataAt++;
  const columns: { at: number; label: string }[] = [];
  for (let at = 1; at < width; at++) {
    const label = sheet
      .slice(headerAt, dataAt)
      .map((row) => (row[at] ?? "").replace(/\s+/g, " ").trim())
      .filter((text) => text !== "")
      .join(" ");
    if (label !== "") columns.push({ at, label });
  }
  if (columns.length === 0) fail('it has no columns under the "Item" header.');

  // Each label's figures, once per row it appears on. A "Mean" row gives its item's figures.
  const found = new Map<string, (number | null)[][]>();
  let item: string | undefined;
  for (const row of sheet.slice(dataAt)) {
    const key = labelKey(row[0] ?? "");
    if (key === "") continue;
    const values = columns.map(({ at }) => cellNumber(row[at]));
    if (key === "mean") {
      const rows = item === undefined ? undefined : found.get(item);
      if (rows !== undefined) rows[rows.length - 1] = values;
    } else if (!STAT_ROWS.has(key)) {
      item = key;
      found.set(key, [...(found.get(key) ?? []), values]);
    }
  }
  const missing: string[] = [];
  const figures = (label: string): (number | null)[] => {
    const rows = found.get(labelKey(label)) ?? [];
    const distinct = new Set(rows.map((values) => JSON.stringify(values)));
    if (distinct.size > 1) fail(`it has more than one "${label}" row, with different figures.`);
    const [values] = rows;
    if (values === undefined || values.every((value) => value === null)) {
      missing.push(label);
      return columns.map(() => null);
    }
    return values;
  };
  const income = figures(INCOME_AFTER_TAXES);
  const total = figures(TOTAL_SPENDING);
  const lines = CE_LINES.map((line) => [line, figures(line)] as const);
  if (missing.length > 0) {
    fail(`it has no figures for these rows: ${missing.map((label) => `"${label}"`).join(", ")}.`);
  }
  const kept = columns.flatMap(({ label }, index) => {
    const incomeAfterTaxes = income[index];
    const totalSpending = total[index];
    if (incomeAfterTaxes == null || totalSpending == null || totalSpending <= 0) return [];
    const byLine = Object.fromEntries(
      lines.map(([line, values]) => [line, values[index] ?? null]),
    ) as Record<CeLine, number | null>;
    return [{ label, incomeAfterTaxes, totalSpending, lines: byLine }];
  });
  if (kept.length === 0) fail("every column lacks a mean income after taxes or a total.");
  return { title: titleCell.replace(/\s+/g, " ").trim(), years, columns: kept };
}

// ---- USDA food plans

const FOOD_COLUMNS = [
  "geographic_area",
  "fam_indv",
  "group",
  "age",
  "year",
  "month",
  "food_plan",
  "frequency",
  "cost",
] as const;

const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

function monthNumber(text: string): number | undefined {
  const value = text.trim().toLowerCase();
  const number = Number(value);
  if (Number.isInteger(number) && number >= 1 && number <= 12) return number;
  const index = MONTH_NAMES.indexOf(value.slice(0, 3));
  return index < 0 ? undefined : index + 1;
}

// An age group's first and last age, from labels such as "1 year", "2-3 years", "19-50 years", and
// "71+ years".
function ageRange(label: string): { fromAge: number; toAge: number | null } | undefined {
  const match = label.match(/^\s*(\d+)\s*(?:([-–—]|to)\s*(\d+)|(\+))?\s*(?:years?|yrs?\.?)?/i);
  if (match === null) return undefined;
  const fromAge = Number(match[1]);
  if (match[4] === "+") return { fromAge, toAge: null };
  return { fromAge, toAge: match[3] === undefined ? fromAge : Number(match[3]) };
}

function normalWords(text: string): string {
  return text
    .replace(/[‐-―−]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

// Fails unless a food plan file's ReadMe still gives USDA's household-size adjustment as
// SIZE_ADJUSTMENT has it.
export function checkSizeAdjustment(sheets: ReadonlyMap<string, Sheet>, file: string): void {
  const readMe = normalWords([...sheets.values()].flat(2).join(" "));
  const lost = SIZE_ADJUSTMENT.find(({ words }) => !readMe.includes(normalWords(words)));
  if (lost !== undefined) {
    throw new Error(
      `${file}: its ReadMe no longer says "${lost.words}". Check USDA's household-size rule.`,
    );
  }
}

// One food plan from a USDA cost-of-food file: the monthly cost per person, by age group and sex,
// for the latest month in the file. The file's long table has the columns FOOD_COLUMNS.
export function parseFoodPlan(
  sheets: ReadonlyMap<string, Sheet>,
  file: string,
  plan: FoodPlan["plan"],
): Omit<FoodPlan, "pricedAt"> {
  const fail = (problem: string): never => {
    throw new Error(`${file}: ${problem}`);
  };
  let table: { rows: Sheet; at: Record<(typeof FOOD_COLUMNS)[number], number> } | undefined;
  for (const sheet of sheets.values()) {
    const headerAt = sheet.findIndex((row) => row.some((cell) => cell.trim() === "cost"));
    const header = (sheet[headerAt] ?? []).map((cell) => cell.trim().toLowerCase());
    if (headerAt < 0 || !FOOD_COLUMNS.every((name) => header.includes(name))) continue;
    const at = Object.fromEntries(FOOD_COLUMNS.map((name) => [name, header.indexOf(name)]));
    table = { rows: sheet.slice(headerAt + 1), at: at as Record<string, number> };
  }
  if (table === undefined) return fail(`no sheet has the columns ${FOOD_COLUMNS.join(", ")}.`);
  const { rows, at } = table;
  const word = new RegExp(plan === "Thrifty" ? "thrifty" : "moderate", "i");
  const picked = rows.flatMap((row) => {
    const cell = (name: (typeof FOOD_COLUMNS)[number]) => (row[at[name]] ?? "").trim();
    if (!/month/i.test(cell("frequency")) || !/indiv/i.test(cell("fam_indv"))) return [];
    if (!word.test(cell("food_plan"))) return [];
    const month = monthNumber(cell("month"));
    const year = cell("year");
    const monthly = cellNumber(cell("cost"));
    if (month === undefined || !/^\d{4}$/.test(year) || monthly === null || monthly <= 0) {
      return fail(`it has a monthly row with a bad year, month, or cost: ${row.join(", ")}.`);
    }
    const group = cell("group");
    const sex = /\bfemale/i.test(group) ? "female" : /\bmale/i.test(group) ? "male" : null;
    return [
      {
        area: cell("geographic_area"),
        month: `${year}-${String(month).padStart(2, "0")}`,
        age: cell("age"),
        sex,
        monthly,
      },
    ] as const;
  });
  const month = picked.map((row) => row.month).sort((a, b) => b.localeCompare(a))[0];
  if (month === undefined) return fail(`it has no monthly ${plan} costs for individuals.`);
  const latest = picked.filter((row) => row.month === month);
  const areas = [...new Set(latest.map((row) => row.area))];
  const [area] = areas;
  if (area === undefined || areas.length > 1) {
    return fail(`its ${month} costs cover more than one area: ${areas.join(", ")}.`);
  }
  const seen = new Set<string>();
  const costs = latest.map(({ age, sex, monthly }) => {
    const range = ageRange(age);
    if (range === undefined) return fail(`it has an age group this build cannot read: "${age}".`);
    const key = `${range.fromAge} ${sex}`;
    if (seen.has(key)) fail(`it has two ${month} costs for "${age}"${sex ? `, ${sex}` : ""}.`);
    seen.add(key);
    return { age, ...range, sex, monthly };
  });
  return { plan, area, month, costs };
}

// ---- CPI

// The CPI values in a BLS API v1 answer for one series, by month, such as "2026-09".
export function parseCpi(text: string, file: string, series: string): Map<string, number> {
  const fail = (problem: string): never => {
    throw new Error(`${file}: ${problem}`);
  };
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    return fail("it is not a BLS API answer in JSON.");
  }
  const { status, Results } = (answer ?? {}) as { status?: unknown; Results?: unknown };
  if (status !== "REQUEST_SUCCEEDED") fail("BLS did not answer the request with data.");
  const [found] = ((Results as { series?: unknown[] } | undefined)?.series ?? []) as {
    seriesID?: unknown;
    data?: unknown;
  }[];
  if (found?.seriesID !== series) fail(`it does not hold the series ${series}.`);
  const values = new Map<string, number>();
  for (const point of Array.isArray(found?.data) ? found.data : []) {
    const { year, period, value } = point as { year?: unknown; period?: unknown; value?: unknown };
    const month = typeof period === "string" ? period.match(/^M(0[1-9]|1[0-2])$/)?.[1] : undefined;
    const number = cellNumber(typeof value === "string" ? value : undefined);
    if (typeof year !== "string" || month === undefined || number === null) continue;
    values.set(`${year}-${month}`, number);
  }
  return values;
}

type Cpi = { series: typeof CPI_ALL_ITEMS | typeof CPI_FOOD_AT_HOME; values: Map<string, number> };

function cpiForMonth({ series, values }: Cpi, month: string, file: string) {
  const value = values.get(month);
  if (value === undefined) throw new Error(`${file}: it has no ${series} value for ${month}.`);
  return { series, period: month, value };
}

// The mean CPI over the CE year or years, such as "2023-2024": the mean of the monthly values,
// to 3 decimals, as BLS rounds its annual averages.
function cpiForYears({ series, values }: Cpi, years: string, file: string) {
  const [first = 0, last = first] = years.split("-").map(Number);
  const months: number[] = [];
  const missing: string[] = [];
  for (let year = first; year <= last; year++) {
    for (let month = 1; month <= 12; month++) {
      const key = `${year}-${String(month).padStart(2, "0")}`;
      const value = values.get(key);
      if (value === undefined) missing.push(key);
      else months.push(value);
    }
  }
  if (missing.length > 0) {
    throw new Error(`${file}: it has no ${series} value for ${missing.join(", ")}.`);
  }
  const mean = months.reduce((sum, value) => sum + value, 0) / months.length;
  return { series, period: years, value: Math.round(mean * 1000) / 1000 };
}

// ---- The snapshot

// Reads one source file by its key. The CLI reads from a folder; tests read the fixtures.
export type ReadSource = (key: SourceKey) => Uint8Array;

export function buildBenchmarkSnapshot(
  read: ReadSource,
  // The ZIP table's sources. The schema checks their agencies.
  zipSources: readonly { agency: string; table: string; url: string; dataDate: string }[],
  sample: boolean,
): BenchmarkSnapshot {
  const text = (key: SourceKey) => new TextDecoder().decode(read(key));
  const firstSheet = (key: SourceKey): Sheet => {
    const [sheet] = readXlsx(read(key)).values();
    if (sheet === undefined) throw new Error(`${SOURCE_FILES[key].file}: it has no sheet.`);
    return sheet;
  };
  const allItems: Cpi = {
    series: CPI_ALL_ITEMS,
    values: parseCpi(text("cpiAllItems"), SOURCE_FILES.cpiAllItems.file, CPI_ALL_ITEMS),
  };
  const foodAtHome: Cpi = {
    series: CPI_FOOD_AT_HOME,
    values: parseCpi(text("cpiFoodAtHome"), SOURCE_FILES.cpiFoodAtHome.file, CPI_FOOD_AT_HOME),
  };
  const ceTable = (key: SourceKey): CeTable => {
    const table = parseCeTable(firstSheet(key), SOURCE_FILES[key].file);
    return {
      ...table,
      pricedAt: cpiForYears(allItems, table.years, SOURCE_FILES.cpiAllItems.file),
    };
  };
  const foodPlan = (key: SourceKey, plan: FoodPlan["plan"]): FoodPlan => {
    const sheets = readXlsx(read(key));
    if (key === "moderate") checkSizeAdjustment(sheets, SOURCE_FILES[key].file);
    const parsed = parseFoodPlan(sheets, SOURCE_FILES[key].file, plan);
    return {
      ...parsed,
      pricedAt: cpiForMonth(foodAtHome, parsed.month, SOURCE_FILES.cpiFoodAtHome.file),
    };
  };

  const byIncome = ceTable("ceByIncome");
  if (byIncome.years.includes("-")) {
    throw new Error(`${SOURCE_FILES.ceByIncome.file}: it covers ${byIncome.years}, not one year.`);
  }
  const sizeKeys = ["ceSize1", "ceSize2", "ceSize3", "ceSize4", "ceSize5"] as const;
  const bySizeAndIncome = sizeKeys.map((key, index) => ({ size: index + 1, table: ceTable(key) }));
  const moderate = foodPlan("moderate", "Moderate-Cost");
  const thrifty = {
    us: foodPlan("thriftyUs", "Thrifty"),
    alaska: foodPlan("thriftyAlaska", "Thrifty"),
    hawaii: foodPlan("thriftyHawaii", "Thrifty"),
  };
  const crossTabYears = bySizeAndIncome[0]?.table.years ?? "";
  const newest = (values: Map<string, number>) => [...values.keys()].sort().at(-1) ?? "";
  const bls = "Bureau of Labor Statistics" as const;
  const usda = "U.S. Department of Agriculture" as const;
  const sources = [
    {
      agency: bls,
      table: "Consumer Expenditure Survey, calendar-year table by income before taxes",
      url: CE_TABLES_PAGE,
      dataDate: byIncome.years,
    },
    {
      agency: bls,
      table: "Consumer Expenditure Survey, size of consumer unit by income before taxes",
      url: CE_TABLES_PAGE,
      dataDate: crossTabYears,
    },
    {
      agency: bls,
      table: `Consumer Price Index (CPI-U), all items, US city average (${CPI_ALL_ITEMS})`,
      url: cpiPage(CPI_ALL_ITEMS),
      dataDate: newest(allItems.values),
    },
    {
      agency: bls,
      table: `Consumer Price Index (CPI-U), food at home, US city average (${CPI_FOOD_AT_HOME})`,
      url: cpiPage(CPI_FOOD_AT_HOME),
      dataDate: newest(foodAtHome.values),
    },
    {
      agency: usda,
      table: "Cost of Food at Home, Moderate-Cost plan, US average",
      url: USDA_REPORTS_PAGE,
      dataDate: moderate.month,
    },
    ...(
      [
        ["US average", thrifty.us],
        ["Alaska", thrifty.alaska],
        ["Hawaii", thrifty.hawaii],
      ] as const
    ).map(([where, plan]) => ({
      agency: usda,
      table: `Cost of Food at Home, Thrifty plan, ${where}`,
      url: USDA_REPORTS_PAGE,
      dataDate: plan.month,
    })),
    ...zipSources,
  ];
  return benchmarkSnapshotSchema.parse({
    sample,
    ce: { dataYear: Number(byIncome.years), byIncome, bySizeAndIncome },
    food: {
      moderate,
      thrifty,
      sizeAdjustment: SIZE_ADJUSTMENT.map(({ fromSize, toSize, percent }) => ({
        fromSize,
        toSize,
        percent,
      })),
    },
    sources,
  });
}

// ---- docs/data-sources.md

export const SOURCES_START = "<!-- sources:start -->";
export const SOURCES_END = "<!-- sources:end -->";
export const MAP_START = "<!-- map:start -->";
export const MAP_END = "<!-- map:end -->";

function between(doc: string, start: string, end: string, body: string): string {
  const from = doc.indexOf(start);
  const to = doc.indexOf(end);
  if (from < 0 || to < from) throw new Error(`docs/data-sources.md lacks ${start} and ${end}.`);
  return `${doc.slice(0, from + start.length)}\n${body}\n${doc.slice(to)}`;
}

// docs/data-sources.md with its generated parts filled from the snapshot: the table of sources
// with their data dates, and the Category-to-CE-line map.
export function renderDataSources(doc: string, snapshot: BenchmarkSnapshot): string {
  const sources = [
    ...(snapshot.sample
      ? [
          `**${SAMPLE_NOTICE}.** The release script has not yet run on the real files. Every Benchmark figure the app ships now is made up.`,
          "",
        ]
      : []),
    "| Agency | Table | Data date |",
    "|---|---|---|",
    ...snapshot.sources.map(
      ({ agency, table, url, dataDate }) => `| ${agency} | [${table}](${url}) | ${dataDate} |`,
    ),
  ].join("\n");
  const map = [
    "| Category | Benchmark | CE lines |",
    "|---|---|---|",
    ...CATEGORIES.map(({ name }) => {
      const choice = CE_LINE_MAP[name];
      let lines = "None";
      if (choice?.kind === "by tenure") {
        lines = `Renters: ${choice.rent.join("; ")}. Owners: ${choice.own.join("; ")}.`;
      } else if (choice?.kind === "food plan and lines") {
        lines = `USDA Moderate-Cost plan, plus ${B_GS_CE_LINES.join("; ")}`;
      } else if (choice !== undefined) {
        lines = ceLinesOf(choice).join("; ");
      }
      return `| ${name} | ${BENCHMARK_ROLES[name]} | ${lines} |`;
    }),
  ].join("\n");
  return between(between(doc, SOURCES_START, SOURCES_END, sources), MAP_START, MAP_END, map);
}

// ---- The release check

// Why the release must not ship this snapshot, or undefined when it may.
export function releaseProblem(snapshot: BenchmarkSnapshot): string | undefined {
  if (!snapshot.sample) return undefined;
  return [
    `The Benchmark snapshot holds ${SAMPLE_NOTICE.toLowerCase()}: it was built from the made-up fixture files.`,
    "Download the source files as docs/data-sources.md says, then run node scripts/build-benchmark-snapshot.ts.",
  ].join("\n");
}
