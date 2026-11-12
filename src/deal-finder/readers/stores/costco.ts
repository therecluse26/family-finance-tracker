import type { StoreLocation } from "../../adapter.ts";
import { checkedProduct, cutText, readKeyOf } from "../checks.ts";
import { recordsIn } from "../http.ts";
import type { ApifyStore, Place } from "./store.ts";

// Costco: `vant47/costco-scraper`, at the Home store's warehouse by `storeIds`, else near the ZIP
// code by `locations`, else at Costco's default warehouse. The warehouse list for Find Stores near
// us comes from `dromb/costco-us` (spike round 14). The plan uses the warehouse price
// (`warehousePrice`); a Product with none keeps only its online price (`onlinePrice`), which the
// plan labels "Online price". A deal read sets `dealsOnly`. Its re-read key is the item number.

export const COSTCO_ACTOR = "vant47/costco-scraper";
export const COSTCO_WAREHOUSES_ACTOR = "dromb/costco-us";
const ITEM_NUMBER = /^\d{1,20}$/;
const WAREHOUSE_ID = /^\d{1,6}$/;

// The warehouse, sent only with the ZIP code switch on.
function placeOf(place: Place): Record<string, unknown> {
  if (place.zipCode === null) return {};
  const warehouse = readKeyOf(place.homeStoreId, WAREHOUSE_ID);
  return warehouse === null ? { locations: [place.zipCode] } : { storeIds: [warehouse] };
}

// Costco leaves a price it does not have empty or 0, so 0 counts as no price here.
const priceOf = (value: unknown) => (value === 0 ? null : value);

function costcoProduct(row: Record<string, unknown>) {
  const warehouse = priceOf(row.warehousePrice);
  const onSale = row.onSale === true;
  return checkedProduct("costco", {
    readKey: readKeyOf(row.itemNumber, ITEM_NUMBER),
    name: row.title,
    brand: row.brand,
    size: row.size,
    link: row.url,
    regularPrice: warehouse,
    dealPrice: onSale && warehouse !== null ? priceOf(row.salePrice) : null,
    dealEndsOn: row.promoEndDate,
    onlinePrice: priceOf(row.onlinePrice),
  });
}

export const costco: ApifyStore = {
  id: "costco",
  actor: COSTCO_ACTOR,
  searchInput: (search) => ({
    actor: COSTCO_ACTOR,
    input: {
      searchTerms: search.words,
      maxItemsPerSearch: search.productCount,
      maxItems: search.productCount * search.words.length,
      ...(search.dealsOnly ? { dealsOnly: true } : {}),
      ...placeOf(search),
    },
  }),
  product: costcoProduct,
  readInput: (readKey, place) => {
    const itemNumber = readKeyOf(readKey, ITEM_NUMBER);
    if (itemNumber === null) return null;
    return {
      actor: COSTCO_ACTOR,
      input: { productIds: [itemNumber], maxItems: 1, ...placeOf(place) },
      product: (row) => {
        const product = costcoProduct(row);
        return product?.readKey === itemNumber ? product : null;
      },
    };
  },
};

// Find Stores near us: the 5 nearest warehouses.
export const costcoFindInput = (zipCode: string) => ({
  actor: COSTCO_WAREHOUSES_ACTOR,
  input: { operation: "warehouses", postalCode: zipCode, autoResolveLocation: true, limit: 5 },
});

// A warehouse row's `warehouse_id` is its number, a dash and 2 lower-case letters, such as
// "1234-ab".
const WAREHOUSE_CODE = /^(\d{1,6})-[a-z]{2}$/;

// Each warehouse, by its number: `id`, all digits, as `vant47`'s `storeIds` takes it. Only a row
// with no `id` falls back to the digits before the dash in `warehouse_id`.
export function costcoWarehousesIn(rows: Record<string, unknown>[]): StoreLocation[] {
  return recordsIn(rows).flatMap((row) => {
    const id =
      row.id === undefined || row.id === null
        ? (WAREHOUSE_CODE.exec(String(row.warehouse_id ?? ""))?.[1] ?? null)
        : readKeyOf(row.id, WAREHOUSE_ID);
    const distance = row.distance_miles;
    if (id === null || typeof distance !== "number" || !Number.isFinite(distance)) return [];
    return [{ id, name: cutText(row.name) ?? "Costco", distanceMiles: distance }];
  });
}
