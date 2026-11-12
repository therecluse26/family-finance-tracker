import {
  changeDealFinderStore,
  countDealFinderData,
  type Database,
  DEAL_FINDER_SETTINGS_ROW,
  deleteDealFinderData,
  listDealFinderStores,
  readDealFinderSettings,
  readHouseholdFacts,
  readPriceSourceCost,
  type StoredDealFinderSettings,
  type StoredDealFinderStore,
  type StoreLookupRow,
  storeDealFinderSettings,
  storeFoundStores,
  storePriceSourceCheck,
} from "../db/index.ts";
import { calendarDateIn } from "../format.ts";
import { type Logger, log, registerSecretValue } from "../log.ts";
import type { SecretPlace, Secrets } from "../secrets/index.ts";
import {
  type FoundStore,
  isMadeUpId,
  type PriceSourceAdapter,
  PriceSourceError,
  type PriceSourceKeys,
} from "./adapter.ts";
import { FIND_STORES_RUNS, priceSourceCostCap } from "./cost-cap.ts";
import {
  FIND_STORES_MILES,
  type FindStoresMiles,
  KEYED_PRICE_SOURCES,
  type KeyedPriceSource,
  MAX_STORES_ON,
  type PriceSourceCheck,
  type PriceSourceSettings,
  type PriceSourceStoreView,
  type PriceSourcesView,
  SUPPORTED_STORES,
  storeNeedsZip,
} from "./view.ts";

// The Price sources page in Settings (spec 15): the keys, each Test, Open Food Facts, the ZIP code
// switch, Find Stores near us, each Store's settings, the cost cap, and "Delete all deal finder
// data". Each key is a Master-key secret: the app encrypts it, and never shows or logs it again.

// Each key's place. Its ciphertext decrypts only in deal_finder_settings' one row, in its column.
const APIFY_TOKEN: SecretPlace = {
  rowId: DEAL_FINDER_SETTINGS_ROW,
  column: "deal_finder_settings.apify_token",
};
const KROGER_CLIENT_ID: SecretPlace = {
  rowId: DEAL_FINDER_SETTINGS_ROW,
  column: "deal_finder_settings.kroger_client_id",
};
const KROGER_CLIENT_SECRET: SecretPlace = {
  rowId: DEAL_FINDER_SETTINGS_ROW,
  column: "deal_finder_settings.kroger_client_secret",
};

const last4 = (key: string) => key.slice(-4);

// The keys a Member saved, decrypted. Decrypting registers each with the logger, which refuses it
// from then on.
export async function readPriceSourceKeys(
  database: Database,
  secrets: Secrets,
): Promise<PriceSourceKeys> {
  return keysOf(await readDealFinderSettings(database), secrets);
}

// Only the sources named are decrypted, so one source's unreadable key never stops the other's Test.
function keysOf(
  stored: StoredDealFinderSettings,
  secrets: Secrets,
  sources: readonly KeyedPriceSource[] = KEYED_PRICE_SOURCES,
): PriceSourceKeys {
  const keys: PriceSourceKeys = {};
  if (sources.includes("apify") && stored.apifyToken !== null) {
    keys.apifyToken = secrets.decrypt(stored.apifyToken, APIFY_TOKEN);
  }
  if (
    sources.includes("kroger") &&
    stored.krogerClientId !== null &&
    stored.krogerClientSecret !== null
  ) {
    keys.kroger = {
      clientId: secrets.decrypt(stored.krogerClientId, KROGER_CLIENT_ID),
      clientSecret: secrets.decrypt(stored.krogerClientSecret, KROGER_CLIENT_SECRET),
    };
  }
  for (const key of [keys.apifyToken, keys.kroger?.clientId, keys.kroger?.clientSecret]) {
    if (key !== undefined) registerSecretValue(key);
  }
  return keys;
}

// The month, YYYY-MM, in the Household time zone.
function monthOf(at: Date, zone: string): string {
  return calendarDateIn(at, zone).slice(0, 7);
}

// Each Store as the page lists it. With the ZIP code switch off, a Store is read at its default
// store, so no Home store or location is shown (spec 15, Store locations and the ZIP code). With
// the real readers, a made-up Home store from the fake adapter counts as none, and the Store asks
// for Find Stores near us again. With the switch on, after a lookup, a Store not found says why.
function storeView(
  store: StoredDealFinderStore,
  zipOn: boolean,
  madeUpStores: boolean,
  lookedUp: boolean,
): PriceSourceStoreView {
  if (!zipOn) {
    return {
      ...storeView(store, true, true, false),
      needsZip: storeNeedsZip(store),
      homeStore: null,
      distanceMiles: null,
      locations: [],
    };
  }
  if (!madeUpStores && isMadeUpId(store.homeStoreId)) {
    return {
      ...storeView(store, true, true, lookedUp),
      homeStore: null,
      distanceMiles: null,
      locations: store.locations.filter((place) => !isMadeUpId(place.id)),
      findAgain: true,
    };
  }
  const why =
    store.lastLookup === null || store.lastLookup === "found" ? "unknown" : store.lastLookup;
  return {
    id: store.id,
    name: store.name,
    kind: store.kind,
    reader: store.reader,
    on: store.on,
    needsZip: false,
    findAgain: false,
    notFound: lookedUp && !store.nearby ? why : null,
    earlierResult: lookedUp && store.nearby && store.lastLookup === "failed",
    homeStore:
      store.homeStoreId === null
        ? null
        : { id: store.homeStoreId, name: store.homeStoreName ?? store.homeStoreId },
    distanceMiles: store.distanceMiles,
    locations: store.locations,
    deliveryFee: store.deliveryFee,
    freeDeliveryFrom: store.freeDeliveryFrom,
    lastGoodReadAt: store.lastGoodReadAt?.toISOString() ?? null,
  };
}

const UNSAVED_STORE = {
  on: false,
  nearby: false,
  homeStoreId: null,
  homeStoreName: null,
  distanceMiles: null,
  deliveryFee: null,
  freeDeliveryFrom: null,
  lastGoodReadAt: null,
  lastLookup: null,
} as const;

const isSupported = (store: { id: string }) => SUPPORTED_STORES.some((one) => one.id === store.id);

// The listed Stores. With the switch on, before any Find Stores near us, only a Store still on
// (ticked with the switch off), so it can be seen and turned off. With the switch on after a lookup,
// and with it off, every supported Store, saved or not, found or not, and each weekly ad found; with
// the switch off, a weekly ad shows that it needs the ZIP code.
function listedStores(
  saved: StoredDealFinderStore[],
  zipOn: boolean,
  lookedUp: boolean,
): StoredDealFinderStore[] {
  if (zipOn && !lookedUp) return saved.filter((store) => store.nearby || store.on);
  const byId = new Map(saved.map((store) => [store.id, store]));
  const supported = SUPPORTED_STORES.map(
    (store): StoredDealFinderStore =>
      byId.get(store.id) ?? { ...store, ...UNSAVED_STORE, locations: [], foundAt: new Date(0) },
  );
  const others = saved.filter(
    (store) => !isSupported(store) && (store.nearby || (zipOn && store.on)),
  );
  return [...supported, ...others].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

const asMiles = (value: number): FindStoresMiles =>
  FIND_STORES_MILES.find((miles) => miles === value) ?? 25;

const withoutZipOf = (id: string) => {
  const store = SUPPORTED_STORES.find((one) => one.id === id);
  return store === undefined ? {} : { withoutZip: store };
};

export function priceSourceSettings(options: {
  database: Database;
  secrets: Secrets;
  // The Price source adapter. Without one, Test and Find Stores near us have no reader.
  adapter?: PriceSourceAdapter;
  logger?: Logger;
  now?: () => Date;
}): PriceSourceSettings {
  const { database, secrets, adapter, logger = log, now = () => new Date() } = options;
  // Only the fake adapter reads the made-up Home stores it found.
  const madeUpStores = adapter?.madeUpStores === true;
  // The Tests in flight, and whether a Find Stores lookup is. Each is taken in the same synchronous
  // step as its check, before the first await, and given back when its work ends.
  const testing = new Set<KeyedPriceSource>();
  let finding = false;
  // The Price source cost cap, shared with the plan run.
  const costCap = priceSourceCostCap(database);

  async function zone(): Promise<string> {
    return (await readHouseholdFacts(database))?.timeZone ?? "UTC";
  }

  async function view(): Promise<PriceSourcesView> {
    const [stored, facts, stores, data] = await Promise.all([
      readDealFinderSettings(database),
      readHouseholdFacts(database),
      listDealFinderStores(database),
      countDealFinderData(database),
    ]);
    const month = monthOf(now(), facts?.timeZone ?? "UTC");
    const zipCode = facts?.zipCode ?? null;
    return {
      apify: {
        tokenLast4: stored.apifyTokenLast4,
        check: stored.apifyCheck,
        checkedAt: stored.apifyCheckedAt?.toISOString() ?? null,
      },
      kroger: {
        clientIdLast4: stored.krogerClientIdLast4,
        clientSecretLast4: stored.krogerClientSecretLast4,
        check: stored.krogerCheck,
        checkedAt: stored.krogerCheckedAt?.toISOString() ?? null,
      },
      openFoodFacts: stored.openFoodFacts,
      zip: {
        on: stored.useZip,
        zipCode,
        changed: stored.storesFoundZip !== null && stored.storesFoundZip !== zipCode,
      },
      findDistanceMiles: asMiles(stored.findDistanceMiles),
      storesFoundAt: stored.storesFoundAt?.toISOString() ?? null,
      costCap: stored.costCap,
      monthCostNanos: await readPriceSourceCost(database, month),
      stores: listedStores(stores, stored.useZip, stored.storesFoundAt !== null).map((store) =>
        storeView(store, stored.useZip, madeUpStores, stored.storesFoundAt !== null),
      ),
      data,
    };
  }

  // A run's cost, when the source reported one, counts toward this month.
  async function addCost(costNanos: number | null): Promise<void> {
    if (costNanos === null || costNanos === 0) return;
    await costCap.free(monthOf(now(), await zone())).end(costNanos);
  }

  // What a Test's call found. Only a PriceSourceError is read, and only its kind: any other thrown
  // value is logged by its type alone, since it can hold a key.
  async function check(
    source: KeyedPriceSource,
    keys: PriceSourceKeys,
    reader: PriceSourceAdapter,
  ): Promise<PriceSourceCheck> {
    try {
      await addCost((await reader.checkAccount(source, keys)).costNanos);
      return "passed";
    } catch (error) {
      // A failed call can still cost, such as a failed Actor run.
      if (error instanceof PriceSourceError) await addCost(error.costNanos ?? null);
      if (error instanceof PriceSourceError && error.kind === "refused key") return "refused";
      if (error instanceof PriceSourceError && error.kind === "usage limit") return "usage limit";
      logger.warn("A Price source did not answer its Test", {
        source,
        failure: error instanceof PriceSourceError ? error.kind : "unknown",
      });
      return "no answer";
    }
  }

  return {
    view,

    async saveApifyToken(token) {
      // Before anything else, so no log line can hold it.
      registerSecretValue(token);
      await storeDealFinderSettings(database, {
        apifyToken: secrets.encrypt(token, APIFY_TOKEN),
        apifyTokenLast4: last4(token),
        apifyCheck: null,
        apifyCheckedAt: null,
      });
      return view();
    },

    async saveKrogerKeys(keys) {
      registerSecretValue(keys.clientId);
      registerSecretValue(keys.clientSecret);
      await storeDealFinderSettings(database, {
        krogerClientId: secrets.encrypt(keys.clientId, KROGER_CLIENT_ID),
        krogerClientIdLast4: last4(keys.clientId),
        krogerClientSecret: secrets.encrypt(keys.clientSecret, KROGER_CLIENT_SECRET),
        krogerClientSecretLast4: last4(keys.clientSecret),
        krogerCheck: null,
        krogerCheckedAt: null,
      });
      return view();
    },

    async test(source) {
      if (testing.has(source)) return { outcome: "busy" };
      testing.add(source);
      try {
        if (adapter === undefined) return { outcome: "no reader" };
        const stored = await readDealFinderSettings(database);
        const tested = source === "apify" ? stored.apifyToken : stored.krogerClientSecret;
        const keys = keysOf(stored, secrets, [source]);
        if (tested === null || (source === "apify" ? keys.apifyToken : keys.kroger) === undefined) {
          return { outcome: "no key" };
        }
        const found = await check(source, keys, adapter);
        const kept = await storePriceSourceCheck(database, source, tested, {
          check: found,
          at: now(),
        });
        if (!kept) return { outcome: "changed" };
        return { outcome: "tested", check: found, view: await view() };
      } finally {
        testing.delete(source);
      }
    },

    async setOpenFoodFacts(on) {
      await storeDealFinderSettings(database, { openFoodFacts: on });
      return view();
    },

    async setUseZip(on) {
      await storeDealFinderSettings(database, { useZip: on });
      return view();
    },

    async findStores(miles) {
      if (finding) return { outcome: "busy" };
      finding = true;
      try {
        if (adapter === undefined) return { outcome: "no reader" };
        const stored = await readDealFinderSettings(database);
        if (!stored.useZip) return { outcome: "zip off" };
        const zipCode = (await readHouseholdFacts(database))?.zipCode;
        if (zipCode === undefined) return { outcome: "no zip code" };
        const keys = keysOf(stored, secrets);
        // The Scraping service's lookups take their places under the cost cap before they start,
        // at one Actor run's worst case each (K18). The Kroger API is free.
        const month = monthOf(now(), await zone());
        let place = costCap.free(month);
        if (keys.apifyToken !== undefined) {
          const held = await costCap.hold(month, stored.costCap, FIND_STORES_RUNS);
          if (held === null) return { outcome: "cost cap" };
          place = held;
        }
        let found: Awaited<ReturnType<PriceSourceAdapter["findLocations"]>>;
        try {
          found = await adapter.findLocations({ zipCode, distanceMiles: miles, keys });
        } catch (error) {
          // The lookups that ran before the failure still cost.
          await place.end(error instanceof PriceSourceError ? error.costNanos : undefined);
          const kind = error instanceof PriceSourceError ? error.kind : "unknown";
          logger.warn("Find Stores near us failed", { failure: kind });
          if (kind === "refused key") return { outcome: "refused key" };
          if (kind === "usage limit") return { outcome: "usage limit" };
          return { outcome: "failed" };
        }
        await place.end(found.costNanos);
        // A location outside the distance is not shown, whatever the source sent: a Store with
        // locations, none within the distance, is "none".
        const within = (store: FoundStore): FoundStore | null => {
          const locations = store.locations
            .filter((place) => place.distanceMiles <= miles)
            .sort((a, b) => a.distanceMiles - b.distanceMiles);
          return store.locations.length > 0 && locations.length === 0
            ? null
            : { ...store, locations };
        };
        // Each supported Store's outcome. One the adapter did not look up has no saved key.
        const lookups = SUPPORTED_STORES.map((supported): StoreLookupRow => {
          const looked = found.value.lookups.find((each) => each.storeId === supported.id);
          if (looked === undefined) return { outcome: "no key", store: supported };
          if (looked.outcome !== "found") return { outcome: looked.outcome, store: supported };
          const near = within({ ...looked.store, id: supported.id });
          return near === null
            ? { outcome: "none", store: supported }
            : { outcome: "found", store: near };
        });
        const weeklyAds =
          found.value.weeklyAds?.flatMap((store) => {
            const near = isSupported(store) ? null : within(store);
            return near === null ? [] : [near];
          }) ?? null;
        await storeFoundStores(database, lookups, weeklyAds, {
          zipCode,
          distanceMiles: miles,
          at: now(),
        });
        return { outcome: "found", view: await view() };
      } finally {
        finding = false;
      }
    },

    async changeStore(id, changes) {
      if (!madeUpStores && isMadeUpId(changes.homeStoreId ?? null)) {
        return { outcome: "no such location" };
      }
      const changed = await changeDealFinderStore(database, id, changes, {
        maxOn: MAX_STORES_ON,
        ...withoutZipOf(id),
        needsZip: storeNeedsZip,
        at: now(),
      });
      return changed === "changed"
        ? { outcome: "changed", view: await view() }
        : { outcome: changed };
    },

    async setCostCap(cents) {
      await storeDealFinderSettings(database, { costCap: cents });
      return view();
    },

    async deleteAll() {
      await deleteDealFinderData(database);
      return view();
    },
  };
}
