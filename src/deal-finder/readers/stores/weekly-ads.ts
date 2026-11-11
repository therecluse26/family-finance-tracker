import type { FoundStore, WeeklyAdItem } from "../../adapter.ts";
import { calendarDate, cutText, parseCents } from "../checks.ts";
import { recordsIn } from "../http.ts";

// The weekly ads: `gratifying_graph/us-grocery-deals` (Flipp data), near the ZIP code. A search
// keeps 5 Deals per List item, with a price only (`onlyWithPrice`). Find Stores near us reads the
// flyers near the ZIP code to learn which chains print an ad there: an Aldi ad shows that an Aldi is
// near, and each local chain becomes a weekly-ad-only Store.

export const WEEKLY_ADS_ACTOR = "gratifying_graph/us-grocery-deals";
const DEALS_PER_SEARCH = 5;

// The Stores the app reads by their own reader. Their ads count for them, under their own ID.
const KNOWN_CHAINS: Readonly<Record<string, string>> = {
  aldi: "aldi",
  target: "target",
  costco: "costco",
  "costco wholesale": "costco",
  walmart: "walmart",
  kroger: "kroger",
  amazon: "amazon",
};

// A chain's Store ID: a known Store's own, else "ad-" and the chain's name in lower case, letters
// and digits only. Null when the name holds none.
export function adStoreId(merchant: string): string | null {
  const plain = merchant.trim().toLowerCase();
  const known = KNOWN_CHAINS[plain];
  if (known !== undefined) return known;
  const slug = plain
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug === "" ? null : `ad-${slug}`;
}

export const weeklyAdSearchInput = (zipCode: string, words: string[]) => ({
  actor: WEEKLY_ADS_ACTOR,
  input: {
    mode: "search",
    zipCodes: [zipCode],
    queries: words,
    maxItemsPerQuery: DEALS_PER_SEARCH,
    onlyWithPrice: true,
  },
});

// One ad item, or null when the checks drop it: it needs a chain, a name, a sale price, and real
// dates. A regular price counts only above the sale price.
export function weeklyAdItem(row: Record<string, unknown>): WeeklyAdItem | null {
  const merchant = cutText(row.merchant);
  const storeId = merchant === null ? null : adStoreId(merchant);
  const name = cutText(row.name);
  const dealPrice = parseCents(row.salePrice);
  const validFrom = calendarDate(row.validFrom);
  const validTo = calendarDate(row.validTo);
  if (storeId === null || name === null || dealPrice === null) return null;
  if (validFrom === null || validTo === null || validTo < validFrom) return null;
  const given =
    row.regularPrice !== null && row.regularPrice !== undefined && row.regularPrice !== "";
  const regular = given ? parseCents(row.regularPrice) : null;
  if (given && regular === null) return null;
  return {
    storeId,
    name,
    dealPrice,
    regularPrice: regular !== null && regular > dealPrice ? regular : null,
    validFrom,
    validTo,
  };
}

// Find Stores near us: one item from each flyer near the ZIP code.
export const weeklyAdFindInput = (zipCode: string) => ({
  actor: WEEKLY_ADS_ACTOR,
  input: {
    mode: "flyers",
    zipCodes: [zipCode],
    onlyWithPrice: true,
    maxItemsPerFlyer: 1,
    maxItems: 40,
  },
});

// The chains that print an ad near the ZIP code: Aldi, when its ad runs there, and each local chain
// as a weekly-ad-only Store. Target, Costco and the rest have their own lookups.
export function adStoresIn(rows: Record<string, unknown>[]): FoundStore[] {
  const found = new Map<string, FoundStore>();
  for (const row of recordsIn(rows)) {
    const name = cutText(row.merchant);
    const id = name === null ? null : adStoreId(name);
    if (name === null || id === null || found.has(id)) continue;
    if (id === "aldi") {
      found.set(id, {
        id,
        name: "Aldi",
        kind: "in person",
        reader: "Scraping service",
        locations: [],
      });
    } else if (id.startsWith("ad-")) {
      found.set(id, {
        id,
        name,
        kind: "weekly ad only",
        reader: "Scraping service",
        locations: [],
      });
    }
  }
  return [...found.values()];
}
