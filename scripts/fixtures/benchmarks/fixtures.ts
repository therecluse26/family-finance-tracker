import type { ReadSource, SourceKey } from "../../benchmark-snapshot.ts";
import { makeXlsx } from "./make-xlsx.ts";

// The made-up Benchmark source files: small copies of the BLS CE tables, the USDA food plan
// files, and the BLS API CPI answers, with the same rows and columns as the real files.
// EVERY NUMBER HERE IS MADE UP. NONE IS REAL DATA.
// The secret scan keeps .xlsx files out of git, since gitleaks cannot read them, so the tables
// live here as rows and are packed into .xlsx files when read.

export const NOT_REAL = "SAMPLE FILE: every number in it is made up, not real data.";
const files = new Map<SourceKey, Uint8Array>();
const write = (key: SourceKey, bytes: Uint8Array | string) =>
  files.set(key, typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);

// ---- CE tables. Four income columns; the last one's income after taxes is suppressed.

const HEADER = [
  ["Item", "All", "Less than", "$40,000", "$100,000", "$200,000"],
  ["", "consumer units", "$40,000", "to $99,999", "to $199,999", "and more"],
];

// Each CE row with its made-up mean in the "All consumer units" column. The other columns scale it.
const ITEMS: [string, number][] = [
  ["Food", 9000],
  ["Food at home", 5600],
  ["Food away from home", 3400],
  ["Alcoholic beverages", 500],
  ["Housing", 22000],
  ["Shelter", 14000],
  ["Owned dwellings", 8000],
  ["Mortgage interest and charges", 3000],
  ["Maintenance, repairs, insurance, other expenses", 1500],
  ["Rented dwellings", 5000],
  ["Other lodging", 1000],
  ["Utilities, fuels, and public services", 4300],
  ["Natural gas", 500],
  ["Electricity", 1700],
  ["Fuel oil and other fuels", 100],
  ["Telephone services", 1400],
  ["Water and other public services", 600],
  ["Household operations", 1800],
  ["Personal services", 500],
  ["Other household expenses", 1300],
  ["Housekeeping supplies", 800],
  ["Household furnishings and equipment", 2100],
  ["Apparel and services", 1900],
  ["Transportation", 12000],
  ["Vehicle purchases (net outlay)", 4600],
  ["Gasoline, other fuels, and motor oil", 2400],
  ["Other vehicle expenses", 4000],
  ["Vehicle finance charges", 400],
  ["Maintenance and repairs", 1100],
  ["Vehicle insurance", 1800],
  ["Vehicle rental, leases, licenses, and other charges", 700],
  ["Public and other transportation", 1000],
  ["Healthcare", 5800],
  ["Health insurance", 4000],
  ["Medical services", 1000],
  ["Drugs", 500],
  ["Medical supplies", 300],
  ["Entertainment", 3600],
  ["Fees and admissions", 900],
  ["Audio and visual equipment and services", 1200],
  ["Pets, toys, hobbies, and playground equipment", 1000],
  ["Pets", 800],
  ["Toys, hobbies, and playground equipment", 200],
  ["Other entertainment supplies, equipment, and services", 500],
  ["Personal care products and services", 900],
  ["Personal care products", 500],
  ["Personal care services", 400],
  ["Reading", 120],
  ["Education", 1400],
  ["Tobacco products and smoking supplies", 300],
  ["Miscellaneous", 1000],
  ["Cash contributions", 2000],
  ["Personal insurance and pensions", 9000],
  ["Life and other personal insurance", 500],
  ["Pensions and Social Security", 8500],
];

const SCALES = [1, 0.5, 0.9, 1.6, 2.8];
const money = (value: number) => String(Math.round(value));

function ceRows(title: string, scale: number): string[][] {
  const figures = (all: number, missingLast = false) =>
    SCALES.map((s, i) => (missingLast && i === SCALES.length - 1 ? "b/" : money(all * s * scale)));
  const item = (label: string, all: number) => [
    [label],
    ["Mean", ...figures(all)],
    ["Share", ...SCALES.map(() => "1.00")],
    ["SE", ...figures(all / 50)],
    ["CV(%)", ...SCALES.map(() => "2.00")],
  ];
  return [
    [title],
    [NOT_REAL],
    ...HEADER,
    ["Number of consumer units (in thousands)", ...figures(1000)],
    ["Consumer unit characteristics:"],
    ["Income before taxes", ...figures(90000)],
    ["Income after taxes 1/"],
    ["Mean", ...figures(80000, true)],
    ["SE", ...figures(800)],
    ["Average annual expenditures"],
    ["Mean", ...figures(75000)],
    ["SE", ...figures(900)],
    ["CV(%)", ...SCALES.map(() => "1.20")],
    ...ITEMS.flatMap(([label, all]) => item(label, all)),
  ];
}

const TABLE =
  "Annual expenditure means, shares, standard errors, and coefficients of variation, Consumer Expenditure Surveys";

write(
  "ceByIncome",
  makeXlsx([{ name: "Table", rows: ceRows(`Income before taxes: ${TABLE}, 2025`, 1) }]),
);
const SIZES = [
  "One person",
  "Two persons",
  "Three persons",
  "Four persons",
  "Five persons or more",
];
SIZES.forEach((size, index) => {
  const key = `ceSize${index + 1}` as SourceKey;
  const title = `Size of consumer unit, ${size}, by income before taxes: ${TABLE}, 2023-2024`;
  write(key, makeXlsx([{ name: "Table", rows: ceRows(title, 0.6 + index * 0.2) }]));
});

// ---- USDA food plans: a ReadMe sheet and a long table.

const README = [
  [NOT_REAL],
  ["This dataset is in the public domain and may be used without permission."],
  [
    "The costs given are for individuals in 4-person households. For individuals in other size households, the following adjustments for economies of scale are suggested: 1-person—add 20 percent; 2-person—add 10 percent; 3-person—add 5 percent; 4-person—no adjustment; 5- or 6-person—subtract 5 percent; 7- (or more) person—subtract 10 percent.",
  ],
];

const AGE_GROUPS: [string, string, number][] = [
  ["Child", "1 year", 150],
  ["Child", "2-3 years", 160],
  ["Child", "4-5 years", 170],
  ["Child", "6-8 years", 220],
  ["Child", "9-11 years", 250],
  ["Male", "12-13 years", 270],
  ["Male", "14-18 years", 280],
  ["Male", "19-50 years", 300],
  ["Male", "51-70 years", 290],
  ["Male", "71+ years", 280],
  ["Female", "12-13 years", 260],
  ["Female", "14-18 years", 255],
  ["Female", "19-50 years", 260],
  ["Female", "51-70 years", 255],
  ["Female", "71+ years", 250],
];

function foodPlan(plan: string, area: string, scale: number): Uint8Array {
  const rows = [
    [
      "geographic_area",
      "fam_indv",
      "group",
      "age",
      "year",
      "month",
      "food_plan",
      "frequency",
      "cost",
    ],
  ];
  for (const [month, rise] of [
    ["August", 1],
    ["September", 1.01],
  ] as const) {
    for (const [group, age, cost] of AGE_GROUPS) {
      const monthly = (cost * scale * rise).toFixed(1);
      const weekly = ((cost * scale * rise * 12) / 52).toFixed(1);
      rows.push([area, "Individual", group, age, "2026", month, plan, "Monthly", monthly]);
      rows.push([area, "Individual", group, age, "2026", month, plan, "Weekly", weekly]);
    }
    const family = (1100 * scale * rise).toFixed(1);
    rows.push([
      area,
      "Family",
      "Family of 4",
      "6-8 and 9-11",
      "2026",
      month,
      plan,
      "Monthly",
      family,
    ]);
  }
  return makeXlsx([
    { name: "ReadMe", rows: README },
    { name: "Data", rows },
  ]);
}

write("moderate", foodPlan("Moderate-Cost", "U.S. average", 1.3));
write("thriftyUs", foodPlan("Thrifty", "U.S. average", 1));
write("thriftyAlaska", foodPlan("Thrifty", "Alaska", 1.3));
write("thriftyHawaii", foodPlan("Thrifty", "Hawaii", 1.6));

// ---- CPI: BLS API v1 answers, months 2023-01 to 2026-09, newest first as BLS lists them.

function cpi(series: string, start: number): string {
  const data = [];
  for (let year = 2026; year >= 2023; year--) {
    for (let month = 12; month >= 1; month--) {
      if (year === 2026 && month > 9) continue;
      const value = (start + (year - 2023) * 12 + month).toFixed(3);
      data.push({
        year: String(year),
        period: `M${String(month).padStart(2, "0")}`,
        periodName: new Date(Date.UTC(year, month - 1)).toLocaleString("en-US", {
          month: "long",
          timeZone: "UTC",
        }),
        value,
        footnotes: [{}],
      });
    }
  }
  return `${JSON.stringify(
    {
      status: "REQUEST_SUCCEEDED",
      responseTime: 1,
      message: [NOT_REAL],
      Results: { series: [{ seriesID: series, data }] },
    },
    null,
    2,
  )}\n`;
}

write("cpiAllItems", cpi("CUUR0000SA0", 300));
write("cpiFoodAtHome", cpi("CUUR0000SAF11", 290));

// Reads a made-up source file, as the release script reads a real one.
export const readFixture: ReadSource = (key) => {
  const bytes = files.get(key);
  if (bytes === undefined) throw new Error(`No fixture for ${key}.`);
  return bytes;
};
