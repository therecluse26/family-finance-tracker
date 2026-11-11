// The Price sources page as Settings sees it (spec 15, The Price sources page in Settings). No key
// is ever in it: only each key's last 4 characters. This file imports nothing, so the web app's
// type check can follow it.

// The distances Find Stores near us takes, in miles. The default is 25.
export const FIND_STORES_MILES = [10, 25, 50] as const;
export type FindStoresMiles = (typeof FIND_STORES_MILES)[number];
export const DEFAULT_FIND_STORES_MILES: FindStoresMiles = 25;

// At most 12 Stores are on at once, so a plan checks at most 4,096 sets (spec 15, How app code
// builds the plan).
export const MAX_STORES_ON = 12;

// The Shopping list holds at most 100 List items.
export const MAX_LIST_ITEMS = 100;

// Price history is kept 400 days (spec 15, Prices and Deals).
export const PRICE_HISTORY_DAYS = 400;

// The Price source cost cap's default, Apify's Free plan credit, and the trip setting's default.
export const DEFAULT_PRICE_SOURCE_COST_CAP_CENTS = 500;
export const DEFAULT_TRIP_SAVING_CENTS = 1000;
// The highest Price source cost cap, and the highest delivery fee or free-delivery amount: $10,000.
export const MAX_PRICE_SOURCE_COST_CAP_CENTS = 1_000_000;
export const MAX_DELIVERY_CENTS = 1_000_000;

// The Price sources that take a key: the Scraping service (Apify) and the Kroger API.
export const KEYED_PRICE_SOURCES = ["apify", "kroger"] as const;
export type KeyedPriceSource = (typeof KEYED_PRICE_SOURCES)[number];

// What the last Test found.
export type PriceSourceCheck = "passed" | "refused" | "usage limit" | "no answer";

export type PriceSourceStoreView = {
  id: string;
  name: string;
  kind: "in person" | "online" | "weekly ad only";
  reader: "Store API" | "Scraping service";
  on: boolean;
  // Without the ZIP switch on, this Store cannot be read: Kroger, Aldi, and the weekly ads.
  needsZip: boolean;
  // The Home store, and the nearest-first locations to pick it from. A Store whose reader picks its
  // own store has one location or none, so it offers no Change.
  homeStore: { id: string; name: string } | null;
  distanceMiles: number | null;
  locations: { id: string; name: string; distanceMiles: number }[];
  // In cents. Null means none.
  deliveryFee: number | null;
  freeDeliveryFrom: number | null;
  lastGoodReadAt: string | null;
};

export type PriceSourcesView = {
  apify: {
    tokenLast4: string | null;
    check: PriceSourceCheck | null;
    checkedAt: string | null;
  };
  kroger: {
    clientIdLast4: string | null;
    clientSecretLast4: string | null;
    check: PriceSourceCheck | null;
    checkedAt: string | null;
  };
  openFoodFacts: boolean;
  // "Use our ZIP code to find stores", with the ZIP code from the Household facts. `changed` is
  // true when the Stores were found for another ZIP code.
  zip: { on: boolean; zipCode: string | null; changed: boolean };
  findDistanceMiles: FindStoresMiles;
  storesFoundAt: string | null;
  // In cents, and this month's cost in billionths of a dollar.
  costCap: number;
  monthCostNanos: number;
  stores: PriceSourceStoreView[];
  // What "Delete all deal finder data" removes.
  data: { products: number; priceReads: number; matches: number; plans: number };
};

export type SaveKeyOutcome = { outcome: "saved"; view: PriceSourcesView };

export type PriceSourceTestOutcome =
  | { outcome: "tested"; check: PriceSourceCheck; view: PriceSourcesView }
  | { outcome: "no key" | "no reader" | "busy" | "changed" };

export type FindStoresOutcome =
  | { outcome: "found"; view: PriceSourcesView }
  | {
      outcome:
        | "zip off"
        | "no zip code"
        | "no reader"
        | "busy"
        | "refused key"
        | "usage limit"
        | "failed";
    };

export type StoreChanges = {
  on?: boolean;
  homeStoreId?: string;
  deliveryFee?: number | null;
  freeDeliveryFrom?: number | null;
};

export type StoreChangeOutcome =
  | { outcome: "changed"; view: PriceSourcesView }
  | { outcome: "no store" | "too many on" | "no such location" };

export type PriceSourceSettings = {
  view(): Promise<PriceSourcesView>;
  // Saves a key, encrypted. Its last Test is cleared.
  saveApifyToken(token: string): Promise<PriceSourcesView>;
  saveKrogerKeys(keys: { clientId: string; clientSecret: string }): Promise<PriceSourcesView>;
  // One small call with the saved key: an Apify account read, or a Kroger token request. One Test
  // of each source runs at a time.
  test(source: KeyedPriceSource): Promise<PriceSourceTestOutcome>;
  setOpenFoodFacts(on: boolean): Promise<PriceSourcesView>;
  setUseZip(on: boolean): Promise<PriceSourcesView>;
  // Find Stores near us, within the distance. One lookup runs at a time.
  findStores(miles: FindStoresMiles): Promise<FindStoresOutcome>;
  changeStore(id: string, changes: StoreChanges): Promise<StoreChangeOutcome>;
  setCostCap(cents: number): Promise<PriceSourcesView>;
  // Every Product, price, match and plan. It keeps the Shopping list, the Stores and the keys.
  deleteAll(): Promise<PriceSourcesView>;
};
