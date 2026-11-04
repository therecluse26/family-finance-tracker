import { aliasedTable, and, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Database, Queries } from "./client.ts";
import {
  householdAccounts,
  refusedTransferLinks,
  transactionDecisions,
  transactions,
  transferLinks,
} from "./schema.ts";

// Transfer pairs in app.db (spec 03, Links, Evidence, Transfers). The money-movement module pairs;
// these functions store and read.

// SQLite takes at most 32,766 values in one statement.
const IDS_PER_QUERY = 500;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += IDS_PER_QUERY) {
    out.push(items.slice(start, start + IDS_PER_QUERY));
  }
  return out;
}

export type StoredTransferLink = typeof transferLinks.$inferSelect;
export type NewTransferLink = Omit<StoredTransferLink, "id">;
export type TransferLinkMaker = StoredTransferLink["madeBy"];

// What Transfer pairing reads of a Transaction and its Account.
export type TransferCandidate = {
  id: string;
  accountId: string;
  amount: number;
  postedDate: string;
  description: string;
  providerCategory: string | null;
  counterparties: { name: string; type: string }[];
  handSet: Record<string, unknown>;
  accountKind: string;
  mask: string | null;
  institutionId: string | null;
  institutionName: string | null;
};

// Which Transactions to read for Transfer pairing: these IDs, or each one with one of these
// amounts, either way, posted from `from` to `to`.
export type TransferCandidateFilter =
  | { ids: readonly string[] }
  | { amounts: readonly number[]; from: string; to: string };

// The Transactions that could pair: each shown, posted Transaction on an Account that is not
// excluded, that the filter names. Pending Transactions wait until they post.
export async function listTransferCandidates(
  database: Database,
  filter: TransferCandidateFilter,
): Promise<TransferCandidate[]> {
  const chosen =
    "ids" in filter
      ? chunks(filter.ids).map((chunk) => inArray(transactions.id, chunk))
      : chunks(filter.amounts.filter((amount) => amount !== 0)).map((chunk) =>
          and(
            inArray(transactions.amount, [...chunk, ...chunk.map((amount) => -amount)]),
            gte(transactions.postedDate, filter.from),
            lte(transactions.postedDate, filter.to),
          ),
        );
  const found: TransferCandidate[] = [];
  for (const where of chosen) {
    const rows = await database
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        amount: transactions.amount,
        postedDate: transactions.postedDate,
        description: transactions.description,
        providerCategory: transactions.providerCategory,
        counterparties: transactions.counterparties,
        handSet: transactions.handSet,
        accountKind: householdAccounts.kind,
        mask: householdAccounts.mask,
        institutionId: householdAccounts.institutionId,
        institutionName: householdAccounts.institutionName,
      })
      .from(transactions)
      .innerJoin(householdAccounts, eq(householdAccounts.id, transactions.accountId))
      .where(
        and(
          where,
          ne(transactions.amount, 0),
          isNull(transactions.hiddenReason),
          eq(transactions.pending, false),
          eq(householdAccounts.excluded, false),
        ),
      );
    found.push(...rows);
  }
  return found;
}

const touching = (ids: string[]) =>
  or(inArray(transferLinks.outTransactionId, ids), inArray(transferLinks.inTransactionId, ids));

// The links that use any of these Transactions.
export async function listTransferLinksOf(
  database: Queries,
  transactionIds: readonly string[],
): Promise<StoredTransferLink[]> {
  const found = new Map<string, StoredTransferLink>();
  for (const chunk of chunks(transactionIds)) {
    for (const link of await database.select().from(transferLinks).where(touching(chunk))) {
      found.set(link.id, link);
    }
  }
  return [...found.values()];
}

// Each link with an Account among these, with both sides' Accounts and posted dates.
export async function listTransferLinkDates(database: Database, accountIds: readonly string[]) {
  const outTxn = aliasedTable(transactions, "out_txn");
  const inTxn = aliasedTable(transactions, "in_txn");
  const found = new Map<
    string,
    {
      id: string;
      outTransactionId: string;
      inTransactionId: string;
      outAccountId: string;
      inAccountId: string;
      outDate: string;
      inDate: string;
    }
  >();
  for (const chunk of chunks(accountIds)) {
    const rows = await database
      .select({
        id: transferLinks.id,
        outTransactionId: transferLinks.outTransactionId,
        inTransactionId: transferLinks.inTransactionId,
        outAccountId: outTxn.accountId,
        inAccountId: inTxn.accountId,
        outDate: outTxn.postedDate,
        inDate: inTxn.postedDate,
      })
      .from(transferLinks)
      .innerJoin(outTxn, eq(outTxn.id, transferLinks.outTransactionId))
      .innerJoin(inTxn, eq(inTxn.id, transferLinks.inTransactionId))
      .where(or(inArray(outTxn.accountId, chunk), inArray(inTxn.accountId, chunk)));
    for (const row of rows) found.set(row.id, row);
  }
  return [...found.values()];
}

// The refused pairs whose money-out side is among these, as "out in" keys.
export async function listRefusedTransferLinks(
  database: Database,
  outTransactionIds: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const chunk of chunks(outTransactionIds)) {
    const rows = await database
      .select()
      .from(refusedTransferLinks)
      .where(inArray(refusedTransferLinks.outTransactionId, chunk));
    for (const row of rows) found.add(`${row.outTransactionId} ${row.inTransactionId}`);
  }
  return found;
}

// Removes, changes, and adds links in one transaction. Removals go first, so a Transaction may
// move from one pair to another.
export async function saveTransferLinks(
  database: Database,
  changes: {
    remove: readonly string[];
    update: readonly { id: string; fields: Partial<NewTransferLink> }[];
    add: readonly NewTransferLink[];
  },
): Promise<void> {
  const { remove, update, add } = changes;
  if (remove.length === 0 && update.length === 0 && add.length === 0) return;
  await database.transaction(async (tx) => {
    for (const chunk of chunks(remove)) {
      await tx.delete(transferLinks).where(inArray(transferLinks.id, chunk));
    }
    for (const { id, fields } of update) {
      await tx.update(transferLinks).set(fields).where(eq(transferLinks.id, id));
    }
    for (const chunk of chunks(add)) {
      await tx
        .insert(transferLinks)
        .values(chunk.map((link) => ({ id: crypto.randomUUID(), ...link })));
    }
  });
}

export type TransferPair = { outTransactionId: string; inTransactionId: string };

const isPair = (pair: TransferPair) =>
  and(
    eq(transferLinks.outTransactionId, pair.outTransactionId),
    eq(transferLinks.inTransactionId, pair.inTransactionId),
  );

// A Member links the pair by hand. It takes the place of any other link either side had. Writes
// only through `database`, so it may run inside a Review list answer's transaction.
export async function linkTransferByHand(
  database: Queries,
  pair: TransferPair,
  by: { memberId: string; at: Date },
): Promise<void> {
  const [existing] = await database.select().from(transferLinks).where(isPair(pair));
  if (existing !== undefined) {
    await database
      .update(transferLinks)
      .set({ madeBy: "Member", memberId: by.memberId, uncertain: false })
      .where(eq(transferLinks.id, existing.id));
    return;
  }
  await database
    .delete(transferLinks)
    .where(touching([pair.outTransactionId, pair.inTransactionId]));
  await database.insert(transferLinks).values({
    id: crypto.randomUUID(),
    ...pair,
    tier: "Unclear",
    signals: [],
    madeBy: "Member",
    memberId: by.memberId,
    createdAt: by.at,
  });
}

// Ends the pair's link, if it has one, and records that the app never makes it again. Writes only
// through `database`.
export async function refuseTransferLink(
  database: Queries,
  pair: TransferPair,
  by: { refusedBy: "AI" | "Member"; memberId?: string; at: Date },
): Promise<void> {
  await database.delete(transferLinks).where(isPair(pair));
  await database
    .insert(refusedTransferLinks)
    .values({ ...pair, refusedBy: by.refusedBy, memberId: by.memberId ?? null, refusedAt: by.at })
    .onConflictDoNothing();
}

// The Transfer link that uses this Transaction, or undefined.
export async function readTransferLink(
  database: Database,
  transactionId: string,
): Promise<StoredTransferLink | undefined> {
  const [link] = await listTransferLinksOf(database, [transactionId]);
  return link;
}

// For the order of decisions: who made the Transfer link that uses the Transaction, or null.
export const transferLinkMaker = sql<TransferLinkMaker | null>`(
  SELECT ${sql.identifier("made_by")} FROM ${transferLinks}
  WHERE ${sql.identifier("out_transaction_id")} = "transactions"."id"
     OR ${sql.identifier("in_transaction_id")} = "transactions"."id"
)`;

// Transactions the order decided as linked Transfers, at steps 2 and 3, whose link has ended since.
export async function listUnlinkedTransferDecisions(database: Database): Promise<string[]> {
  const rows = await database
    .select({ id: transactionDecisions.transactionId })
    .from(transactionDecisions)
    .where(
      and(
        inArray(transactionDecisions.step, ["2", "3"]),
        sql`NOT EXISTS (
          SELECT 1 FROM ${transferLinks}
          WHERE ${sql.identifier("out_transaction_id")} = "transaction_decisions"."transaction_id"
             OR ${sql.identifier("in_transaction_id")} = "transaction_decisions"."transaction_id"
        )`,
      ),
    );
  return rows.map((row) => row.id);
}
