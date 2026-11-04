import { and, asc, eq, inArray, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import type { Queries } from "./client.ts";
import { categoryRules, transactions } from "./schema.ts";

// Category rules in app.db (spec 04, Category rules). The categorization module decides; these
// functions store and read.

export type StoredCategoryRule = typeof categoryRules.$inferSelect;
export type NewCategoryRule = Omit<StoredCategoryRule, "id">;

// A Merchant as the queries below look it up: the provider's Merchant ID, if any, and the clean
// name as identity compares it.
export type MerchantLookup = { merchantId: string | null; merchantKey: string };

// The rules that may be for this Merchant: those with its Merchant ID or its clean name. The
// categorization module keeps those that are the same Merchant.
export async function listRulesNamed(
  database: Queries,
  merchant: MerchantLookup,
): Promise<StoredCategoryRule[]> {
  const byKey = eq(categoryRules.merchantKey, merchant.merchantKey);
  return database
    .select()
    .from(categoryRules)
    .where(
      merchant.merchantId === null
        ? byKey
        : or(eq(categoryRules.merchantId, merchant.merchantId), byKey),
    );
}

// Every rule, by Merchant name.
export async function listCategoryRules(database: Queries): Promise<StoredCategoryRule[]> {
  return database
    .select()
    .from(categoryRules)
    .orderBy(asc(categoryRules.merchantName), asc(categoryRules.id));
}

export async function readCategoryRule(
  database: Queries,
  id: string,
): Promise<StoredCategoryRule | undefined> {
  const [row] = await database.select().from(categoryRules).where(eq(categoryRules.id, id));
  return row;
}

// Stores a new rule in place of the rules it replaces, and returns its ID.
export async function storeCategoryRule(
  database: Queries,
  rule: NewCategoryRule,
  replaces: readonly string[],
): Promise<string> {
  const id = crypto.randomUUID();
  if (replaces.length > 0) {
    await database.delete(categoryRules).where(inArray(categoryRules.id, [...replaces]));
  }
  await database.insert(categoryRules).values({ id, ...rule });
  return id;
}

// Returns the rule it removed, or undefined when no rule has the ID.
export async function removeCategoryRule(
  database: Queries,
  id: string,
): Promise<StoredCategoryRule | undefined> {
  const [removed] = await database
    .delete(categoryRules)
    .where(eq(categoryRules.id, id))
    .returning();
  return removed;
}

// The shown Transactions that may be this Merchant's: those with its Merchant ID or no Merchant
// ID, or, for a Merchant with no ID, every one with a clean name. The categorization module keeps
// those that are the same Merchant.
export async function listMerchantCandidates(
  database: Queries,
  merchant: Pick<MerchantLookup, "merchantId">,
): Promise<{ id: string; merchantId: string | null; merchantCleanName: string }[]> {
  const conditions: SQL[] = [
    isNull(transactions.hiddenReason),
    isNotNull(transactions.merchantCleanName),
  ];
  if (merchant.merchantId !== null) {
    const sameId = or(
      eq(transactions.merchantId, merchant.merchantId),
      isNull(transactions.merchantId),
    );
    if (sameId !== undefined) conditions.push(sameId);
  }
  const rows = await database
    .select({
      id: transactions.id,
      merchantId: transactions.merchantId,
      merchantCleanName: transactions.merchantCleanName,
    })
    .from(transactions)
    .where(and(...conditions))
    .orderBy(asc(transactions.postedDate), asc(transactions.id));
  return rows.flatMap((row) =>
    row.merchantCleanName === null ? [] : [{ ...row, merchantCleanName: row.merchantCleanName }],
  );
}
