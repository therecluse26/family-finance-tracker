import { eq } from "drizzle-orm";
import type { Database } from "./client.ts";
import { updateCheck } from "./schema.ts";

// The daily Update check's switch and its last result (spec 12, Updates). The updates module
// decides; these functions store and read.

const CHECK_ROW = 1;

export type UpdateCheckState = Omit<typeof updateCheck.$inferSelect, "id">;

const NEVER_CHECKED: UpdateCheckState = {
  enabled: true,
  checkedAt: null,
  latestVersion: null,
  latestTag: null,
  lastFailure: null,
};

export async function readUpdateCheck(database: Database): Promise<UpdateCheckState> {
  const [row] = await database.select().from(updateCheck).where(eq(updateCheck.id, CHECK_ROW));
  if (row === undefined) return NEVER_CHECKED;
  const { id: _id, ...state } = row;
  return state;
}

// Turns the check on or off.
export async function storeUpdateCheckEnabled(database: Database, enabled: boolean) {
  await database
    .insert(updateCheck)
    .values({ id: CHECK_ROW, enabled })
    .onConflictDoUpdate({ target: updateCheck.id, set: { enabled } });
}

// Stores a check GitHub answered: the latest release's version and tag, or none.
export async function storeUpdateChecked(
  database: Database,
  latest: { version: string; tag: string } | null,
  at: Date,
): Promise<void> {
  const checked = {
    checkedAt: at,
    latestVersion: latest?.version ?? null,
    latestTag: latest?.tag ?? null,
    lastFailure: null,
  };
  await database
    .insert(updateCheck)
    .values({ id: CHECK_ROW, ...checked })
    .onConflictDoUpdate({ target: updateCheck.id, set: checked });
}

// Stores why a check failed. The last answered check stays.
export async function storeUpdateFailure(database: Database, failure: string): Promise<void> {
  await database
    .insert(updateCheck)
    .values({ id: CHECK_ROW, lastFailure: failure })
    .onConflictDoUpdate({ target: updateCheck.id, set: { lastFailure: failure } });
}
