import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { budgetTailoringRuns, goals } from "./schema.ts";

// Budget tailoring runs in app.db (spec 05, Which Proposals exist). The tailoring module decides
// when a run is due and what it makes; these functions store and read.

export type StoredTailoringRun = typeof budgetTailoringRuns.$inferSelect;

export type TailoringRunRequest = { kind: "Tailoring" } | { kind: "Goal"; goalId: string };

// Stores a run that waits for its AI call. The Tailoring run is stored once ever: never again once
// one waits or ended. A Goal run is stored once per waiting Goal, and only for a Goal app.db has.
// True when this call stored it.
export async function requestTailoringRun(
  database: Database,
  run: TailoringRunRequest,
  at: Date,
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const goalId = run.kind === "Goal" ? run.goalId : null;
    if (goalId !== null) {
      const [goal] = await tx.select({ id: goals.id }).from(goals).where(eq(goals.id, goalId));
      if (goal === undefined) return false;
    }
    const [found] = await tx
      .select({ id: budgetTailoringRuns.id })
      .from(budgetTailoringRuns)
      .where(
        goalId === null
          ? eq(budgetTailoringRuns.kind, "Tailoring")
          : and(
              eq(budgetTailoringRuns.kind, "Goal"),
              eq(budgetTailoringRuns.goalId, goalId),
              isNull(budgetTailoringRuns.endedAt),
            ),
      );
    if (found !== undefined) return false;
    // The unique index holds the Tailoring run to one row.
    const stored = await tx
      .insert(budgetTailoringRuns)
      .values({ kind: run.kind, goalId, requestedAt: at })
      .onConflictDoNothing()
      .returning({ id: budgetTailoringRuns.id });
    return stored.length > 0;
  });
}

// The runs that wait for their AI call, oldest first.
export function listWaitingTailoringRuns(database: Database): Promise<StoredTailoringRun[]> {
  return database
    .select()
    .from(budgetTailoringRuns)
    .where(isNull(budgetTailoringRuns.endedAt))
    .orderBy(asc(budgetTailoringRuns.id));
}

// The run's AI call answered: a Goal run is deleted, and the Tailoring run is kept as ended, so it
// never runs again.
export async function endTailoringRun(database: Database, id: number, at: Date): Promise<void> {
  await database
    .delete(budgetTailoringRuns)
    .where(and(eq(budgetTailoringRuns.id, id), eq(budgetTailoringRuns.kind, "Goal")));
  await database
    .update(budgetTailoringRuns)
    .set({ endedAt: at })
    .where(and(eq(budgetTailoringRuns.id, id), eq(budgetTailoringRuns.kind, "Tailoring")));
}

// The run took its no-AI path: it is deleted, so a later AI provider can ask for a Tailoring run
// again.
export async function dropTailoringRun(database: Database, id: number): Promise<void> {
  await database.delete(budgetTailoringRuns).where(eq(budgetTailoringRuns.id, id));
}

// One more run of this one that threw. Returns its count of failed tries.
export async function countTailoringRunFailure(database: Database, id: number): Promise<number> {
  const [row] = await database
    .update(budgetTailoringRuns)
    .set({ failedTries: sql`${budgetTailoringRuns.failedTries} + 1` })
    .where(eq(budgetTailoringRuns.id, id))
    .returning({ failedTries: budgetTailoringRuns.failedTries });
  return row?.failedTries ?? 0;
}
