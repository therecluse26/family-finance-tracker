import { aliasedTable, and, asc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Database, Queries } from "./client.ts";
import { type TransferLinkMaker, transferLinkMaker } from "./links.ts";
import { transactionDecisions, transactionParts, transactions } from "./schema.ts";

// Each Transaction's type and parts (spec 03, Order of decisions). The money-movement module
// decides; these functions store and read.

// SQLite takes at most 32,766 values in one statement.
const IDS_PER_QUERY = 500;

export type StoredPart = typeof transactionParts.$inferSelect;
export type PartType = StoredPart["type"];

export type CategorySource = NonNullable<StoredPart["categorySource"]>;
export type CategoryConfidence = NonNullable<StoredPart["categoryConfidence"]>;

// A part as a decision stores it. The categorization step fills the Category's provenance later,
// unless the part carries it over from the pending Transaction it replaces.
export type NewPart = Pick<StoredPart, "type" | "amount" | "category"> &
  Partial<
    Pick<StoredPart, "keepsCategory" | "categorySource" | "categoryConfidence" | "categoryNeedsAi">
  >;

export type StoredDecision = {
  transactionId: string;
  step: string;
  provisionalUntil: string | null;
  decidedAt: Date;
  parts: NewPart[];
};

// What the order of decisions reads of a Transaction.
export type DecisionRecord = {
  id: string;
  accountId: string;
  amount: number;
  postedDate: string;
  authorizedDate: string | null;
  pending: boolean;
  description: string;
  merchantName: string | null;
  merchantCleanName: string | null;
  providerCategory: string | null;
  handSet: Record<string, unknown>;
  // Who made the Transfer link that uses it, or null when it has none.
  transferLink: TransferLinkMaker | null;
  hidden: boolean;
};

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += IDS_PER_QUERY) {
    out.push(items.slice(start, start + IDS_PER_QUERY));
  }
  return out;
}

// The Transactions with these IDs, in the order given. An unknown ID is left out.
export async function readDecisionRecords(
  database: Database,
  ids: readonly string[],
): Promise<DecisionRecord[]> {
  const found = new Map<string, DecisionRecord>();
  for (const chunk of chunks(ids)) {
    const rows = await database
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        amount: transactions.amount,
        postedDate: transactions.postedDate,
        authorizedDate: transactions.authorizedDate,
        pending: transactions.pending,
        description: transactions.description,
        merchantName: transactions.merchantName,
        merchantCleanName: transactions.merchantCleanName,
        providerCategory: transactions.providerCategory,
        handSet: transactions.handSet,
        transferLink: transferLinkMaker,
        hiddenReason: transactions.hiddenReason,
      })
      .from(transactions)
      .where(inArray(transactions.id, chunk));
    for (const { hiddenReason, ...row } of rows) {
      found.set(row.id, { ...row, hidden: hiddenReason !== null });
    }
  }
  return ids.flatMap((id) => found.get(id) ?? []);
}

// Saves each decision in place of the Transaction's earlier one.
export async function storeDecisions(
  database: Database,
  decisions: readonly StoredDecision[],
): Promise<void> {
  if (decisions.length === 0) return;
  await database.transaction(async (tx) => {
    for (const chunk of chunks(decisions)) {
      const ids = chunk.map((decision) => decision.transactionId);
      await tx.delete(transactionDecisions).where(inArray(transactionDecisions.transactionId, ids));
      await tx.insert(transactionDecisions).values(chunk.map(({ parts, ...decision }) => decision));
      const parts = chunk.flatMap((decision) =>
        decision.parts.map((part, index) => ({
          transactionId: decision.transactionId,
          part: index,
          ...part,
        })),
      );
      if (parts.length > 0) await tx.insert(transactionParts).values(parts);
    }
  });
}

export async function removeDecisions(database: Database, ids: readonly string[]): Promise<void> {
  for (const chunk of chunks(ids)) {
    await database
      .delete(transactionDecisions)
      .where(inArray(transactionDecisions.transactionId, chunk));
  }
}

export async function readDecision(
  database: Database,
  transactionId: string,
): Promise<StoredDecision | undefined> {
  const [decision] = await database
    .select()
    .from(transactionDecisions)
    .where(eq(transactionDecisions.transactionId, transactionId));
  if (decision === undefined) return undefined;
  const parts = await database
    .select({
      type: transactionParts.type,
      amount: transactionParts.amount,
      category: transactionParts.category,
    })
    .from(transactionParts)
    .where(eq(transactionParts.transactionId, transactionId))
    .orderBy(asc(transactionParts.part));
  return { ...decision, parts };
}

// The Transactions whose provisional result ended before `today`, oldest first.
export async function listProvisionalPassed(database: Database, today: string): Promise<string[]> {
  const rows = await database
    .select({ id: transactionDecisions.transactionId })
    .from(transactionDecisions)
    .innerJoin(transactions, eq(transactions.id, transactionDecisions.transactionId))
    .where(lt(transactionDecisions.provisionalUntil, today))
    .orderBy(asc(transactions.postedDate), asc(transactions.id));
  return rows.map((row) => row.id);
}

// Every part of every posted Transaction that is not hidden, with the dates its month comes from.
export async function listPostedParts(database: Database) {
  return database
    .select({
      type: transactionParts.type,
      amount: transactionParts.amount,
      category: transactionParts.category,
      postedDate: transactions.postedDate,
      authorizedDate: transactions.authorizedDate,
    })
    .from(transactionParts)
    .innerJoin(transactions, eq(transactions.id, transactionParts.transactionId))
    .where(and(eq(transactions.pending, false), isNull(transactions.hiddenReason)));
}

// The parts of the pending Transaction that each posted one replaces, with their Categories' provenance,
// by the posted Transaction's ID (spec 03, Pending Transactions). Read before Matching removes the
// hidden pending Transaction's result.
export async function readPendingParts(
  database: Database,
  postedIds: readonly string[],
): Promise<Map<string, StoredPart[]>> {
  const pending = aliasedTable(transactions, "pending");
  const found = new Map<string, StoredPart[]>();
  for (const chunk of chunks(postedIds)) {
    const rows = await database
      .select({ postedId: transactions.id, part: transactionParts })
      .from(transactions)
      .innerJoin(
        pending,
        and(
          eq(pending.connectionId, transactions.connectionId),
          eq(pending.providerTransactionId, transactions.pendingTransactionId),
        ),
      )
      .innerJoin(transactionParts, eq(transactionParts.transactionId, pending.id))
      .where(and(inArray(transactions.id, chunk), isNotNull(transactions.pendingTransactionId)))
      .orderBy(asc(transactionParts.part));
    for (const { postedId, part } of rows) {
      found.set(postedId, [...(found.get(postedId) ?? []), part]);
    }
  }
  return found;
}

// What the categorization cascade reads of a Transaction, with its parts.
export type CategoryRecord = {
  id: string;
  postedDate: string;
  hidden: boolean;
  merchantId: string | null;
  merchantCleanName: string | null;
  providerCategory: string | null;
  providerCategoryConfidence: string | null;
  handSet: Record<string, unknown>;
  parts: Pick<StoredPart, "part" | "type" | "category" | "keepsCategory" | "categorySource">[];
};

// The Transactions with these IDs, in the order given. An unknown ID is left out.
export async function readCategoryRecords(
  database: Queries,
  ids: readonly string[],
): Promise<CategoryRecord[]> {
  const found = new Map<string, CategoryRecord>();
  for (const chunk of chunks(ids)) {
    const rows = await database
      .select({
        id: transactions.id,
        postedDate: transactions.postedDate,
        hiddenReason: transactions.hiddenReason,
        merchantId: transactions.merchantId,
        merchantCleanName: transactions.merchantCleanName,
        providerCategory: transactions.providerCategory,
        providerCategoryConfidence: transactions.providerCategoryConfidence,
        handSet: transactions.handSet,
        part: {
          part: transactionParts.part,
          type: transactionParts.type,
          category: transactionParts.category,
          keepsCategory: transactionParts.keepsCategory,
          categorySource: transactionParts.categorySource,
        },
      })
      .from(transactions)
      .leftJoin(transactionParts, eq(transactionParts.transactionId, transactions.id))
      .where(inArray(transactions.id, chunk))
      .orderBy(asc(transactionParts.part));
    for (const { hiddenReason, part, ...row } of rows) {
      const record = found.get(row.id) ?? { ...row, hidden: hiddenReason !== null, parts: [] };
      if (part !== null) record.parts.push(part);
      found.set(row.id, record);
    }
  }
  return ids.flatMap((id) => found.get(id) ?? []);
}

// One Spending Transaction in a Merchant's history: its first Spending part's Category and how
// that Category was chosen. Loan payment parts are left out.
export type MerchantHistoryRow = {
  id: string;
  postedDate: string;
  merchantId: string | null;
  merchantCleanName: string;
  category: string;
  categorySource: CategorySource | null;
};

// Every shown Spending Transaction with a Merchant and a Category, oldest first.
export async function listMerchantHistory(database: Queries): Promise<MerchantHistoryRow[]> {
  const rows = await database
    .select({
      id: transactions.id,
      postedDate: transactions.postedDate,
      merchantId: transactions.merchantId,
      merchantCleanName: sql<string>`${transactions.merchantCleanName}`,
      category: sql<string>`${transactionParts.category}`,
      categorySource: transactionParts.categorySource,
    })
    .from(transactionParts)
    .innerJoin(transactions, eq(transactions.id, transactionParts.transactionId))
    .where(
      and(
        eq(transactionParts.type, "Spending"),
        isNotNull(transactionParts.category),
        eq(transactionParts.keepsCategory, false),
        isNull(transactions.hiddenReason),
        isNotNull(transactions.merchantCleanName),
      ),
    )
    .orderBy(asc(transactions.postedDate), asc(transactions.id), asc(transactionParts.part));
  // A Transaction with several Spending parts counts once, with its first.
  return rows.filter((row, index) => index === 0 || rows[index - 1]?.id !== row.id);
}

export type PartCategory = {
  transactionId: string;
  part: number;
  category: string;
  categorySource: CategorySource;
  categoryConfidence: CategoryConfidence;
  categoryNeedsAi: boolean;
};

// Saves the Category the categorization step chose for each part.
export async function storePartCategories(
  database: Queries,
  choices: readonly PartCategory[],
): Promise<void> {
  if (choices.length === 0) return;
  await database.transaction(async (tx) => {
    for (const { transactionId, part, ...choice } of choices) {
      await tx
        .update(transactionParts)
        .set(choice)
        .where(
          and(eq(transactionParts.transactionId, transactionId), eq(transactionParts.part, part)),
        );
    }
  });
}
