import { count, getTableName, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { members, setupSteps } from "./schema.ts";

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
