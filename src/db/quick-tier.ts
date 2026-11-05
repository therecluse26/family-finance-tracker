import { and, eq, exists, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { merchantNameAnswers, transactions } from "./schema.ts";

// What the categorization step's Quick-tier uses read and store (spec 04, AI decisions; spec 08,
// Every AI use): the facts of each Transaction a Category fix sends, and AI cleanup's Merchant
// names. The categorization module decides; these functions read and write.

// SQLite takes at most 32,766 values in one statement.
const IDS_PER_QUERY = 500;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += IDS_PER_QUERY) {
    out.push(items.slice(start, start + IDS_PER_QUERY));
  }
  return out;
}

// What a Category fix sends of a Transaction besides its Merchant and provider category, which the
// cascade reads already.
export type CategoryFixFacts = {
  id: string;
  description: string;
  amount: number;
  accountId: string;
  mcc: string | null;
};

// The facts of the Transactions with these IDs, by ID. An unknown ID is left out.
export async function readCategoryFixFacts(
  database: Database,
  ids: readonly string[],
): Promise<Map<string, CategoryFixFacts>> {
  const found = new Map<string, CategoryFixFacts>();
  for (const chunk of chunks(ids)) {
    const rows = await database
      .select({
        id: transactions.id,
        description: transactions.description,
        amount: transactions.amount,
        accountId: transactions.accountId,
        mcc: transactions.mcc,
      })
      .from(transactions)
      .where(inArray(transactions.id, chunk));
    for (const row of rows) found.set(row.id, row);
  }
  return found;
}

// A shown Transaction whose clean name the cleanup rules could not fix, with its bank description.
export type MarkedName = { id: string; description: string };

// The shown Transactions among these IDs whose clean name is marked for AI cleanup, in the order
// given.
export async function listMarkedNames(
  database: Database,
  ids: readonly string[],
): Promise<MarkedName[]> {
  const found = new Map<string, MarkedName>();
  for (const chunk of chunks(ids)) {
    const rows = await database
      .select({ id: transactions.id, description: transactions.description })
      .from(transactions)
      .where(
        and(
          inArray(transactions.id, chunk),
          eq(transactions.merchantNeedsAi, true),
          isNull(transactions.hiddenReason),
        ),
      );
    for (const row of rows) found.set(row.id, row);
  }
  return ids.flatMap((id) => found.get(id) ?? []);
}

// The stored AI answers for these description texts, by description.
export async function readMerchantNameAnswers(
  database: Database,
  descriptions: readonly string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const chunk of chunks([...new Set(descriptions)])) {
    const rows = await database
      .select({ description: merchantNameAnswers.description, name: merchantNameAnswers.name })
      .from(merchantNameAnswers)
      .where(inArray(merchantNameAnswers.description, chunk));
    for (const row of rows) found.set(row.description, row.name);
  }
  return found;
}

// Keeps each AI answer by its description text. A newer answer for one text replaces the older.
export async function storeMerchantNameAnswers(
  database: Database,
  answers: readonly { description: string; name: string }[],
  at: Date,
): Promise<void> {
  for (const chunk of chunks(answers)) {
    await database
      .insert(merchantNameAnswers)
      .values(chunk.map((answer) => ({ ...answer, answeredAt: at })))
      .onConflictDoUpdate({
        target: merchantNameAnswers.description,
        set: { name: sql`excluded.name`, answeredAt: sql`excluded.answered_at` },
      });
  }
}

// Gives each Transaction among these IDs that is marked for AI cleanup the stored answer for its
// description as its clean name, and clears the mark. A Transaction with no stored answer keeps its
// rule-cleaned name and its mark. One statement for each 500 IDs.
export async function applyMerchantNameAnswers(
  database: Database,
  ids: readonly string[],
): Promise<void> {
  const answer = database
    .select({ name: merchantNameAnswers.name })
    .from(merchantNameAnswers)
    .where(eq(merchantNameAnswers.description, transactions.description));
  for (const chunk of chunks(ids)) {
    await database
      .update(transactions)
      .set({ merchantCleanName: sql`(${answer})`, merchantNeedsAi: false })
      .where(
        and(
          inArray(transactions.id, chunk),
          eq(transactions.merchantNeedsAi, true),
          exists(answer),
        ),
      );
  }
}
