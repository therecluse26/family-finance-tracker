import { and, asc, eq, exists, inArray, isNotNull, isNull, type SQL, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { aiRedo, transactionParts, transactions } from "./schema.ts";

// The first AI run and the redo of no-AI work in app.db (spec 08, Runs that reuse these uses;
// Redo of no-AI work). The redo module decides; these functions store and read. Each claim is one
// conditional update, so it succeeds once.

const AI_REDO_ROW = 1;

// SQLite takes at most 32,766 values in one statement.
const IDS_PER_QUERY = 500;

export type AiAwayReason = "pause" | "outage";

export type AiRedoState = {
  awayAt: Date | null;
  awayReason: AiAwayReason | null;
  dueAt: Date | null;
  failures: number;
  firstRunDoneAt: Date | null;
};

export async function readAiRedo(database: Database): Promise<AiRedoState> {
  const [row] = await database
    .select({
      awayAt: aiRedo.awayAt,
      awayReason: aiRedo.awayReason,
      dueAt: aiRedo.dueAt,
      failures: aiRedo.failures,
      firstRunDoneAt: aiRedo.firstRunDoneAt,
    })
    .from(aiRedo)
    .where(eq(aiRedo.id, AI_REDO_ROW));
  return row ?? { awayAt: null, awayReason: null, dueAt: null, failures: 0, firstRunDoneAt: null };
}

// A background AI use found AI away at `at`. The first time since AI came back sets awayAt; the
// latest reason wins.
export async function markAiAway(
  database: Database,
  reason: AiAwayReason,
  at: Date,
): Promise<void> {
  await database
    .insert(aiRedo)
    .values({ id: AI_REDO_ROW, awayAt: at, awayReason: reason })
    .onConflictDoUpdate({
      target: aiRedo.id,
      set: { awayAt: sql`coalesce(${aiRedo.awayAt}, excluded.away_at)`, awayReason: reason },
    });
}

// AI came back at `at`: ends the away mark and makes a redo due. With `reason`, only AI away for
// that reason comes back. True only for the call that ended it, which then starts the redo.
export async function claimAiBack(
  database: Database,
  at: Date,
  reason?: AiAwayReason,
): Promise<boolean> {
  const claimed = await database
    .update(aiRedo)
    .set({ awayAt: null, awayReason: null, dueAt: at })
    .where(
      and(
        eq(aiRedo.id, AI_REDO_ROW),
        isNotNull(aiRedo.awayAt),
        reason === undefined ? undefined : eq(aiRedo.awayReason, reason),
      ),
    )
    .returning({ id: aiRedo.id });
  return claimed.length === 1;
}

// A redo starts with AI on: AI is not away. A call that finds AI away during the redo marks it
// again.
export async function clearAiAway(database: Database): Promise<void> {
  await database
    .update(aiRedo)
    .set({ awayAt: null, awayReason: null })
    .where(eq(aiRedo.id, AI_REDO_ROW));
}

// The redo that AI's return at `dueAt` started has finished, or stopped: it is no longer due, and
// its failures count from 0. A later return of AI, with its own time, stays due.
export async function endAiRedo(database: Database, dueAt: Date | null): Promise<void> {
  await database
    .update(aiRedo)
    .set(dueAt === null ? { failures: 0 } : { dueAt: null, failures: 0 })
    .where(and(eq(aiRedo.id, AI_REDO_ROW), dueAt === null ? undefined : eq(aiRedo.dueAt, dueAt)));
}

// One more failed redo. Returns how many failed in a row.
export async function countAiRedoFailure(database: Database): Promise<number> {
  await database.insert(aiRedo).values({ id: AI_REDO_ROW }).onConflictDoNothing();
  const [row] = await database
    .update(aiRedo)
    .set({ failures: sql`${aiRedo.failures} + 1` })
    .where(eq(aiRedo.id, AI_REDO_ROW))
    .returning({ failures: aiRedo.failures });
  return row?.failures ?? 1;
}

// Records that the first AI run finished. True only for the call that recorded it.
export async function claimFirstAiRunDone(database: Database, at: Date): Promise<boolean> {
  await database.insert(aiRedo).values({ id: AI_REDO_ROW }).onConflictDoNothing();
  const claimed = await database
    .update(aiRedo)
    .set({ firstRunDoneAt: at })
    .where(and(eq(aiRedo.id, AI_REDO_ROW), isNull(aiRedo.firstRunDoneAt)))
    .returning({ id: aiRedo.id });
  return claimed.length === 1;
}

// The shown Transactions whose clean name is still the rule-cleaned one, marked for AI cleanup,
// oldest first. One read.
export async function listMarkedNameIds(database: Database): Promise<string[]> {
  const rows = await database
    .select({ id: transactions.id })
    .from(transactions)
    .where(and(eq(transactions.merchantNeedsAi, true), isNull(transactions.hiddenReason)))
    .orderBy(asc(transactions.postedDate), asc(transactions.id));
  return rows.map((row) => row.id);
}

// The shown Transactions with a part whose Category is a best guess marked for the redo, and the
// shown Transactions among `also`, oldest first, each once. One read, and one more for each 500 of
// `also`.
export async function listBestGuessIds(
  database: Database,
  also: readonly string[] = [],
): Promise<string[]> {
  const marked = exists(
    database
      .select({ one: sql`1` })
      .from(transactionParts)
      .where(
        and(
          eq(transactionParts.transactionId, transactions.id),
          eq(transactionParts.categoryNeedsAi, true),
        ),
      ),
  );
  const found = new Map<string, string>();
  const read = async (where: SQL) => {
    const rows = await database
      .select({ id: transactions.id, postedDate: transactions.postedDate })
      .from(transactions)
      .where(and(where, isNull(transactions.hiddenReason)));
    for (const row of rows) found.set(row.id, row.postedDate);
  };
  await read(marked);
  const extra = [...new Set(also)];
  for (let start = 0; start < extra.length; start += IDS_PER_QUERY) {
    await read(inArray(transactions.id, extra.slice(start, start + IDS_PER_QUERY)));
  }
  return [...found]
    .sort(([a, aDate], [b, bDate]) => aDate.localeCompare(bDate) || a.localeCompare(b))
    .map(([id]) => id);
}
