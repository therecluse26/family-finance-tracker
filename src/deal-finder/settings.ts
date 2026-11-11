import {
  addPriceSourceCost,
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
  storeDealFinderSettings,
  storeFoundStores,
  storePriceSourceCheck,
} from "../db/index.ts";
import { calendarDateIn } from "../format.ts";
import { type Logger, log, registerSecretValue } from "../log.ts";
import type { SecretPlace, Secrets } from "../secrets/index.ts";
import { type PriceSourceAdapter, PriceSourceError, type PriceSourceKeys } from "./adapter.ts";
import {
  FIND_STORES_MILES,
  type FindStoresMiles,
  type KeyedPriceSource,
  MAX_STORES_ON,
  type PriceSourceCheck,
  type PriceSourceSettings,
  type PriceSourceStoreView,
  type PriceSourcesView,
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

function keysOf(stored: StoredDealFinderSettings, secrets: Secrets): PriceSourceKeys {
  const keys: PriceSourceKeys = {};
  if (stored.apifyToken !== null) {
    keys.apifyToken = secrets.decrypt(stored.apifyToken, APIFY_TOKEN);
  }
  if (stored.krogerClientId !== null && stored.krogerClientSecret !== null) {
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

// Kroger, Aldi, and the weekly ads need the ZIP code (spec 15, Store locations and the ZIP code).
const needsZip = (store: StoredDealFinderStore) =>
  store.reader === "Store API" || store.id === "aldi" || store.kind === "weekly ad only";

function storeView(store: StoredDealFinderStore, zipOn: boolean): PriceSourceStoreView {
  return {
    id: store.id,
    name: store.name,
    kind: store.kind,
    reader: store.reader,
    on: store.on,
    needsZip: !zipOn && needsZip(store),
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

const asMiles = (value: number): FindStoresMiles =>
  FIND_STORES_MILES.find((miles) => miles === value) ?? 25;

export function priceSourceSettings(options: {
  database: Database;
  secrets: Secrets;
  // The Price source adapter. Without one, Test and Find Stores near us have no reader.
  adapter?: PriceSourceAdapter;
  logger?: Logger;
  now?: () => Date;
}): PriceSourceSettings {
  const { database, secrets, adapter, logger = log, now = () => new Date() } = options;
  // The Tests in flight, and whether a Find Stores lookup is. Each is taken in the same synchronous
  // step as its check, before the first await, and given back when its work ends.
  const testing = new Set<KeyedPriceSource>();
  let finding = false;

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
      stores: stores.map((store) => storeView(store, stored.useZip)),
      data,
    };
  }

  // A run's cost, when the source reported one, counts toward this month.
  async function addCost(costNanos: number | null): Promise<void> {
    if (costNanos === null || costNanos === 0) return;
    await addPriceSourceCost(database, monthOf(now(), await zone()), costNanos);
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
        const keys = keysOf(stored, secrets);
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
        let found: Awaited<ReturnType<PriceSourceAdapter["findLocations"]>>;
        try {
          found = await adapter.findLocations({
            zipCode,
            distanceMiles: miles,
            keys: keysOf(stored, secrets),
          });
        } catch (error) {
          const kind = error instanceof PriceSourceError ? error.kind : "unknown";
          logger.warn("Find Stores near us failed", { failure: kind });
          if (kind === "refused key") return { outcome: "refused key" };
          if (kind === "usage limit") return { outcome: "usage limit" };
          return { outcome: "failed" };
        }
        await addCost(found.costNanos);
        // A location outside the distance is not shown, whatever the source sent.
        const near = found.value.flatMap((store) => {
          const locations = store.locations
            .filter((place) => place.distanceMiles <= miles)
            .sort((a, b) => a.distanceMiles - b.distanceMiles);
          return store.locations.length > 0 && locations.length === 0
            ? []
            : [{ ...store, locations }];
        });
        await storeFoundStores(database, near, { zipCode, distanceMiles: miles, at: now() });
        return { outcome: "found", view: await view() };
      } finally {
        finding = false;
      }
    },

    async changeStore(id, changes) {
      const changed = await changeDealFinderStore(database, id, changes, MAX_STORES_ON);
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
