import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "./client.ts";
import { followUpMarks, transactions } from "./schema.ts";

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

export async function markTransactionsHandled(
  database: Database,
  step: string,
  transactionIds: readonly string[],
  at: Date,
): Promise<void> {
  for (let start = 0; start < transactionIds.length; start += MARKS_PER_INSERT) {
    const chunk = transactionIds.slice(start, start + MARKS_PER_INSERT);
    await database
      .insert(followUpMarks)
      .values(chunk.map((transactionId) => ({ step, transactionId, handledAt: at })))
      .onConflictDoNothing();
  }
}
