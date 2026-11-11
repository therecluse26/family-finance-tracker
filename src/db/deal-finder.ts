import { and, asc, count, eq, lt, ne, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  dealFinderPriceReads,
  dealFinderProducts,
  dealFinderSettings,
  dealFinderStores,
  LIST_ITEM_UNITS,
  memberMatchChoices,
  priceSourceCosts,
  productMatches,
  shoppingListItems,
  shoppingPlanLines,
  shoppingPlans,
} from "./schema.ts";

// The deal finder's rows in app.db (spec 15, Deal finder): its settings and keys, the Stores, the
// month's Price source cost, the Shopping list, and the data "Delete all deal finder data" removes.

// The deal finder settings' one row.
export const DEAL_FINDER_SETTINGS_ROW = 1;

export type StoredDealFinderSettings = Omit<typeof dealFinderSettings.$inferSelect, "id">;
export type StoredDealFinderStore = typeof dealFinderStores.$inferSelect;

// Each setting with no row: the schema's own defaults.
const DEFAULT_SETTINGS: StoredDealFinderSettings = {
  apifyToken: null,
  apifyTokenLast4: null,
  apifyCheck: null,
  apifyCheckedAt: null,
  krogerClientId: null,
  krogerClientIdLast4: null,
  krogerClientSecret: null,
  krogerClientSecretLast4: null,
  krogerCheck: null,
  krogerCheckedAt: null,
  openFoodFacts: false,
  useZip: false,
  findDistanceMiles: 25,
  storesFoundZip: null,
  storesFoundAt: null,
  costCap: 500,
  tripSaving: 1000,
  dietaryNeeds: "",
};

export async function readDealFinderSettings(
  database: Database,
): Promise<StoredDealFinderSettings> {
  const [row] = await database
    .select()
    .from(dealFinderSettings)
    .where(eq(dealFinderSettings.id, DEAL_FINDER_SETTINGS_ROW));
  if (row === undefined) return { ...DEFAULT_SETTINGS };
  const { id: _id, ...stored } = row;
  return stored;
}

// Changes some settings, and keeps the rest. A key is its ciphertext.
export async function storeDealFinderSettings(
  database: Database,
  changes: Partial<StoredDealFinderSettings>,
): Promise<void> {
  if (Object.keys(changes).length === 0) return;
  await database
    .insert(dealFinderSettings)
    .values({ id: DEAL_FINDER_SETTINGS_ROW, ...changes })
    .onConflictDoUpdate({ target: dealFinderSettings.id, set: changes });
}

// Stores a Test's result only while the key it tested is still the saved one, so a key saved during
// the Test keeps no result. True when it was stored.
export async function storePriceSourceCheck(
  database: Database,
  source: "apify" | "kroger",
  tested: string,
  result: { check: NonNullable<StoredDealFinderSettings["apifyCheck"]>; at: Date },
): Promise<boolean> {
  const stored =
    source === "apify"
      ? await database
          .update(dealFinderSettings)
          .set({ apifyCheck: result.check, apifyCheckedAt: result.at })
          .where(eq(dealFinderSettings.apifyToken, tested))
          .returning({ id: dealFinderSettings.id })
      : await database
          .update(dealFinderSettings)
          .set({ krogerCheck: result.check, krogerCheckedAt: result.at })
          .where(eq(dealFinderSettings.krogerClientSecret, tested))
          .returning({ id: dealFinderSettings.id });
  return stored.length === 1;
}

// Adds a run's cost to its month, YYYY-MM.
export async function addPriceSourceCost(
  database: Database,
  month: string,
  costNanos: number,
): Promise<void> {
  if (!Number.isSafeInteger(costNanos) || costNanos < 0) {
    throw new RangeError("A run's cost is a whole number of billionths of a dollar.");
  }
  await database
    .insert(priceSourceCosts)
    .values({ month, costNanos })
    .onConflictDoUpdate({
      target: priceSourceCosts.month,
      set: { costNanos: sql`${priceSourceCosts.costNanos} + ${costNanos}` },
    });
}

export async function readPriceSourceCost(database: Database, month: string): Promise<number> {
  const [row] = await database
    .select({ costNanos: priceSourceCosts.costNanos })
    .from(priceSourceCosts)
    .where(eq(priceSourceCosts.month, month));
  return row?.costNanos ?? 0;
}

// Every saved Store, nearby or not, ticked or not, by name.
export async function listDealFinderStores(database: Database): Promise<StoredDealFinderStore[]> {
  return database
    .select()
    .from(dealFinderStores)
    .orderBy(asc(dealFinderStores.name), asc(dealFinderStores.id));
}

export type FoundStoreRow = Pick<StoredDealFinderStore, "id" | "name" | "kind" | "reader"> & {
  locations: { id: string; name: string; distanceMiles: number }[];
};

// Saves what Find Stores near us found, in one transaction (spec 15, Find Stores near us). A Store
// found again keeps whether it is on, its Home store while that is still listed, and its delivery
// settings; a new one is off, with its nearest location as its Home store. A Store not found is off
// and hidden, and keeps its settings.
export async function storeFoundStores(
  database: Database,
  found: FoundStoreRow[],
  lookup: { zipCode: string; distanceMiles: number; at: Date },
): Promise<void> {
  await database.transaction(async (tx) => {
    const before = new Map(
      (await tx.select().from(dealFinderStores)).map((store) => [store.id, store]),
    );
    await tx.update(dealFinderStores).set({ on: false, nearby: false });
    for (const store of found) {
      const old = before.get(store.id);
      const home =
        store.locations.find((place) => place.id === old?.homeStoreId) ?? store.locations[0];
      const row = {
        name: store.name,
        kind: store.kind,
        reader: store.reader,
        // A Store not found by the last lookup is off already; one ticked with the switch off stays on.
        on: old?.on === true,
        nearby: true,
        locations: store.locations,
        homeStoreId: home?.id ?? null,
        homeStoreName: home?.name ?? null,
        distanceMiles: home?.distanceMiles ?? null,
        foundAt: lookup.at,
      };
      await tx
        .insert(dealFinderStores)
        .values({ id: store.id, ...row })
        .onConflictDoUpdate({ target: dealFinderStores.id, set: row });
    }
    const settings = {
      storesFoundZip: lookup.zipCode,
      storesFoundAt: lookup.at,
      findDistanceMiles: lookup.distanceMiles,
    };
    await tx
      .insert(dealFinderSettings)
      .values({ id: DEAL_FINDER_SETTINGS_ROW, ...settings })
      .onConflictDoUpdate({ target: dealFinderSettings.id, set: settings });
  });
}

export type StoreChangeResult =
  | "changed"
  | "no store"
  | "too many on"
  | "no such location"
  | "needs zip";

type StoreIdentity = Pick<StoredDealFinderStore, "id" | "name" | "kind" | "reader">;

export type StoreChangeRules = {
  maxOn: number;
  // With the ZIP code switch off, the Store as the page lists it with no lookup, when it is one.
  // Its row is added on its first change.
  withoutZip?: StoreIdentity;
  // Whether the Store gives no price without the ZIP code.
  needsZip: (store: StoreIdentity) => boolean;
  at: Date;
};

// Changes one listed Store's settings. With the ZIP code switch on, the listed Stores are the ones
// Find Stores near us found; with it off, they are also the Stores read with no location, and a
// Store that needs the ZIP code cannot be turned on, nor its Home store picked. Turning a Store on
// counts the Stores on in the same statement, so two at once never pass the cap. A Home store must
// be one of the Store's own listed locations.
export async function changeDealFinderStore(
  database: Database,
  id: string,
  changes: {
    on?: boolean;
    homeStoreId?: string;
    deliveryFee?: number | null;
    freeDeliveryFrom?: number | null;
  },
  rules: StoreChangeRules,
): Promise<StoreChangeResult> {
  return database.transaction(async (tx) => {
    const [settings] = await tx
      .select({ useZip: dealFinderSettings.useZip })
      .from(dealFinderSettings)
      .where(eq(dealFinderSettings.id, DEAL_FINDER_SETTINGS_ROW));
    const useZip = settings?.useZip === true;
    const withoutZip = useZip ? undefined : rules.withoutZip;
    const [saved] = await tx.select().from(dealFinderStores).where(eq(dealFinderStores.id, id));
    // A Store still on is listed, so it can always be turned off.
    const listed = saved?.nearby === true || saved?.on === true || withoutZip !== undefined;
    const store = listed ? (saved ?? withoutZip) : undefined;
    if (store === undefined) return "no store";
    if (!useZip && changes.homeStoreId !== undefined) return "needs zip";
    const turningOn = changes.on === true && saved?.on !== true;
    if (!useZip && turningOn && rules.needsZip(store)) return "needs zip";
    if (saved === undefined) {
      await tx.insert(dealFinderStores).values({
        id: store.id,
        name: store.name,
        kind: store.kind,
        reader: store.reader,
        on: false,
        nearby: false,
        locations: [],
        foundAt: rules.at,
      });
    }
    const locations = saved?.locations ?? [];
    const set: Partial<StoredDealFinderStore> = {};
    if (changes.homeStoreId !== undefined) {
      const home = locations.find((place) => place.id === changes.homeStoreId);
      if (home === undefined) return "no such location";
      set.homeStoreId = home.id;
      set.homeStoreName = home.name;
      set.distanceMiles = home.distanceMiles;
    }
    if (changes.deliveryFee !== undefined) set.deliveryFee = changes.deliveryFee;
    if (changes.freeDeliveryFrom !== undefined) set.freeDeliveryFrom = changes.freeDeliveryFrom;
    if (turningOn) {
      const others = tx
        .select({ count: count() })
        .from(dealFinderStores)
        .where(and(eq(dealFinderStores.on, true), ne(dealFinderStores.id, id)));
      const turned = await tx
        .update(dealFinderStores)
        .set({ ...set, on: true })
        .where(and(eq(dealFinderStores.id, id), lt(sql`(${others})`, rules.maxOn)))
        .returning({ id: dealFinderStores.id });
      return turned.length === 1 ? "changed" : "too many on";
    }
    if (changes.on === false) set.on = false;
    if (Object.keys(set).length > 0) {
      await tx.update(dealFinderStores).set(set).where(eq(dealFinderStores.id, id));
    }
    return "changed";
  });
}

export type DealFinderDataCounts = {
  products: number;
  priceReads: number;
  matches: number;
  plans: number;
};

export async function countDealFinderData(database: Database): Promise<DealFinderDataCounts> {
  const [row] = await database
    .select({
      products: sql<number>`(SELECT count(*) FROM ${dealFinderProducts})`,
      priceReads: sql<number>`(SELECT count(*) FROM ${dealFinderPriceReads})`,
      matches: sql<number>`(SELECT count(*) FROM ${productMatches})`,
      plans: sql<number>`(SELECT count(*) FROM ${shoppingPlans})`,
    })
    .from(sql`(SELECT 1)`);
  return {
    products: Number(row?.products ?? 0),
    priceReads: Number(row?.priceReads ?? 0),
    matches: Number(row?.matches ?? 0),
    plans: Number(row?.plans ?? 0),
  };
}

// "Delete all deal finder data" (spec 15, The Price sources page in Settings), in one transaction:
// every plan and its lines, every match and Member match choice, every price read, and every
// Product. It keeps the Shopping list, the Stores and their settings, the keys, and the month's
// cost, which Apify charged already.
export async function deleteDealFinderData(database: Database): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.delete(shoppingPlanLines);
    await tx.delete(shoppingPlans);
    await tx.delete(productMatches);
    await tx.delete(memberMatchChoices);
    await tx.delete(dealFinderPriceReads);
    await tx.delete(dealFinderProducts);
  });
}

// Deletes the price reads older than `before`: price history is kept 400 days.
export async function deletePriceReadsBefore(database: Database, before: Date): Promise<number> {
  const deleted = await database
    .delete(dealFinderPriceReads)
    .where(lt(dealFinderPriceReads.readAt, before))
    .returning({ id: dealFinderPriceReads.id });
  return deleted.length;
}

export type NewListItem = {
  id: string;
  words: string;
  quantity: number;
  unit: (typeof LIST_ITEM_UNITS)[number];
  brandLock: string | null;
  note: string | null;
  addedAt: Date;
  addedBy: string | null;
};

// Adds a List item at the end of the Shopping list. The count and the insert are one statement, so
// two adds at once never pass the cap. False when the list holds `max` List items already.
export async function addShoppingListItem(
  database: Database,
  item: NewListItem,
  max: number,
): Promise<boolean> {
  if (!LIST_ITEM_UNITS.includes(item.unit)) throw new RangeError("Unknown List item unit.");
  const added = await database.all<{ id: string }>(sql`
    INSERT INTO ${shoppingListItems}
      (id, words, quantity, unit, brand_lock, note, ticked, place, added_at, added_by)
    SELECT ${item.id}, ${item.words}, ${item.quantity}, ${item.unit}, ${item.brandLock},
      ${item.note}, 0, (SELECT coalesce(max(place) + 1, 0) FROM ${shoppingListItems}),
      ${item.addedAt.toISOString()}, ${item.addedBy}
    WHERE (SELECT count(*) FROM ${shoppingListItems}) < ${max}
    RETURNING id`);
  return added.length === 1;
}
