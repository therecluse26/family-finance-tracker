import { checkedProduct, storeLink } from "../checks.ts";
import type { ApifyStore } from "./store.ts";

// Aldi: `blackfalcondata/aldi-us-scraper`, with the ZIP code as `location`. The Actor picks the
// store, and gives no price without one, so Aldi needs the ZIP code. It takes one query a run
// (spike round 12), so it gets one run per List item. A brand lock also goes in its `brand` filter,
// and a deal read sets `onSaleOnly`. Its re-read key is the Product link, which `startUrls` takes.

export const ALDI_ACTOR = "blackfalcondata/aldi-us-scraper";

function aldiProduct(row: Record<string, unknown>) {
  const link = storeLink("aldi", row.url);
  const onSale = row.isOnSale === true;
  return checkedProduct("aldi", {
    readKey: link,
    name: row.title,
    brand: row.brand,
    size: row.size,
    link,
    regularPrice: onSale && row.regularPrice != null ? row.regularPrice : row.priceValue,
    dealPrice: onSale && row.regularPrice != null ? row.priceValue : null,
  });
}

export const aldi: ApifyStore = {
  id: "aldi",
  actor: ALDI_ACTOR,
  searchInput: (search) => {
    const [query] = search.words;
    if (search.zipCode === null || query === undefined) return null;
    return {
      actor: ALDI_ACTOR,
      input: {
        location: search.zipCode,
        query,
        maxResults: search.productCount,
        ...(search.brand === null ? {} : { brand: search.brand }),
        ...(search.dealsOnly ? { onSaleOnly: true } : {}),
      },
    };
  },
  product: aldiProduct,
  readInput: (readKey, place) => {
    const link = storeLink("aldi", readKey);
    if (link === null || place.zipCode === null) return null;
    return {
      actor: ALDI_ACTOR,
      input: { location: place.zipCode, startUrls: [{ url: link }], maxResults: 1 },
      product: (row) => {
        const product = aldiProduct(row);
        return product?.readKey === link ? product : null;
      },
    };
  },
};
