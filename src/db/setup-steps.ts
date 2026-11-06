import { count, getTableName, isNotNull, isNull, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { aiSettings, connections, members, setupSteps } from "./schema.ts";

export type SetupStepStatus = "done" | "skipped";

// Whether app.db holds a Member. An app.db that the app has not yet migrated holds none, so
// `fft setup` can ask before the first start.
export async function hasMember(database: Database): Promise<boolean> {
  const tables = await database.all(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${getTableName(members)}`,
  );
  if (tables.length === 0) return false;
  const [row] = await database.select({ members: count() }).from(members);
  return (row?.members ?? 0) > 0;
}

// Each wizard step that is done or skipped, by its name.
export async function readSetupSteps(database: Database): Promise<Map<string, SetupStepStatus>> {
  const rows = await database.select().from(setupSteps);
  return new Map(rows.map((row) => [row.step, row.status]));
}

export async function markSetupStep(
  database: Database,
  step: string,
  status: SetupStepStatus,
  at = new Date(),
): Promise<void> {
  await database
    .insert(setupSteps)
    .values({ step, status, at })
    .onConflictDoUpdate({ target: setupSteps.step, set: { status, at } });
}

// Marks each step done in one statement, over a skip.
export async function markSetupStepsDone(
  database: Database,
  steps: readonly string[],
  at = new Date(),
): Promise<void> {
  if (steps.length === 0) return;
  await database
    .insert(setupSteps)
    .values(steps.map((step) => ({ step, status: "done" as const, at })))
    .onConflictDoUpdate({
      target: setupSteps.step,
      set: { status: sql`excluded.status`, at: sql`excluded.at` },
    });
}

// Skip on a wizard step. A step already done stays done, and one already skipped keeps its time.
export async function skipSetupStep(
  database: Database,
  step: string,
  at = new Date(),
): Promise<void> {
  await database.insert(setupSteps).values({ step, status: "skipped", at }).onConflictDoNothing();
}

// What app.db holds for the wizard's Banks step and the AI extra (spec 12, The first-run wizard).
export type SetupFacts = {
  // A Connection not removed: what step 5, Banks, adds. An Unconnected account or a Manual loan
  // does not count.
  banks: boolean;
  // An AI provider, set in Settings, AI.
  ai: boolean;
  // The Connections not removed, which the Finish step names.
  connections: number;
};

export async function readSetupFacts(database: Database): Promise<SetupFacts> {
  const [[connected], providers] = await Promise.all([
    database.select({ count: count() }).from(connections).where(isNull(connections.removedAt)),
    database
      .select({ id: aiSettings.id })
      .from(aiSettings)
      .where(isNotNull(aiSettings.provider))
      .limit(1),
  ]);
  const connectionCount = connected?.count ?? 0;
  return {
    banks: connectionCount > 0,
    ai: providers.length > 0,
    connections: connectionCount,
  };
}
