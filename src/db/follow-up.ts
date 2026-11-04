import { and, asc, eq, gt, inArray, isNull, lte, max } from "drizzle-orm";
import type { Database, Queries } from "./client.ts";
import { followUpChanges, followUpMarks, transactions } from "./schema.ts";

// Each follow-up step's handled marks (spec 10, The follow-up pipeline). The follow-up module
// decides; these functions store and read.

// SQLite takes at most 32,766 values in one statement. Each mark has 3.
const MARKS_PER_INSERT = 1000;

// The IDs of every Transaction the step has not handled, hidden ones included, oldest first.
export async function listUnhandledTransactions(
  database: Database,
  step: string,
): Promise<string[]> {
  const rows = await database
    .select({ id: transactions.id })
    .from(transactions)
    .leftJoin(
      followUpMarks,
      and(eq(followUpMarks.transactionId, transactions.id), eq(followUpMarks.step, step)),
    )
    .where(isNull(followUpMarks.step))
    .orderBy(asc(transactions.postedDate), asc(transactions.id));
  return rows.map((row) => row.id);
}

// The number of the last change a Member's answer or edit made, or 0. A step reads it as it
// begins.
export async function readLastFollowUpChange(database: Database): Promise<number> {
  const [row] = await database.select({ last: max(followUpChanges.seq) }).from(followUpChanges);
  return row?.last ?? 0;
}

// Marks the Transactions handled for the step. With `changedAfter`, the number the step read as it
// began, a Transaction that a Member's change made unhandled since then stays unhandled, so the
// next job handles it again. The changes up to that number are then dropped.
export async function markTransactionsHandled(
  database: Database,
  step: string,
  transactionIds: readonly string[],
  at: Date,
  changedAfter?: number,
): Promise<void> {
  let marked = transactionIds;
  if (changedAfter !== undefined) {
    const changed = new Set(
      (
        await database
          .select({ id: followUpChanges.transactionId })
          .from(followUpChanges)
          .where(gt(followUpChanges.seq, changedAfter))
      ).map((row) => row.id),
    );
    if (changed.size > 0) marked = transactionIds.filter((id) => !changed.has(id));
  }
  for (let start = 0; start < marked.length; start += MARKS_PER_INSERT) {
    const chunk = marked.slice(start, start + MARKS_PER_INSERT);
    await database
      .insert(followUpMarks)
      .values(chunk.map((transactionId) => ({ step, transactionId, handledAt: at })))
      .onConflictDoNothing();
  }
  if (changedAfter !== undefined) {
    await database.delete(followUpChanges).where(lte(followUpChanges.seq, changedAfter));
  }
}

// Makes these Transactions unhandled for every step again, as a sync that changes them does, and
// records the change, so a step already running leaves them unhandled. Writes only through
// `database`, so it may run inside a Review list answer's transaction.
export async function markTransactionsUnhandled(
  database: Queries,
  transactionIds: readonly string[],
): Promise<void> {
  for (let start = 0; start < transactionIds.length; start += MARKS_PER_INSERT) {
    const chunk = transactionIds.slice(start, start + MARKS_PER_INSERT);
    await database.delete(followUpMarks).where(inArray(followUpMarks.transactionId, chunk));
    await database
      .insert(followUpChanges)
      .values(chunk.map((transactionId) => ({ transactionId })));
  }
}
