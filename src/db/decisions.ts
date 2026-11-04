import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { transactionDecisions, transactionParts, transactions } from "./schema.ts";

// Each Transaction's type and parts (spec 03, Order of decisions). The money-movement module
// decides; these functions store and read.

// SQLite takes at most 32,766 values in one statement.
const IDS_PER_QUERY = 500;

export type StoredPart = typeof transactionParts.$inferSelect;
export type PartType = StoredPart["type"];

export type StoredDecision = {
  transactionId: string;
  step: string;
  provisionalUntil: string | null;
  decidedAt: Date;
  parts: { type: PartType; amount: number; category: string | null }[];
};

// What the order of decisions reads of a Transaction.
export type DecisionRecord = {
  id: string;
  accountId: string;
  amount: number;
  postedDate: string;
  authorizedDate: string | null;
  pending: boolean;
  description: string;
  merchantName: string | null;
  merchantCleanName: string | null;
  providerCategory: string | null;
  handSet: Record<string, unknown>;
  hidden: boolean;
  // Whether Matching has decided it, and the sum of its parts when it has.
  decided: boolean;
  decidedAmount: number | null;
};

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += IDS_PER_QUERY) {
    out.push(items.slice(start, start + IDS_PER_QUERY));
  }
  return out;
}

// The Transactions with these IDs, in the order given. An unknown ID is left out.
export async function readDecisionRecords(
  database: Database,
  ids: readonly string[],
): Promise<DecisionRecord[]> {
  const found = new Map<string, DecisionRecord>();
  for (const chunk of chunks(ids)) {
    const rows = await database
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        amount: transactions.amount,
        postedDate: transactions.postedDate,
        authorizedDate: transactions.authorizedDate,
        pending: transactions.pending,
        description: transactions.description,
        merchantName: transactions.merchantName,
        merchantCleanName: transactions.merchantCleanName,
        providerCategory: transactions.providerCategory,
        handSet: transactions.handSet,
        hiddenReason: transactions.hiddenReason,
        decidedAt: transactionDecisions.decidedAt,
        decidedAmount: sql<number | null>`(
          SELECT sum(${transactionParts.amount}) FROM ${transactionParts}
          WHERE ${transactionParts.transactionId} = ${transactions.id}
        )`,
      })
      .from(transactions)
      .leftJoin(transactionDecisions, eq(transactionDecisions.transactionId, transactions.id))
      .where(inArray(transactions.id, chunk));
    for (const { hiddenReason, decidedAt, ...row } of rows) {
      found.set(row.id, { ...row, hidden: hiddenReason !== null, decided: decidedAt !== null });
    }
  }
  return ids.flatMap((id) => found.get(id) ?? []);
}

// Saves each decision in place of the Transaction's earlier one.
export async function storeDecisions(
  database: Database,
  decisions: readonly StoredDecision[],
): Promise<void> {
  if (decisions.length === 0) return;
  await database.transaction(async (tx) => {
    for (const chunk of chunks(decisions)) {
      const ids = chunk.map((decision) => decision.transactionId);
      await tx.delete(transactionDecisions).where(inArray(transactionDecisions.transactionId, ids));
      await tx.insert(transactionDecisions).values(chunk.map(({ parts, ...decision }) => decision));
      const parts = chunk.flatMap((decision) =>
        decision.parts.map((part, index) => ({
          transactionId: decision.transactionId,
          part: index,
          ...part,
        })),
      );
      if (parts.length > 0) await tx.insert(transactionParts).values(parts);
    }
  });
}

export async function removeDecisions(database: Database, ids: readonly string[]): Promise<void> {
  for (const chunk of chunks(ids)) {
    await database
      .delete(transactionDecisions)
      .where(inArray(transactionDecisions.transactionId, chunk));
  }
}

export async function readDecision(
  database: Database,
  transactionId: string,
): Promise<StoredDecision | undefined> {
  const [decision] = await database
    .select()
    .from(transactionDecisions)
    .where(eq(transactionDecisions.transactionId, transactionId));
  if (decision === undefined) return undefined;
  const parts = await database
    .select({
      type: transactionParts.type,
      amount: transactionParts.amount,
      category: transactionParts.category,
    })
    .from(transactionParts)
    .where(eq(transactionParts.transactionId, transactionId))
    .orderBy(asc(transactionParts.part));
  return { ...decision, parts };
}

// The Transactions whose provisional result ended before `today`, oldest first.
export async function listProvisionalPassed(database: Database, today: string): Promise<string[]> {
  const rows = await database
    .select({ id: transactionDecisions.transactionId })
    .from(transactionDecisions)
    .innerJoin(transactions, eq(transactions.id, transactionDecisions.transactionId))
    .where(lt(transactionDecisions.provisionalUntil, today))
    .orderBy(asc(transactions.postedDate), asc(transactions.id));
  return rows.map((row) => row.id);
}

// Every part of every posted Transaction that is not hidden, with the dates its month comes from.
export async function listPostedParts(database: Database) {
  return database
    .select({
      type: transactionParts.type,
      amount: transactionParts.amount,
      category: transactionParts.category,
      postedDate: transactions.postedDate,
      authorizedDate: transactions.authorizedDate,
    })
    .from(transactionParts)
    .innerJoin(transactions, eq(transactions.id, transactionParts.transactionId))
    .where(and(eq(transactions.pending, false), isNull(transactions.hiddenReason)));
}
