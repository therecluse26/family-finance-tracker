import type { StoreLocation } from "../../adapter.ts";
import { checkedProduct, cutText, readKeyOf } from "../checks.ts";
import { isRecord, recordsIn } from "../http.ts";
import type { ApifyStore, Place } from "./store.ts";

// Target: `litescrape/target-search` at the Home store's `store_id`, and Apify's own
// `apify/e-commerce-scraping-tool` for one Product's page. The Home store comes from
// `axlymxp/target-store-scraper` near the ZIP code (spike round 12).

export const TARGET_ACTOR = "litescrape/target-search";
export const TARGET_PAGE_ACTOR = "apify/e-commerce-scraping-tool";
export const TARGET_STORES_ACTOR = "axlymxp/target-store-scraper";
// `maxResults` caps the whole run, not each search, so it is 25 per List item.
const RESULTS_PER_SEARCH = 25;
const TCIN = /^\d{1,12}$/;
// target-search's `store_id` takes 1 to 6 digits.
const STORE_ID = /^\d{1,6}$/;

// The Home store's ID, sent only with the ZIP code switch on: it names a place.
const storeOf = (place: Place) => {
  const id = place.zipCode === null ? null : readKeyOf(place.homeStoreId, STORE_ID);
  return id === null ? {} : { store_id: id };
};

// A price as a number of dollars, or as `{ amount }`.
const amountOf = (value: unknown) => (isRecord(value) ? value.amount : value);

const pageOf = (tcin: string) => `https://www.target.com/p/-/A-${tcin}`;

export const target: ApifyStore = {
  id: "target",
  actor: TARGET_ACTOR,
  searchInput: (search) => ({
    actor: TARGET_ACTOR,
    input: {
      requests: search.words.map((query) => ({ query })),
      datasetOutput: true,
      maxResults: RESULTS_PER_SEARCH * search.words.length,
      ...storeOf(search),
    },
  }),
  // A sale shows as a price below `original_price`.
  product: (row) => {
    const data = isRecord(row.data) ? row.data : row;
    const price = amountOf(data.price);
    const original = amountOf(data.original_price);
    const sale = typeof price === "number" && typeof original === "number" && price < original;
    return checkedProduct("target", {
      readKey: readKeyOf(data.tcin, TCIN),
      name: data.title,
      brand: data.brand,
      size: data.size,
      upc: data.upc,
      link: data.url,
      regularPrice: sale ? original : price,
      dealPrice: sale ? price : null,
    });
  },
  // One Product's page, through Apify's own Actor. It reads the site's default store.
  readInput: (readKey) => {
    const tcin = readKeyOf(readKey, TCIN);
    if (tcin === null) return null;
    return {
      actor: TARGET_PAGE_ACTOR,
      input: { scrapeMode: "AUTO", detailsUrls: [{ url: pageOf(tcin) }], maxProductResults: 1 },
      product: (row) => {
        const offers = Array.isArray(row.offers) ? row.offers[0] : row.offers;
        return checkedProduct("target", {
          readKey: tcin,
          name: row.name,
          brand: isRecord(row.brand) ? row.brand.name : row.brand,
          link: row.url,
          regularPrice: isRecord(offers) ? offers.price : null,
        });
      },
    };
  },
};

// Find Stores near us: up to 5 nearest open stores within the distance.
export const targetFindInput = (zipCode: string, miles: number) => ({
  actor: TARGET_STORES_ACTOR,
  input: { locations: [zipCode], within: miles, limit: 5 },
});

export function targetStoresIn(rows: Record<string, unknown>[]): StoreLocation[] {
  return recordsIn(rows).flatMap((row) => {
    const id = readKeyOf(row.storeId, STORE_ID);
    const distance = row.distanceMiles;
    const open = row.status === undefined || /^open/i.test(String(row.status));
    if (id === null || !open || typeof distance !== "number" || !Number.isFinite(distance)) {
      return [];
    }
    return [{ id, name: cutText(row.name) ?? "Target", distanceMiles: distance }];
  });
}
