import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  dealFinderPriceReads,
  dealFinderProducts,
  dealFinderStores,
  type LIST_ITEM_UNITS,
  listItemSearches,
  memberMatchChoices,
  type PRODUCT_MATCH_ANSWERS,
  productMatches,
  shoppingListItems,
  shoppingPlans,
} from "./schema.ts";

// The deal finder's plan runs in app.db (spec 15, The Shopping plan; Search once, then re-read;
// Matching List items to Products): what a run reads, what each Store's read stores, the match
// answers, and each plan run's row. Every read here is one statement for all List items, and every
// write one statement for a whole batch (K3).

export type PlanRunListItem = {
  id: string;
  words: string;
  quantity: number;
  unit: (typeof LIST_ITEM_UNITS)[number];
  brandLock: string | null;
  searchWords: string | null;
};

// A List item's saved `match` at a Store, with the time of its Product's last price read.
export type SavedMatch = {
  listItemId: string;
  productId: string;
  storeId: string;
  readKey: string;
  lastReadAt: Date | null;
};

export type ListItemSearch = { listItemId: string; storeId: string; searchedAt: Date };

export type PlanRunInputs = {
  // The List items not ticked off, in their order on the list.
  items: PlanRunListItem[];
  // Every saved `match` of those List items at a Store that is on.
  matches: SavedMatch[];
  // Each of those List items' last full search at a Store that is on.
  searches: ListItemSearch[];
};

const asDate = (value: unknown): Date | null =>
  value === null || value === undefined ? null : new Date(String(value));

// What a plan run reads before it reads any Store: three statements, whatever the list's length.
export async function readPlanRunInputs(database: Database): Promise<PlanRunInputs> {
  const items = await database
    .select({
      id: shoppingListItems.id,
      words: shoppingListItems.words,
      quantity: shoppingListItems.quantity,
      unit: shoppingListItems.unit,
      brandLock: shoppingListItems.brandLock,
      searchWords: shoppingListItems.searchWords,
    })
    .from(shoppingListItems)
    .where(eq(shoppingListItems.ticked, false))
    .orderBy(asc(shoppingListItems.place), asc(shoppingListItems.id));
  const matchRows = await database.all<Record<string, unknown>>(sql`
    SELECT pm.list_item_id, pm.product_id, pm.store_id, pm.read_key,
      (SELECT max(r.read_at) FROM ${dealFinderPriceReads} r WHERE r.product_id = pm.product_id)
        AS last_read_at
    FROM ${productMatches} pm
    JOIN ${shoppingListItems} li ON li.id = pm.list_item_id AND li.ticked = 0
    JOIN ${dealFinderStores} s ON s.id = pm.store_id AND s."on" = 1
    WHERE pm.answer = 'match'`);
  const searchRows = await database.all<Record<string, unknown>>(sql`
    SELECT ls.list_item_id, ls.store_id, ls.searched_at
    FROM ${listItemSearches} ls
    JOIN ${shoppingListItems} li ON li.id = ls.list_item_id AND li.ticked = 0
    JOIN ${dealFinderStores} s ON s.id = ls.store_id AND s."on" = 1`);
  return {
    items,
    matches: matchRows.map((row) => ({
      listItemId: String(row.list_item_id),
      productId: String(row.product_id),
      storeId: String(row.store_id),
      readKey: String(row.read_key),
      lastReadAt: asDate(row.last_read_at),
    })),
    searches: searchRows.map((row) => ({
      listItemId: String(row.list_item_id),
      storeId: String(row.store_id),
      searchedAt: new Date(String(row.searched_at)),
    })),
  };
}

// One Product as a Store gave it, after the app's checks: whole cents above $0.00 and below
// $10,000.00, and text cut to 200 characters (spec 15, Checks on every price).
export type CheckedProduct = {
  readKey: string;
  name: string;
  brand: string | null;
  size: string | null;
  upc: string | null;
  link: string | null;
  regularPrice: number | null;
  dealPrice: number | null;
  dealEndsOn: string | null;
  onlinePrice: number | null;
};

// What one Store's read found, stored in one transaction as soon as the read ends, so a later
// Store's failure keeps it (K5).
export type StoreRead = {
  storeId: string;
  at: Date;
  // The Products each List item's search found, in the Store's own order. Each new one is linked to
  // the List item as "unchecked", for the AI or a Member to answer.
  found: { listItemId: string; products: CheckedProduct[] }[];
  // The List items fully searched, even those whose search found nothing.
  searched: string[];
  // The saved matches read again, by their re-read key.
  reread: CheckedProduct[];
  // Saved matches the Store no longer has, or gave no price for. Each one's match ends, and its
  // List item is searched again at the next plan run.
  failed: { listItemId: string; readKey: string }[];
};

// Rows per statement, so a batch never passes SQLite's limit on bound values.
const CHUNK = 400;

function chunks<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < rows.length; start += CHUNK) {
    out.push(rows.slice(start, start + CHUNK));
  }
  return out;
}

// Stores one Store's read: its Products and their prices, the found Products' links to their List
// items, each full search's time, and the Store's last good read. One statement per kind of row.
export async function storeStoreRead(database: Database, read: StoreRead): Promise<void> {
  const { storeId, at } = read;
  const byKey = new Map<string, CheckedProduct>();
  for (const product of [...read.found.flatMap((each) => each.products), ...read.reread]) {
    byKey.set(product.readKey, product);
  }
  await database.transaction(async (tx) => {
    const ids = new Map<string, string>();
    for (const part of chunks([...byKey.values()])) {
      const stored = await tx
        .insert(dealFinderProducts)
        .values(
          part.map((product) => ({
            id: crypto.randomUUID(),
            storeId,
            readKey: product.readKey,
            name: product.name,
            brand: product.brand,
            size: product.size,
            upc: product.upc,
            link: product.link,
            addedAt: at,
          })),
        )
        .onConflictDoUpdate({
          target: [dealFinderProducts.storeId, dealFinderProducts.readKey],
          set: {
            name: sql`excluded.name`,
            brand: sql`excluded.brand`,
            // A size the AI read stays until the Store gives one.
            size: sql`coalesce(excluded.size, ${dealFinderProducts.size})`,
            upc: sql`excluded.upc`,
            link: sql`excluded.link`,
          },
        })
        .returning({ id: dealFinderProducts.id, readKey: dealFinderProducts.readKey });
      for (const row of stored) ids.set(row.readKey, row.id);
    }
    for (const part of chunks([...byKey.values()])) {
      await tx.insert(dealFinderPriceReads).values(
        part.map((product) => ({
          productId: ids.get(product.readKey) as string,
          readAt: at,
          regularPrice: product.regularPrice,
          dealPrice: product.dealPrice,
          dealEndsOn: product.dealEndsOn,
          onlinePrice: product.onlinePrice,
        })),
      );
    }
    const links = read.found.flatMap(({ listItemId, products }) =>
      products.map((product) => ({
        listItemId,
        productId: ids.get(product.readKey) as string,
        storeId,
        answer: "unchecked" as const,
        readKey: product.readKey,
        lastFullSearchAt: at,
        matchedAt: at,
      })),
    );
    for (const part of chunks(links)) {
      // A Product found again keeps its answer.
      await tx
        .insert(productMatches)
        .values(part)
        .onConflictDoUpdate({
          target: [productMatches.listItemId, productMatches.productId],
          set: { lastFullSearchAt: at, readKey: sql`excluded.read_key` },
        });
    }
    for (const part of chunks(read.searched)) {
      await tx
        .insert(listItemSearches)
        .values(part.map((listItemId) => ({ listItemId, storeId, searchedAt: at })))
        .onConflictDoUpdate({
          target: [listItemSearches.listItemId, listItemSearches.storeId],
          set: { searchedAt: at },
        });
    }
    if (read.failed.length > 0) {
      const failed = JSON.stringify(read.failed);
      await tx.run(sql`
        DELETE FROM ${productMatches}
        WHERE store_id = ${storeId}
          AND EXISTS (SELECT 1 FROM json_each(${failed}) f
            WHERE f.value->>'listItemId' = list_item_id AND f.value->>'readKey' = read_key)`);
      await tx.run(sql`
        DELETE FROM ${listItemSearches}
        WHERE store_id = ${storeId}
          AND list_item_id IN (SELECT f.value->>'listItemId' FROM json_each(${failed}) f)`);
    }
    await tx
      .update(dealFinderStores)
      .set({ lastGoodReadAt: at })
      .where(eq(dealFinderStores.id, storeId));
  });
}

// A found Product its List item has no answer for yet, with what the AI reads of both.
export type UncheckedMatch = {
  listItemId: string;
  productId: string;
  storeId: string;
  storeName: string;
  words: string;
  quantity: number;
  unit: (typeof LIST_ITEM_UNITS)[number];
  brandLock: string | null;
  name: string;
  brand: string | null;
  size: string | null;
  upc: string | null;
  // The Product's latest price: its regular price, else its online price, else its Deal price.
  price: number | null;
};

// Every unchecked match of a List item not ticked off at a Store that is on, in one statement.
export async function listUncheckedMatches(database: Database): Promise<UncheckedMatch[]> {
  const rows = await database.all<Record<string, unknown>>(sql`
    WITH latest AS (
      SELECT product_id, regular_price, deal_price, online_price,
        ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY read_at DESC, id DESC) AS n
      FROM ${dealFinderPriceReads}
      WHERE product_id IN (SELECT product_id FROM ${productMatches} WHERE answer = 'unchecked')
    )
    SELECT pm.list_item_id, pm.product_id, pm.store_id, s.name AS store_name, li.words,
      li.quantity, li.unit, li.brand_lock, p.name, p.brand, p.size, p.upc,
      coalesce(l.regular_price, l.online_price, l.deal_price) AS price
    FROM ${productMatches} pm
    JOIN ${shoppingListItems} li ON li.id = pm.list_item_id AND li.ticked = 0
    JOIN ${dealFinderStores} s ON s.id = pm.store_id AND s."on" = 1
    JOIN ${dealFinderProducts} p ON p.id = pm.product_id
    LEFT JOIN latest l ON l.product_id = pm.product_id AND l.n = 1
    WHERE pm.answer = 'unchecked'
    ORDER BY li.place, pm.store_id, pm.rowid`);
  return rows.map((row) => ({
    listItemId: String(row.list_item_id),
    productId: String(row.product_id),
    storeId: String(row.store_id),
    storeName: String(row.store_name),
    words: String(row.words),
    quantity: Number(row.quantity),
    unit: String(row.unit) as UncheckedMatch["unit"],
    brandLock: row.brand_lock === null ? null : String(row.brand_lock),
    name: String(row.name),
    brand: row.brand === null ? null : String(row.brand),
    size: row.size === null ? null : String(row.size),
    upc: row.upc === null ? null : String(row.upc),
    price: row.price === null ? null : Number(row.price),
  }));
}

export type MatchAnswer = {
  listItemId: string;
  productId: string;
  answer: Exclude<(typeof PRODUCT_MATCH_ANSWERS)[number], "unchecked">;
  reason: string | null;
};

// Stores the answers for one batch, and each size the AI read for a Product whose size code could
// not read. One statement each. Only an unchecked match takes an answer, so a Member's choice made
// during the run stays.
export async function storeMatchAnswers(
  database: Database,
  answers: readonly MatchAnswer[],
  sizes: readonly { productId: string; size: string }[],
  at: Date,
): Promise<void> {
  await database.transaction(async (tx) => {
    for (const part of chunks(answers)) {
      await tx.run(sql`
        UPDATE ${productMatches}
        SET answer = a.value->>'answer', reason = a.value->>'reason', matched_at = ${at.toISOString()}
        FROM json_each(${JSON.stringify(part)}) a
        WHERE ${productMatches.listItemId} = a.value->>'listItemId'
          AND ${productMatches.productId} = a.value->>'productId'
          AND ${productMatches.answer} = 'unchecked'`);
    }
    for (const part of chunks(sizes)) {
      await tx.run(sql`
        UPDATE ${dealFinderProducts}
        SET size = s.value->>'size'
        FROM json_each(${JSON.stringify(part)}) s
        WHERE ${dealFinderProducts.id} = s.value->>'productId'`);
    }
  });
}

// The List item's words as a Member choice is kept: trimmed, in lower case, with one space between
// words.
export const choiceWords = (words: string) => words.trim().toLowerCase().replace(/\s+/g, " ");

// Each Member choice for these words, by words and Product, in one statement.
export async function readMemberChoices(
  database: Database,
  words: readonly string[],
): Promise<Map<string, "confirmed" | "rejected">> {
  const wanted = [...new Set(words.map(choiceWords))];
  if (wanted.length === 0) return new Map();
  const rows = await database.all<Record<string, unknown>>(sql`
    SELECT words, product_id, choice FROM ${memberMatchChoices}
    WHERE words IN (SELECT value FROM json_each(${JSON.stringify(wanted)}))`);
  return new Map(
    rows.map((row) => [
      `${String(row.words)}\u0000${String(row.product_id)}`,
      String(row.choice) as "confirmed" | "rejected",
    ]),
  );
}

// A Member confirms or rejects one match (spec 15, Matching List items to Products, step 5). The
// app remembers it for the same List item words and Product, and the match takes it at once: a
// confirmed one, a substitute too, counts as a `match`. False when the List item has no such
// Product.
export async function storeMemberChoice(
  database: Database,
  choice: {
    listItemId: string;
    productId: string;
    choice: "confirmed" | "rejected";
    memberId: string | null;
    at: Date;
  },
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const [item] = await tx
      .select({ words: shoppingListItems.words })
      .from(shoppingListItems)
      .innerJoin(productMatches, eq(productMatches.listItemId, shoppingListItems.id))
      .where(
        and(
          eq(shoppingListItems.id, choice.listItemId),
          eq(productMatches.productId, choice.productId),
        ),
      );
    if (item === undefined) return false;
    const row = {
      words: choiceWords(item.words),
      productId: choice.productId,
      choice: choice.choice,
      memberId: choice.memberId,
      at: choice.at,
    };
    await tx
      .insert(memberMatchChoices)
      .values(row)
      .onConflictDoUpdate({
        target: [memberMatchChoices.words, memberMatchChoices.productId],
        set: { choice: row.choice, memberId: row.memberId, at: row.at },
      });
    await tx
      .update(productMatches)
      .set({
        answer: choice.choice === "confirmed" ? "match" : "no",
        matchedAt: choice.at,
      })
      .where(
        and(
          eq(productMatches.listItemId, choice.listItemId),
          eq(productMatches.productId, choice.productId),
        ),
      );
    return true;
  });
}

// Stores the search words the AI wrote for List items, in one statement.
export async function storeSearchWords(
  database: Database,
  words: readonly { id: string; searchWords: string }[],
): Promise<void> {
  for (const part of chunks(words)) {
    await database.run(sql`
      UPDATE ${shoppingListItems} SET search_words = w.value->>'searchWords'
      FROM json_each(${JSON.stringify(part)}) w
      WHERE ${shoppingListItems.id} = w.value->>'id'`);
  }
}

export type StoreFailure = { storeId: string; reason: string };

export type StoredPlanRun = {
  id: string;
  startedAt: Date;
  state: "running" | "done" | "failed";
  finishedAt: Date | null;
  storeFailures: StoreFailure[];
};

const planRunColumns = {
  id: shoppingPlans.id,
  startedAt: shoppingPlans.startedAt,
  state: shoppingPlans.state,
  finishedAt: shoppingPlans.finishedAt,
  storeFailures: shoppingPlans.storeFailures,
};

// Starts a plan run, unless one runs: a plan run that started before `staleBefore` has stopped, and
// ends as failed here. The check and the insert are one statement, so two at once never both start.
// Returns the plan run that runs now, and whether it is the new one.
export async function startPlanRun(
  database: Database,
  run: { id: string; at: Date; by: string | null; tripSaving: number; staleBefore: Date },
): Promise<{ id: string; started: boolean }> {
  await database
    .update(shoppingPlans)
    .set({ state: "failed", finishedAt: run.at })
    .where(and(eq(shoppingPlans.state, "running"), lte(shoppingPlans.startedAt, run.staleBefore)));
  const started = await database.all<{ id: string }>(sql`
    INSERT INTO ${shoppingPlans} (id, started_at, started_by, state, trip_saving, store_failures)
    SELECT ${run.id}, ${run.at.toISOString()}, ${run.by}, 'running', ${run.tripSaving}, '[]'
    WHERE NOT EXISTS (SELECT 1 FROM ${shoppingPlans} WHERE state = 'running')
    RETURNING id`);
  if (started.length === 1) return { id: run.id, started: true };
  const running = await readRunningPlanRun(database);
  return running === undefined
    ? { id: run.id, started: false }
    : { id: running.id, started: false };
}

export async function readRunningPlanRun(database: Database): Promise<StoredPlanRun | undefined> {
  const [row] = await database
    .select(planRunColumns)
    .from(shoppingPlans)
    .where(eq(shoppingPlans.state, "running"))
    .orderBy(asc(shoppingPlans.startedAt))
    .limit(1);
  return row;
}

export async function readPlanRun(
  database: Database,
  id: string,
): Promise<StoredPlanRun | undefined> {
  const [row] = await database
    .select(planRunColumns)
    .from(shoppingPlans)
    .where(eq(shoppingPlans.id, id));
  return row;
}

export async function readLatestPlanRun(database: Database): Promise<StoredPlanRun | undefined> {
  const [row] = await database
    .select(planRunColumns)
    .from(shoppingPlans)
    .orderBy(sql`${shoppingPlans.startedAt} DESC`, sql`${shoppingPlans.id} DESC`)
    .limit(1);
  return row;
}

// Ends a running plan run. False when it was not running, such as one a later start ended.
export async function finishPlanRun(
  database: Database,
  id: string,
  end: { state: "done" | "failed"; at: Date; storeFailures: StoreFailure[] },
): Promise<boolean> {
  const ended = await database
    .update(shoppingPlans)
    .set({ state: end.state, finishedAt: end.at, storeFailures: end.storeFailures })
    .where(and(eq(shoppingPlans.id, id), eq(shoppingPlans.state, "running")))
    .returning({ id: shoppingPlans.id });
  return ended.length === 1;
}

// The plan runs in a row, since the Store's last good read, in which the Store could not be read.
export async function countStoreFailedRuns(
  database: Database,
  storeId: string,
  failedReason: string,
): Promise<number> {
  const [row] = await database.all<{ runs: number }>(sql`
    SELECT count(*) AS runs FROM ${shoppingPlans} p
    WHERE p.state = 'done'
      AND p.started_at > coalesce(
        (SELECT last_good_read_at FROM ${dealFinderStores} WHERE id = ${storeId}), '')
      AND EXISTS (SELECT 1 FROM json_each(p.store_failures) f
        WHERE f.value->>'storeId' = ${storeId} AND f.value->>'reason' = ${failedReason})`);
  return Number(row?.runs ?? 0);
}
