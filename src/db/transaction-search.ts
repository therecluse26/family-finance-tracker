import {
  aliasedTable,
  and,
  count,
  eq,
  exists,
  gte,
  isNotNull,
  isNull,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { NEWEST_SHOWN_FIRST, shownDate } from "./bank-data.ts";
import type { Database } from "./client.ts";
import type { PartType } from "./decisions.ts";
import { spendingLinks, transactionParts, transactions } from "./schema.ts";

// Chat's Transaction search (spec 08, Lookup tools): every field that is set must match. Hidden
// Transactions are left out; pending ones are found.
export type TransactionSearch = {
  accountId?: string;
  // Posted dates, YYYY-MM-DD. Both ends are included.
  from?: string;
  to?: string;
  // A part of the Merchant's clean name, in any case.
  merchant?: string;
  // One part has the type and the Category, each that is set. A linked Refund or Reimbursement
  // part has its Spending's Categories (spec 03, Which month a link changes).
  type?: PartType;
  category?: string;
  // The amount's size in whole cents, whichever way the money moved. Both ends are included.
  minAmount?: number;
  maxAmount?: number;
};

export type FoundTransactions = {
  // At most `limit` Transactions, newest first by the date each shows.
  transactions: {
    id: string;
    accountId: string;
    // Money into the Account is positive.
    amount: number;
    postedDate: string;
    // The date the row shows: the purchase date when the bank gives one, else the posted date.
    shownDate: string;
    pending: boolean;
    merchantCleanName: string | null;
  }[];
  // How many Transactions match, and their amounts' sum in whole cents.
  count: number;
  total: number;
};

function conditions(database: Database, search: TransactionSearch): SQL[] {
  const where: SQL[] = [isNull(transactions.hiddenReason)];
  if (search.accountId !== undefined) where.push(eq(transactions.accountId, search.accountId));
  if (search.from !== undefined) where.push(gte(transactions.postedDate, search.from));
  if (search.to !== undefined) where.push(lte(transactions.postedDate, search.to));
  if (search.merchant !== undefined) {
    // Any part of the name: % and _ in the text match only themselves. Both sides go through
    // SQLite's lower(), so they fold case alike.
    const pattern = `%${search.merchant.replace(/[\\%_]/g, (mark) => `\\${mark}`)}%`;
    where.push(sql`lower(${transactions.merchantCleanName}) LIKE lower(${pattern}) ESCAPE '\\'`);
  }
  if (search.minAmount !== undefined) {
    where.push(sql`abs(${transactions.amount}) >= ${search.minAmount}`);
  }
  if (search.maxAmount !== undefined) {
    where.push(sql`abs(${transactions.amount}) <= ${search.maxAmount}`);
  }
  const { type, category } = search;
  if (type === undefined && category === undefined) return where;
  // One EXISTS on the Transaction's own parts, with its Spending through the link of a linked part.
  const spent = aliasedTable(transactions, "spent");
  const spentPart = aliasedTable(transactionParts, "spent_part");
  const ofPart: SQL[] = [eq(transactionParts.transactionId, transactions.id)];
  if (type !== undefined) ofPart.push(eq(transactionParts.type, type));
  if (category !== undefined) {
    const spentIn = database
      .select({ one: sql`1` })
      .from(spentPart)
      .where(
        and(
          eq(spentPart.transactionId, spent.id),
          eq(spentPart.type, "Spending"),
          eq(spentPart.category, category),
        ),
      );
    ofPart.push(
      or(
        and(isNull(spent.id), eq(transactionParts.category, category)),
        and(isNotNull(spent.id), exists(spentIn)),
      ) as SQL,
    );
  }
  where.push(
    exists(
      database
        .select({ one: sql`1` })
        .from(transactionParts)
        .leftJoin(
          spendingLinks,
          and(
            eq(transactionParts.linked, true),
            eq(spendingLinks.transactionId, transactionParts.transactionId),
          ),
        )
        .leftJoin(spent, eq(spent.id, spendingLinks.spendingTransactionId))
        .where(and(...ofPart)),
    ),
  );
  return where;
}

// The newest `limit` Transactions that match, with how many match and their total: two
// statements, whatever the history's size.
export async function searchTransactions(
  database: Database,
  search: TransactionSearch,
  limit: number,
): Promise<FoundTransactions> {
  const where = and(...conditions(database, search));
  const found = await database
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amount: transactions.amount,
      postedDate: transactions.postedDate,
      // The date the row shows, which it sorts by: the purchase date, else the posted date.
      shownDate,
      pending: transactions.pending,
      merchantCleanName: transactions.merchantCleanName,
    })
    .from(transactions)
    .where(where)
    .orderBy(...NEWEST_SHOWN_FIRST)
    .limit(limit);
  const [matches] = await database
    .select({
      count: count(),
      total: sql<number>`coalesce(sum(${transactions.amount}), 0)`,
    })
    .from(transactions)
    .where(where);
  return {
    transactions: found,
    count: matches?.count ?? 0,
    total: Number(matches?.total ?? 0),
  };
}
