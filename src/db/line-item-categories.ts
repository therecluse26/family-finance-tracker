import { and, asc, eq, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import type { Queries } from "./client.ts";
import type { CategoryConfidence } from "./decisions.ts";
import type { StoredItemRule, StoredLineItem } from "./line-items.ts";
import { itemRules, lineItems, transactionParts } from "./schema.ts";

// Line item Categories, Item rules, and the parts a Transaction takes from its Line items, in
// app.db (spec 14, Categories of Line items; Item rules; Splits from Line items). The line-items
// and categorization modules decide; these functions store and read, a batch at a time: an Item
// rule changes every Line item it covers in one statement.

const IDS_PER_QUERY = 500;

function chunks<T>(items: readonly T[], size = IDS_PER_QUERY): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }
  return out;
}

// What choosing a Line item's Category reads of it.
export type CategorizedLineItem = Pick<
  StoredLineItem,
  | "id"
  | "transactionId"
  | "productId"
  | "cleanName"
  | "name"
  | "quantity"
  | "unitPrice"
  | "total"
  | "orderDate"
  | "category"
  | "categorySource"
  | "categoryConfidence"
  | "categoryNeedsAi"
>;

export type LineItemCategorySource = NonNullable<StoredLineItem["categorySource"]>;

const categorized = {
  id: lineItems.id,
  transactionId: lineItems.transactionId,
  productId: lineItems.productId,
  cleanName: lineItems.cleanName,
  name: lineItems.name,
  quantity: lineItems.quantity,
  unitPrice: lineItems.unitPrice,
  total: lineItems.total,
  orderDate: lineItems.orderDate,
  category: lineItems.category,
  categorySource: lineItems.categorySource,
  categoryConfidence: lineItems.categoryConfidence,
  categoryNeedsAi: lineItems.categoryNeedsAi,
};

// The Line items linked to each of these Transactions, by Transaction ID, by order date and ID. A
// Transaction with none is left out. One query per 500 Transactions.
export async function readLinkedLineItems(
  database: Queries,
  transactionIds: readonly string[],
): Promise<Map<string, CategorizedLineItem[]>> {
  const found = new Map<string, CategorizedLineItem[]>();
  for (const chunk of chunks([...new Set(transactionIds)])) {
    const rows = await database
      .select(categorized)
      .from(lineItems)
      .where(inArray(lineItems.transactionId, chunk))
      .orderBy(asc(lineItems.orderDate), asc(lineItems.id));
    for (const row of rows) {
      if (row.transactionId === null) continue;
      const items = found.get(row.transactionId);
      if (items === undefined) found.set(row.transactionId, [row]);
      else items.push(row);
    }
  }
  return found;
}

// The Line items with these IDs, in no order. An unknown ID is left out.
export async function readCategorizedLineItems(
  database: Queries,
  ids: readonly string[],
): Promise<CategorizedLineItem[]> {
  const found: CategorizedLineItem[] = [];
  for (const chunk of chunks([...new Set(ids)])) {
    found.push(
      ...(await database.select(categorized).from(lineItems).where(inArray(lineItems.id, chunk))),
    );
  }
  return found;
}

// Every Line item with no Category yet, oldest order first.
export function listUncategorizedLineItems(database: Queries): Promise<CategorizedLineItem[]> {
  return database
    .select(categorized)
    .from(lineItems)
    .where(isNull(lineItems.categorySource))
    .orderBy(asc(lineItems.orderDate), asc(lineItems.id));
}

// Every Line item whose Category the Transaction step chose with no AI, for the redo of no-AI work
// (spec 14, Step 4), oldest order first.
export function listMarkedLineItems(database: Queries): Promise<CategorizedLineItem[]> {
  return database
    .select(categorized)
    .from(lineItems)
    .where(eq(lineItems.categoryNeedsAi, true))
    .orderBy(asc(lineItems.orderDate), asc(lineItems.id));
}

// Every Line item the AI chose with confidence "low", for the Review list's cards.
export function listUnsureLineItems(database: Queries): Promise<CategorizedLineItem[]> {
  return database
    .select(categorized)
    .from(lineItems)
    .where(and(eq(lineItems.categorySource, "AI"), eq(lineItems.categoryConfidence, "low")))
    .orderBy(asc(lineItems.orderDate), asc(lineItems.id));
}

export type LineItemChoice = {
  id: string;
  // Null for the Transaction step on a linked Line item until the cascade gives its Transaction's
  // Category.
  category: string | null;
  categorySource: LineItemCategorySource;
  categoryConfidence: CategoryConfidence;
  categoryNeedsAi: boolean;
};

// Saves each Line item's Category, in one transaction, with one statement for each 500 Line items
// that take the same choice (K3). A Line item a Member set by hand keeps it, even when a Member set
// it after the choice was made.
export async function storeLineItemChoices(
  database: Queries,
  choices: readonly LineItemChoice[],
): Promise<void> {
  if (choices.length === 0) return;
  const alike = new Map<string, { choice: Omit<LineItemChoice, "id">; ids: string[] }>();
  for (const { id, ...choice } of choices) {
    const key = JSON.stringify([
      choice.category,
      choice.categorySource,
      choice.categoryConfidence,
      choice.categoryNeedsAi,
    ]);
    const group = alike.get(key);
    if (group === undefined) alike.set(key, { choice, ids: [id] });
    else group.ids.push(id);
  }
  await database.transaction(async (tx) => {
    for (const { choice, ids } of alike.values()) {
      for (const chunk of chunks(ids)) {
        await tx
          .update(lineItems)
          .set(choice)
          .where(and(inArray(lineItems.id, chunk), notHandSet));
      }
    }
  });
}

const notHandSet = or(isNull(lineItems.categorySource), ne(lineItems.categorySource, "hand-set"));

// Gives the Transaction step's Line items of each Transaction the Category the cascade gave the
// Transaction (spec 14, Step 4). Only those still from the Transaction step change.
export async function storeTransactionStepCategories(
  database: Queries,
  chosen: readonly { transactionId: string; category: string }[],
): Promise<void> {
  if (chosen.length === 0) return;
  const byCategory = new Map<string, string[]>();
  for (const { transactionId, category } of chosen) {
    const ids = byCategory.get(category);
    if (ids === undefined) byCategory.set(category, [transactionId]);
    else ids.push(transactionId);
  }
  await database.transaction(async (tx) => {
    for (const [category, transactionIds] of byCategory) {
      for (const chunk of chunks(transactionIds)) {
        await tx
          .update(lineItems)
          .set({ category })
          .where(
            and(
              inArray(lineItems.transactionId, chunk),
              eq(lineItems.categorySource, "Transaction"),
            ),
          );
      }
    }
  });
}

// A Member sets one Line item's Category by hand. Returns it as it was, or undefined when no Line
// item has the ID.
export async function setLineItemCategoryByHand(
  database: Queries,
  id: string,
  category: string,
): Promise<CategorizedLineItem | undefined> {
  const [before] = await database.select(categorized).from(lineItems).where(eq(lineItems.id, id));
  if (before === undefined) return undefined;
  await database
    .update(lineItems)
    .set({
      category,
      categorySource: "hand-set",
      categoryConfidence: "certain",
      categoryNeedsAi: false,
    })
    .where(eq(lineItems.id, id));
  return before;
}

// Sets these Line items' Category by hand, in one statement per 500.
export async function setLineItemCategoriesByHand(
  database: Queries,
  ids: readonly string[],
  category: string,
): Promise<void> {
  for (const chunk of chunks([...new Set(ids)])) {
    await database
      .update(lineItems)
      .set({
        category,
        categorySource: "hand-set",
        categoryConfidence: "certain",
        categoryNeedsAi: false,
      })
      .where(inArray(lineItems.id, chunk));
  }
}

// A product as an Item rule names it: its product ID, else its clean name (spec 14, Item rules).
export type Product = { productId: string | null; cleanName: string };

export function productKeyOf(product: Product): string {
  return JSON.stringify(
    product.productId === null ? ["name", product.cleanName] : ["id", product.productId],
  );
}

// The Line items a rule for this product covers. A rule with a product ID covers that product ID,
// and a Line item with no product ID by clean name. A rule with no product ID covers the clean name,
// except a Line item whose own product ID has a rule of its own.
function coveredBy(product: Product): SQL {
  if (product.productId !== null) {
    return or(
      eq(lineItems.productId, product.productId),
      and(isNull(lineItems.productId), eq(lineItems.cleanName, product.cleanName)),
    ) as SQL;
  }
  return and(
    eq(lineItems.cleanName, product.cleanName),
    or(
      isNull(lineItems.productId),
      sql`NOT EXISTS (SELECT 1 FROM ${itemRules} WHERE ${itemRules.productId} = ${lineItems.productId})`,
    ),
  ) as SQL;
}

export type ChangedLineItems = { ids: string[]; transactionIds: string[] };

const changedOf = (rows: readonly { id: string; transactionId: string | null }[]) => ({
  ids: rows.map((row) => row.id),
  transactionIds: [
    ...new Set(rows.flatMap((row) => (row.transactionId === null ? [] : [row.transactionId]))),
  ],
});

// Makes or replaces the product's Item rule, then gives every Line item it covers that no Member
// set by hand its Category, in one statement. Returns the rule's ID and the Line items it changed,
// with their Transactions.
export async function storeItemRule(
  database: Queries,
  rule: Product & { name: string; category: string; madeAt: Date; madeBy: string | null },
): Promise<{ id: string; changed: ChangedLineItems }> {
  const productKey = productKeyOf(rule);
  const values = {
    productKey,
    productId: rule.productId,
    cleanName: rule.cleanName,
    name: rule.name,
    category: rule.category,
    madeAt: rule.madeAt,
    madeBy: rule.madeBy,
  };
  const [stored] = await database
    .insert(itemRules)
    .values({ id: crypto.randomUUID(), ...values })
    .onConflictDoUpdate({ target: itemRules.productKey, set: values })
    .returning({ id: itemRules.id });
  if (stored === undefined) throw new Error("The Item rule was not stored.");
  const rows = await database
    .update(lineItems)
    .set({
      category: rule.category,
      categorySource: "Item rule",
      categoryConfidence: "certain",
      categoryNeedsAi: false,
    })
    .where(and(coveredBy(rule), notHandSet))
    .returning({ id: lineItems.id, transactionId: lineItems.transactionId });
  return { id: stored.id, changed: changedOf(rows) };
}

// Deletes an Item rule, and clears the Category of every Line item it chose, so they go down the
// steps again. Returns the rule, or undefined when no rule has the ID, with the Line items it
// cleared.
export async function removeItemRule(
  database: Queries,
  id: string,
): Promise<{ rule: StoredItemRule; cleared: ChangedLineItems } | undefined> {
  const [rule] = await database.delete(itemRules).where(eq(itemRules.id, id)).returning();
  if (rule === undefined) return undefined;
  const rows = await database
    .update(lineItems)
    .set({ category: null, categorySource: null, categoryConfidence: null, categoryNeedsAi: false })
    .where(and(coveredBy(rule), eq(lineItems.categorySource, "Item rule")))
    .returning({ id: lineItems.id, transactionId: lineItems.transactionId });
  return { rule, cleared: changedOf(rows) };
}

// The rule that covers each of these Line items, by Line item ID: by product ID first, then by
// clean name. One read of every Item rule.
export async function readItemRulesFor(
  database: Queries,
  items: readonly CategorizedLineItem[],
): Promise<Map<string, StoredItemRule>> {
  const found = new Map<string, StoredItemRule>();
  if (items.length === 0) return found;
  const rules = await database.select().from(itemRules);
  const byProductId = new Map<string, StoredItemRule>();
  const byName = new Map<string, StoredItemRule>();
  for (const rule of rules) {
    if (rule.productId !== null) byProductId.set(rule.productId, rule);
    else byName.set(rule.cleanName, rule);
  }
  const byNameAny = new Map<string, StoredItemRule>();
  for (const rule of rules) if (!byNameAny.has(rule.cleanName)) byNameAny.set(rule.cleanName, rule);
  for (const item of items) {
    const rule =
      item.productId === null
        ? byNameAny.get(item.cleanName)
        : (byProductId.get(item.productId) ?? byName.get(item.cleanName));
    if (rule !== undefined) found.set(item.id, rule);
  }
  return found;
}

// One part a Transaction takes from its Line items: whole cents in the Transaction's sign, and its
// Category.
export type LineItemPart = { amount: number; category: string };

// Puts each Transaction's parts from its Line items in place of its one Spending part, in one
// transaction. A Transaction whose parts changed since the cascade read them, such as one Matching
// decided again, keeps them: the follow-up job that decided it handles it again. Reads and writes
// once per run of Transactions. Returns the Transactions that took their parts.
export async function storeLineItemParts(
  database: Queries,
  splits: readonly { transactionId: string; amount: number; parts: readonly LineItemPart[] }[],
): Promise<string[]> {
  if (splits.length === 0) return [];
  return database.transaction(async (tx) => {
    const stored: string[] = [];
    for (const run of chunks(splits)) {
      const now = await tx
        .select({
          transactionId: transactionParts.transactionId,
          type: transactionParts.type,
          amount: transactionParts.amount,
          keepsCategory: transactionParts.keepsCategory,
          linked: transactionParts.linked,
          categorySource: transactionParts.categorySource,
        })
        .from(transactionParts)
        .where(
          inArray(
            transactionParts.transactionId,
            run.map((split) => split.transactionId),
          ),
        );
      const partsOf = new Map<string, typeof now>();
      for (const part of now) {
        partsOf.set(part.transactionId, [...(partsOf.get(part.transactionId) ?? []), part]);
      }
      const taking = run.filter((split) => {
        const parts = partsOf.get(split.transactionId) ?? [];
        const [only] = parts;
        return (
          parts.length === 1 &&
          only !== undefined &&
          only.type === "Spending" &&
          !only.keepsCategory &&
          !only.linked &&
          only.amount === split.amount &&
          only.categorySource !== "hand-set"
        );
      });
      if (taking.length === 0) continue;
      const ids = taking.map((split) => split.transactionId);
      await tx.delete(transactionParts).where(inArray(transactionParts.transactionId, ids));
      const rows = taking.flatMap((split) =>
        split.parts.map((part, index) => ({
          transactionId: split.transactionId,
          part: index,
          type: "Spending" as const,
          amount: part.amount,
          category: part.category,
          categorySource: "Line items" as const,
          categoryConfidence: "certain" as const,
          categoryNeedsAi: false,
        })),
      );
      for (const values of chunks(rows, 100)) await tx.insert(transactionParts).values(values);
      stored.push(...ids);
    }
    return stored;
  });
}
