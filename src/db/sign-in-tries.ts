import { and, count, eq, gt, inArray, lte } from "drizzle-orm";
import type { Database } from "./client.ts";
import { signInTries } from "./schema.ts";

// Adds one try under each key, and returns each new row's key and ID.
export async function addSignInTries(
  database: Database,
  keys: string[],
  at: Date,
): Promise<{ key: string; id: number }[]> {
  if (keys.length === 0) return [];
  return database
    .insert(signInTries)
    .values(keys.map((key) => ({ key, at })))
    .returning({ key: signInTries.key, id: signInTries.id });
}

// The tries under this key after `since`, up to and including the try with ID `upTo`. Tries
// added later are left out, so of many tries at the same time, the first ones still count low.
export async function countSignInTries(
  database: Database,
  key: string,
  since: Date,
  upTo: number,
): Promise<number> {
  const [row] = await database
    .select({ tries: count() })
    .from(signInTries)
    .where(and(eq(signInTries.key, key), gt(signInTries.at, since), lte(signInTries.id, upTo)));
  return row?.tries ?? 0;
}

export async function removeSignInTries(database: Database, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await database.delete(signInTries).where(inArray(signInTries.id, ids));
}

// Deletes the tries at or before `before`, which no longer count.
export async function removeSignInTriesUpTo(database: Database, before: Date): Promise<void> {
  await database.delete(signInTries).where(lte(signInTries.at, before));
}
