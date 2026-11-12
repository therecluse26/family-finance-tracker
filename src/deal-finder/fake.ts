import {
  type Costed,
  type FoundLocations,
  type FoundStore,
  type PriceSourceAdapter,
  PriceSourceError,
  type PriceSourceErrorKind,
  type PriceSourceKeys,
  type ProductRead,
  type StoreLookup,
  type WeeklyAdItem,
} from "./adapter.ts";
import type { FindStoresMiles } from "./view.ts";

// The in-memory fake Price source adapter (spec 15, Price sources). It serves every test and every
// development run, and never touches a network. Every Store location, Product, price and Deal in it
// is made up. Tests may switch on a refused key, a usage limit, or a Store that fails.

// Each call's name, as `calls` records it.
export type FakePriceSourceCall =
  | "checkAccount"
  | "findLocations"
  | "searchStore"
  | "searchStoreMany"
  | "readProduct"
  | "readProducts"
  | "readWeeklyAds";

// Made-up run costs, in billionths of a dollar, near the ones spec 15 measured.
const FIND_COST_NANOS = 30_000_000;
const SEARCH_COST_NANOS = 2_000_000;
const PRODUCT_COST_NANOS = 5_000_000;
const DEAL_COST_NANOS = 2_000_000;

// Every made-up location, with its distance from any ZIP code.
const LOCATIONS: FoundStore[] = [
  {
    id: "kroger",
    name: "Kroger",
    kind: "in person",
    reader: "Store API",
    locations: [
      { id: "fake-kroger-0101", name: "Kroger, Maple Avenue", distanceMiles: 2.4 },
      { id: "fake-kroger-0102", name: "Kroger, Orchard Road", distanceMiles: 6.8 },
      { id: "fake-kroger-0103", name: "Kroger, Lakeview Plaza", distanceMiles: 18.5 },
      { id: "fake-kroger-0104", name: "Kroger, Granite Hill", distanceMiles: 41.0 },
    ],
  },
  {
    id: "target",
    name: "Target",
    kind: "in person",
    reader: "Scraping service",
    locations: [
      { id: "fake-target-2201", name: "Target, Riverside", distanceMiles: 3.1 },
      { id: "fake-target-2202", name: "Target, North Commons", distanceMiles: 12.9 },
    ],
  },
  {
    id: "costco",
    name: "Costco",
    kind: "in person",
    reader: "Scraping service",
    locations: [
      { id: "fake-costco-3301", name: "Costco, Fairgrounds", distanceMiles: 14.2 },
      { id: "fake-costco-3302", name: "Costco, Old Mill", distanceMiles: 33.7 },
    ],
  },
  {
    id: "walmart",
    name: "Walmart",
    kind: "in person",
    reader: "Scraping service",
    locations: [{ id: "fake-walmart-4401", name: "Walmart, Pine Street", distanceMiles: 4.6 }],
  },
  { id: "aldi", name: "Aldi", kind: "in person", reader: "Scraping service", locations: [] },
  { id: "amazon", name: "Amazon", kind: "online", reader: "Scraping service", locations: [] },
  {
    id: "ad-hilltop-market",
    name: "Hilltop Market",
    kind: "weekly ad only",
    reader: "Scraping service",
    locations: [],
  },
];

type FakeProduct = Omit<ProductRead, "dealEndsOn"> & { dealEndsOn?: string };

const product = (
  readKey: string,
  name: string,
  regularPrice: number | null,
  extra: Partial<FakeProduct> = {},
): FakeProduct => ({
  readKey,
  name,
  brand: null,
  size: null,
  upc: null,
  link: null,
  regularPrice,
  dealPrice: null,
  onlinePrice: null,
  ...extra,
});

// Each Store's made-up Products.
const CATALOG: Record<string, FakeProduct[]> = {
  kroger: [
    product("0001111000101", "Fake Farms Ground Beef 80/20, 1 lb", 549, {
      brand: "Fake Farms",
      size: "1 lb",
      dealPrice: 449,
      dealEndsOn: "2026-11-18",
    }),
    product("0001111000102", "Sample Creamy Peanut Butter, 16 oz", 299, {
      brand: "Sample",
      size: "16 oz",
    }),
    product("0001111000103", "Grade A Large Eggs, 12 ct", 389, { size: "12 ct" }),
  ],
  walmart: [
    product("fake-wm-5501", "Ground Beef 80% Lean, 1 lb", 519, { size: "1 lb" }),
    product("fake-wm-5502", "Sample Creamy Peanut Butter, 16 oz", 278, {
      brand: "Sample",
      size: "16 oz",
    }),
  ],
  target: [
    product("fake-tg-6601", "Market Pantry Style Large Eggs, 12 ct", 359, {
      size: "12 ct",
      dealPrice: 329,
      dealEndsOn: "2026-11-14",
    }),
  ],
  aldi: [
    product("fake-aldi-7701", "Budget Brand Ground Beef 80/20, 1 lb", 479, { size: "1 lb" }),
    product("fake-aldi-7702", "Budget Brand Large Eggs, 12 ct", 279, { size: "12 ct" }),
  ],
  costco: [
    product("fake-cc-8801", "Warehouse Large Eggs, 24 ct", 699, {
      size: "24 ct",
      onlinePrice: 899,
    }),
    // A Product with no warehouse price: the plan uses its online price.
    product("fake-cc-8802", "Warehouse Peanut Butter, 2 x 40 oz", null, {
      size: "80 oz",
      onlinePrice: 1299,
    }),
  ],
  amazon: [
    product("B0FAKE0001", "Sample Creamy Peanut Butter, 16 oz", 349, {
      brand: "Sample",
      size: "16 oz",
      dealPrice: 299,
    }),
  ],
};

const WEEKLY_ADS: WeeklyAdItem[] = [
  {
    storeId: "ad-hilltop-market",
    name: "Hilltop Ground Beef, per lb",
    dealPrice: 399,
    regularPrice: 529,
    validFrom: "2026-11-11",
    validTo: "2026-11-17",
  },
  {
    storeId: "target",
    name: "Large Eggs, 12 ct",
    dealPrice: 299,
    regularPrice: 359,
    validFrom: "2026-11-09",
    validTo: "2026-11-15",
  },
];

const matches = (name: string, words: string) => {
  const wanted = words.toLowerCase().split(/\s+/).filter(Boolean);
  const plain = name.toLowerCase();
  return wanted.length > 0 && wanted.every((word) => plain.includes(word));
};

const asRead = (item: FakeProduct): ProductRead => ({
  ...item,
  dealEndsOn: item.dealEndsOn ?? null,
});

export class FakePriceSource implements PriceSourceAdapter {
  readonly madeUpStores = true;
  // Each call, in order, with the source or Store it named. Never a key.
  readonly calls: { call: FakePriceSourceCall; target: string }[] = [];
  // Switches: every call of the source throws this kind of error until it is cleared.
  readonly sourceErrors = new Map<"apify" | "kroger", PriceSourceErrorKind>();
  // Every call for this Store fails.
  readonly failingStores = new Set<string>();
  // Only this Store's Find Stores lookup fails, as one failed Actor run does. "weekly ads" fails
  // the weekly-ad-only Stores' lookup.
  readonly failingLookups = new Set<string>();
  // What a switched-on source error says the failed work still cost, such as a failed Actor run.
  failureCostNanos: number | undefined;
  // The next this many calls for this Store fail, then they work again.
  readonly failingTimes = new Map<string, number>();
  // What each failed Store call charged, in billionths of a dollar.
  failedRunCostNanos: number | undefined;
  // While set, every call waits for it, so a test can hold calls in flight.
  hold: Promise<void> | undefined;

  private async begin(call: FakePriceSourceCall, target: string): Promise<void> {
    this.calls.push({ call, target });
    if (this.hold !== undefined) await this.hold;
  }

  // The source a Store is read through: the Kroger API for Kroger, else the Scraping service.
  private failFor(source: "apify" | "kroger", keys: PriceSourceKeys): void {
    const kind = this.sourceErrors.get(source);
    if (kind !== undefined) {
      throw new PriceSourceError(kind, `The fake ${source} found ${kind}.`, this.failureCostNanos);
    }
    const keyed = source === "apify" ? keys.apifyToken : keys.kroger;
    if (keyed === undefined) {
      throw new PriceSourceError("refused key", `The fake ${source} got no key.`);
    }
  }

  private failForStore(storeId: string, keys: PriceSourceKeys): void {
    this.failFor(storeId === "kroger" ? "kroger" : "apify", keys);
    const times = this.failingTimes.get(storeId) ?? 0;
    if (times > 0) this.failingTimes.set(storeId, times - 1);
    if (this.failingStores.has(storeId) || times > 0) {
      const message = `The fake ${storeId} failed.`;
      throw new PriceSourceError("store failed", message, this.failedRunCostNanos);
    }
  }

  async checkAccount(source: "apify" | "kroger", keys: PriceSourceKeys): Promise<Costed<true>> {
    await this.begin("checkAccount", source);
    this.failFor(source, keys);
    return { value: true, costNanos: null };
  }

  async findLocations(input: {
    zipCode: string;
    distanceMiles: FindStoresMiles;
    keys: PriceSourceKeys;
  }): Promise<Costed<FoundLocations>> {
    await this.begin("findLocations", input.zipCode);
    // Kroger's locations come from the Kroger API, every other Store's from the Scraping service, so
    // a Household with only the Kroger keys finds Kroger alone.
    const { apifyToken, kroger } = input.keys;
    if (apifyToken === undefined && kroger === undefined) {
      throw new PriceSourceError("refused key", "The fake Price source got no key.");
    }
    if (apifyToken !== undefined) this.failFor("apify", input.keys);
    if (kroger !== undefined) this.failFor("kroger", input.keys);
    const keyed = (store: FoundStore) =>
      store.reader === "Store API" ? kroger !== undefined : apifyToken !== undefined;
    // A Store with locations, none within the distance, is "none".
    const within = (store: FoundStore): FoundStore | null => {
      const near = store.locations.filter((place) => place.distanceMiles <= input.distanceMiles);
      return store.locations.length > 0 && near.length === 0 ? null : { ...store, locations: near };
    };
    const failing = (id: string) => this.failingStores.has(id) || this.failingLookups.has(id);
    const lookups = LOCATIONS.filter(
      (store) => keyed(store) && store.kind !== "weekly ad only",
    ).map((store): StoreLookup => {
      if (failing(store.id))
        return { storeId: store.id, outcome: "failed", failure: "store failed" };
      const near = within(store);
      return near === null
        ? { storeId: store.id, outcome: "none" }
        : { storeId: store.id, outcome: "found", store: near };
    });
    const weeklyAds =
      apifyToken === undefined || this.failingLookups.has("weekly ads")
        ? null
        : LOCATIONS.filter((store) => store.kind === "weekly ad only" && !failing(store.id));
    return { value: { lookups, weeklyAds }, costNanos: FIND_COST_NANOS };
  }

  async searchStore(input: {
    storeId: string;
    homeStoreId: string | null;
    zipCode: string | null;
    words: string;
    productCount: number;
    keys: PriceSourceKeys;
  }): Promise<Costed<ProductRead[]>> {
    await this.begin("searchStore", input.storeId);
    this.failForStore(input.storeId, input.keys);
    const found = (CATALOG[input.storeId] ?? [])
      .filter((item) => matches(item.name, input.words))
      .slice(0, input.productCount)
      .map(asRead);
    return {
      value: found,
      costNanos: input.storeId === "kroger" ? null : SEARCH_COST_NANOS,
    };
  }

  async searchStoreMany(input: {
    storeId: string;
    homeStoreId: string | null;
    zipCode: string | null;
    searches: { words: string; productCount: number }[];
    keys: PriceSourceKeys;
  }): Promise<Costed<ProductRead[][]>> {
    await this.begin("searchStoreMany", input.storeId);
    this.failForStore(input.storeId, input.keys);
    const found = input.searches.map((search) =>
      (CATALOG[input.storeId] ?? [])
        .filter((item) => matches(item.name, search.words))
        .slice(0, search.productCount)
        .map(asRead),
    );
    return {
      value: found,
      costNanos: input.storeId === "kroger" ? null : SEARCH_COST_NANOS * input.searches.length,
    };
  }

  async readProducts(input: {
    storeId: string;
    homeStoreId: string | null;
    zipCode: string | null;
    readKeys: string[];
    keys: PriceSourceKeys;
  }): Promise<Costed<(ProductRead | null)[]>> {
    await this.begin("readProducts", input.storeId);
    this.failForStore(input.storeId, input.keys);
    const read = input.readKeys.map((readKey) => {
      const item = (CATALOG[input.storeId] ?? []).find((one) => one.readKey === readKey);
      return item === undefined ? null : asRead(item);
    });
    return {
      value: read,
      costNanos: input.storeId === "kroger" ? null : PRODUCT_COST_NANOS * read.length,
    };
  }

  async readProduct(input: {
    storeId: string;
    homeStoreId: string | null;
    zipCode: string | null;
    readKey: string;
    keys: PriceSourceKeys;
  }): Promise<Costed<ProductRead | null>> {
    await this.begin("readProduct", input.storeId);
    this.failForStore(input.storeId, input.keys);
    const item = (CATALOG[input.storeId] ?? []).find((one) => one.readKey === input.readKey);
    return {
      value: item === undefined ? null : asRead(item),
      costNanos: input.storeId === "kroger" ? null : PRODUCT_COST_NANOS,
    };
  }

  async readWeeklyAds(input: {
    zipCode: string;
    storeIds: string[];
    words: string[];
    keys: PriceSourceKeys;
  }): Promise<Costed<WeeklyAdItem[]>> {
    await this.begin("readWeeklyAds", input.zipCode);
    this.failFor("apify", input.keys);
    const found = WEEKLY_ADS.filter(
      (item) =>
        input.storeIds.includes(item.storeId) &&
        !this.failingStores.has(item.storeId) &&
        input.words.some((words) => matches(item.name, words)),
    );
    return { value: found, costNanos: found.length * DEAL_COST_NANOS };
  }
}
