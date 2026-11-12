import { type Logger, log } from "../../log.ts";
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
} from "../adapter.ts";
import type { FindStoresMiles } from "../view.ts";
import { type ActorEvents, APIFY_BASE_URL, ApifyClient, type ApifyTimings } from "./apify.ts";
import { cutText } from "./checks.ts";
import { KROGER_BASE_URL, type KrogerCallCount, KrogerReader } from "./kroger.ts";
import { ALDI_ACTOR, ALDI_EVENTS, aldi } from "./stores/aldi.ts";
import { AMAZON_ACTOR, AMAZON_EVENTS, amazon } from "./stores/amazon.ts";
import {
  COSTCO_ACTOR,
  COSTCO_EVENTS,
  COSTCO_WAREHOUSES_ACTOR,
  COSTCO_WAREHOUSES_EVENTS,
  costco,
  costcoFindInput,
  costcoWarehousesIn,
} from "./stores/costco.ts";
import { type ActorCall, type ApifyStore, type Place, withBrand } from "./stores/store.ts";
import {
  TARGET_ACTOR,
  TARGET_EVENTS,
  TARGET_PAGE_ACTOR,
  TARGET_PAGE_EVENTS,
  TARGET_STORES_ACTOR,
  TARGET_STORES_EVENTS,
  target,
  targetFindInput,
  targetStoresIn,
} from "./stores/target.ts";
import { WALMART_ACTOR, WALMART_EVENTS, walmart } from "./stores/walmart.ts";
import {
  adStoresIn,
  WEEKLY_ADS_ACTOR,
  WEEKLY_ADS_EVENTS,
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

// The events each Actor charges, as its reader names them. A run of an Actor not listed, or listed
// with null, counts at its $1.00 cap.
const ACTOR_EVENTS: Readonly<Record<string, ActorEvents | null>> = {
  [WALMART_ACTOR]: WALMART_EVENTS,
  [TARGET_ACTOR]: TARGET_EVENTS,
  [TARGET_PAGE_ACTOR]: TARGET_PAGE_EVENTS,
  [TARGET_STORES_ACTOR]: TARGET_STORES_EVENTS,
  [ALDI_ACTOR]: ALDI_EVENTS,
  [COSTCO_ACTOR]: COSTCO_EVENTS,
  [COSTCO_WAREHOUSES_ACTOR]: COSTCO_WAREHOUSES_EVENTS,
  [AMAZON_ACTOR]: AMAZON_EVENTS,
  [WEEKLY_ADS_ACTOR]: WEEKLY_ADS_EVENTS,
};

const withEvents = (call: ActorCall) => ({ ...call, events: ACTOR_EVENTS[call.actor] ?? null });

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
  // other failure is that one lookup's, with its kind, and keeps what its failed run cost.
  async function lookup<T>(
    name: string,
    work: () => Promise<Costed<T>>,
  ): Promise<Costed<Looked<T>>> {
    try {
      const done = await work();
      return { value: { ok: true, value: done.value }, costNanos: done.costNanos };
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
      return {
        value: {
          ok: false,
          failure: error instanceof PriceSourceError ? error.kind : "store failed",
        },
        costNanos: error instanceof PriceSourceError ? (error.costNanos ?? null) : null,
      };
    }
  }

  // Lookups side by side. Every one ends before a refused key or a usage limit is thrown, and the
  // error carries what all of them cost, so no finished run's cost is lost.
  async function allLookups<T>(work: Promise<Costed<T>>[]): Promise<Costed<T>[]> {
    const ends = await Promise.allSettled(work);
    let costNanos = 0;
    let failure: PriceSourceError | null = null;
    const done: Costed<T>[] = [];
    for (const end of ends) {
      if (end.status === "fulfilled") {
        done.push(end.value);
        costNanos += end.value.costNanos ?? 0;
        continue;
      }
      const error =
        end.reason instanceof PriceSourceError
          ? end.reason
          : new PriceSourceError("store failed", "A Store lookup failed.");
      costNanos += error.costNanos ?? 0;
      failure ??= error;
    }
    if (failure !== null) throw new PriceSourceError(failure.kind, failure.message, costNanos);
    return done;
  }

  async function apifyLookups(
    token: string,
    zipCode: string,
    miles: FindStoresMiles,
  ): Promise<Costed<FoundLocations>> {
    const scraped = (name: string, kind: FoundStore["kind"], locations: FoundStore["locations"]) =>
      ({ id: name.toLowerCase(), name, kind, reader: "Scraping service", locations }) as FoundStore;
    const run = (name: string, call: ActorCall) =>
      lookup(name, () => apify.run(token, withEvents(call)));
    const runs = await allLookups([
      run("target", targetFindInput(zipCode, miles)),
      run("costco", costcoFindInput(zipCode)),
      run("weekly ads", weeklyAdFindInput(zipCode)),
    ]);
    const [targetRows, costcoRows, adRows] = runs.map((each) => each.value);
    const adStores = adRows?.ok === true ? adStoresIn(adRows.value) : null;
    const lookups: StoreLookup[] = [
      outcomeOf("target", targetRows, (rows) => {
        const stores = targetStoresIn(rows).slice(0, 5);
        return stores.length === 0 ? null : scraped("Target", "in person", stores);
      }),
      outcomeOf("costco", costcoRows, (rows) => {
        const warehouses = costcoWarehousesIn(rows).slice(0, 5);
        return warehouses.length === 0 ? null : scraped("Costco", "in person", warehouses);
      }),
      // Walmart reads by the ZIP code, with no Home store, so it is found with no run.
      { storeId: "walmart", outcome: "found", store: scraped("Walmart", "in person", []) },
      // Aldi is found by its weekly ad near the ZIP code.
      outcomeOf("aldi", adRows, () => adStores?.find((store) => store.id === "aldi") ?? null),
      { storeId: "amazon", outcome: "found", store: scraped("Amazon", "online", []) },
    ];
    const weeklyAds = adStores?.filter((store) => store.kind === "weekly ad only") ?? null;
    return { value: { lookups, weeklyAds }, costNanos: costOf(runs) };
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
      const none: Costed<FoundLocations> = {
        value: { lookups: [], weeklyAds: null },
        costNanos: null,
      };
      // Kroger is one more lookup: a failure other than a refused key or a usage limit is only
      // Kroger's, and the Apify lookups' cost is kept.
      const krogerLookup = async (keys: NonNullable<PriceSourceKeys["kroger"]>) => {
        const { value, costNanos } = await lookup("kroger", async () => ({
          value: await kroger.findLocations({
            zipCode: input.zipCode,
            distanceMiles: input.distanceMiles,
            keys,
          }),
          costNanos: null,
        }));
        const found = outcomeOf("kroger", value, (store) =>
          store.locations.length === 0 ? null : store,
        );
        return { value: { lookups: [found], weeklyAds: null }, costNanos };
      };
      const [krogerFound, apifyFound] = await allLookups<FoundLocations>([
        krogerKeys === undefined ? Promise.resolve(none) : krogerLookup(krogerKeys),
        apifyToken === undefined
          ? Promise.resolve(none)
          : apifyLookups(apifyToken, input.zipCode, input.distanceMiles),
      ]);
      const sources = [krogerFound ?? none, apifyFound ?? none];
      return {
        value: {
          lookups: sources.flatMap((each) => each.value.lookups),
          weeklyAds: apifyFound?.value.weeklyAds ?? null,
        },
        costNanos: apifyToken === undefined ? null : costOf(sources),
      };
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
      const run = await apify.run(token, withEvents(call));
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
      const call = store.readInput(input.readKey, place, input.name);
      if (call === null) return { value: null, costNanos: null };
      const run = await apify.run(token, withEvents(call));
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
      const run = await apify.run(token, withEvents(call));
      const wanted = new Set(input.storeIds);
      const items = run.value.flatMap((row) => {
        const item = weeklyAdItem(row);
        return item !== null && wanted.has(item.storeId) ? [item] : [];
      });
      return { value: items satisfies WeeklyAdItem[], costNanos: run.costNanos };
    },
  };
}

// A lookup's answer, or the kind of its failure.
type Looked<T> = { ok: true; value: T } | { ok: false; failure: PriceSourceErrorKind };

// One Store's lookup: failed with its run, found, or none within the distance.
function outcomeOf<T>(
  storeId: string,
  looked: Looked<T> | undefined,
  found: (value: T) => FoundStore | null,
): StoreLookup {
  if (looked === undefined || !looked.ok) {
    return { storeId, outcome: "failed", failure: looked?.failure ?? "store failed" };
  }
  const store = found(looked.value);
  return store === null ? { storeId, outcome: "none" } : { storeId, outcome: "found", store };
}

// What a set of lookups cost together.
function costOf(runs: Costed<unknown>[]): number {
  return runs.reduce((sum, run) => sum + (run.costNanos ?? 0), 0);
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
