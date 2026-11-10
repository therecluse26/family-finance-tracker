import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Queries } from "./client.ts";
import type { StoredLineItem } from "./line-items.ts";
import {
  householdAccounts,
  lineItems,
  refusedLineItemLinks,
  reviewItems,
  transactionParts,
  transactions,
} from "./schema.ts";

// Links between Line items and the Transactions that paid for them, in app.db (spec 14, Linking
// Line items to Transactions). The line-items module decides; these functions read and store, a
// run at a time: one read of each table a run needs, and one statement for each kind of write.

const IDS_PER_QUERY = 500;

function chunks<T>(items: readonly T[], size = IDS_PER_QUERY): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }
  return out;
}

// A shipment is one order's Line items with one ship time. A whole order, for the app's
// whole-order link, has no ship time.
export type ShipmentTarget = { orderId: string; shipTime: string | null };

// The best answer of a shipment's Review list item, "None of these", names the shipment it is
// about: "none|<order ID>|<ship time>", or "none|<order ID>|" for a whole order. Order IDs and
// ship times hold no "|". countShipments reads it in SQL, in the same form.
export function shipmentAnswerValue(target: ShipmentTarget): string {
  return `none|${target.orderId}|${target.shipTime ?? ""}`;
}

export function shipmentOfAnswer(value: string): ShipmentTarget | undefined {
  const [none, orderId, shipTime, ...rest] = value.split("|");
  if (none !== "none" || orderId === undefined || orderId === "" || shipTime === undefined) {
    return undefined;
  }
  if (rest.length > 0) return undefined;
  return { orderId, shipTime: shipTime === "" ? null : shipTime };
}

// What a link run reads of each Line item.
export type LinkingItem = Pick<
  StoredLineItem,
  | "id"
  | "orderId"
  | "shipTime"
  | "shipDate"
  | "orderDate"
  | "name"
  | "total"
  | "cardLast4"
  | "giftCard"
  | "transactionId"
  | "linkKind"
>;

// Every Line item of a source, by order, ship time, and name.
export async function readLinkingItems(
  database: Queries,
  source: StoredLineItem["source"],
): Promise<LinkingItem[]> {
  return database
    .select({
      id: lineItems.id,
      orderId: lineItems.orderId,
      shipTime: lineItems.shipTime,
      shipDate: lineItems.shipDate,
      orderDate: lineItems.orderDate,
      name: lineItems.name,
      total: lineItems.total,
      cardLast4: lineItems.cardLast4,
      giftCard: lineItems.giftCard,
      transactionId: lineItems.transactionId,
      linkKind: lineItems.linkKind,
    })
    .from(lineItems)
    .where(eq(lineItems.source, source))
    .orderBy(
      asc(lineItems.orderId),
      asc(lineItems.shipTime),
      asc(lineItems.name),
      asc(lineItems.id),
    );
}

// A Transaction's day: its purchase date when it has one.
const purchaseDate = sql<string>`coalesce(${transactions.authorizedDate}, ${transactions.postedDate})`;

// Every part of the Transaction is Spending, and it has one.
const spendingOnly = sql<boolean>`(
  EXISTS (SELECT 1 FROM ${transactionParts} WHERE ${transactionParts.transactionId} = ${transactions.id} AND ${transactionParts.type} = 'Spending')
  AND NOT EXISTS (SELECT 1 FROM ${transactionParts} WHERE ${transactionParts.transactionId} = ${transactions.id} AND ${transactionParts.type} <> 'Spending')
)`;

// What a link reads of a Transaction.
export type LinkTransaction = {
  id: string;
  accountId: string;
  amount: number;
  purchaseDate: string;
  pending: boolean;
  hiddenReason: StoredTransactionHiddenReason;
  description: string;
  merchantCleanName: string | null;
  spending: boolean;
};

type StoredTransactionHiddenReason = (typeof transactions.$inferSelect)["hiddenReason"];

const LINK_TRANSACTION_FIELDS = {
  id: transactions.id,
  accountId: transactions.accountId,
  amount: transactions.amount,
  purchaseDate,
  pending: transactions.pending,
  hiddenReason: transactions.hiddenReason,
  description: transactions.description,
  merchantCleanName: transactions.merchantCleanName,
  spending: spendingOnly,
};

const asLinkTransaction = (row: Omit<LinkTransaction, "spending"> & { spending: unknown }) => ({
  ...row,
  spending: Boolean(row.spending),
});

// The Spending charges that may be Amazon's, with a purchase date from `from` to `to`: posted, not
// hidden or removed, every part Spending, and with AMAZON or AMZN in the bank description or the
// Merchant's clean name. One statement; the module checks the Merchant's identity.
export async function readAmazonCandidates(
  database: Queries,
  window: { from: string; to: string },
): Promise<LinkTransaction[]> {
  const rows = await database
    .select(LINK_TRANSACTION_FIELDS)
    .from(transactions)
    .where(
      and(
        eq(transactions.pending, false),
        isNull(transactions.hiddenReason),
        sql`${purchaseDate} BETWEEN ${window.from} AND ${window.to}`,
        sql`(upper(${transactions.description}) LIKE '%AMAZON%' OR upper(${transactions.description}) LIKE '%AMZN%' OR upper(coalesce(${transactions.merchantCleanName}, '')) LIKE '%AMAZON%' OR upper(coalesce(${transactions.merchantCleanName}, '')) LIKE '%AMZN%')`,
        spendingOnly,
      ),
    );
  return rows.map(asLinkTransaction);
}

// The Transactions with these IDs, hidden ones included, 500 IDs a statement.
export async function readLinkTransactions(
  database: Queries,
  ids: readonly string[],
): Promise<LinkTransaction[]> {
  const found: LinkTransaction[] = [];
  for (const chunk of chunks([...new Set(ids)])) {
    const rows = await database
      .select(LINK_TRANSACTION_FIELDS)
      .from(transactions)
      .where(inArray(transactions.id, chunk));
    found.push(...rows.map(asLinkTransaction));
  }
  return found;
}

// Every Transaction that holds a Line item, hidden ones included, in one statement.
export async function readLinkedTransactions(database: Queries): Promise<LinkTransaction[]> {
  const rows = await database
    .select(LINK_TRANSACTION_FIELDS)
    .from(transactions)
    .where(
      inArray(
        transactions.id,
        database
          .selectDistinct({ id: sql<string>`${lineItems.transactionId}` })
          .from(lineItems)
          .where(isNotNull(lineItems.transactionId)),
      ),
    );
  return rows.map(asLinkTransaction);
}

// Each Account's last 4 digits, by Account ID. An Account without them is left out.
export async function readAccountMasks(database: Queries): Promise<Map<string, string>> {
  const rows = await database
    .select({ id: householdAccounts.id, mask: householdAccounts.mask })
    .from(householdAccounts)
    .where(isNotNull(householdAccounts.mask));
  return new Map(rows.flatMap((row) => (row.mask === null ? [] : [[row.id, row.mask]])));
}

export type RefusedLineItemLink = { orderId: string; shipTime: string; transactionId: string };

// Every shipment and Transaction the app never links again.
export async function readRefusedLineItemLinks(database: Queries): Promise<RefusedLineItemLink[]> {
  return database
    .select({
      orderId: refusedLineItemLinks.orderId,
      shipTime: refusedLineItemLinks.shipTime,
      transactionId: refusedLineItemLinks.transactionId,
    })
    .from(refusedLineItemLinks);
}

// Which Transaction holds each linked shipment, and which order each Transaction holds, as they
// stand now: what a link run reads again inside its write, so a link a Member made meanwhile wins.
export async function readHeldShipments(database: Queries): Promise<
  {
    orderId: string;
    shipTime: string;
    transactionId: string;
  }[]
> {
  const rows = await database
    .selectDistinct({
      orderId: lineItems.orderId,
      shipTime: lineItems.shipTime,
      transactionId: sql<string>`${lineItems.transactionId}`,
    })
    .from(lineItems)
    .where(isNotNull(lineItems.transactionId));
  return rows;
}

// Links each Line item to the Transaction it maps to, by the Line item's ID, in one statement. A
// Line item already linked stays as it is. Returns how many it linked.
export async function storeLineItemLinks(
  database: Queries,
  links: ReadonlyMap<string, string>,
  kind: "app" | "hand",
): Promise<number> {
  if (links.size === 0) return 0;
  const map = JSON.stringify(Object.fromEntries(links));
  const result = await database.run(sql`
    UPDATE ${lineItems} SET transaction_id = link.value, link_kind = ${kind}
    FROM json_each(${map}) AS link
    WHERE ${lineItems.id} = link.key AND ${lineItems.transactionId} IS NULL
  `);
  return result.rowsAffected;
}

// Unlinks each Line item from the Transaction it maps to, by the Line item's ID, in one statement.
// A Line item linked to another Transaction by now stays as it is.
export async function unlinkLineItems(
  database: Queries,
  links: ReadonlyMap<string, string>,
): Promise<number> {
  if (links.size === 0) return 0;
  const map = JSON.stringify(Object.fromEntries(links));
  const result = await database.run(sql`
    UPDATE ${lineItems} SET transaction_id = NULL, link_kind = NULL
    FROM json_each(${map}) AS link
    WHERE ${lineItems.id} = link.key AND ${lineItems.transactionId} = link.value
  `);
  return result.rowsAffected;
}

// The open items of a kind, each with its best answer's value and its Transactions.
export async function readOpenShipmentItems(
  database: Queries,
  kind: string,
): Promise<{ id: string; value: string; transactionIds: string[] }[]> {
  const rows = await database
    .select({
      id: reviewItems.id,
      bestAnswer: reviewItems.bestAnswer,
      subjectIds: reviewItems.subjectIds,
    })
    .from(reviewItems)
    .where(and(eq(reviewItems.kind, kind), isNull(reviewItems.closedAt)))
    .orderBy(asc(reviewItems.createdAt), asc(reviewItems.id));
  return rows.map((row) => ({
    id: row.id,
    value: row.bestAnswer.value,
    transactionIds: row.subjectIds,
  }));
}

// The app never links these shipments and Transactions again. A pair already refused stays as it
// was. 500 rows a statement.
export async function storeRefusedLineItemLinks(
  database: Queries,
  refusals: readonly RefusedLineItemLink[],
  by: { memberId: string | null; at: Date },
): Promise<void> {
  for (const chunk of chunks(refusals)) {
    await database
      .insert(refusedLineItemLinks)
      .values(chunk.map((row) => ({ ...row, memberId: by.memberId, refusedAt: by.at })))
      .onConflictDoNothing();
  }
}

// A Member links a shipment by hand to a Transaction the app had refused: the refusal ends.
export async function deleteRefusedLineItemLinks(
  database: Queries,
  refusals: readonly RefusedLineItemLink[],
): Promise<void> {
  for (const row of refusals) {
    await database
      .delete(refusedLineItemLinks)
      .where(
        and(
          eq(refusedLineItemLinks.orderId, row.orderId),
          eq(refusedLineItemLinks.shipTime, row.shipTime),
          eq(refusedLineItemLinks.transactionId, row.transactionId),
        ),
      );
  }
}

// The Line items of a shipment, or of a whole order.
export async function readShipmentItems(
  database: Queries,
  target: ShipmentTarget,
): Promise<LinkingItem[]> {
  return database
    .select({
      id: lineItems.id,
      orderId: lineItems.orderId,
      shipTime: lineItems.shipTime,
      shipDate: lineItems.shipDate,
      orderDate: lineItems.orderDate,
      name: lineItems.name,
      total: lineItems.total,
      cardLast4: lineItems.cardLast4,
      giftCard: lineItems.giftCard,
      transactionId: lineItems.transactionId,
      linkKind: lineItems.linkKind,
    })
    .from(lineItems)
    .where(
      and(
        eq(lineItems.orderId, target.orderId),
        target.shipTime === null ? undefined : eq(lineItems.shipTime, target.shipTime),
      ),
    )
    .orderBy(asc(lineItems.shipTime), asc(lineItems.name), asc(lineItems.id));
}

// The Line items linked to a Transaction.
export async function readItemsHeldBy(
  database: Queries,
  transactionId: string,
): Promise<LinkingItem[]> {
  return database
    .select({
      id: lineItems.id,
      orderId: lineItems.orderId,
      shipTime: lineItems.shipTime,
      shipDate: lineItems.shipDate,
      orderDate: lineItems.orderDate,
      name: lineItems.name,
      total: lineItems.total,
      cardLast4: lineItems.cardLast4,
      giftCard: lineItems.giftCard,
      transactionId: lineItems.transactionId,
      linkKind: lineItems.linkKind,
    })
    .from(lineItems)
    .where(eq(lineItems.transactionId, transactionId));
}

// One unlinked shipment a Member may link by hand.
export type ShipmentToLink = {
  orderId: string;
  shipTime: string;
  orderDate: string;
  shipDate: string;
  total: number;
  items: number;
  names: string[];
  giftCard: boolean;
};

const MAX_SHIPMENTS_TO_LINK = 100;

// The unlinked shipments of a source with an order date from `from` to `to`, newest first, 100 at
// most: one statement.
export async function listShipmentsToLink(
  database: Queries,
  source: StoredLineItem["source"],
  window: { from: string; to: string },
): Promise<ShipmentToLink[]> {
  const orderDate = sql<string>`min(${lineItems.orderDate})`;
  const rows = await database
    .select({
      orderId: lineItems.orderId,
      shipTime: lineItems.shipTime,
      orderDate,
      shipDate: sql<string>`min(${lineItems.shipDate})`,
      total: sql<number>`sum(${lineItems.total})`,
      items: sql<number>`count(*)`,
      names: sql<string>`json_group_array(${lineItems.name})`,
      giftCard: sql<number>`max(${lineItems.giftCard})`,
    })
    .from(lineItems)
    .where(
      and(
        eq(lineItems.source, source),
        sql`${lineItems.orderDate} BETWEEN ${window.from} AND ${window.to}`,
      ),
    )
    .groupBy(lineItems.orderId, lineItems.shipTime)
    .having(sql`max(${lineItems.transactionId} IS NOT NULL) = 0`)
    .orderBy(desc(orderDate), asc(lineItems.orderId), asc(lineItems.shipTime))
    .limit(MAX_SHIPMENTS_TO_LINK);
  return rows.map((row) => ({
    ...row,
    total: Number(row.total),
    items: Number(row.items),
    names: (JSON.parse(row.names) as string[]).sort(),
    giftCard: Boolean(row.giftCard),
  }));
}

// Closes the open items of a kind whose best answer names one of these shipments, with no answer,
// in one statement. `except` is an item a Member is answering, which closes as answered. Returns
// how many closed.
export async function closeShipmentReviewItems(
  database: Queries,
  kind: string,
  targets: readonly ShipmentTarget[],
  closing: { reason: string; at: Date; except?: string },
): Promise<number> {
  if (targets.length === 0) return 0;
  const values = JSON.stringify([...new Set(targets.map(shipmentAnswerValue))]);
  const rows = await database
    .update(reviewItems)
    .set({ closedAt: closing.at, closedReason: closing.reason, answer: null, answeredBy: null })
    .where(
      and(
        eq(reviewItems.kind, kind),
        isNull(reviewItems.closedAt),
        sql`json_extract(${reviewItems.bestAnswer}, '$.value') IN (SELECT value FROM json_each(${values}))`,
        closing.except === undefined ? undefined : sql`${reviewItems.id} <> ${closing.except}`,
      ),
    )
    .returning({ id: reviewItems.id });
  return rows.length;
}

// Closes these open items with no answer, in one statement. Returns how many closed.
export async function closeReviewItemsIn(
  database: Queries,
  ids: readonly string[],
  closing: { reason: string; at: Date },
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await database
    .update(reviewItems)
    .set({ closedAt: closing.at, closedReason: closing.reason, answer: null, answeredBy: null })
    .where(
      and(
        isNull(reviewItems.closedAt),
        sql`${reviewItems.id} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
      ),
    )
    .returning({ id: reviewItems.id });
  return rows.length;
}
