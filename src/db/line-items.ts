import { and, asc, count, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Database, Queries } from "./client.ts";
import {
  itemRules,
  lineItemImports,
  lineItems,
  members,
  refusedLineItemLinks,
  reviewItems,
} from "./schema.ts";

// Line items, Item rules, and order file imports in app.db (spec 14). The line-items module reads
// the files and decides; these functions store and read, a batch at a time: no write per row.

export type StoredLineItem = typeof lineItems.$inferSelect;
export type StoredItemRule = typeof itemRules.$inferSelect;
export type StoredLineItemImport = typeof lineItemImports.$inferSelect;

// The fields an import writes: what the file says. An import never writes a Line item's Category or
// link.
export const LINE_ITEM_FILE_FIELDS = [
  "orderId",
  "orderDate",
  "shipDate",
  "shipTime",
  "productId",
  "name",
  "cleanName",
  "quantity",
  "unitPrice",
  "unitTax",
  "shippingCharge",
  "discounts",
  "total",
  "cardLast4",
  "giftCard",
  "place",
] as const satisfies readonly (keyof StoredLineItem)[];

export type LineItemFileFields = Pick<StoredLineItem, (typeof LINE_ITEM_FILE_FIELDS)[number]>;
export type NewLineItem = LineItemFileFields & Pick<StoredLineItem, "source" | "key">;

// SQLite takes up to 32,766 values in one statement. A Line item has 22 columns to insert.
const ROWS_PER_INSERT = 500;
const IDS_PER_QUERY = 500;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }
  return out;
}

// The stored Line items with these import keys, by key.
export async function readLineItemsByKey(
  database: Queries,
  keys: readonly string[],
): Promise<Map<string, StoredLineItem>> {
  const found = new Map<string, StoredLineItem>();
  for (const chunk of chunks(keys, IDS_PER_QUERY)) {
    const rows = await database.select().from(lineItems).where(inArray(lineItems.key, chunk));
    for (const row of rows) found.set(row.key, row);
  }
  return found;
}

// Each column's name in app.db, for the upsert's `excluded.<column>`.
const fileColumnUpdates = Object.fromEntries(
  [...LINE_ITEM_FILE_FIELDS, "updatedAt" as const].map((field) => [
    field,
    sql.raw(`excluded.${lineItems[field].name}`),
  ]),
);

// Stores each Line item by its import key, a batch per statement: a new key adds a Line item, and
// a stored key's row gets the new file fields. Its Category and link stay.
export async function upsertLineItems(
  database: Queries,
  rows: readonly NewLineItem[],
  at: Date,
): Promise<void> {
  for (const chunk of chunks(rows, ROWS_PER_INSERT)) {
    await database
      .insert(lineItems)
      .values(chunk.map((row) => ({ ...row, id: crypto.randomUUID(), addedAt: at, updatedAt: at })))
      .onConflictDoUpdate({ target: lineItems.key, set: fileColumnUpdates });
  }
}

export type NewLineItemImport = Omit<StoredLineItemImport, "id">;

export async function storeLineItemImport(
  database: Queries,
  record: NewLineItemImport,
): Promise<string> {
  const id = crypto.randomUUID();
  await database.insert(lineItemImports).values({ id, ...record });
  return id;
}

// The newest import of a source, with its Member's name: null once the Member was removed.
export async function readLastLineItemImport(
  database: Queries,
  source: StoredLineItem["source"],
): Promise<(StoredLineItemImport & { memberName: string | null }) | undefined> {
  const [row] = await database
    .select({ record: lineItemImports, memberName: members.name })
    .from(lineItemImports)
    .leftJoin(members, eq(members.id, lineItemImports.memberId))
    .where(eq(lineItemImports.source, source))
    .orderBy(desc(lineItemImports.importedAt))
    .limit(1);
  return row === undefined ? undefined : { ...row.record, memberName: row.memberName };
}

// A source's shipments by where their linking stands (spec 14, The Amazon page in Settings). A
// shipment is one order's Line items with one ship time. An unlinked one paid in part by gift card
// is not tried. Another unlinked one waits for a charge while its ship date is on or after
// `waitingFrom`, and is "not matched" after.
export type ShipmentCounts = {
  linked: number;
  waiting: number;
  notMatched: number;
  giftCard: number;
};

export async function countShipments(
  database: Queries,
  source: StoredLineItem["source"],
  waitingFrom: string,
): Promise<ShipmentCounts> {
  const shipments = database
    .select({
      linked: sql<number>`max(${lineItems.transactionId} IS NOT NULL)`.as("linked"),
      giftCard: sql<number>`max(${lineItems.giftCard})`.as("gift_card"),
      shipDate: sql<string>`min(${lineItems.shipDate})`.as("ship_date"),
    })
    .from(lineItems)
    .where(eq(lineItems.source, source))
    .groupBy(lineItems.orderId, lineItems.shipTime)
    .as("shipments");
  const [row] = await database
    .select({
      linked: sql<number>`coalesce(sum(${shipments.linked}), 0)`,
      giftCard: sql<number>`coalesce(sum(NOT ${shipments.linked} AND ${shipments.giftCard}), 0)`,
      waiting: sql<number>`coalesce(sum(NOT ${shipments.linked} AND NOT ${shipments.giftCard} AND ${shipments.shipDate} >= ${waitingFrom}), 0)`,
      notMatched: sql<number>`coalesce(sum(NOT ${shipments.linked} AND NOT ${shipments.giftCard} AND ${shipments.shipDate} < ${waitingFrom}), 0)`,
    })
    .from(shipments);
  return {
    linked: Number(row?.linked ?? 0),
    waiting: Number(row?.waiting ?? 0),
    notMatched: Number(row?.notMatched ?? 0),
    giftCard: Number(row?.giftCard ?? 0),
  };
}

// How many Line items a source has stored.
export async function countLineItems(
  database: Queries,
  source: StoredLineItem["source"],
): Promise<number> {
  const [row] = await database
    .select({ items: count() })
    .from(lineItems)
    .where(eq(lineItems.source, source));
  return row?.items ?? 0;
}

// How many open Review list items have this kind.
export async function countOpenReviewItemsOfKind(database: Queries, kind: string): Promise<number> {
  const [row] = await database
    .select({ open: count() })
    .from(reviewItems)
    .where(and(eq(reviewItems.kind, kind), isNull(reviewItems.closedAt)));
  return row?.open ?? 0;
}

// How many Line items each of these Transactions has linked, by Transaction ID. A Transaction with
// none is left out. One query per 500 Transactions.
export async function countLineItemsOf(
  database: Queries,
  transactionIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const ids = [...new Set(transactionIds)];
  // A long list, such as every Transaction: one read of every linked Line item's count, through
  // the index, costs less than a read per 500 IDs.
  if (ids.length > IDS_PER_QUERY) {
    const wanted = new Set(ids);
    const rows = await database
      .select({ transactionId: lineItems.transactionId, items: count() })
      .from(lineItems)
      .where(isNotNull(lineItems.transactionId))
      .groupBy(lineItems.transactionId);
    for (const row of rows) {
      if (row.transactionId !== null && wanted.has(row.transactionId)) {
        counts.set(row.transactionId, row.items);
      }
    }
    return counts;
  }
  for (const chunk of chunks(ids, IDS_PER_QUERY)) {
    const rows = await database
      .select({ transactionId: lineItems.transactionId, items: count() })
      .from(lineItems)
      .where(inArray(lineItems.transactionId, chunk))
      .groupBy(lineItems.transactionId);
    for (const row of rows)
      if (row.transactionId !== null) counts.set(row.transactionId, row.items);
  }
  return counts;
}

// The Line items linked to a Transaction, by order, ship time, and name.
export async function listLineItemsOf(
  database: Queries,
  transactionId: string,
): Promise<StoredLineItem[]> {
  return database
    .select()
    .from(lineItems)
    .where(eq(lineItems.transactionId, transactionId))
    .orderBy(
      asc(lineItems.orderId),
      asc(lineItems.shipTime),
      asc(lineItems.name),
      asc(lineItems.id),
    );
}

// What "Delete all Amazon data" removed, and the Transactions that had its Line items linked.
export type LineItemDataDeleted = {
  transactionIds: string[];
  lineItems: number;
  itemRules: number;
  imports: number;
};

// Deletes every Line item of a source, every refused link, every Item rule, and every import
// record of the source, in one transaction (spec 14, Delete all Amazon data). Nothing else changes.
export async function deleteLineItemData(
  database: Database,
  source: StoredLineItem["source"],
): Promise<LineItemDataDeleted> {
  return database.transaction(async (tx) => {
    const linked = await tx
      .selectDistinct({ id: lineItems.transactionId })
      .from(lineItems)
      .where(and(eq(lineItems.source, source), isNotNull(lineItems.transactionId)));
    const removed = await tx
      .delete(lineItems)
      .where(eq(lineItems.source, source))
      .returning({ id: lineItems.id });
    await tx.delete(refusedLineItemLinks);
    const rules = await tx.delete(itemRules).returning({ id: itemRules.id });
    const imports = await tx
      .delete(lineItemImports)
      .where(eq(lineItemImports.source, source))
      .returning({ id: lineItemImports.id });
    return {
      transactionIds: linked.flatMap((row) => (row.id === null ? [] : [row.id])),
      lineItems: removed.length,
      itemRules: rules.length,
      imports: imports.length,
    };
  });
}

const EXPORT_PAGE = 1000;

// Every Line item, a page at a time, by order date, for the data export.
export async function* readExportedLineItems(database: Queries): AsyncGenerator<StoredLineItem[]> {
  let after: { orderDate: string; id: string } | undefined;
  for (;;) {
    const page = await database
      .select()
      .from(lineItems)
      .where(
        after === undefined
          ? undefined
          : sql`(${lineItems.orderDate}, ${lineItems.id}) > (${after.orderDate}, ${after.id})`,
      )
      .orderBy(asc(lineItems.orderDate), asc(lineItems.id))
      .limit(EXPORT_PAGE);
    if (page.length === 0) return;
    yield page;
    const last = page.at(-1);
    if (last === undefined || page.length < EXPORT_PAGE) return;
    after = { orderDate: last.orderDate, id: last.id };
  }
}

// Every Item rule, by name.
export async function listItemRules(database: Queries): Promise<StoredItemRule[]> {
  return database.select().from(itemRules).orderBy(asc(itemRules.name), asc(itemRules.id));
}
