import { and, eq, isNull, lte } from "drizzle-orm";
import type { AiUseName } from "./ai-usage.ts";
import type { Database } from "./client.ts";
import { aiRetries } from "./schema.ts";

// The AI retry of each background AI use in app.db (spec 08, Failures). The ai module decides when
// a use tries again; these functions store and read.

export type StoredAiRetry = typeof aiRetries.$inferSelect;

export async function readAiRetry(
  database: Database,
  use: AiUseName,
): Promise<StoredAiRetry | undefined> {
  const [row] = await database.select().from(aiRetries).where(eq(aiRetries.use, use));
  return row;
}

// One more failed call: the use waits until `retryAt`, and the AI retry job has not asked for it.
export async function storeAiFailure(
  database: Database,
  use: AiUseName,
  failures: number,
  retryAt: Date,
): Promise<void> {
  const row = { use, failures, retryAt, askedAt: null };
  await database
    .insert(aiRetries)
    .values(row)
    .onConflictDoUpdate({ target: aiRetries.use, set: row });
}

// The use's call worked, or it took its no-AI path: it waits for no retry.
export async function clearAiRetry(database: Database, use: AiUseName): Promise<void> {
  await database.delete(aiRetries).where(eq(aiRetries.use, use));
}

// The retries due at `now` that the AI retry job has not asked for yet.
export function listDueAiRetries(database: Database, now: Date): Promise<StoredAiRetry[]> {
  return database
    .select()
    .from(aiRetries)
    .where(and(lte(aiRetries.retryAt, now), isNull(aiRetries.askedAt)));
}

// Notes that the AI retry job asked for the use's work at this retry time. A failure since then
// moved retry_at, and its retry is asked for at its own time. True when it noted it.
export async function markAiRetryAsked(
  database: Database,
  use: AiUseName,
  retryAt: Date,
  at: Date,
): Promise<boolean> {
  const result = await database
    .update(aiRetries)
    .set({ askedAt: at })
    .where(and(eq(aiRetries.use, use), eq(aiRetries.retryAt, retryAt), isNull(aiRetries.askedAt)));
  return result.rowsAffected === 1;
}
