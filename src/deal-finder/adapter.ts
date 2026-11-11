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

export type PriceSourceAdapter = {
  // For Test: one small call with the key. It resolves when the source accepts it.
  checkAccount(source: "apify" | "kroger", keys: PriceSourceKeys): Promise<Costed<true>>;
  // Every supported Store near the ZIP code, within the distance.
  findLocations(input: {
    zipCode: string;
    distanceMiles: FindStoresMiles;
    keys: PriceSourceKeys;
  }): Promise<Costed<FoundStore[]>>;
  // Searches one Store for words, in the Store's own best-match order, and keeps up to
  // `productCount` Products.
  searchStore(input: {
    storeId: string;
    homeStoreId: string | null;
    zipCode: string | null;
    words: string;
    productCount: number;
    keys: PriceSourceKeys;
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

// Each error a Price source maps to: the source refused the key, its usage limit was reached, or
// the Store failed, for any other reason.
export type PriceSourceErrorKind = "refused key" | "usage limit" | "store failed";

export class PriceSourceError extends Error {
  override name = "PriceSourceError";
  readonly kind: PriceSourceErrorKind;
  // What the failed run still charged, in billionths of a dollar, from the source's own run record.
  // A Scraping service run that fails can charge. Undefined when it charged nothing or is not known.
  readonly costNanos?: number;

  constructor(kind: PriceSourceErrorKind, message: string, costNanos?: number) {
    super(message);
    this.kind = kind;
    if (costNanos !== undefined) this.costNanos = costNanos;
  }
}
