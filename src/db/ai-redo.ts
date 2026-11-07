import {
  and,
  asc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Database } from "./client.ts";
import { aiRedo, reviewItems, transactionParts, transactions } from "./schema.ts";

// The first AI run and the redo of no-AI work in app.db (spec 08, Runs that reuse these uses;
// Redo of no-AI work). The redo module decides; these functions store and read. Each claim is one
// conditional update, so it succeeds once.

const AI_REDO_ROW = 1;

// SQLite takes at most 32,766 values in one statement.
const IDS_PER_QUERY = 500;

export type AiAwayReason = "pause" | "outage";

// The last redo that ended: when, how many marked items it decided, how many Transactions'
// Categories the AI answered, and whether it finished or stopped (spec 08, AI work on your
// Transactions).
export type AiRedoRun = {
  at: Date;
  items: number;
  aiCategories: number;
  outcome: "finished" | "stopped";
};

export type AiRedoState = {
  awayAt: Date | null;
  awayReason: AiAwayReason | null;
  dueAt: Date | null;
  failures: number;
  firstRunDoneAt: Date | null;
  lastRun: AiRedoRun | null;
};

export async function readAiRedo(database: Database): Promise<AiRedoState> {
  const [row] = await database
    .select({
      awayAt: aiRedo.awayAt,
      awayReason: aiRedo.awayReason,
      dueAt: aiRedo.dueAt,
      failures: aiRedo.failures,
      firstRunDoneAt: aiRedo.firstRunDoneAt,
      lastRunAt: aiRedo.lastRunAt,
      lastRunItems: aiRedo.lastRunItems,
      lastRunAiCategories: aiRedo.lastRunAiCategories,
      lastRunOutcome: aiRedo.lastRunOutcome,
    })
    .from(aiRedo)
    .where(eq(aiRedo.id, AI_REDO_ROW));
  if (row === undefined) {
    return {
      awayAt: null,
      awayReason: null,
      dueAt: null,
      failures: 0,
      firstRunDoneAt: null,
      lastRun: null,
    };
  }
  const { lastRunAt, lastRunItems, lastRunAiCategories, lastRunOutcome, ...state } = row;
  return {
    ...state,
    lastRun:
      lastRunAt === null || lastRunOutcome === null
        ? null
        : {
            at: lastRunAt,
            items: lastRunItems,
            aiCategories: lastRunAiCategories,
            outcome: lastRunOutcome,
          },
  };
}

// Records the redo that just ended, in place of the one before.
export async function recordAiRedoRun(database: Database, run: AiRedoRun): Promise<void> {
  const last = {
    lastRunAt: run.at,
    lastRunItems: run.items,
    lastRunAiCategories: run.aiCategories,
    lastRunOutcome: run.outcome,
  };
  await database
    .insert(aiRedo)
    .values({ id: AI_REDO_ROW, ...last })
    .onConflictDoUpdate({ target: aiRedo.id, set: last });
}

// The marked items that wait for the AI: each shown Transaction with a marked Merchant name, each
// shown Transaction with a marked Category, and each open marked Review list item. One read.
export async function countMarkedItems(database: Database): Promise<number> {
  const result = await database.get<{ n: number }>(sql`SELECT
      (SELECT count(*) FROM ${transactions}
        WHERE ${transactions.merchantNeedsAi} = 1 AND ${transactions.hiddenReason} IS NULL)
    + (SELECT count(DISTINCT ${transactionParts.transactionId}) FROM ${transactionParts}
        JOIN ${transactions} ON ${transactions.id} = ${transactionParts.transactionId}
        WHERE ${transactionParts.categoryNeedsAi} = 1 AND ${transactions.hiddenReason} IS NULL)
    + (SELECT count(*) FROM ${reviewItems}
        WHERE ${reviewItems.needsAi} = 1 AND ${reviewItems.closedAt} IS NULL) AS n`);
  return Number(result?.n ?? 0);
}

// "Run AI on all history" (spec 08, AI work on your Transactions): marks the Category of each part
// the cascade covers, Spending and a Refund with no link, on the shown Transactions posted on or
// after `since`, a calendar date, when the provider, Merchant history, the AI, or a best guess
// chose it. A hand-set Category, a Category rule, a Category Money movement names, and a part of a
// tracked loan payment stay unmarked. The redo then asks the AI about each marked part that is not
// a best guess at step 5, past steps 3 and 4. One statement. Returns how many parts it marked.
export async function markCategoriesForAi(database: Database, since: string): Promise<number> {
  const marked = await database
    .update(transactionParts)
    .set({ categoryNeedsAi: true })
    .where(
      and(
        inArray(transactionParts.categorySource, [
          "provider",
          "Merchant history",
          "AI",
          "best guess",
        ]),
        or(
          eq(transactionParts.type, "Spending"),
          and(eq(transactionParts.type, "Refund"), eq(transactionParts.linked, false)),
        ),
        // A part of a tracked loan payment keeps its Category: only a hand edit changes it.
        eq(transactionParts.keepsCategory, false),
        inArray(
          transactionParts.transactionId,
          database
            .select({ id: transactions.id })
            .from(transactions)
            .where(and(gte(transactions.postedDate, since), isNull(transactions.hiddenReason))),
        ),
      ),
    )
    .returning({ transactionId: transactionParts.transactionId });
  return marked.length;
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
