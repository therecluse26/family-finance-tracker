import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { merchantKey } from "../merchants/identity.ts";
import { AI_SETTINGS_ROW } from "./ai-settings.ts";
import type { Database, Queries } from "./client.ts";
import { aiSettings, merchantLookupMonths, merchantLookups, transactions } from "./schema.ts";

// What the Web lookup keeps (spec 04, Web lookup; spec 08, Merchant web lookup): each Merchant's
// answer, the month's count of lookups under their cap, and the switch. The categorization and ai
// modules decide; these functions read and write.

// SQLite takes at most 32,766 values in one statement.
const KEYS_PER_QUERY = 500;

// A Merchant's kept answer. A lookup that found nothing keeps no Category.
export type KeptMerchantLookup =
  | {
      outcome: "found";
      category: string;
      confidence: "high" | "medium" | "low";
      description: string;
      lookedUpAt: Date;
    }
  | { outcome: "nothing found"; lookedUpAt: Date };

type Row = typeof merchantLookups.$inferSelect;

function lookupOf(row: Row): KeptMerchantLookup {
  if (
    row.outcome === "found" &&
    row.category !== null &&
    row.confidence !== null &&
    row.description !== null
  ) {
    return {
      outcome: "found",
      category: row.category,
      confidence: row.confidence,
      description: row.description,
      lookedUpAt: row.lookedUpAt,
    };
  }
  return { outcome: "nothing found", lookedUpAt: row.lookedUpAt };
}

// The kept answers for these Merchant keys, by key, in one read for each 500 keys. A key with no
// answer is left out.
export async function readMerchantLookups(
  database: Database,
  keys: readonly string[],
): Promise<Map<string, KeptMerchantLookup>> {
  const found = new Map<string, KeptMerchantLookup>();
  const unique = [...new Set(keys)];
  for (let start = 0; start < unique.length; start += KEYS_PER_QUERY) {
    const rows = await database
      .select()
      .from(merchantLookups)
      .where(inArray(merchantLookups.merchantKey, unique.slice(start, start + KEYS_PER_QUERY)));
    for (const row of rows) found.set(row.merchantKey, lookupOf(row));
  }
  return found;
}

// Keeps a Merchant's answer, in place of the one kept before.
export async function storeMerchantLookup(
  database: Database,
  merchantKey: string,
  lookup: KeptMerchantLookup,
): Promise<void> {
  const row =
    lookup.outcome === "found"
      ? { merchantKey, ...lookup }
      : {
          merchantKey,
          outcome: lookup.outcome,
          category: null,
          confidence: null,
          description: null,
          lookedUpAt: lookup.lookedUpAt,
        };
  const { merchantKey: _, ...set } = row;
  await database
    .insert(merchantLookups)
    .values(row)
    .onConflictDoUpdate({ target: merchantLookups.merchantKey, set });
}

// The key a Transaction's Merchant keeps its lookup under, as src/categorization/web-lookup.ts
// makes it: the provider's Merchant ID, else the clean name as identity compares it.
function heldKey(merchantId: string | null, cleanName: string | null): string | undefined {
  if (merchantId !== null) return `id:${merchantId}`;
  const name = cleanName === null ? "" : merchantKey(cleanName);
  return name === "" ? undefined : `name:${name}`;
}

// Deletes each kept answer no Transaction's Merchant holds any more, as when a Connection's
// history goes (known finding K6): an answer names a Merchant from that history. Two reads and one
// delete for each 500 answers, never a read per Transaction.
export async function deleteUnheldMerchantLookups(database: Queries): Promise<void> {
  const kept = await database.select({ key: merchantLookups.merchantKey }).from(merchantLookups);
  if (kept.length === 0) return;
  const merchants = await database
    .selectDistinct({
      id: transactions.merchantId,
      name: transactions.merchantCleanName,
    })
    .from(transactions);
  const held = new Set(merchants.map((row) => heldKey(row.id, row.name)));
  const unheld = kept.map((row) => row.key).filter((key) => !held.has(key));
  for (let start = 0; start < unheld.length; start += KEYS_PER_QUERY) {
    await database
      .delete(merchantLookups)
      .where(inArray(merchantLookups.merchantKey, unheld.slice(start, start + KEYS_PER_QUERY)));
  }
}

// Takes one lookup's place under the month's cap, in one statement, so lookups side by side
// cannot pass it (known finding K18). False at the cap.
export async function reserveMerchantLookup(
  database: Database,
  month: string,
  cap: number,
): Promise<boolean> {
  if (cap <= 0) return false;
  const result = await database
    .insert(merchantLookupMonths)
    .values({ month, lookups: 1 })
    .onConflictDoUpdate({
      target: merchantLookupMonths.month,
      set: { lookups: sql`${merchantLookupMonths.lookups} + 1` },
      setWhere: lt(merchantLookupMonths.lookups, cap),
    });
  return result.rowsAffected === 1;
}

// Gives back a place a lookup took, when no call went out.
export async function giveBackMerchantLookup(database: Database, month: string): Promise<void> {
  await database
    .update(merchantLookupMonths)
    .set({ lookups: sql`${merchantLookupMonths.lookups} - 1` })
    .where(and(eq(merchantLookupMonths.month, month), gt(merchantLookupMonths.lookups, 0)));
}

// The month's lookups so far.
export async function countMerchantLookups(database: Database, month: string): Promise<number> {
  const [row] = await database
    .select({ lookups: merchantLookupMonths.lookups })
    .from(merchantLookupMonths)
    .where(eq(merchantLookupMonths.month, month));
  return row?.lookups ?? 0;
}

// The Web lookup's switch. With no AI settings row, it is on, as the row starts.
export async function readWebLookupSwitch(database: Database): Promise<boolean> {
  const [row] = await database
    .select({ webLookup: aiSettings.webLookup })
    .from(aiSettings)
    .where(eq(aiSettings.id, AI_SETTINGS_ROW));
  return row?.webLookup ?? true;
}

// Sets the switch on the AI settings row. False with no row: no AI provider was ever set up, and
// a first save writes the row with the switch on.
export async function storeWebLookupSwitch(database: Database, on: boolean): Promise<boolean> {
  const result = await database
    .update(aiSettings)
    .set({ webLookup: on })
    .where(eq(aiSettings.id, AI_SETTINGS_ROW));
  return result.rowsAffected === 1;
}

// The AI provider and Quick model, as "provider:model", that refused the Web lookup's search, or
// null when none did.
export async function readWebSearchRefused(database: Database): Promise<string | null> {
  const [row] = await database
    .select({ refused: aiSettings.webSearchRefused })
    .from(aiSettings)
    .where(eq(aiSettings.id, AI_SETTINGS_ROW));
  return row?.refused ?? null;
}

// Notes that the AI provider refused the Web lookup's search with this Quick model.
export async function storeWebSearchRefused(database: Database, model: string): Promise<void> {
  await database
    .update(aiSettings)
    .set({ webSearchRefused: model })
    .where(eq(aiSettings.id, AI_SETTINGS_ROW));
}
