import type { StoreLocation } from "../../adapter.ts";
import { checkedProduct, cutText, readKeyOf } from "../checks.ts";
import { isRecord } from "../http.ts";
import type { ApifyStore, Place } from "./store.ts";

// Walmart: `gauravlabs/walmart-search-api`, by ZIP code. Its `storeId` input failed 2 of 2 runs
// (spike round 14), so the Actor picks the store from the ZIP code, and the reader never sends a
// store ID. Paid ads are left out with `excludeSponsored`, which costs nothing.

export const WALMART_ACTOR = "gauravlabs/walmart-search-api";
const ITEM_ID = /^\d{1,20}$/;

const zipOf = (place: Place) => (place.zipCode === null ? {} : { zipcode: place.zipCode });

// A Walmart link as the Actor gives it, whole or from the site's root.
const linkOf = (value: unknown) =>
  typeof value === "string" && value.startsWith("/ip/") ? `https://www.walmart.com${value}` : value;

function walmartProduct(row: Record<string, unknown>) {
  return checkedProduct("walmart", {
    readKey: readKeyOf(row.usItemId, ITEM_ID),
    name: row.title,
    brand: row.brand,
    size: row.size,
    upc: row.upc,
    link: linkOf(row.url),
    regularPrice: row.price,
  });
}

export const walmart: ApifyStore = {
  id: "walmart",
  actor: WALMART_ACTOR,
  searchInput: (search) => ({
    actor: WALMART_ACTOR,
    input: {
      queries: search.words,
      maxResultsPerQuery: search.productCount,
      excludeSponsored: true,
      ...zipOf(search),
    },
  }),
  product: walmartProduct,
  // Walmart charges per search, so a re-read is a search for the item number.
  readInput: (readKey, place) => {
    const itemId = readKeyOf(readKey, ITEM_ID);
    if (itemId === null) return null;
    return {
      actor: WALMART_ACTOR,
      input: { queries: [itemId], maxResultsPerQuery: 5, excludeSponsored: true, ...zipOf(place) },
      product: (row) => {
        const product = walmartProduct(row);
        return product?.readKey === itemId ? product : null;
      },
    };
  },
};

// Find Stores near us: one search with the ZIP code. Its row names the store the Actor picked.
export const walmartFindInput = (zipCode: string) => ({
  actor: WALMART_ACTOR,
  input: { queries: ["milk"], maxResultsPerQuery: 1, excludeSponsored: true, zipcode: zipCode },
});

export function walmartStoreIn(rows: Record<string, unknown>[]): StoreLocation | null {
  for (const row of rows) {
    const store = isRecord(row.store) ? row.store : null;
    const id = readKeyOf(store?.store_id, ITEM_ID);
    const distance = store?.distance;
    if (store === null || id === null) continue;
    if (typeof distance !== "number" || !Number.isFinite(distance) || distance < 0) continue;
    return { id, name: cutText(store.name) ?? "Walmart", distanceMiles: distance };
  }
  return null;
}
