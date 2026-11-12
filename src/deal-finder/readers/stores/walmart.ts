import type { ActorEvents } from "../apify.ts";
import { checkedProduct, cutText, parseCents, readKeyOf } from "../checks.ts";
import type { ApifyStore, Place } from "./store.ts";

// Walmart: `burbn/walmart-product-search`, by ZIP code (owner decision, 2026-11-11: the earlier
// Actor stopped taking the owner's runs). It takes one query a run and has no Home store: Walmart's
// prices are for the ZIP code. It charges per run and per row, about $0.88 for one page of about
// 40 rows. It has no field to leave paid ads out, so the reader drops them.

export const WALMART_ACTOR = "burbn/walmart-product-search";
// Its charged events (owner's run, 2026-11-12): $0.02 a start event, one for each GB of its 4 GB,
// and $0.02 a row.
export const WALMART_EVENTS: ActorEvents = {
  start: "apify-actor-start",
  row: "apify-default-dataset-item",
};
const ITEM_ID = /^\d{1,20}$/;

// The ZIP code, sent only with the ZIP code switch on: it names a place.
const zipOf = (place: Place) => (place.zipCode === null ? {} : { zip: place.zipCode });

// One run: the words as one query, one page of results.
const searchOf = (query: string, place: Place) => ({
  actor: WALMART_ACTOR,
  input: { query, domain: "us", maxPages: 1, ...zipOf(place) },
});

// A Walmart link as the Actor gives it, whole or from the site's root.
const linkOf = (value: unknown) =>
  typeof value === "string" && value.startsWith("/ip/") ? `https://www.walmart.com${value}` : value;

// A row the store sells: not a paid ad, not out of stock, and for pickup or delivery from the
// store. A row sold only online, such as by a marketplace seller, is not the store's price.
const atStore = (row: Record<string, unknown>) =>
  row.sponsored !== true &&
  row.outOfStock !== true &&
  (row.pickup === true || row.deliveryFromStore === true);

// A sale shows as a price below `listPrice`. The row gives no size field, so the size is read
// from the title, as for any Product with none.
function walmartProduct(row: Record<string, unknown>) {
  if (!atStore(row)) return null;
  const price = parseCents(row.price);
  const listPrice = parseCents(row.listPrice);
  const sale = price !== null && listPrice !== null && price < listPrice;
  return checkedProduct("walmart", {
    readKey: readKeyOf(row.usItemId, ITEM_ID),
    name: row.title,
    brand: row.brand,
    link: linkOf(row.url),
    regularPrice: sale ? row.listPrice : row.price,
    dealPrice: sale ? row.price : null,
  });
}

export const walmart: ApifyStore = {
  id: "walmart",
  actor: WALMART_ACTOR,
  searchInput: (search) => searchOf(search.words.join(" "), search),
  product: walmartProduct,
  // The Actor has no lookup by item number, so a re-read is one search for the Product's saved
  // name, at the same cost as a search (about $0.88), keeping only the row with the same item
  // number. Plan runs search Walmart again instead, as it costs the same.
  readInput: (readKey, place, name) => {
    const itemId = readKeyOf(readKey, ITEM_ID);
    const query = cutText(name);
    if (itemId === null || query === null) return null;
    return {
      ...searchOf(query, place),
      product: (row) => {
        const product = walmartProduct(row);
        return product?.readKey === itemId ? product : null;
      },
    };
  },
};
