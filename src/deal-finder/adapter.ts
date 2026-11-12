import type { FindStoresMiles } from "./view.ts";

// The Price source adapter (spec 15, Price sources): one interface, like the Bank-data adapter.
// Each Price source maps these calls to its own API. A fake adapter serves every test and every
// development run. An adapter throws only a PriceSourceError: no raw error from a source leaves it,
// since one can hold a key or a request.

// The keys a Member saved, decrypted. A source with no saved key is absent.
export type PriceSourceKeys = {
  apifyToken?: string;
  kroger?: { clientId: string; clientSecret: string };
};

// A run's cost, in billionths of a dollar, when the source reports one. A free call, such as the
// Kroger API's, reports none.
export type Costed<T> = { value: T; costNanos: number | null };

export type StoreLocation = { id: string; name: string; distanceMiles: number };

// One Store that Find Stores near us found (spec 15, Find Stores near us, step 3).
export type FoundStore = {
  // The chain, such as "kroger", or "ad-" and a local chain's name for a weekly-ad-only Store.
  id: string;
  name: string;
  kind: "in person" | "online" | "weekly ad only";
  reader: "Store API" | "Scraping service";
  // Nearest first. Empty for a Store whose reader picks its own store from the ZIP code, and for an
  // online Store.
  locations: StoreLocation[];
};

// What Find Stores near us learned about one supported Store: found, with its locations; none
// within the distance; or a lookup that failed, with its PriceSourceError kind. A failed lookup is
// not "none": the Store keeps what an earlier lookup found.
export type StoreLookup =
  | { storeId: string; outcome: "found"; store: FoundStore }
  | { storeId: string; outcome: "none" }
  | { storeId: string; outcome: "failed"; failure: PriceSourceErrorKind };

export type FoundLocations = {
  // One for each supported Store looked up. A Store whose Price source has no saved key is not.
  lookups: StoreLookup[];
  // The weekly-ad-only Stores found, or null when their lookup failed or did not run.
  weeklyAds: FoundStore[] | null;
};

// One Product and its prices, as a Store gives them. Prices are whole cents.
export type ProductRead = {
  // The Store's re-read key: its item number, ASIN, or Product link.
  readKey: string;
  name: string;
  brand: string | null;
  size: string | null;
  upc: string | null;
  link: string | null;
  regularPrice: number | null;
  dealPrice: number | null;
  dealEndsOn: string | null;
  // Costco's online price, beside its warehouse price, which is the regular price.
  onlinePrice: number | null;
};

// One weekly-ad item.
export type WeeklyAdItem = {
  // The Store, as FoundStore names it.
  storeId: string;
  name: string;
  dealPrice: number;
  regularPrice: number | null;
  validFrom: string;
  validTo: string;
};

// The fake adapter's Home stores, locations and Product re-read keys: each ID starts with "fake-".
// A Household that ran on the fake adapter, such as under `pnpm dev`, can still hold some once it
// runs on the real readers.
export const isMadeUpId = (id: string | null): boolean => id !== null && id.startsWith("fake-");

export type PriceSourceAdapter = {
  // True for the fake adapter, which reads its own made-up Home stores. Any other adapter is a real
  // reader, and is never sent a made-up Home store: the Store asks for Find Stores near us again.
  readonly madeUpStores?: true;
  // For Test: one small call with the key. It resolves when the source accepts it.
  checkAccount(source: "apify" | "kroger", keys: PriceSourceKeys): Promise<Costed<true>>;
  // Every supported Store near the ZIP code, within the distance, and the weekly-ad-only Stores. A
  // refused key or a usage limit throws; any other failure is that one Store's "failed" lookup.
  findLocations(input: {
    zipCode: string;
    distanceMiles: FindStoresMiles;
    keys: PriceSourceKeys;
  }): Promise<Costed<FoundLocations>>;
  // Searches one Store for words, in the Store's own best-match order, never a price sort, and keeps
  // up to `productCount` Products. A brand lock goes into the words at every Store, and into the
  // Store's own brand filter where it has one. `dealsOnly` asks for on-sale Products only, where the
  // Store's reader has such a filter (spec 15, Search order and filters).
  searchStore(input: {
    storeId: string;
    homeStoreId: string | null;
    zipCode: string | null;
    words: string;
    productCount: number;
    keys: PriceSourceKeys;
    brand?: string | null;
    dealsOnly?: boolean;
  }): Promise<Costed<ProductRead[]>>;
  // One run with every search of a plan run at one Store, for a Store whose reader takes a list of
  // search words (spec 15, Cost and limits). Answers each search's Products in the searches' order.
  // A reader without it gets one searchStore call for each search.
  searchStoreMany?(input: {
    storeId: string;
    homeStoreId: string | null;
    zipCode: string | null;
    searches: { words: string; productCount: number }[];
    keys: PriceSourceKeys;
  }): Promise<Costed<ProductRead[][]>>;
  // One run that reads many Products at one Store by their re-read keys, such as Costco's item
  // numbers. Answers each key's Product in order, null when the Store no longer has it. A reader
  // without it gets one readProduct call for each key.
  readProducts?(input: {
    storeId: string;
    homeStoreId: string | null;
    zipCode: string | null;
    readKeys: string[];
    keys: PriceSourceKeys;
  }): Promise<Costed<(ProductRead | null)[]>>;
  // Reads one Product by its re-read key. Null when the Store no longer has it.
  readProduct(input: {
    storeId: string;
    homeStoreId: string | null;
    zipCode: string | null;
    readKey: string;
    keys: PriceSourceKeys;
  }): Promise<Costed<ProductRead | null>>;
  // The weekly ads near the ZIP code, for the named Stores and words.
  readWeeklyAds(input: {
    zipCode: string;
    storeIds: string[];
    words: string[];
    keys: PriceSourceKeys;
  }): Promise<Costed<WeeklyAdItem[]>>;
};

// Each error a Price source maps to: the source refused the key, its usage limit was reached, the
// source or Store took too long, or the Store failed, for any other reason, such as a failed Actor
// run.
export type PriceSourceErrorKind = "refused key" | "usage limit" | "timed out" | "store failed";

export class PriceSourceError extends Error {
  override name = "PriceSourceError";
  readonly kind: PriceSourceErrorKind;
  // What the failed work still cost, in billionths of a dollar, from the source's own run record,
  // such as a failed or stopped Actor run's charge. The caller adds it to the month's cost, as for
  // work that succeeded. Undefined when it charged nothing or is not known.
  readonly costNanos?: number;

  constructor(kind: PriceSourceErrorKind, message: string, costNanos?: number) {
    super(message);
    this.kind = kind;
    if (costNanos !== undefined) this.costNanos = costNanos;
  }
}
