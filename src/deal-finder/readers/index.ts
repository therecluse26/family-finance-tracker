import { type Logger, log } from "../../log.ts";
import {
  type Costed,
  type FoundStore,
  type PriceSourceAdapter,
  PriceSourceError,
  type PriceSourceKeys,
  type ProductRead,
  type WeeklyAdItem,
} from "../adapter.ts";
import type { FindStoresMiles } from "../view.ts";
import { APIFY_BASE_URL, ApifyClient, type ApifyTimings } from "./apify.ts";
import { cutText } from "./checks.ts";
import { KROGER_BASE_URL, type KrogerCallCount, KrogerReader } from "./kroger.ts";
import { aldi } from "./stores/aldi.ts";
import { amazon } from "./stores/amazon.ts";
import { costco, costcoFindInput, costcoWarehousesIn } from "./stores/costco.ts";
import { type ActorCall, type ApifyStore, type Place, withBrand } from "./stores/store.ts";
import { target, targetFindInput, targetStoresIn } from "./stores/target.ts";
import { walmart, walmartFindInput, walmartStoreIn } from "./stores/walmart.ts";
import {
  adStoresIn,
  weeklyAdFindInput,
  weeklyAdItem,
  weeklyAdSearchInput,
} from "./stores/weekly-ads.ts";

// The real Price source adapter (spec 15, Price sources): the Kroger API for Kroger, and Apify, the
// Scraping service, for every other Store, each through its own Actor. Which source a call uses
// comes from the Store and the saved keys: a Store API always wins for its Stores. Every call sends
// only what spec 15's "Data and privacy" lists: the key, search words, Product keys, and, with the
// ZIP code switch on, the ZIP code and a Home store ID. Nothing names a Member.

export type PriceSourceReaderOptions = {
  // The services' addresses. The built app uses the real ones; tests and dev runs give the local fake
  // servers' (src/deal-finder/fake-servers).
  apifyBaseUrl?: string;
  krogerBaseUrl?: string;
  logger?: Logger;
  now?: () => Date;
  apifyTimings?: Partial<ApifyTimings>;
  krogerCalls?: KrogerCallCount;
  krogerTimeoutMs?: number;
};

const APIFY_STORES: Readonly<Record<string, ApifyStore>> = {
  walmart,
  target,
  aldi,
  costco,
  amazon,
};

// Search words are cut to 200 characters, like every text field.
const wordsOf = (words: string, brand: string | null) => cutText(withBrand(words, brand)) ?? "";

const noApifyToken = () => new PriceSourceError("refused key", "No Apify token is saved.");
const noKrogerKeys = () => new PriceSourceError("refused key", "No Kroger keys are saved.");

export function priceSourceReaders(options: PriceSourceReaderOptions = {}): PriceSourceAdapter {
  const logger = options.logger ?? log;
  const apify = new ApifyClient({
    baseUrl: options.apifyBaseUrl ?? APIFY_BASE_URL,
    logger,
    ...(options.apifyTimings === undefined ? {} : { timings: options.apifyTimings }),
  });
  const kroger = new KrogerReader({
    baseUrl: options.krogerBaseUrl ?? KROGER_BASE_URL,
    logger,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.krogerCalls === undefined ? {} : { count: options.krogerCalls }),
    ...(options.krogerTimeoutMs === undefined ? {} : { timeoutMs: options.krogerTimeoutMs }),
  });

  const tokenOf = (keys: PriceSourceKeys) => {
    if (keys.apifyToken === undefined) throw noApifyToken();
    return keys.apifyToken;
  };
  const krogerKeysOf = (keys: PriceSourceKeys) => {
    if (keys.kroger === undefined) throw noKrogerKeys();
    return keys.kroger;
  };
  const storeOf = (storeId: string) => {
    const store = APIFY_STORES[storeId];
    if (store === undefined)
      throw new PriceSourceError("store failed", "No reader reads this Store.");
    return store;
  };

  // A lookup for Find Stores near us. A refused key or a usage limit ends the whole lookup; any
  // other failure leaves out that one Store.
  async function lookup<T>(
    name: string,
    work: () => Promise<Costed<T>>,
  ): Promise<Costed<T | null>> {
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof PriceSourceError &&
        (error.kind === "refused key" || error.kind === "usage limit")
      ) {
        throw error;
      }
      logger.warn("A Store lookup failed", {
        store: name,
        failure: error instanceof PriceSourceError ? error.kind : "unknown",
      });
      return { value: null, costNanos: null };
    }
  }

  async function apifyLookups(
    token: string,
    zipCode: string,
    miles: FindStoresMiles,
  ): Promise<Costed<FoundStore[]>> {
    const scraped = (name: string, kind: FoundStore["kind"], locations: FoundStore["locations"]) =>
      ({ id: name.toLowerCase(), name, kind, reader: "Scraping service", locations }) as FoundStore;
    const run = (name: string, call: ActorCall) =>
      lookup(name, () => apify.run(token, call.actor, call.input));
    const [targetRun, costcoRun, walmartRun, adRun] = await Promise.all([
      run("target", targetFindInput(zipCode, miles)),
      run("costco", costcoFindInput(zipCode)),
      run("walmart", walmartFindInput(zipCode)),
      run("weekly ads", weeklyAdFindInput(zipCode)),
    ]);
    const found: FoundStore[] = [];
    const targetStores = targetStoresIn(targetRun.value ?? []).slice(0, 5);
    if (targetStores.length > 0) found.push(scraped("Target", "in person", targetStores));
    const warehouses = costcoWarehousesIn(costcoRun.value ?? []).slice(0, 5);
    if (warehouses.length > 0) found.push(scraped("Costco", "in person", warehouses));
    if (walmartRun.value !== null && walmartRun.value.length > 0) {
      const picked = walmartStoreIn(walmartRun.value);
      found.push(scraped("Walmart", "in person", picked === null ? [] : [picked]));
    }
    found.push(...adStoresIn(adRun.value ?? []));
    found.push(scraped("Amazon", "online", []));
    const costs = [targetRun, costcoRun, walmartRun, adRun].map((run) => run.costNanos ?? 0);
    return { value: found, costNanos: costs.reduce((sum, cost) => sum + cost, 0) };
  }

  return {
    async checkAccount(source, keys) {
      return source === "apify"
        ? apify.checkToken(tokenOf(keys))
        : kroger.checkKeys(krogerKeysOf(keys));
    },

    async findLocations(input) {
      const { apifyToken, kroger: krogerKeys } = input.keys;
      if (apifyToken === undefined && krogerKeys === undefined) throw noApifyToken();
      const [krogerFound, apifyFound] = await Promise.all([
        krogerKeys === undefined
          ? null
          : kroger.findLocations({
              zipCode: input.zipCode,
              distanceMiles: input.distanceMiles,
              keys: krogerKeys,
            }),
        apifyToken === undefined
          ? null
          : apifyLookups(apifyToken, input.zipCode, input.distanceMiles),
      ]);
      const found = [
        ...(krogerFound === null || krogerFound.locations.length === 0 ? [] : [krogerFound]),
        ...(apifyFound?.value ?? []),
      ];
      return { value: found, costNanos: apifyFound?.costNanos ?? null };
    },

    async searchStore(input) {
      const brand = input.brand?.trim() || null;
      const words = wordsOf(input.words, brand);
      const place: Place = { homeStoreId: input.homeStoreId, zipCode: input.zipCode };
      const productCount = Math.max(1, Math.floor(input.productCount));
      if (input.storeId === "kroger") {
        const keys = krogerKeysOf(input.keys);
        // Kroger gives no price without a location, so it needs the ZIP code switch on.
        if (input.zipCode === null || input.homeStoreId === null)
          return { value: [], costNanos: null };
        return kroger.search({ locationId: input.homeStoreId, words, brand, productCount, keys });
      }
      const store = storeOf(input.storeId);
      const token = tokenOf(input.keys);
      const call = store.searchInput({
        ...place,
        words: [words],
        productCount,
        brand,
        dealsOnly: input.dealsOnly === true,
      });
      if (call === null) return { value: [], costNanos: null };
      const run = await apify.run(token, call.actor, call.input);
      const products = run.value.flatMap((row) => {
        const product = store.product(row);
        return product === null ? [] : [product];
      });
      return { value: firstOfEach(products).slice(0, productCount), costNanos: run.costNanos };
    },

    async readProduct(input) {
      const place: Place = { homeStoreId: input.homeStoreId, zipCode: input.zipCode };
      if (input.storeId === "kroger") {
        const keys = krogerKeysOf(input.keys);
        if (input.zipCode === null || input.homeStoreId === null)
          return { value: null, costNanos: null };
        return kroger.read({ locationId: input.homeStoreId, productId: input.readKey, keys });
      }
      const store = storeOf(input.storeId);
      const token = tokenOf(input.keys);
      const call = store.readInput(input.readKey, place);
      if (call === null) return { value: null, costNanos: null };
      const run = await apify.run(token, call.actor, call.input);
      let found: ProductRead | null = null;
      for (const row of run.value) {
        found = call.product(row);
        if (found !== null) break;
      }
      return { value: found, costNanos: run.costNanos };
    },

    async readWeeklyAds(input) {
      const token = tokenOf(input.keys);
      const words = input.words.map((each) => cutText(each)).filter((each) => each !== null);
      if (words.length === 0 || input.storeIds.length === 0) return { value: [], costNanos: null };
      const call = weeklyAdSearchInput(input.zipCode, words);
      const run = await apify.run(token, call.actor, call.input);
      const wanted = new Set(input.storeIds);
      const items = run.value.flatMap((row) => {
        const item = weeklyAdItem(row);
        return item !== null && wanted.has(item.storeId) ? [item] : [];
      });
      return { value: items satisfies WeeklyAdItem[], costNanos: run.costNanos };
    },
  };
}

// Each Product once, in the Store's own order: a row repeated in one run counts once.
function firstOfEach(products: ProductRead[]): ProductRead[] {
  const seen = new Set<string>();
  return products.filter((product) => {
    if (seen.has(product.readKey)) return false;
    seen.add(product.readKey);
    return true;
  });
}
