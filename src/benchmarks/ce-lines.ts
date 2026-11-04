import type { Category } from "../categories/index.ts";

// The Category-to-CE-line map (spec 05, The Benchmark for a Category). It is our own work, under
// the AGPL, not government data. It follows section 7.3 of the Transaction categorization research,
// refined to the lines the CE tables by income publish. Each CE line belongs to at most one
// Category, so no Spending counts twice.

// The CE lines the map uses, as the CE tables label them. The release script fails when a CE
// table lacks one.
export const CE_LINES = [
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
] as const;

export type CeLine = (typeof CE_LINES)[number];

// What each Category's Benchmark does (spec 05, Which Categories have a Benchmark).
// - "drafts": the Benchmark drafts the Category's Budget.
// - "drafts shared": Groceries and Superstores share B_GS, which drafts both Budgets.
// - "context": the Benchmark only gives a Bills Budget its context line.
// - "none": the Category has no Benchmark.
export type BenchmarkRole = "drafts" | "drafts shared" | "context" | "none";

export const BENCHMARK_ROLES: Readonly<Record<Category, BenchmarkRole>> = Object.freeze({
  Housing: "context",
  Utilities: "context",
  "Phone and internet": "context",
  Insurance: "context",
  "Taxes and government": "none",
  "Interest and fees": "none",
  Groceries: "drafts shared",
  Superstores: "drafts shared",
  Clothing: "drafts",
  "Home and garden": "drafts",
  "Alcohol and tobacco": "drafts",
  "General goods": "none",
  Gas: "drafts",
  Car: "drafts",
  "Transit and rideshare": "drafts",
  Health: "drafts",
  "Personal care": "drafts",
  Childcare: "drafts",
  Pets: "drafts",
  Fitness: "drafts",
  Restaurants: "drafts",
  Entertainment: "drafts",
  Hobbies: "drafts",
  Travel: "none",
  "Books and education": "drafts",
  "Gifts and donations": "none",
  "Payments to people": "none",
  Cash: "none",
  Services: "none",
  Miscellaneous: "none",
});

// The CE lines of one Category.
// - "lines": the share is the sum of these lines.
// - "by tenure": Housing takes rented dwellings for a Household that rents, and owned dwellings
//   for one that owns (spec 05, Household facts).
// - "food plan and lines": B_GS, the USDA Moderate-Cost plan plus the share of these lines.
export type CeLineChoice =
  | { readonly kind: "lines"; readonly lines: readonly CeLine[] }
  | {
      readonly kind: "by tenure";
      readonly rent: readonly CeLine[];
      readonly own: readonly CeLine[];
    }
  | { readonly kind: "food plan and lines"; readonly lines: readonly CeLine[] };

// The CE lines of B_GS: the household supplies and personal-care products a Superstore sells
// beside food at home.
export const B_GS_CE_LINES: readonly CeLine[] = Object.freeze([
  "Housekeeping supplies",
  "Personal care products",
]);

const lines = (...chosen: CeLine[]): CeLineChoice =>
  Object.freeze({ kind: "lines", lines: Object.freeze(chosen) });

const bGs: CeLineChoice = Object.freeze({ kind: "food plan and lines", lines: B_GS_CE_LINES });

export const CE_LINE_MAP: Readonly<Partial<Record<Category, CeLineChoice>>> = Object.freeze({
  Housing: Object.freeze({
    kind: "by tenure",
    rent: Object.freeze<CeLine[]>(["Rented dwellings"]),
    own: Object.freeze<CeLine[]>(["Owned dwellings"]),
  }),
  Utilities: lines(
    "Natural gas",
    "Electricity",
    "Fuel oil and other fuels",
    "Water and other public services",
  ),
  // CE counts internet service under other household expenses and cable TV under entertainment.
  "Phone and internet": lines("Telephone services"),
  // Several CE lines, not one major group (spec 05). CE folds homeowner's insurance into the
  // owned-dwellings upkeep line, so it is left out here.
  Insurance: lines("Vehicle insurance", "Health insurance", "Life and other personal insurance"),
  Groceries: bGs,
  Superstores: bGs,
  Clothing: lines("Apparel and services"),
  "Home and garden": lines("Household furnishings and equipment", "Other household expenses"),
  "Alcohol and tobacco": lines("Alcoholic beverages", "Tobacco products and smoking supplies"),
  Gas: lines("Gasoline, other fuels, and motor oil"),
  // A vehicle purchase is a lump in CE and a loan payment at the bank, so it is left out.
  Car: lines("Maintenance and repairs", "Vehicle rental, leases, licenses, and other charges"),
  "Transit and rideshare": lines("Public and other transportation"),
  Health: lines("Medical services", "Drugs", "Medical supplies"),
  // Only the services: the products sit in B_GS (spec 05).
  "Personal care": lines("Personal care services"),
  // CE's personal services are babysitting, day care, and care for the elderly.
  Childcare: lines("Personal services"),
  Pets: lines("Pets"),
  // Research 7.3 gives Fitness CE fees and admissions: gyms, clubs, and sports fees, with tickets.
  Fitness: lines("Fees and admissions"),
  Restaurants: lines("Food away from home"),
  Entertainment: lines("Audio and visual equipment and services"),
  // Toys and hobbies, and sporting goods, which CE counts in other entertainment supplies.
  Hobbies: lines(
    "Toys, hobbies, and playground equipment",
    "Other entertainment supplies, equipment, and services",
  ),
  // Several CE lines (spec 05). Travel has no Benchmark, so it drafts no Budget, and its lines may
  // be shared: the CE tables by income do not part airfares from local transit.
  Travel: lines("Other lodging", "Public and other transportation"),
  "Books and education": lines("Reading", "Education"),
});

// Every CE line a Category uses.
export function ceLinesOf(choice: CeLineChoice): readonly CeLine[] {
  return choice.kind === "by tenure" ? [...choice.rent, ...choice.own] : choice.lines;
}
