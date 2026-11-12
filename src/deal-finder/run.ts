import type { HouseholdAi } from "../ai/index.ts";
import {
  type CheckedProduct,
  countStoreFailedRuns,
  type Database,
  deletePriceReadsBefore,
  finishPlanRun,
  listDealFinderStores,
  listUncheckedMatches,
  type PlanRunListItem,
  readDealFinderSettings,
  readHouseholdFacts,
  readLatestPlanRun,
  readPlanRun,
  readPlanRunInputs,
  readPriceSourceCost,
  readRunningPlanRun,
  type SavedMatch,
  type StoredDealFinderSettings,
  type StoredDealFinderStore,
  type StoreFailure,
  type StoreRead,
  startPlanRun,
  storePriceSourceCheck,
  storeStoreRead,
} from "../db/index.ts";
import { calendarDateIn } from "../format.ts";
import { Job, type JobArgument, startJob } from "../jobs/index.ts";
import { type Logger, log } from "../log.ts";
import { endCondition, type NewNotice, raiseNotice } from "../notify/index.ts";
import type { Secrets } from "../secrets/index.ts";
import {
  isMadeUpId,
  type PriceSourceAdapter,
  PriceSourceError,
  type PriceSourceKeys,
  type ProductRead,
  type WeeklyAdItem,
} from "./adapter.ts";
import { type CapPlace, CostCapReached, priceSourceCostCap } from "./cost-cap.ts";
import { answerMatches, lookUpFacts, searchQuery, writeSearchWords } from "./match.ts";
import type { ProductDataAdapter, ProductFacts } from "./product-data.ts";
import {
  COST_CAP_REACHED,
  COULD_NOT_READ,
  FIND_STORES_AGAIN,
  NEEDS_ZIP,
  type PlanRunPhase,
  type PlanRunStart,
  type PlanRunStoreProgress,
  type PlanRunView,
  SOURCE_REASONS,
} from "./run-view.ts";
import { readPriceSourceKeys } from "./settings.ts";
import { PRICE_HISTORY_DAYS, storeNeedsZip, WALMART_SEARCH_NANOS } from "./view.ts";

// The plan run (spec 15, The Shopping plan; Search once, then re-read; Cost and limits; Failures).
// A Member presses "Find the best prices", and a job reads each Store that is on, the AI matches
// List items to Products, and app code builds the plan. One plan run goes at a time: a second press
// while one runs joins it. A run that holds a full search at a Store that charges waits for a
// Member to confirm its expected cost.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// A price read less than 24 hours ago is reused (spec 15, Prices and Deals).
export const PRICE_REUSE_MS = DAY_MS;
// A List item is fully searched again 30 days after its last full search.
export const FULL_SEARCH_AGAIN_MS = 30 * DAY_MS;
// Walmart searches a List item again 28 days after its last full search, and reads nothing between
// (owner decision, 2026-11-12): a search costs about $0.88, and its Actor cannot read one Product.
export const WALMART_SEARCH_AGAIN_MS = 28 * DAY_MS;
// The weekly ads are searched again a day after their last search, as Deals change each week.
const WEEKLY_ADS_AGAIN_MS = DAY_MS;
// A plan run still running an hour after it started has stopped, such as at a restart cut short:
// the next start ends it as failed, and its job, run again, ends at once (known finding K4).
export const PLAN_RUN_STALE_MS = HOUR_MS;
// At most 2 Actor runs go at once.
export const RUNS_AT_ONCE = 2;
// A Store that fails this many plan runs in a row raises one System notice.
export const FAILED_RUNS_FOR_NOTICE = 3;

// Products kept per search (owner decision, 2026-11-11): 15 at Kroger, Walmart and Target, 10 at
// Costco and Aldi, and 5 at Amazon and the weekly ads.
export const PRODUCTS_PER_SEARCH: Readonly<Record<string, number>> = {
  kroger: 15,
  walmart: 15,
  target: 15,
  costco: 10,
  aldi: 10,
  amazon: 5,
};
const DEFAULT_PRODUCTS_PER_SEARCH = 15;
export const WEEKLY_AD_DEALS = 5;

// How each Store's saved matches are read again.
// - api: the Store API reads each Product, free.
// - search again: Target searches again, as a search costs the same as a re-read.
// - full search only: Walmart reads nothing between full searches, 28 days apart, and the plan
//   uses its saved price.
// - re-read: the Scraping service reads the matched Products by item number or link.
type ReadMode = "api" | "search again" | "full search only" | "re-read";

function readModeOf(store: Pick<StoredDealFinderStore, "id" | "reader">): ReadMode {
  if (store.reader === "Store API") return "api";
  if (store.id === "walmart") return "full search only";
  return store.id === "target" ? "search again" : "re-read";
}

// Measured prices (spec 15, Cost and limits), in billionths of a dollar: per search, per Actor run,
// and per Product or Deal. They come from the owner's run of 2026-11-12, counted from each Actor's
// charged events on Apify's run records a day later, not from `usageTotalUsd` at the end of a run,
// which holds only the start events. Walmart is $0.08 a run (4 start events, one per GB of its 4 GB)
// plus $0.02 a row, about 40 rows a search: about $0.88 a search at most. Target charges $0.00025 a
// request. Aldi is about $0.01 a run plus $0.002 a Product, Costco $0.005 a Product, Amazon $0.0025
// a Product, and the weekly ads $0.002 a Deal; their start events add less than a cent a run. Aldi
// and Walmart take one query, so each search is its own run. A Store with no measured price counts
// Costco's price per Product, the highest.
type RunPrice = { perSearch: number; perRun: number; perProduct: number };
const RUN_PRICES: Readonly<Record<string, RunPrice>> = {
  walmart: { perSearch: WALMART_SEARCH_NANOS, perRun: 0, perProduct: 0 },
  target: { perSearch: 250_000, perRun: 0, perProduct: 0 },
  aldi: { perSearch: 0, perRun: 10_000_000, perProduct: 2_000_000 },
  costco: { perSearch: 0, perRun: 0, perProduct: 5_000_000 },
  amazon: { perSearch: 0, perRun: 0, perProduct: 2_500_000 },
};
const UNKNOWN_STORE_PRICE: RunPrice = { perSearch: 0, perRun: 0, perProduct: 5_000_000 };
const WEEKLY_AD_PRICE: RunPrice = { perSearch: 0, perRun: 0, perProduct: 2_000_000 };

const productsPerSearch = (storeId: string) =>
  PRODUCTS_PER_SEARCH[storeId] ?? DEFAULT_PRODUCTS_PER_SEARCH;

// What a plan run reads at one Store.
type StoreWork = {
  store: StoredDealFinderStore;
  // List items fully searched: their first run, 30 days on (28 at Walmart), or after their match
  // failed.
  full: PlanRunListItem[];
  // List items Target searches again, in place of a re-read.
  again: PlanRunListItem[];
  // Saved matches read again, each older than 24 hours.
  reread: SavedMatch[];
};

// What a plan run reads at one Store, from its List items' saved matches and full searches. A
// List item whose prices are all less than 24 hours old reads nothing, and at Walmart a List item
// reads nothing between its full searches.
function planStoreWork(
  store: StoredDealFinderStore,
  items: readonly PlanRunListItem[],
  matches: ReadonlyMap<string, SavedMatch[]>,
  searched: ReadonlyMap<string, Date>,
  now: number,
): StoreWork {
  const work: StoreWork = { store, full: [], again: [], reread: [] };
  const mode = readModeOf(store);
  const searchAgainMs =
    mode === "full search only" ? WALMART_SEARCH_AGAIN_MS : FULL_SEARCH_AGAIN_MS;
  for (const item of items) {
    const key = `${item.id}\u0000${store.id}`;
    const last = searched.get(key);
    if (last === undefined || now - last.getTime() >= searchAgainMs) {
      work.full.push(item);
      continue;
    }
    if (mode === "full search only") continue;
    const stale = (matches.get(key) ?? []).filter(
      (match) => match.lastReadAt === null || now - match.lastReadAt.getTime() >= PRICE_REUSE_MS,
    );
    if (stale.length === 0) continue;
    if (mode === "search again") work.again.push(item);
    else work.reread.push(...stale);
  }
  return work;
}

// The expected cost of one Store's work, in billionths of a dollar. The Store API is free.
function storeCost(work: StoreWork): number {
  if (readModeOf(work.store) === "api") return 0;
  const price = RUN_PRICES[work.store.id] ?? UNKNOWN_STORE_PRICE;
  const count = productsPerSearch(work.store.id);
  const searches = work.full.length + work.again.length;
  let cost = searches * (price.perSearch + price.perRun + price.perProduct * count);
  if (work.reread.length > 0) cost += price.perRun + price.perProduct * work.reread.length;
  return cost;
}

const weeklyAdsCost = (items: number) => items * WEEKLY_AD_DEALS * WEEKLY_AD_PRICE.perProduct;

// The weekly ads' work: the List items whose weekly-ad search is a day old or more at a
// weekly-ad-only Store that is on, and whether any is a List item's first.
type AdsWork = { stores: StoredDealFinderStore[]; items: PlanRunListItem[]; first: boolean };

function planAdsWork(
  stores: readonly StoredDealFinderStore[],
  items: readonly PlanRunListItem[],
  searched: ReadonlyMap<string, Date>,
  now: number,
): AdsWork {
  const work: AdsWork = { stores: [...stores], items: [], first: false };
  if (stores.length === 0) return work;
  for (const item of items) {
    const times = stores.map((store) => searched.get(`${item.id}\u0000${store.id}`));
    if (times.some((time) => time === undefined)) work.first = true;
    if (times.some((time) => time === undefined || now - time.getTime() >= WEEKLY_ADS_AGAIN_MS)) {
      work.items.push(item);
    }
  }
  return work;
}

// A price, in whole cents above $0.00 and below $10,000.00 (spec 15, Checks on every price). Null
// for none, and undefined for one that fails, which drops its Product.
function checkedPrice(price: number | null): number | null | undefined {
  if (price === null) return null;
  return Number.isSafeInteger(price) && price >= 1 && price <= 999_999 ? price : undefined;
}

const TEXT_MAX = 200;
const cut = (text: string | null) => {
  if (text === null) return null;
  const plain = text.toWellFormed().replace(/\s+/g, " ").trim().slice(0, TEXT_MAX).trim();
  return plain === "" ? null : plain;
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (date: string | null) =>
  date !== null && DATE.test(date) && new Date(`${date}T00:00:00Z`).toISOString().startsWith(date)
    ? date
    : null;

// A Product after the app's checks, or undefined when it is dropped: a price that is not whole cents
// in range, no price at all, no name, or a re-read key that does not fit.
export function checkProduct(product: ProductRead): CheckedProduct | undefined {
  const regularPrice = checkedPrice(product.regularPrice);
  const dealPrice = checkedPrice(product.dealPrice);
  const onlinePrice = checkedPrice(product.onlinePrice);
  if (regularPrice === undefined || dealPrice === undefined || onlinePrice === undefined) {
    return undefined;
  }
  if (regularPrice === null && dealPrice === null && onlinePrice === null) return undefined;
  const name = cut(product.name);
  const readKey = product.readKey.trim();
  if (name === null || readKey === "" || readKey.length > TEXT_MAX) return undefined;
  const link = product.link !== null && product.link.length <= TEXT_MAX ? product.link : null;
  const upc = product.upc !== null && /^\d{6,14}$/.test(product.upc) ? product.upc : null;
  return {
    readKey,
    name,
    brand: cut(product.brand),
    size: cut(product.size),
    upc,
    link,
    regularPrice,
    dealPrice,
    dealEndsOn: realDate(product.dealEndsOn),
    onlinePrice,
  };
}

// A weekly-ad item as a Product of its Store: it has only its Deal, and its own end date.
function adProduct(item: WeeklyAdItem): ProductRead {
  const name = item.name.slice(0, 150);
  return {
    readKey: `ad:${item.validTo}:${name}`,
    name: item.name,
    brand: null,
    size: null,
    upc: null,
    link: null,
    regularPrice: null,
    dealPrice: item.dealPrice,
    dealEndsOn: item.validTo,
    onlinePrice: null,
  };
}

const plainWords = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);

// Whether a weekly-ad item is for a List item: its name holds every word of the List item.
function adFor(item: PlanRunListItem, adName: string): boolean {
  const name = new Set(plainWords(adName));
  const words = plainWords(item.words);
  return words.length > 0 && words.every((word) => name.has(word) || name.has(`${word}s`));
}

// The most barcodes' facts the app keeps between plan runs.
const FACTS_KEPT = 5_000;

// A System notice: the notify module's, unless a test gives its own.
export type PlanRunNotices = {
  raise(notice: NewNotice): Promise<unknown>;
  end(condition: string): Promise<void>;
};

// The condition of the one System notice a Store raises when it fails 3 plan runs in a row.
export const storeFailingCondition = (storeId: string) => `deal finder store failing:${storeId}`;

export type PlanRunOptions = {
  database: Database;
  secrets: Secrets;
  adapter: PriceSourceAdapter;
  ai: HouseholdAi;
  // Open Food Facts, used when a Member turns it on.
  productData?: ProductDataAdapter;
  logger?: Logger;
  now?: () => Date;
  notices?: PlanRunNotices;
  // Starts the plan run's job. Tests give their own, which may run it at once.
  startRun?: (planId: string) => Promise<void>;
  // Builds the Shopping plan from the stored prices and matches, once the reads and matches end.
  buildPlan?: (planId: string) => Promise<void>;
};

export type PlanRuns = {
  // "Find the best prices". With a full search at a Store that charges, it starts only when the
  // Member confirmed at least the expected cost, in billionths of a dollar.
  start(memberId: string | null, confirmedCostNanos?: number): Promise<PlanRunStart>;
  // The running plan run, else the last one, with each Store's progress. Null before any.
  view(): Promise<PlanRunView | null>;
  // The plan run's work, which its job runs. It never throws: a failure ends the run as failed.
  run(planId: string): Promise<void>;
};

type Progress = {
  planId: string;
  phase: PlanRunPhase;
  startedAt: Date;
  finishedAt: Date | null;
  stores: Map<string, PlanRunStoreProgress>;
};

type KeyedSource = "apify" | "kroger";
const sourceOf = (store: Pick<StoredDealFinderStore, "reader">): KeyedSource =>
  store.reader === "Store API" ? "kroger" : "apify";

// Why a Store's read ended, as its progress and the plan's failures show it.
type StoreEnd =
  | { state: "read" | "stored prices" }
  | { state: "skipped" | "failed"; reason: string };

export function planRuns(options: PlanRunOptions): PlanRuns {
  const { database, adapter, ai, logger = log } = options;
  const now = options.now ?? (() => new Date());
  const notices: PlanRunNotices = options.notices ?? { raise: raiseNotice, end: endCondition };
  const startRun =
    options.startRun ?? ((planId: string) => startJob(PlanRunJob, [planId]) as Promise<void>);
  // The start in flight: a second press while it runs joins it (K18).
  let starting: Promise<PlanRunStart> | undefined;
  // The progress of the running plan run, or of the last one this process ran.
  let progress: Progress | undefined;
  // The Price source cost cap, held before each Actor run (K18).
  const costCap = priceSourceCostCap(database);
  // Each barcode's Open Food Facts facts, kept while the app runs.
  const facts = new Map<string, ProductFacts | null>();

  async function zoneAndZip(): Promise<{ timeZone: string; zipCode: string | null }> {
    const household = await readHouseholdFacts(database);
    return { timeZone: household?.timeZone ?? "UTC", zipCode: household?.zipCode ?? null };
  }

  const monthOf = (at: Date, timeZone: string) => calendarDateIn(at, timeZone).slice(0, 7);

  // Every Store that is on, and why one that cannot be read is skipped.
  function skipReason(
    store: StoredDealFinderStore,
    settings: StoredDealFinderSettings,
    zipCode: string | null,
    keys: PriceSourceKeys,
  ): string | undefined {
    if (storeNeedsZip(store) && (!settings.useZip || zipCode === null)) return NEEDS_ZIP;
    // A Home store the fake adapter found is never sent to a real reader. It is sent only with the
    // ZIP code switch on.
    if (settings.useZip && isMadeUpId(store.homeStoreId) && adapter.madeUpStores !== true) {
      return FIND_STORES_AGAIN;
    }
    const source = sourceOf(store);
    const check = source === "apify" ? settings.apifyCheck : settings.krogerCheck;
    if (check === "refused") return SOURCE_REASONS[source]["refused key"];
    const keyed = source === "apify" ? keys.apifyToken : keys.kroger;
    if (keyed === undefined) return SOURCE_REASONS[source]["no key"];
    return undefined;
  }

  async function readKeys(): Promise<PriceSourceKeys> {
    try {
      return await readPriceSourceKeys(database, options.secrets);
    } catch (error) {
      logger.warn("The Price source keys could not be read for a plan run", {
        error: error instanceof Error ? error.name : "unknown",
      });
      return {};
    }
  }

  // Everything a plan run reads at each Store, and its expected cost.
  async function workOf(at: Date) {
    const [inputs, settings, stores, place] = await Promise.all([
      readPlanRunInputs(database),
      readDealFinderSettings(database),
      listDealFinderStores(database),
      zoneAndZip(),
    ]);
    const on = stores.filter((store) => store.on);
    const searched = new Map(
      inputs.searches.map((search) => [
        `${search.listItemId}\u0000${search.storeId}`,
        search.searchedAt,
      ]),
    );
    const matches = new Map<string, SavedMatch[]>();
    for (const match of inputs.matches) {
      const key = `${match.listItemId}\u0000${match.storeId}`;
      // A Product the fake adapter found is never re-read by a real reader. It counts as no match,
      // and its List item is fully searched at that Store, unless it was searched there after that
      // Product's last read.
      if (isMadeUpId(match.readKey) && adapter.madeUpStores !== true) {
        const last = searched.get(key);
        if (last !== undefined && match.lastReadAt !== null && last <= match.lastReadAt) {
          searched.delete(key);
        }
        continue;
      }
      matches.set(key, [...(matches.get(key) ?? []), match]);
    }
    const time = at.getTime();
    const adStores = on.filter((store) => store.kind === "weekly ad only");
    const storeWork = on
      .filter((store) => store.kind !== "weekly ad only")
      .map((store) => planStoreWork(store, inputs.items, matches, searched, time));
    const ads = planAdsWork(adStores, inputs.items, searched, time);
    return { inputs, settings, on, storeWork, ads, place };
  }

  // The expected cost of the reads that could run now, past the Stores that would be skipped.
  function costOf(
    work: Awaited<ReturnType<typeof workOf>>,
    keys: PriceSourceKeys,
  ): { costNanos: number; fullSearch: boolean } {
    const { settings, storeWork, ads, place } = work;
    let costNanos = 0;
    let fullSearch = false;
    for (const each of storeWork) {
      if (skipReason(each.store, settings, place.zipCode, keys) !== undefined) continue;
      const cost = storeCost(each);
      costNanos += cost;
      if (each.full.length > 0 && cost > 0) fullSearch = true;
    }
    const readableAds = ads.stores.filter(
      (store) => skipReason(store, settings, place.zipCode, keys) === undefined,
    );
    if (readableAds.length > 0 && ads.items.length > 0) {
      costNanos += weeklyAdsCost(ads.items.length);
      if (ads.first) fullSearch = true;
    }
    return { costNanos, fullSearch };
  }

  function viewOf(run: Progress): PlanRunView {
    return {
      planId: run.planId,
      running: run.phase !== "done" && run.phase !== "failed",
      phase: run.phase,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      stores: [...run.stores.values()],
    };
  }

  async function startOnce(
    memberId: string | null,
    confirmedCostNanos: number | undefined,
  ): Promise<PlanRunStart> {
    const at = now();
    const running = await readRunningPlanRun(database);
    if (running !== undefined && at.getTime() - running.startedAt.getTime() < PLAN_RUN_STALE_MS) {
      return { outcome: "joined", run: (await view()) as PlanRunView };
    }
    const work = await workOf(at);
    if (work.inputs.items.length === 0) return { outcome: "no items" };
    if (work.on.length === 0) return { outcome: "no stores" };
    const keys = await readKeys();
    const { costNanos, fullSearch } = costOf(work, keys);
    if (fullSearch && (confirmedCostNanos === undefined || confirmedCostNanos < costNanos)) {
      const month = monthOf(at, work.place.timeZone);
      return {
        outcome: "confirm",
        cost: {
          fullSearch,
          costNanos,
          monthCostNanos: await readPriceSourceCost(database, month),
          capCents: work.settings.costCap,
        },
      };
    }
    const started = await startPlanRun(database, {
      id: crypto.randomUUID(),
      at,
      by: memberId,
      tripSaving: work.settings.tripSaving,
      staleBefore: new Date(at.getTime() - PLAN_RUN_STALE_MS),
    });
    if (!started.started) return { outcome: "joined", run: (await view()) as PlanRunView };
    progress = {
      planId: started.id,
      phase: "reading",
      startedAt: at,
      finishedAt: null,
      stores: new Map(
        work.on.map((store) => [
          store.id,
          { storeId: store.id, name: store.name, state: "waiting", reason: null },
        ]),
      ),
    };
    try {
      await startRun(started.id);
    } catch (error) {
      await finishPlanRun(database, started.id, { state: "failed", at: now(), storeFailures: [] });
      if (progress?.planId === started.id) progress = { ...progress, phase: "failed" };
      throw error;
    }
    return { outcome: "started", run: (await view()) as PlanRunView };
  }

  async function view(): Promise<PlanRunView | null> {
    const latest = (await readRunningPlanRun(database)) ?? (await readLatestPlanRun(database));
    if (latest === undefined) return null;
    if (progress !== undefined && progress.planId === latest.id) return viewOf(progress);
    // A run from before a restart: its row says how it ended, and which Stores failed.
    const stores = await listDealFinderStores(database);
    const names = new Map(stores.map((store) => [store.id, store.name]));
    return {
      planId: latest.id,
      running: latest.state === "running",
      phase: latest.state === "running" ? "reading" : latest.state,
      startedAt: latest.startedAt.toISOString(),
      finishedAt: latest.finishedAt?.toISOString() ?? null,
      stores: latest.storeFailures.map((failure) => ({
        storeId: failure.storeId,
        name: names.get(failure.storeId) ?? failure.storeId,
        state: failure.reason === COULD_NOT_READ ? "failed" : "skipped",
        reason: failure.reason,
      })),
    };
  }

  // One Store's progress, when the run is this process's.
  function mark(
    planId: string,
    storeId: string,
    state: PlanRunStoreProgress["state"],
    reason?: string,
  ) {
    const each = progress?.planId === planId ? progress.stores.get(storeId) : undefined;
    if (each !== undefined) {
      each.state = state;
      each.reason = reason ?? null;
    }
  }

  async function run(planId: string): Promise<void> {
    try {
      await runOnce(planId);
    } catch (error) {
      logger.error("A plan run failed", { error: error instanceof Error ? error.name : "unknown" });
      // The Store failures found before the run failed still show.
      const storeFailures =
        progress?.planId === planId
          ? [...progress.stores.values()].flatMap((store) =>
              (store.state === "skipped" || store.state === "failed") && store.reason !== null
                ? [{ storeId: store.storeId, reason: store.reason }]
                : [],
            )
          : [];
      try {
        await finishPlanRun(database, planId, { state: "failed", at: now(), storeFailures });
      } catch (ending) {
        logger.error("A failed plan run could not be ended", {
          error: ending instanceof Error ? ending.name : "unknown",
        });
      }
      if (progress?.planId === planId)
        progress = { ...progress, phase: "failed", finishedAt: now() };
    }
  }

  async function runOnce(planId: string): Promise<void> {
    const stored = await readPlanRun(database, planId);
    if (stored === undefined || stored.state !== "running") return;
    const startedAt = now();
    if (startedAt.getTime() - stored.startedAt.getTime() >= PLAN_RUN_STALE_MS) {
      await finishPlanRun(database, planId, { state: "failed", at: startedAt, storeFailures: [] });
      logger.warn("A plan run stopped before it ended", { planId });
      return;
    }
    // A run whose job started again after a restart has no progress yet.
    if (progress?.planId !== planId) {
      progress = {
        planId,
        phase: "reading",
        startedAt: stored.startedAt,
        finishedAt: null,
        stores: new Map(),
      };
    }
    const running = progress;
    const keys = await readKeys();
    let work = await workOf(startedAt);
    for (const store of work.on) {
      if (!running.stores.has(store.id)) {
        running.stores.set(store.id, {
          storeId: store.id,
          name: store.name,
          state: "waiting",
          reason: null,
        });
      }
    }
    // The AI writes each new List item's search words once, before any search.
    if (work.inputs.items.some((item) => item.searchWords === null)) {
      const written = await writeSearchWords(database, ai, work.inputs.items);
      if (written.written.size > 0) work = await workOf(startedAt);
    }
    const failures: StoreFailure[] = [];
    const ended = new Map<string, StoreEnd>();
    const end = (storeId: string, outcome: StoreEnd) => {
      ended.set(storeId, outcome);
      if (outcome.state === "skipped" || outcome.state === "failed") {
        failures.push({ storeId, reason: outcome.reason });
        mark(planId, storeId, outcome.state, outcome.reason);
      } else {
        mark(planId, storeId, outcome.state);
      }
    };
    // A source that refused its key or reached its usage limit in this run: its other Stores are
    // skipped with the same reason.
    const sourceDown = new Map<KeyedSource, string>();
    const { settings, place } = work;
    const zipCode = settings.useZip ? place.zipCode : null;
    const month = monthOf(startedAt, place.timeZone);

    type Task = {
      storeIds: string[];
      source: KeyedSource;
      read: () => Promise<void>;
    };
    const tasks: Task[] = [];
    for (const each of work.storeWork) {
      const reason = skipReason(each.store, settings, place.zipCode, keys);
      if (reason !== undefined) {
        end(each.store.id, { state: "skipped", reason });
        continue;
      }
      if (each.full.length + each.again.length + each.reread.length === 0) {
        end(each.store.id, { state: "stored prices" });
        continue;
      }
      tasks.push({
        storeIds: [each.store.id],
        source: sourceOf(each.store),
        read: () => readStore(each, zipCode, keys),
      });
    }
    const adStores = work.ads.stores.filter((store) => {
      const reason = skipReason(store, settings, place.zipCode, keys);
      if (reason !== undefined) end(store.id, { state: "skipped", reason });
      return reason === undefined;
    });
    if (adStores.length > 0) {
      if (work.ads.items.length === 0 || zipCode === null) {
        for (const store of adStores) end(store.id, { state: "stored prices" });
      } else {
        tasks.push({
          storeIds: adStores.map((store) => store.id),
          source: "apify",
          read: () => readWeeklyAds(adStores, work.ads.items, zipCode, keys),
        });
      }
    }

    // One store's read, with one retry, and the cost cap before each Actor run. Each read is stored
    // as it ends, so a later Store's failure keeps it (K5). A Store whose next Actor run does not fit
    // under the cap ends with "cost cap reached", and keeps what it read before.
    const runTask = async (task: Task) => {
      const down = sourceDown.get(task.source);
      if (down !== undefined) {
        for (const id of task.storeIds) end(id, { state: "skipped", reason: down });
        return;
      }
      for (const id of task.storeIds) mark(planId, id, "reading");
      try {
        await task.read();
        for (const id of task.storeIds) end(id, { state: "read" });
      } catch (error) {
        if (error instanceof CostCapReached) {
          for (const id of task.storeIds) end(id, { state: "skipped", reason: COST_CAP_REACHED });
          return;
        }
        const kind = error instanceof PriceSourceError ? error.kind : "store failed";
        if (kind === "refused key" || kind === "usage limit") {
          const reason = SOURCE_REASONS[task.source][kind];
          sourceDown.set(task.source, reason);
          if (kind === "refused key") await noteRefused(task.source);
          for (const id of task.storeIds) end(id, { state: "skipped", reason });
        } else {
          logger.warn("A Store could not be read in a plan run", {
            stores: task.storeIds,
            error: error instanceof PriceSourceError ? error.kind : "unknown",
          });
          for (const id of task.storeIds) end(id, { state: "failed", reason: COULD_NOT_READ });
        }
      }
    };

    // A place under the cost cap for one adapter call, which starts at most one Actor run. The
    // Store API is free and holds none. Throws CostCapReached when the run does not fit.
    const placeFor = async (source: KeyedSource): Promise<CapPlace> => {
      if (source !== "apify") return costCap.free(month);
      const place = await costCap.hold(month, settings.costCap);
      if (place === null) throw new CostCapReached();
      return place;
    };

    // Each adapter call with one retry for the Store in this run, each try with its own place under
    // the cost cap. A refused key or a usage limit is not retried. A run's cost counts toward the
    // month as soon as it is known, and a failed run's too, before the retry or the end. A run that
    // timed out is a Store failure, like any other failed Actor run (spec 15, Failures).
    const withRetry =
      (retries: { left: number }, source: KeyedSource) =>
      async <T>(call: () => Promise<{ value: T; costNanos: number | null }>): Promise<T> => {
        for (;;) {
          const place = await placeFor(source);
          try {
            const result = await call();
            await place.end(result.costNanos);
            return result.value;
          } catch (error) {
            await place.end(error instanceof PriceSourceError ? error.costNanos : undefined);
            const kind = error instanceof PriceSourceError ? error.kind : "store failed";
            const storeFailure = kind === "store failed" || kind === "timed out";
            if (!storeFailure || retries.left === 0) throw error;
            retries.left -= 1;
          }
        }
      };

    async function readStore(
      each: StoreWork,
      zip: string | null,
      sourceKeys: PriceSourceKeys,
    ): Promise<void> {
      const { store } = each;
      const retries = { left: 1 };
      const call = withRetry(retries, sourceOf(store));
      const base = {
        storeId: store.id,
        homeStoreId: settings.useZip ? store.homeStoreId : null,
        zipCode: zip,
        keys: sourceKeys,
      };
      // The cost cap can stop the read between two Actor runs. What was read before is kept.
      let capped: CostCapReached | undefined;
      const untilCap = async (work: () => Promise<void>) => {
        try {
          await work();
        } catch (error) {
          if (!(error instanceof CostCapReached)) throw error;
          capped = error;
        }
      };
      const searchItems = [...each.full, ...each.again];
      const count = productsPerSearch(store.id);
      const found: StoreRead["found"] = [];
      // The searches that ran, in order. A missing answer is a search that found nothing.
      let searchedCount = 0;
      if (searchItems.length > 0) {
        const searches = searchItems.map((item) => ({
          words: searchQuery(item),
          productCount: count,
        }));
        const results: ProductRead[][] = [];
        await untilCap(async () => {
          if (adapter.searchStoreMany !== undefined) {
            const many = adapter.searchStoreMany.bind(adapter);
            results.push(...(await call(() => many({ ...base, searches }))));
            searchedCount = searches.length;
            return;
          }
          for (const search of searches) {
            results.push(
              await call(() =>
                adapter.searchStore({ ...base, words: search.words, productCount: count }),
              ),
            );
            searchedCount += 1;
          }
        });
        searchItems.slice(0, searchedCount).forEach((item, index) => {
          const products = (results[index] ?? [])
            .slice(0, count)
            .flatMap((product) => checkProduct(product) ?? []);
          found.push({ listItemId: item.id, products });
        });
      }
      const reread: CheckedProduct[] = [];
      const failed: StoreRead["failed"] = [];
      if (each.reread.length > 0 && capped === undefined) {
        const readKeys = [...new Set(each.reread.map((match) => match.readKey))];
        const results: (ProductRead | null)[] = [];
        // The re-read keys that were read.
        let readCount = 0;
        await untilCap(async () => {
          if (readModeOf(store) !== "api" && adapter.readProducts !== undefined) {
            const many = adapter.readProducts.bind(adapter);
            results.push(...(await call(() => many({ ...base, readKeys }))));
            readCount = readKeys.length;
            return;
          }
          for (const readKey of readKeys) {
            results.push(await call(() => adapter.readProduct({ ...base, readKey })));
            readCount += 1;
          }
        });
        const byKey = new Map<string, CheckedProduct | undefined>();
        readKeys.slice(0, readCount).forEach((readKey, index) => {
          const product = results[index];
          // Stored under the key it was read by, so the saved match keeps its Product.
          const checked =
            product === null || product === undefined
              ? undefined
              : checkProduct({ ...product, readKey });
          byKey.set(readKey, checked);
        });
        for (const product of byKey.values()) if (product !== undefined) reread.push(product);
        for (const match of each.reread) {
          // The match fails: the Store no longer has it, or gave it no price. A key the cost cap
          // left unread keeps its match.
          if (byKey.has(match.readKey) && byKey.get(match.readKey) === undefined) {
            failed.push({ listItemId: match.listItemId, readKey: match.readKey });
          }
        }
      }
      // A Store the cost cap stopped before its first run read nothing, and stores nothing.
      if (capped === undefined || found.length > 0 || reread.length > 0 || failed.length > 0) {
        const searched = new Set(found.map((each) => each.listItemId));
        await storeStoreRead(database, {
          storeId: store.id,
          at: now(),
          found,
          searched: each.full.filter((item) => searched.has(item.id)).map((item) => item.id),
          reread,
          failed,
        });
      }
      if (capped !== undefined) throw capped;
    }

    async function readWeeklyAds(
      stores: readonly StoredDealFinderStore[],
      items: readonly PlanRunListItem[],
      zip: string,
      sourceKeys: PriceSourceKeys,
    ): Promise<void> {
      const retries = { left: 1 };
      const ads = await withRetry(
        retries,
        "apify",
      )<WeeklyAdItem[]>(() =>
        adapter.readWeeklyAds({
          zipCode: zip,
          storeIds: stores.map((store) => store.id),
          words: items.map((item) => searchQuery(item)),
          keys: sourceKeys,
        }),
      );
      const at = now();
      for (const store of stores) {
        const own = ads.filter((ad) => ad.storeId === store.id);
        await storeStoreRead(database, {
          storeId: store.id,
          at,
          found: items.map((item) => ({
            listItemId: item.id,
            products: own
              .filter((ad) => adFor(item, ad.name))
              .slice(0, WEEKLY_AD_DEALS)
              .flatMap((ad) => checkProduct(adProduct(ad)) ?? []),
          })),
          searched: items.map((item) => item.id),
          reread: [],
          failed: [],
        });
      }
    }

    async function noteRefused(source: KeyedSource): Promise<void> {
      const tested = source === "apify" ? settings.apifyToken : settings.krogerClientSecret;
      if (tested === null) return;
      await storePriceSourceCheck(database, source, tested, { check: "refused", at: now() });
    }

    // At most 2 runs at once.
    let next = 0;
    const worker = async () => {
      while (next < tasks.length) {
        const task = tasks[next] as Task;
        next += 1;
        await runTask(task);
      }
    };
    await Promise.all(Array.from({ length: RUNS_AT_ONCE }, worker));

    // Matching: every unchecked match, from this run and any run before it that stopped.
    running.phase = "matching";
    const unchecked = await listUncheckedMatches(database);
    if (unchecked.length > 0) {
      const fresh = await readDealFinderSettings(database);
      if (fresh.openFoodFacts && options.productData !== undefined) {
        // The cache holds at most a few runs of lookups.
        if (facts.size > FACTS_KEPT) facts.clear();
        const barcodes = unchecked.flatMap((row) => (row.upc === null ? [] : [row.upc]));
        await lookUpFacts(options.productData, barcodes, facts, logger);
      }
      await answerMatches(
        { database, ai, dietaryNeeds: fresh.dietaryNeeds, facts, now },
        unchecked,
      );
    }
    running.phase = "building";
    await options.buildPlan?.(planId);
    await finishPlanRun(database, planId, { state: "done", at: now(), storeFailures: failures });
    running.phase = "done";
    running.finishedAt = now();
    await noteStoreFailures(ended);
  }

  // A Store that fails 3 plan runs in a row raises one System notice; a good read ends it. A failed
  // notice never fails the run.
  async function noteStoreFailures(ended: ReadonlyMap<string, StoreEnd>): Promise<void> {
    const stores = new Map(
      (await listDealFinderStores(database)).map((store) => [store.id, store]),
    );
    for (const [storeId, outcome] of ended) {
      try {
        if (outcome.state === "read") {
          await notices.end(storeFailingCondition(storeId));
        } else if (outcome.state === "failed" && outcome.reason === COULD_NOT_READ) {
          const runs = await countStoreFailedRuns(database, storeId, COULD_NOT_READ);
          if (runs >= FAILED_RUNS_FOR_NOTICE) {
            const name = stores.get(storeId)?.name ?? storeId;
            await notices.raise({
              kind: "condition",
              condition: storeFailingCondition(storeId),
              text: `The deal finder could not read ${name} in ${FAILED_RUNS_FOR_NOTICE} plan runs in a row. A release of the app may need a new reader for it.`,
            });
          }
        }
      } catch (error) {
        logger.warn("A Store's System notice could not be changed", {
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  }

  return {
    start(memberId, confirmedCostNanos) {
      if (starting !== undefined) return starting;
      starting = startOnce(memberId, confirmedCostNanos).finally(() => {
        starting = undefined;
      });
      return starting;
    },
    view,
    run,
  };
}

// The plan runs of the running app: the plan run job finds them here.
let services: PlanRuns | undefined;

export function startPlanRuns(options: PlanRunOptions): { planRuns: PlanRuns; stop(): void } {
  if (services !== undefined) throw new Error("Plan runs are already running.");
  const started = planRuns(options);
  services = started;
  return {
    planRuns: started,
    stop() {
      if (services === started) services = undefined;
    },
  };
}

// The plan run job (spec 15, Speed: a plan run is a job). It is safe to run twice: a run that is
// not running, or that started more than an hour ago, ends at once. It never throws, so Sidequest
// makes no retry of its own (K4).
export class PlanRunJob extends Job {
  override async run(...args: JobArgument[]): Promise<void> {
    const [planId] = args;
    if (services === undefined) throw new Error("Plan runs are not running.");
    if (typeof planId !== "string") return;
    await services.run(planId);
  }
}

// Price history: each price read is kept 400 days (spec 15, Prices and Deals).
export async function prunePriceHistory(database: Database, at = new Date()): Promise<number> {
  return deletePriceReadsBefore(database, new Date(at.getTime() - PRICE_HISTORY_DAYS * DAY_MS));
}

let pruning: { database: Database; logger: Logger } | undefined;

export function startPriceHistoryPrune(options: { database: Database; logger?: Logger }): {
  stop(): void;
} {
  if (pruning !== undefined) throw new Error("The price history prune is already running.");
  const started = { database: options.database, logger: options.logger ?? log };
  pruning = started;
  return {
    stop() {
      if (pruning === started) pruning = undefined;
    },
  };
}

// The daily task's job. It never throws for a failed prune: the next day's run tries again, so
// Sidequest makes no retry of its own.
export class PriceHistoryPruneJob extends Job {
  override async run(): Promise<void> {
    if (pruning === undefined) throw new Error("The price history prune is not running.");
    const { database, logger } = pruning;
    try {
      const deleted = await prunePriceHistory(database);
      if (deleted > 0) logger.info("Deleted old deal finder price reads", { deleted });
    } catch (error) {
      logger.error("The deal finder price history could not be pruned", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }
}
