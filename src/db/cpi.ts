import { desc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { cpiFetch, cpiValues } from "./schema.ts";

// The fetched CPI values and the monthly fetch's state (spec 05, CPI). The benchmarks module
// decides; these functions store and read.

const FETCH_ROW = 1;

export type CpiSeries = (typeof cpiValues.$inferSelect)["series"];
export type FetchedCpi = { series: CpiSeries; month: string; value: number };

export type CpiFetchState = {
  fetchedAt: Date | null;
  fetchedRound: string | null;
  failedRound: string | null;
  failedTries: number;
  lastFailure: string | null;
};

const NO_FETCH: CpiFetchState = {
  fetchedAt: null,
  fetchedRound: null,
  failedRound: null,
  failedTries: 0,
  lastFailure: null,
};

export async function readCpiFetch(database: Database): Promise<CpiFetchState> {
  const [row] = await database.select().from(cpiFetch).where(eq(cpiFetch.id, FETCH_ROW));
  if (row === undefined) return NO_FETCH;
  const { id: _id, ...state } = row;
  return state;
}

// Stores the values a fetch brought, in one statement. A value BLS revised replaces the stored one.
export async function storeCpiValues(
  database: Database,
  values: readonly FetchedCpi[],
  at: Date,
): Promise<void> {
  if (values.length === 0) return;
  await database
    .insert(cpiValues)
    .values(values.map((value) => ({ ...value, fetchedAt: at })))
    .onConflictDoUpdate({
      target: [cpiValues.series, cpiValues.month],
      set: { value: sql`excluded.value`, fetchedAt: sql`excluded.fetched_at` },
    });
}

// Marks the round fetched at `at`, which ends its failed tries.
export async function markCpiFetched(database: Database, round: string, at: Date): Promise<void> {
  const done = { fetchedAt: at, fetchedRound: round, failedRound: null, failedTries: 0 };
  await database
    .insert(cpiFetch)
    .values({ id: FETCH_ROW, ...done, lastFailure: null })
    .onConflictDoUpdate({ target: cpiFetch.id, set: { ...done, lastFailure: null } });
}

// Counts a failed try in the round, and returns the round's failed tries so far. A failure in a new
// round starts the count again.
export async function markCpiFailed(
  database: Database,
  round: string,
  failure: string,
): Promise<number> {
  const tries = sql`case when ${cpiFetch.failedRound} = ${round} then ${cpiFetch.failedTries} + 1 else 1 end`;
  const [row] = await database
    .insert(cpiFetch)
    .values({ id: FETCH_ROW, failedRound: round, failedTries: 1, lastFailure: failure })
    .onConflictDoUpdate({
      target: cpiFetch.id,
      set: { failedTries: tries, failedRound: round, lastFailure: failure },
    })
    .returning({ failedTries: cpiFetch.failedTries });
  return row?.failedTries ?? 1;
}

// The newest fetched value of a series, or undefined before any fetch stored one.
export async function readNewestCpi(
  database: Database,
  series: CpiSeries,
): Promise<FetchedCpi | undefined> {
  const [row] = await database
    .select({ series: cpiValues.series, month: cpiValues.month, value: cpiValues.value })
    .from(cpiValues)
    .where(eq(cpiValues.series, series))
    .orderBy(desc(cpiValues.month))
    .limit(1);
  return row;
}
