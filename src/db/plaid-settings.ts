import { and, eq, lte, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { plaidSettings } from "./schema.ts";

// The Plaid keys and the count of Plaid Items in app.db (spec 02). The bank module decides and
// encrypts; these functions store and read.

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

// The ID of plaid_settings' one row. The Plaid secret's ciphertext is bound to it.
export const PLAID_SETTINGS_ROW = 1;

export type StoredPlaidSettings = {
  clientId: string | null;
  // The secret's ciphertext, as the secrets module made it.
  secret: string | null;
  appItems: number;
  // Items spent outside the app.
  outsideItems: number;
};

export async function readPlaidSettings(database: Database): Promise<StoredPlaidSettings> {
  const [row] = await database
    .select()
    .from(plaidSettings)
    .where(eq(plaidSettings.id, PLAID_SETTINGS_ROW));
  return {
    clientId: row?.clientId ?? null,
    secret: row?.secret ?? null,
    appItems: row?.appItems ?? 0,
    outsideItems: row?.outsideItems ?? 0,
  };
}

// Replaces the client ID and the secret together. `secret` is the ciphertext.
export async function storePlaidKeys(
  database: Database,
  keys: { clientId: string; secret: string },
): Promise<void> {
  await database
    .insert(plaidSettings)
    .values({ id: PLAID_SETTINGS_ROW, ...keys })
    .onConflictDoUpdate({ target: plaidSettings.id, set: keys });
}

// Sets N to `itemsUsed` by storing the Items spent outside the app: N minus the app's own count.
// The check and the change are one statement, so N never falls below the app's count, even when a
// Connection is added at the same time. True when it was set.
export async function storeItemsUsed(database: Database, itemsUsed: number): Promise<boolean> {
  await database.insert(plaidSettings).values({ id: PLAID_SETTINGS_ROW }).onConflictDoNothing();
  const set = await database
    .update(plaidSettings)
    .set({ outsideItems: sql`${itemsUsed} - ${plaidSettings.appItems}` })
    .where(and(eq(plaidSettings.id, PLAID_SETTINGS_ROW), lte(plaidSettings.appItems, itemsUsed)))
    .returning({ id: plaidSettings.id });
  return set.length === 1;
}

// Counts one more Plaid Connection. addConnection calls it in the same transaction as the insert.
export async function countPlaidItem(tx: Transaction): Promise<void> {
  await tx
    .insert(plaidSettings)
    .values({ id: PLAID_SETTINGS_ROW, appItems: 1 })
    .onConflictDoUpdate({
      target: plaidSettings.id,
      set: { appItems: sql`${plaidSettings.appItems} + 1` },
    });
}
