import { MAX_STORES_ON } from "./view.ts";

// The Shopping plan's math (spec 15, How app code builds the plan; What the plan shows). Every
// function here is pure: it takes the stored Stores, List items, Products, prices and matches, and
// reads no Price source and no database. All money is whole cents.

export type PlanStoreKind = "in person" | "online" | "weekly ad only";
export type PlanUnit = "each" | "oz" | "lb" | "fl oz" | "gal" | "ct" | "pack";
export type PlanPriceKind = "regular" | "deal" | "online";

export type PlanStore = {
  id: string;
  name: string;
  kind: PlanStoreKind;
  // Only a Store that is on goes in a plan.
  on: boolean;
  // Empty means no fee (spec 15, Trip setting).
  deliveryFee: number | null;
  freeDeliveryFrom: number | null;
};

export type PlanListItem = {
  id: string;
  place: number;
  words: string;
  quantity: number;
  unit: PlanUnit;
  // A ticked List item is bought already, so the plan leaves it out.
  ticked: boolean;
};

export type PlanProduct = {
  id: string;
  storeId: string;
  name: string;
  size: string | null;
};

// A Product's last price read.
export type PlanPrice = {
  productId: string;
  readAt: Date;
  regularPrice: number | null;
  dealPrice: number | null;
  // YYYY-MM-DD. Empty when the source gives no end date.
  dealEndsOn: string | null;
  onlinePrice: number | null;
};

export type PlanMatch = {
  listItemId: string;
  productId: string;
  answer: "match" | "substitute" | "no";
};

// A Member's confirm or reject of a match, kept by the List item's words, trimmed and in lower
// case.
export type PlanChoice = {
  words: string;
  productId: string;
  choice: "confirmed" | "rejected";
};

export type PlanInput = {
  stores: readonly PlanStore[];
  items: readonly PlanListItem[];
  products: readonly PlanProduct[];
  prices: readonly PlanPrice[];
  matches: readonly PlanMatch[];
  choices: readonly PlanChoice[];
  // "An extra trip must save at least $X", in cents.
  tripSaving: number;
};

// One List item's line: its Store, Product, packages and price, or "Not found" with no Store. A
// stored line whose List item was removed since has no List item, and gets no Deal.
export type PlanLine = {
  listItemId: string | null;
  place: number;
  words: string;
  storeId: string | null;
  productId: string | null;
  productName: string | null;
  packages: number | null;
  price: number | null;
  total: number | null;
  priceKind: PlanPriceKind | null;
  priceReadAt: Date | null;
};

export type PlanStoreTotal = { storeId: string; subtotal: number; deliveryFee: number };

export type PlanTotals = {
  stores: PlanStoreTotal[];
  itemsTotal: number;
  deliveryFees: number;
  // Item totals plus delivery fees: what the Household pays, before sales tax.
  total: number;
  // Each Store visited in person is one trip. An online Store is not.
  trips: number;
  notFound: number;
};

export type ShoppingPlanResult = PlanTotals & {
  lines: PlanLine[];
  // The best one-Store plan, and the saving against it. Empty when no one Store finds as many List
  // items as the plan.
  bestOneStore: { storeId: string; total: number } | null;
  saving: number | null;
};

// ---- Package sizes ----

type Measure = "weight" | "volume" | "count";

// A Product's package size: weight in ounces, volume in fluid ounces, or a count.
export type PackageSize = { measure: Measure; amount: number };

// Each size unit app code reads, longest first, and its measure and size in the base unit.
const SIZE_UNITS: readonly [string, Measure, number][] = [
  ["fluid ounces", "volume", 1],
  ["fluid ounce", "volume", 1],
  ["fl. oz.", "volume", 1],
  ["fl. oz", "volume", 1],
  ["fl oz", "volume", 1],
  ["floz", "volume", 1],
  ["gallons", "volume", 128],
  ["gallon", "volume", 128],
  ["gal", "volume", 128],
  ["quarts", "volume", 32],
  ["quart", "volume", 32],
  ["qt", "volume", 32],
  ["pints", "volume", 16],
  ["pint", "volume", 16],
  ["pt", "volume", 16],
  ["liters", "volume", 33.814022701843],
  ["liter", "volume", 33.814022701843],
  ["litres", "volume", 33.814022701843],
  ["litre", "volume", 33.814022701843],
  ["ml", "volume", 0.033814022701843],
  ["l", "volume", 33.814022701843],
  ["pounds", "weight", 16],
  ["pound", "weight", 16],
  ["lbs", "weight", 16],
  ["lb", "weight", 16],
  ["ounces", "weight", 1],
  ["ounce", "weight", 1],
  ["oz", "weight", 1],
  ["kg", "weight", 35.27396194958],
  ["grams", "weight", 0.03527396194958],
  ["gram", "weight", 0.03527396194958],
  ["g", "weight", 0.03527396194958],
  ["count", "count", 1],
  ["ct", "count", 1],
  ["dozen", "count", 12],
  ["each", "count", 1],
  ["ea", "count", 1],
  ["pack", "count", 1],
  ["pk", "count", 1],
];

const escaped = (unit: string) => unit.replace(/[.]/g, "\\.").replace(/ /g, "\\s*");
const UNIT_PATTERN = SIZE_UNITS.map(([unit]) => escaped(unit)).join("|");
// "16 oz", "2 x 16 oz", "1.5 lb", "12 ct". A unit must end at a word's end.
const SIZE = new RegExp(
  `(?:(\\d{1,3})\\s*[x×]\\s*)?(\\d{1,5}(?:\\.\\d{1,3})?)\\s*(${UNIT_PATTERN})(?![a-z])`,
  "gi",
);

// Every size written in the text, in order.
function sizesIn(text: string): PackageSize[] {
  const found: PackageSize[] = [];
  for (const [, times, amount, unit] of text.toLowerCase().matchAll(SIZE)) {
    const written = (unit ?? "").replace(/\s+/g, " ");
    const known = SIZE_UNITS.find(([name]) => name.replace(/\s+/g, " ") === written);
    const value = Number(amount) * (times === undefined ? 1 : Number(times));
    if (known !== undefined && value > 0)
      found.push({ measure: known[1], amount: value * known[2] });
  }
  return found;
}

const MEASURE_OF: Record<PlanUnit, { measure: Measure; factor: number } | undefined> = {
  oz: { measure: "weight", factor: 1 },
  lb: { measure: "weight", factor: 16 },
  "fl oz": { measure: "volume", factor: 1 },
  gal: { measure: "volume", factor: 128 },
  ct: { measure: "count", factor: 1 },
  each: undefined,
  pack: undefined,
};

// The most packages one List item buys of one Product. More than this means the size was misread.
const MAX_PACKAGES = 999;

// Packages to buy = the List item quantity divided by the package size, rounded up (spec 15,
// Matching List items to Products). A List item in `each` with a Product in `ct` counts one per
// count; in `each` with any other size, or in `pack`, one per package. App code reads the size from
// the Product's size field, else from its name. Undefined when the sizes do not compare, such as
// pounds against fluid ounces, or no size can be read for a List item in a weight or volume.
export function packagesToBuy(
  item: Pick<PlanListItem, "quantity" | "unit">,
  product: Pick<PlanProduct, "size" | "name">,
): number | undefined {
  if (!(item.quantity > 0)) return undefined;
  const sizes = [...sizesIn(product.size ?? ""), ...sizesIn(product.name)];
  let packages: number;
  if (item.unit === "pack") {
    packages = Math.ceil(item.quantity);
  } else if (item.unit === "each") {
    const count = sizes.find((size) => size.measure === "count");
    packages = Math.ceil(item.quantity / (count?.amount ?? 1) - 1e-9);
  } else {
    const wanted = MEASURE_OF[item.unit];
    const size = sizes.find((each) => each.measure === wanted?.measure);
    if (wanted === undefined || size === undefined) return undefined;
    packages = Math.ceil((item.quantity * wanted.factor) / size.amount - 1e-9);
  }
  packages = Math.max(1, packages);
  return packages <= MAX_PACKAGES ? packages : undefined;
}

// The unit price, for ranking Products of one total: price per base unit, or per package.
function unitPrice(price: number, product: PlanProduct): number {
  const [size] = [...sizesIn(product.size ?? ""), ...sizesIn(product.name)];
  return size === undefined ? price : price / size.amount;
}

// ---- Matches and prices ----

export const choiceKey = (words: string, productId: string) =>
  `${words.trim().toLowerCase()}\u0000${productId}`;

// A Product the plan may use for a List item: a `match`, unless a Member rejected it, or any
// Product a Member confirmed. A substitute counts only once a Member picks it.
function usableMatches(input: PlanInput): Map<string, string[]> {
  const items = new Map(input.items.map((item) => [item.id, item]));
  const choices = new Map(
    input.choices.map((choice) => [choiceKey(choice.words, choice.productId), choice.choice]),
  );
  const usable = new Map<string, string[]>();
  for (const match of input.matches) {
    const item = items.get(match.listItemId);
    if (item === undefined) continue;
    const choice = choices.get(choiceKey(item.words, match.productId));
    if (choice === "rejected" || (choice !== "confirmed" && match.answer !== "match")) continue;
    const list = usable.get(item.id) ?? [];
    list.push(match.productId);
    usable.set(item.id, list);
  }
  return usable;
}

// One way to buy one List item at one Store.
type Option = {
  product: PlanProduct;
  packages: number;
  price: number;
  total: number;
  kind: PlanPriceKind;
  readAt: Date;
  dealEndsOn: string | null;
};

// The better of two options: the lower total, then the lower unit price, then the Product ID.
function better(a: Option | undefined, b: Option): boolean {
  if (a === undefined) return true;
  if (b.total !== a.total) return b.total < a.total;
  const [ua, ub] = [unitPrice(a.price, a.product), unitPrice(b.price, b.product)];
  if (ub !== ua) return ub < ua;
  return b.product.id < a.product.id;
}

// The regular price a plan uses: the Store's regular price, else, as at Costco, its online price.
// A weekly-ad-only Store has no regular price (spec 15, Stores and their readers).
function regularOf(
  store: PlanStore,
  price: PlanPrice,
): { price: number; kind: PlanPriceKind } | null {
  if (store.kind === "weekly ad only") return null;
  if (price.regularPrice !== null) return { price: price.regularPrice, kind: "regular" };
  if (price.onlinePrice !== null) return { price: price.onlinePrice, kind: "online" };
  return null;
}

// A Deal that still runs on `today`, YYYY-MM-DD.
function dealOf(price: PlanPrice, today: string): number | null {
  if (price.dealPrice === null) return null;
  if (price.dealEndsOn !== null && price.dealEndsOn < today) return null;
  return price.dealPrice;
}

// For each List item that is not ticked, each Store that is on, and each usable Product there,
// the best option by `pick`. Read once per batch: each lookup is by ID (K3).
function bestOptions(
  input: PlanInput,
  pick: (
    store: PlanStore,
    price: PlanPrice,
  ) => Omit<Option, "product" | "packages" | "total" | "readAt"> | null,
): Map<string, Map<string, Option>> {
  const stores = new Map(
    input.stores.filter((store) => store.on).map((store) => [store.id, store]),
  );
  const products = new Map(input.products.map((product) => [product.id, product]));
  const prices = new Map(input.prices.map((price) => [price.productId, price]));
  const usable = usableMatches(input);
  const best = new Map<string, Map<string, Option>>();
  for (const item of input.items) {
    if (item.ticked) continue;
    const byStore = new Map<string, Option>();
    for (const productId of usable.get(item.id) ?? []) {
      const product = products.get(productId);
      const store = product === undefined ? undefined : stores.get(product.storeId);
      const price = prices.get(productId);
      if (product === undefined || store === undefined || price === undefined) continue;
      const picked = pick(store, price);
      const packages = picked === null ? undefined : packagesToBuy(item, product);
      if (picked === null || packages === undefined) continue;
      const option = {
        ...picked,
        product,
        packages,
        total: packages * picked.price,
        readAt: price.readAt,
      };
      if (better(byStore.get(store.id), option)) byStore.set(store.id, option);
    }
    best.set(item.id, byStore);
  }
  return best;
}

// ---- Totals ----

// An online Store's delivery fee, when its order is below its free-delivery amount. A Store
// visited in person has none.
export function deliveryFeeOf(store: PlanStore, subtotal: number): number {
  if (store.kind !== "online" || store.deliveryFee === null || subtotal === 0) return 0;
  return store.freeDeliveryFrom !== null && subtotal >= store.freeDeliveryFrom
    ? 0
    : store.deliveryFee;
}

// The totals of a plan's lines: each Store's subtotal and delivery fee, the total and the trips.
export function planTotals(lines: readonly PlanLine[], stores: readonly PlanStore[]): PlanTotals {
  const byId = new Map(stores.map((store) => [store.id, store]));
  const subtotals = new Map<string, number>();
  let notFound = 0;
  for (const line of lines) {
    if (line.storeId === null || line.total === null) notFound += 1;
    else subtotals.set(line.storeId, (subtotals.get(line.storeId) ?? 0) + line.total);
  }
  const totals: PlanStoreTotal[] = [];
  let trips = 0;
  for (const [storeId, subtotal] of subtotals) {
    const store = byId.get(storeId);
    totals.push({
      storeId,
      subtotal,
      deliveryFee: store === undefined ? 0 : deliveryFeeOf(store, subtotal),
    });
    if (store !== undefined && store.kind !== "online") trips += 1;
  }
  const itemsTotal = totals.reduce((sum, each) => sum + each.subtotal, 0);
  const deliveryFees = totals.reduce((sum, each) => sum + each.deliveryFee, 0);
  return {
    stores: totals,
    itemsTotal,
    deliveryFees,
    total: itemsTotal + deliveryFees,
    trips,
    notFound,
  };
}

// ---- The plan ----

const bitCount = (bits: number) => {
  let count = 0;
  for (let rest = bits; rest !== 0; rest &= rest - 1) count += 1;
  return count;
};

type SetScore = {
  mask: number;
  notFound: number;
  score: number;
  trips: number;
  total: number;
  storesUsed: number;
};

// A set that leaves fewer List items not found wins; then the lower score; a tie goes to fewer
// trips, then to the lower total, then to fewer Stores (spec 15, How app code builds the plan).
function beats(a: SetScore, b: SetScore | undefined): boolean {
  if (b === undefined) return true;
  if (a.notFound !== b.notFound) return a.notFound < b.notFound;
  if (a.score !== b.score) return a.score < b.score;
  if (a.trips !== b.trips) return a.trips < b.trips;
  if (a.total !== b.total) return a.total < b.total;
  return a.storesUsed < b.storesUsed;
}

// Builds the Shopping plan from regular prices (spec 15, How app code builds the plan). For each
// set of Stores that are on, each List item goes to its cheapest `match` in the set by total for
// the packages to buy; the set's score is item totals, plus delivery fees, plus $X for each trip
// after the first. A Deal never decides which Stores the plan visits.
export function buildShoppingPlan(input: PlanInput): ShoppingPlanResult {
  if (!Number.isSafeInteger(input.tripSaving) || input.tripSaving < 0) {
    throw new RangeError("The trip setting must be whole cents, from $0.");
  }
  const items = input.items.filter((item) => !item.ticked).sort((a, b) => a.place - b.place);
  // The sets are of the Stores that are on. A weekly-ad-only Store has no regular price, so it
  // holds no List item in any set.
  const stores = input.stores.filter((store) => store.on);
  if (stores.length > MAX_STORES_ON) {
    throw new RangeError(`At most ${MAX_STORES_ON} Stores are on at once.`);
  }
  const options = bestOptions(input, (store, price) => {
    const regular = regularOf(store, price);
    return regular === null ? null : { ...regular, dealEndsOn: null };
  });

  const storeCount = stores.length;
  const itemCount = items.length;
  const sets = 1 << storeCount;
  // cost[item * stores + store]: the item's best total at that Store, or Infinity.
  const cost = new Float64Array(itemCount * storeCount).fill(Number.POSITIVE_INFINITY);
  for (const [i, item] of items.entries()) {
    const byStore = options.get(item.id);
    for (const [s, store] of stores.entries()) {
      const option = byStore?.get(store.id);
      if (option !== undefined) cost[i * storeCount + s] = option.total;
    }
  }
  // best[set * items + item] and where[...]: the item's cheapest total in the set, and its Store.
  // Each set adds its lowest Store to the set without it, so every set is one pass over the items.
  // A tie goes to the Store listed first.
  const best = new Float64Array(sets * itemCount).fill(Number.POSITIVE_INFINITY);
  const where = new Int8Array(sets * itemCount).fill(-1);
  const inPerson = stores.reduce(
    (bits, store, s) => (store.kind === "in person" ? bits | (1 << s) : bits),
    0,
  );
  const subtotals = new Float64Array(storeCount);
  let chosen: SetScore | undefined;
  for (let mask = 0; mask < sets; mask += 1) {
    if (mask !== 0) {
      const low = mask & -mask;
      const s = 31 - Math.clz32(low);
      const rest = (mask ^ low) * itemCount;
      const row = mask * itemCount;
      for (let i = 0; i < itemCount; i += 1) {
        const here = cost[i * storeCount + s] as number;
        const other = best[rest + i] as number;
        if (here <= other && here !== Number.POSITIVE_INFINITY) {
          best[row + i] = here;
          where[row + i] = s;
        } else {
          best[row + i] = other;
          where[row + i] = where[rest + i] as number;
        }
      }
    }
    subtotals.fill(0);
    let notFound = 0;
    let used = 0;
    const row = mask * itemCount;
    for (let i = 0; i < itemCount; i += 1) {
      const s = where[row + i] as number;
      if (s < 0) {
        notFound += 1;
        continue;
      }
      subtotals[s] = (subtotals[s] as number) + (best[row + i] as number);
      used |= 1 << s;
    }
    let total = 0;
    for (let s = 0; s < storeCount; s += 1) {
      const subtotal = subtotals[s] as number;
      if (subtotal > 0) total += subtotal + deliveryFeeOf(stores[s] as PlanStore, subtotal);
    }
    const trips = bitCount(used & inPerson);
    const score = total + input.tripSaving * Math.max(0, trips - 1);
    const set = { mask, notFound, score, trips, total, storesUsed: bitCount(used) };
    if (beats(set, chosen)) chosen = set;
  }

  const row = (chosen?.mask ?? 0) * itemCount;
  const lines = items.map((item, i): PlanLine => {
    const s = where[row + i] as number;
    const store = s < 0 ? undefined : stores[s];
    const option = store === undefined ? undefined : options.get(item.id)?.get(store.id);
    return option === undefined || store === undefined
      ? notFoundLine(item)
      : {
          listItemId: item.id,
          place: item.place,
          words: item.words,
          storeId: store.id,
          productId: option.product.id,
          productName: option.product.name,
          packages: option.packages,
          price: option.price,
          total: option.total,
          priceKind: option.kind,
          priceReadAt: option.readAt,
        };
  });
  const totals = planTotals(lines, stores);

  // The best one-Store plan: the most List items found, then the lowest total.
  let one: { storeId: string; notFound: number; total: number } | undefined;
  for (const [s, store] of stores.entries()) {
    const single = planTotals(
      items.map((item, i) => {
        const option = cost[i * storeCount + s] as number;
        return option === Number.POSITIVE_INFINITY
          ? notFoundLine(item)
          : { ...notFoundLine(item), storeId: store.id, total: option };
      }),
      stores,
    );
    if (
      one === undefined ||
      single.notFound < one.notFound ||
      (single.notFound === one.notFound && single.total < one.total)
    ) {
      one = { storeId: store.id, notFound: single.notFound, total: single.total };
    }
  }
  const comparable =
    one !== undefined && one.notFound === totals.notFound && totals.notFound < itemCount;
  return {
    ...totals,
    lines,
    bestOneStore:
      comparable && one !== undefined ? { storeId: one.storeId, total: one.total } : null,
    saving: comparable && one !== undefined ? one.total - totals.total : null,
  };
}

function notFoundLine(item: PlanListItem): PlanLine {
  return {
    listItemId: item.id,
    place: item.place,
    words: item.words,
    storeId: null,
    productId: null,
    productName: null,
    packages: null,
    price: null,
    total: null,
    priceKind: null,
    priceReadAt: null,
  };
}

// ---- Deals ----

export type PlanDeal = {
  listItemId: string;
  place: number;
  storeId: string;
  productId: string;
  productName: string;
  packages: number;
  price: number;
  total: number;
  endsOn: string | null;
  // Against the List item's plan total.
  saves: number;
  readAt: Date;
};

// The Deals at one Store that is not in the plan, and whether their saving pays for the trip.
export type StoreDeals = {
  storeId: string;
  deals: PlanDeal[];
  // The Deals' savings, less the delivery fee an online Store would charge for them.
  saving: number;
  paysForTrip: boolean;
};

export type PlanDeals = {
  // Beside a List item: each Deal that beats its plan price at a Store already in the plan.
  beside: PlanDeal[];
  // At Stores not in the plan, by saving, most first.
  elsewhere: StoreDeals[];
};

// The Deals for a plan's lines on `today` (spec 15, What the plan shows). For each List item with
// a line, the best Deal at each Store that is on, when it beats the line's total. A Deal at a Store
// in the plan shows beside the List item. A Deal at another Store moves the plan only when the trip
// setting says its saving pays for the trip: an extra trip pays when it saves more than $X, as in
// the plan's score, and the first trip, or an online Store, when it saves anything.
export function findDeals(input: PlanInput, lines: readonly PlanLine[], today: string): PlanDeals {
  const options = bestOptions(input, (_store, price) => {
    const deal = dealOf(price, today);
    return deal === null ? null : { price: deal, kind: "deal", dealEndsOn: price.dealEndsOn };
  });
  const stores = new Map(input.stores.map((store) => [store.id, store]));
  const inPlan = new Set(lines.flatMap((line) => (line.storeId === null ? [] : [line.storeId])));
  const trips = planTotals(lines, input.stores).trips;
  const beside: PlanDeal[] = [];
  const elsewhere = new Map<string, PlanDeal[]>();
  for (const line of lines) {
    // A List item that uses a Deal already shows no other.
    if (line.total === null || line.priceKind === "deal" || line.listItemId === null) continue;
    for (const [storeId, option] of options.get(line.listItemId) ?? []) {
      if (option.total >= line.total) continue;
      const deal: PlanDeal = {
        listItemId: line.listItemId,
        place: line.place,
        storeId,
        productId: option.product.id,
        productName: option.product.name,
        packages: option.packages,
        price: option.price,
        total: option.total,
        endsOn: option.dealEndsOn,
        saves: line.total - option.total,
        readAt: option.readAt,
      };
      if (inPlan.has(storeId)) beside.push(deal);
      else elsewhere.set(storeId, [...(elsewhere.get(storeId) ?? []), deal]);
    }
  }
  const byPlace = (a: PlanDeal, b: PlanDeal) => a.place - b.place || b.saves - a.saves;
  return {
    beside: beside.sort(byPlace),
    elsewhere: [...elsewhere]
      .map(([storeId, deals]): StoreDeals => {
        const store = stores.get(storeId) as PlanStore;
        const dealTotal = deals.reduce((sum, deal) => sum + deal.total, 0);
        const saving =
          deals.reduce((sum, deal) => sum + deal.saves, 0) - deliveryFeeOf(store, dealTotal);
        const paysForTrip =
          store.kind === "online" || trips === 0 ? saving > 0 : saving > input.tripSaving;
        return { storeId, deals: deals.sort(byPlace), saving, paysForTrip };
      })
      .sort((a, b) => b.saving - a.saving || a.storeId.localeCompare(b.storeId)),
  };
}
