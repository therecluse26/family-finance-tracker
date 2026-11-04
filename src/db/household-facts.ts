import { eq } from "drizzle-orm";
import type { Database } from "./client.ts";
import { householdFacts, setupSteps } from "./schema.ts";

// The Household facts in app.db (spec 05, Household facts). The household module decides; these
// functions store and read.

const FACTS_ROW = 1;

export type StoredHouseholdFacts = Omit<typeof householdFacts.$inferSelect, "id">;

export async function readHouseholdFacts(
  database: Database,
): Promise<StoredHouseholdFacts | undefined> {
  const [row] = await database
    .select()
    .from(householdFacts)
    .where(eq(householdFacts.id, FACTS_ROW));
  if (row === undefined) return undefined;
  const { id: _id, ...facts } = row;
  return facts;
}

// Saves the facts, and marks the wizard's step 4 done in the same transaction (spec 12, The
// first-run wizard).
export async function storeHouseholdFacts(
  database: Database,
  facts: StoredHouseholdFacts,
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx
      .insert(householdFacts)
      .values({ id: FACTS_ROW, ...facts })
      .onConflictDoUpdate({ target: householdFacts.id, set: facts });
    await tx
      .insert(setupSteps)
      .values({ step: "household facts", status: "done", at: facts.updatedAt })
      .onConflictDoNothing();
  });
}
