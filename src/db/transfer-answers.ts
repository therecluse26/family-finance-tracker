import { asc, eq, exists, inArray, type SQL } from "drizzle-orm";
import type { Queries } from "./client.ts";
import { spendingLinks, transactionDecisions, transactions, transferAnswers } from "./schema.ts";

// Remembered one-sided Transfer answers in app.db (spec 03, Review list items). The money-movement
// module decides; these functions store and read.

export type StoredTransferAnswer = typeof transferAnswers.$inferSelect;
export type NewTransferAnswer = Omit<StoredTransferAnswer, "id">;

// Every remembered answer, by Merchant name.
export async function listTransferAnswers(database: Queries): Promise<StoredTransferAnswer[]> {
  return database
    .select()
    .from(transferAnswers)
    .orderBy(asc(transferAnswers.merchantName), asc(transferAnswers.lastFours));
}

// Stores the answer for its key, in place of the key's earlier answer, and returns its ID.
export async function storeTransferAnswer(
  database: Queries,
  answer: NewTransferAnswer,
): Promise<string> {
  const id = crypto.randomUUID();
  await database
    .insert(transferAnswers)
    .values({ id, ...answer })
    .onConflictDoUpdate({
      target: [transferAnswers.merchantKey, transferAnswers.lastFours],
      set: {
        id,
        merchantName: answer.merchantName,
        answer: answer.answer,
        accountId: answer.accountId,
        madeAt: answer.madeAt,
        madeBy: answer.madeBy,
      },
    });
  return id;
}

// Returns the answer it removed, or undefined when no answer has the ID.
export async function removeTransferAnswer(
  database: Queries,
  id: string,
): Promise<StoredTransferAnswer | undefined> {
  const [removed] = await database
    .delete(transferAnswers)
    .where(eq(transferAnswers.id, id))
    .returning();
  return removed;
}

// What a Money movement card on the Review list reads of each Transaction: what keys it, whether
// it still shows, its hand-set fields, the step of its last result, or null when it has none, and
// whether it reduces Spending as a Refund or Reimbursement.
export type CardFacts = {
  id: string;
  postedDate: string;
  amount: number;
  description: string;
  merchantName: string | null;
  merchantCleanName: string | null;
  providerCategory: string | null;
  hidden: boolean;
  handSet: Record<string, unknown>;
  step: string | null;
  reducesSpending: boolean;
};

const factColumns = {
  id: transactions.id,
  postedDate: transactions.postedDate,
  amount: transactions.amount,
  description: transactions.description,
  merchantName: transactions.merchantName,
  merchantCleanName: transactions.merchantCleanName,
  providerCategory: transactions.providerCategory,
  hiddenReason: transactions.hiddenReason,
  handSet: transactions.handSet,
  step: transactionDecisions.step,
};

async function readFacts(database: Queries, where: SQL): Promise<CardFacts[]> {
  const reduces = exists(
    database
      .select({ id: spendingLinks.transactionId })
      .from(spendingLinks)
      .where(eq(spendingLinks.transactionId, transactions.id)),
  );
  const rows = await database
    .select({ ...factColumns, reducesSpending: reduces })
    .from(transactions)
    .leftJoin(transactionDecisions, eq(transactionDecisions.transactionId, transactions.id))
    .where(where)
    .orderBy(asc(transactions.postedDate), asc(transactions.id));
  return rows.map(({ hiddenReason, reducesSpending, ...row }) => ({
    ...row,
    hidden: hiddenReason !== null,
    reducesSpending: Boolean(reducesSpending),
  }));
}

// The facts of these Transactions, in one statement for each 500.
export async function readCardFacts(
  database: Queries,
  ids: readonly string[],
): Promise<CardFacts[]> {
  const found: CardFacts[] = [];
  const unique = [...new Set(ids)];
  for (let start = 0; start < unique.length; start += 500) {
    found.push(
      ...(await readFacts(database, inArray(transactions.id, unique.slice(start, start + 500)))),
    );
  }
  return found;
}

// The facts of every Transaction whose last result came from one of these steps, oldest first.
export function listCardFactsAt(
  database: Queries,
  steps: readonly string[],
): Promise<CardFacts[]> {
  return readFacts(database, inArray(transactionDecisions.step, [...steps]));
}
