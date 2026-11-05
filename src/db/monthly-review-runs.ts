import { and, asc, eq, isNull } from "drizzle-orm";
import type { Database } from "./client.ts";
import { connections, monthlyReviewRuns, proposals } from "./schema.ts";

// The Monthly review's runs in app.db (spec 08, Monthly review; Failures). The monthly-review
// module decides when a run tries, and when it ends; these functions store and read.

export type StoredMonthlyReviewRun = typeof monthlyReviewRuns.$inferSelect;

// The review of `month` is due. A month that has a run keeps it, so a second start changes nothing.
export async function markMonthlyReviewDue(
  database: Database,
  month: string,
  at: Date,
): Promise<void> {
  await database.insert(monthlyReviewRuns).values({ month, dueAt: at }).onConflictDoNothing();
}

// The runs that have not ended, oldest month first.
export function listOpenMonthlyReviewRuns(database: Database): Promise<StoredMonthlyReviewRun[]> {
  return database
    .select()
    .from(monthlyReviewRuns)
    .where(isNull(monthlyReviewRuns.endedAt))
    .orderBy(asc(monthlyReviewRuns.month));
}

export async function readMonthlyReviewRun(
  database: Database,
  month: string,
): Promise<StoredMonthlyReviewRun | undefined> {
  const [row] = await database
    .select()
    .from(monthlyReviewRuns)
    .where(eq(monthlyReviewRuns.month, month));
  return row;
}

// The run makes no try before `retryAt`.
export async function storeMonthlyReviewRetry(
  database: Database,
  month: string,
  retryAt: Date,
): Promise<void> {
  await database
    .update(monthlyReviewRuns)
    .set({ retryAt })
    .where(and(eq(monthlyReviewRuns.month, month), isNull(monthlyReviewRuns.endedAt)));
}

// Keeps the Writer's reply. A run that has one keeps it. True when it stored this one.
export async function storeMonthlyReviewReply(
  database: Database,
  month: string,
  reply: Record<string, unknown>,
): Promise<boolean> {
  const result = await database
    .update(monthlyReviewRuns)
    .set({ reply, retryAt: null })
    .where(and(eq(monthlyReviewRuns.month, month), isNull(monthlyReviewRuns.reply)));
  return result.rowsAffected === 1;
}

export async function markMonthlyReviewProposed(
  database: Database,
  month: string,
  at: Date,
): Promise<void> {
  await database
    .update(monthlyReviewRuns)
    .set({ proposedAt: at })
    .where(eq(monthlyReviewRuns.month, month));
}

// Ends the run. A run that has ended keeps its outcome. True when it ended this one.
export async function endMonthlyReviewRun(
  database: Database,
  month: string,
  outcome: NonNullable<StoredMonthlyReviewRun["outcome"]>,
  at: Date,
): Promise<boolean> {
  const result = await database
    .update(monthlyReviewRuns)
    .set({ outcome, endedAt: at, retryAt: null })
    .where(and(eq(monthlyReviewRuns.month, month), isNull(monthlyReviewRuns.endedAt)));
  return result.rowsAffected === 1;
}

// Each Healthy Connection's last successful sync, or null before its first. A removed Connection
// and a held one never sync, so neither is listed.
export async function listHealthyConnectionSyncs(
  database: Database,
): Promise<{ id: string; lastSyncedAt: Date | null }[]> {
  return database
    .select({ id: connections.id, lastSyncedAt: connections.lastSyncedAt })
    .from(connections)
    .where(
      and(
        eq(connections.health, "healthy"),
        isNull(connections.removedAt),
        eq(connections.syncHeld, false),
      ),
    );
}

// The reasons of the Proposals the review of `month` has made, in any status. A look that failed
// between two Proposals made the first: the next look matches it by its reason and skips it.
export async function listMonthlyReviewProposalReasons(
  database: Database,
  month: string,
): Promise<string[]> {
  const rows = await database
    .select({ reason: proposals.reason })
    .from(proposals)
    .where(and(eq(proposals.source, "Monthly review"), eq(proposals.runId, month)));
  return rows.map((row) => row.reason);
}
