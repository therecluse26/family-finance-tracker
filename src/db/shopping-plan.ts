import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { readDealFinderSettings } from "./deal-finder.ts";
import {
  dealFinderProducts,
  dealFinderStores,
  memberMatchChoices,
  productMatches,
  shoppingListItems,
  shoppingPlanDeals,
  shoppingPlanLines,
  shoppingPlans,
} from "./schema.ts";

// The stored rows a Shopping plan is built from, and the plans themselves (spec 15, The Shopping
// plan). The plan's math is app code over these rows; this file decides nothing. Every Store, List
// item, match and Member choice is read, so the plan's own filters (`match` only, Stores that are
// on, List items not ticked) decide alone.

export type StoredShoppingPlan = typeof shoppingPlans.$inferSelect;
export type StoredShoppingPlanLine = typeof shoppingPlanLines.$inferSelect;
export type StoredShoppingPlanDeal = typeof shoppingPlanDeals.$inferSelect;

export type ShoppingPlanRows = {
  stores: Pick<
    typeof dealFinderStores.$inferSelect,
    "id" | "name" | "kind" | "on" | "deliveryFee" | "freeDeliveryFrom"
  >[];
  items: Pick<
    typeof shoppingListItems.$inferSelect,
    "id" | "place" | "words" | "quantity" | "unit" | "ticked"
  >[];
  products: Pick<typeof dealFinderProducts.$inferSelect, "id" | "storeId" | "name" | "size">[];
  prices: {
    productId: string;
    readAt: Date;
    regularPrice: number | null;
    dealPrice: number | null;
    dealEndsOn: string | null;
    onlinePrice: number | null;
  }[];
  matches: Pick<typeof productMatches.$inferSelect, "listItemId" | "productId" | "answer">[];
  choices: Pick<typeof memberMatchChoices.$inferSelect, "words" | "productId" | "choice">[];
  tripSaving: number;
};

// Every row the plan reads, in one read transaction: each Store, List item, match and Member
// choice, each matched Product, and each one's last price read.
export async function readShoppingPlanRows(database: Database): Promise<ShoppingPlanRows> {
  const { tripSaving } = await readDealFinderSettings(database);
  return database.transaction(
    async (tx) => {
      const stores = await tx
        .select({
          id: dealFinderStores.id,
          name: dealFinderStores.name,
          kind: dealFinderStores.kind,
          on: dealFinderStores.on,
          deliveryFee: dealFinderStores.deliveryFee,
          freeDeliveryFrom: dealFinderStores.freeDeliveryFrom,
        })
        .from(dealFinderStores)
        .orderBy(asc(dealFinderStores.name), asc(dealFinderStores.id));
      const items = await tx
        .select({
          id: shoppingListItems.id,
          place: shoppingListItems.place,
          words: shoppingListItems.words,
          quantity: shoppingListItems.quantity,
          unit: shoppingListItems.unit,
          ticked: shoppingListItems.ticked,
        })
        .from(shoppingListItems)
        .orderBy(asc(shoppingListItems.place), asc(shoppingListItems.id));
      const matches = await tx
        .select({
          listItemId: productMatches.listItemId,
          productId: productMatches.productId,
          answer: productMatches.answer,
        })
        .from(productMatches);
      const choices = await tx
        .select({
          words: memberMatchChoices.words,
          productId: memberMatchChoices.productId,
          choice: memberMatchChoices.choice,
        })
        .from(memberMatchChoices);
      const matched = tx.select({ id: productMatches.productId }).from(productMatches);
      const products = await tx
        .select({
          id: dealFinderProducts.id,
          storeId: dealFinderProducts.storeId,
          name: dealFinderProducts.name,
          size: dealFinderProducts.size,
        })
        .from(dealFinderProducts)
        .where(inArray(dealFinderProducts.id, matched));
      // Each matched Product's last price read, in one statement.
      const reads = await tx.all<{
        product_id: string;
        read_at: string;
        regular_price: number | null;
        deal_price: number | null;
        deal_ends_on: string | null;
        online_price: number | null;
      }>(sql`
        SELECT product_id, read_at, regular_price, deal_price, deal_ends_on, online_price
        FROM (
          SELECT r.*, row_number() OVER (
            PARTITION BY r.product_id ORDER BY r.read_at DESC, r.id DESC
          ) AS n
          FROM deal_finder_price_reads r
          WHERE r.product_id IN (SELECT product_id FROM product_matches)
        )
        WHERE n = 1`);
      return {
        stores,
        items,
        products,
        prices: reads.map((read) => ({
          productId: read.product_id,
          readAt: new Date(read.read_at),
          regularPrice: read.regular_price,
          dealPrice: read.deal_price,
          dealEndsOn: read.deal_ends_on,
          onlinePrice: read.online_price,
        })),
        matches,
        choices,
        tripSaving,
      };
    },
    { behavior: "deferred" },
  );
}

export type NewShoppingPlanLine = Omit<StoredShoppingPlanLine, "planId">;

// Stores a built plan's lines and totals, and marks it done, in one transaction. A plan built again
// replaces its lines, and drops the Deals used in it.
export async function storeShoppingPlanResult(
  database: Database,
  planId: string,
  result: {
    lines: readonly NewShoppingPlanLine[];
    total: number;
    trips: number;
    saving: number | null;
    tripSaving: number;
  },
  at: Date,
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const updated = await tx
      .update(shoppingPlans)
      .set({
        state: "done",
        finishedAt: at,
        total: result.total,
        trips: result.trips,
        saving: result.saving,
        tripSaving: result.tripSaving,
      })
      .where(eq(shoppingPlans.id, planId))
      .returning({ id: shoppingPlans.id });
    if (updated.length === 0) return false;
    await tx.delete(shoppingPlanDeals).where(eq(shoppingPlanDeals.planId, planId));
    await tx.delete(shoppingPlanLines).where(eq(shoppingPlanLines.planId, planId));
    if (result.lines.length > 0) {
      await tx.insert(shoppingPlanLines).values(result.lines.map((line) => ({ ...line, planId })));
    }
    return true;
  });
}

export type LastShoppingPlan = {
  plan: StoredShoppingPlan;
  lines: StoredShoppingPlanLine[];
  deals: StoredShoppingPlanDeal[];
};

// The last plan that was built, with its lines and the Deals used in it.
export async function readLastShoppingPlan(
  database: Database,
): Promise<LastShoppingPlan | undefined> {
  return database.transaction(
    async (tx) => {
      const [plan] = await tx
        .select()
        .from(shoppingPlans)
        .where(eq(shoppingPlans.state, "done"))
        .orderBy(desc(shoppingPlans.finishedAt), desc(shoppingPlans.startedAt))
        .limit(1);
      if (plan === undefined) return undefined;
      const lines = await tx
        .select()
        .from(shoppingPlanLines)
        .where(eq(shoppingPlanLines.planId, plan.id))
        .orderBy(asc(shoppingPlanLines.place));
      const deals = await tx
        .select()
        .from(shoppingPlanDeals)
        .where(eq(shoppingPlanDeals.planId, plan.id))
        .orderBy(asc(shoppingPlanDeals.place));
      return { plan, lines, deals };
    },
    { behavior: "deferred" },
  );
}

// "Use this Deal": the Deal replaces any other Deal used on the same line.
export async function storeShoppingPlanDeal(
  database: Database,
  deal: StoredShoppingPlanDeal,
): Promise<void> {
  const { planId: _planId, place: _place, ...rest } = deal;
  await database
    .insert(shoppingPlanDeals)
    .values(deal)
    .onConflictDoUpdate({ target: [shoppingPlanDeals.planId, shoppingPlanDeals.place], set: rest });
}

// Back to the regular price. False when the line used no Deal.
export async function deleteShoppingPlanDeal(
  database: Database,
  planId: string,
  place: number,
): Promise<boolean> {
  const deleted = await database
    .delete(shoppingPlanDeals)
    .where(and(eq(shoppingPlanDeals.planId, planId), eq(shoppingPlanDeals.place, place)))
    .returning({ place: shoppingPlanDeals.place });
  return deleted.length > 0;
}
