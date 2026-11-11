import {
  type Database,
  deleteShoppingPlanDeal,
  type LastShoppingPlan,
  readLastShoppingPlan,
  readShoppingPlanRows,
  type ShoppingPlanRows,
  storeShoppingPlanDeal,
  storeShoppingPlanResult,
} from "../db/index.ts";
import {
  buildShoppingPlan,
  findDeals,
  type PlanDeal,
  type PlanDeals,
  type PlanLine,
  planTotals,
} from "../deal-finder/index.ts";
import { calendarDateIn } from "../format.ts";
import { householdTimeZone } from "../household/index.ts";
import type {
  ShoppingPlanDealView,
  ShoppingPlanLineView,
  ShoppingPlanRoutes,
  ShoppingPlanStoreView,
  ShoppingPlanView,
  TakeDealOutcome,
} from "./shopping-plan-views.ts";

// The Shopping plan (spec 15, The Shopping plan): building it from stored rows, the plan as the
// Shopping list page shows it, "Use this Deal", and the plan as Chat's `get_shopping_plan` reads it.
// App code does every price, total and saving; the AI never does.

// The words the plan always shows.
export const PLAN_NOTE = "Prices can change. Sales tax is not included.";

// Builds the plan from the stored Products, matches and prices, and stores its lines and totals.
// A plan run's job calls it when its reads and matches are done. False when no plan has the ID.
export async function buildStoredShoppingPlan(
  database: Database,
  planId: string,
  at: Date = new Date(),
): Promise<boolean> {
  const rows = await readShoppingPlanRows(database);
  const plan = buildShoppingPlan(rows);
  return storeShoppingPlanResult(
    database,
    planId,
    {
      lines: plan.lines.map((line, place) => ({ ...line, place })),
      total: plan.total,
      trips: plan.trips,
      saving: plan.saving,
      tripSaving: rows.tripSaving,
    },
    at,
  );
}

type CurrentPlan = {
  last: LastShoppingPlan;
  rows: ShoppingPlanRows;
  zone: string;
  today: string;
  // The stored lines, with each Deal a Member used that still runs.
  lines: (PlanLine & { dealEndsOn: string | null })[];
  deals: PlanDeals;
};

// The last plan as it stands today. A used Deal moves its line until the Deal ends; then the line
// is back at its regular-price Store. Deals come from the last price reads.
async function currentPlan(database: Database, now: Date): Promise<CurrentPlan | undefined> {
  const last = await readLastShoppingPlan(database);
  if (last === undefined) return undefined;
  const rows = await readShoppingPlanRows(database);
  const zone = (await householdTimeZone(database)) ?? "UTC";
  const today = calendarDateIn(now, zone);
  const used = new Map(last.deals.map((deal) => [deal.place, deal]));
  const lines = last.lines.map((line) => {
    const deal = used.get(line.place);
    if (deal === undefined || (deal.endsOn !== null && deal.endsOn < today)) {
      return { ...line, dealEndsOn: null };
    }
    return {
      ...line,
      storeId: deal.storeId,
      productId: deal.productId,
      productName: deal.productName,
      packages: deal.packages,
      price: deal.price,
      total: deal.total,
      priceKind: "deal" as const,
      priceReadAt: deal.priceReadAt,
      dealEndsOn: deal.endsOn,
    };
  });
  // Whether a Deal pays for a trip follows the trip setting the plan was built with.
  const deals = findDeals({ ...rows, tripSaving: last.plan.tripSaving }, lines, today);
  return { last, rows, zone, today, lines, deals };
}

function viewOf(current: CurrentPlan): ShoppingPlanView {
  const { last, rows, zone, today, lines, deals } = current;
  const day = (moment: Date) => calendarDateIn(moment, zone);
  const stores = new Map(rows.stores.map((store) => [store.id, store]));
  const dealView = (deal: PlanDeal): ShoppingPlanDealView => ({
    storeId: deal.storeId,
    storeName: stores.get(deal.storeId)?.name ?? "Store",
    productId: deal.productId,
    productName: deal.productName,
    packages: deal.packages,
    price: deal.price,
    total: deal.total,
    endsOn: deal.endsOn,
    saves: deal.saves,
    readOn: day(deal.readAt),
  });
  const totals = planTotals(lines, rows.stores);
  const sections = new Map<string, ShoppingPlanStoreView>();
  const notFound: ShoppingPlanView["notFound"] = [];
  for (const line of lines) {
    const store = line.storeId === null ? undefined : stores.get(line.storeId);
    if (
      store === undefined ||
      line.productName === null ||
      line.packages === null ||
      line.price === null ||
      line.total === null ||
      line.priceKind === null ||
      line.priceReadAt === null
    ) {
      notFound.push({ place: line.place, words: line.words });
      continue;
    }
    const total = totals.stores.find((each) => each.storeId === store.id);
    const section = sections.get(store.id) ?? {
      storeId: store.id,
      name: store.name,
      kind: store.kind,
      lines: [],
      subtotal: total?.subtotal ?? 0,
      deliveryFee: total?.deliveryFee ?? 0,
    };
    const view: ShoppingPlanLineView = {
      place: line.place,
      words: line.words,
      productName: line.productName,
      packages: line.packages,
      price: line.price,
      total: line.total,
      priceKind: line.priceKind,
      readOn: day(line.priceReadAt),
      dealEndsOn: line.dealEndsOn,
      deals: deals.beside
        .filter((deal) => deal.place === line.place)
        .sort((a, b) => b.saves - a.saves)
        .map(dealView),
    };
    section.lines.push(view);
    sections.set(store.id, section);
  }
  const words = new Map(lines.map((line) => [line.place, line.words]));
  // The saving against the best one-Store plan, which the stored plan kept as its saving.
  const oneStoreTotal =
    last.plan.saving === null ? null : last.plan.saving + (last.plan.total ?? 0);
  return {
    planId: last.plan.id,
    builtOn: day(last.plan.finishedAt ?? last.plan.startedAt),
    today,
    tripSaving: last.plan.tripSaving,
    stores: [...sections.values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.storeId.localeCompare(b.storeId),
    ),
    notFound,
    total: totals.total,
    trips: totals.trips,
    saving: oneStoreTotal === null ? null : oneStoreTotal - totals.total,
    elsewhere: deals.elsewhere.map((each) => ({
      storeId: each.storeId,
      name: stores.get(each.storeId)?.name ?? "Store",
      kind: stores.get(each.storeId)?.kind ?? "in person",
      saving: each.saving,
      paysForTrip: each.paysForTrip,
      deals: each.deals.map((deal) => ({
        ...dealView(deal),
        place: deal.place,
        words: words.get(deal.place) ?? "",
      })),
    })),
    failures: last.plan.storeFailures.map((failure) => ({
      storeId: failure.storeId,
      name: stores.get(failure.storeId)?.name ?? failure.storeId,
      reason: failure.reason,
    })),
  };
}

// The last plan as the page shows it, or undefined before the first plan.
export async function shoppingPlanView(
  database: Database,
  now: Date = new Date(),
): Promise<ShoppingPlanView | undefined> {
  const current = await currentPlan(database, now);
  return current === undefined ? undefined : viewOf(current);
}

// "Use this Deal": the server finds the Deal itself, from the stored prices, and never takes a
// price from the browser. A Deal at a Store not in the plan is used only when its saving pays for
// the trip.
async function takeDeal(
  database: Database,
  wanted: { planId: string; place: number; productId: string },
  memberId: string,
  now: Date,
): Promise<TakeDealOutcome> {
  const current = await currentPlan(database, now);
  if (current === undefined) return "no plan";
  if (current.last.plan.id !== wanted.planId) return "plan changed";
  if (!current.lines.some((line) => line.place === wanted.place)) return "no line";
  const offered = [
    ...current.deals.beside,
    ...current.deals.elsewhere.filter((store) => store.paysForTrip).flatMap((store) => store.deals),
  ];
  const deal = offered.find(
    (each) => each.place === wanted.place && each.productId === wanted.productId,
  );
  if (deal === undefined) return "no deal";
  await storeShoppingPlanDeal(database, {
    planId: wanted.planId,
    place: wanted.place,
    storeId: deal.storeId,
    productId: deal.productId,
    productName: deal.productName,
    packages: deal.packages,
    price: deal.price,
    total: deal.total,
    endsOn: deal.endsOn,
    priceReadAt: deal.readAt,
    usedAt: now,
    usedBy: memberId,
  });
  return "used";
}

export function shoppingPlanRoutes(
  database: Database,
  now: () => Date = () => new Date(),
): ShoppingPlanRoutes {
  return {
    view: () => shoppingPlanView(database, now()),
    takeDeal: (deal, memberId) => takeDeal(database, deal, memberId, now()),
    dropDeal: ({ planId, place }) => deleteShoppingPlanDeal(database, planId, place),
  };
}

// Cents as dollars, with 2 decimals and no thousands separator, such as "12.50", as Chat's other
// tools write them.
function dollars(cents: number): string {
  const size = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(size / 100)}.${String(size % 100).padStart(2, "0")}`;
}

const chatDeal = (deal: ShoppingPlanDealView) => ({
  store: deal.storeName,
  product: deal.productName,
  packages: deal.packages,
  price: dollars(deal.price),
  total: dollars(deal.total),
  saves: dollars(deal.saves),
  endsOn: deal.endsOn,
  priceDate: deal.readOn,
});

// The last plan as Chat's `get_shopping_plan` returns it (spec 15, Chat tools): Stores, List items,
// prices, Deals, total, trips, and the date of each price. Amounts are dollars.
export async function shoppingPlanForChat(database: Database, now: Date = new Date()) {
  const view = await shoppingPlanView(database, now);
  if (view === undefined) {
    return { plan: null, note: "No Shopping plan yet. A Member presses Find the best prices." };
  }
  return {
    plan: {
      builtOn: view.builtOn,
      stores: view.stores.map((store) => ({
        store: store.name,
        online: store.kind === "online",
        items: store.lines.map((line) => ({
          listItem: line.words,
          product: line.productName,
          packages: line.packages,
          price: dollars(line.price),
          total: dollars(line.total),
          priceKind: line.priceKind,
          priceDate: line.readOn,
          dealEndsOn: line.dealEndsOn,
          deals: line.deals.map(chatDeal),
        })),
        subtotal: dollars(store.subtotal),
        deliveryFee: dollars(store.deliveryFee),
      })),
      notFound: view.notFound.map((line) => line.words),
      total: dollars(view.total),
      trips: view.trips,
      savingAgainstBestOneStore: view.saving === null ? null : dollars(view.saving),
      tripSetting: dollars(view.tripSaving),
      dealsAtOtherStores: view.elsewhere.map((store) => ({
        store: store.name,
        saving: dollars(store.saving),
        paysForTrip: store.paysForTrip,
        deals: store.deals.map((deal) => ({ listItem: deal.words, ...chatDeal(deal) })),
      })),
      storesNotRead: view.failures.map((failure) => ({
        store: failure.name,
        reason: failure.reason,
      })),
      note: PLAN_NOTE,
    },
  };
}
