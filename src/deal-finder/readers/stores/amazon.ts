import type { ActorEvents } from "../apify.ts";
import { checkedProduct, parseCents, readKeyOf } from "../checks.ts";
import type { ApifyStore } from "./store.ts";

// Amazon: `delicious_zebu/amazon-product-data-scraper`. Amazon has one price for the US, so the
// reader never sends the ZIP code. The regular price is the list price, else the current price; a
// coupon is a Deal. A re-read searches for the ASIN, which gives that one Product (spike round 14):
// Product links return nothing.

export const AMAZON_ACTOR = "delicious_zebu/amazon-product-data-scraper";
export const AMAZON_EVENTS: ActorEvents = {
  start: "apify-actor-start",
  row: "apify-default-dataset-item",
};
const ASIN = /^[A-Z0-9]{10}$/;

const common = { website: "amazon.com", deliverTo: "US", scrapeProductDetails: false };

// A coupon's saving, in cents, off a price: "Save $1.00" or "Save 15%". Null when it reads as
// neither, or leaves no price.
export function couponPrice(priceCents: number, coupon: unknown): number | null {
  if (typeof coupon !== "string") return null;
  const dollars = /\$\s?(\d{1,4}(?:\.\d{1,2})?)/.exec(coupon);
  const percent = /(\d{1,2})\s?%/.exec(coupon);
  let off: number | null = null;
  if (dollars?.[1] !== undefined) off = parseCents(dollars[1]);
  else if (percent?.[1] !== undefined) off = Math.round((priceCents * Number(percent[1])) / 100);
  if (off === null || off <= 0 || off >= priceCents) return null;
  return priceCents - off;
}

function amazonProduct(row: Record<string, unknown>) {
  const price = parseCents(row.price_value);
  // A current price that fails the checks drops the Product, even beside a list price.
  if (price === null && row.price_value !== null && row.price_value !== undefined) return null;
  const list = row.list_price_value;
  const coupon = price === null ? null : couponPrice(price, row.coupon);
  return checkedProduct("amazon", {
    readKey: readKeyOf(row.asin, ASIN),
    name: row.title,
    brand: row.brand,
    link: row.url,
    regularPrice: list === null || list === undefined || list === "" ? row.price_value : list,
    dealPrice: coupon === null ? null : coupon / 100,
  });
}

export const amazon: ApifyStore = {
  id: "amazon",
  actor: AMAZON_ACTOR,
  searchInput: (search) => ({
    actor: AMAZON_ACTOR,
    input: { Keywords: search.words, maxItems: search.productCount, ...common },
  }),
  product: amazonProduct,
  readInput: (readKey) => {
    const asin = readKeyOf(readKey, ASIN);
    if (asin === null) return null;
    return {
      actor: AMAZON_ACTOR,
      input: { Keywords: [asin], maxItems: 1, ...common },
      product: (row) => {
        const product = amazonProduct(row);
        return product?.readKey === asin ? product : null;
      },
    };
  },
};
