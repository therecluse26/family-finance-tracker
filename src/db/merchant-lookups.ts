import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { AI_SETTINGS_ROW } from "./ai-settings.ts";
import type { Database } from "./client.ts";
import { aiSettings, merchantLookupMonths, merchantLookups } from "./schema.ts";

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
