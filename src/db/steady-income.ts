import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  householdAccounts,
  incomeSeries,
  transactionParts,
  transactions,
  typedSteadyIncome,
} from "./schema.ts";

// Income series and the typed Steady Income figure in app.db (spec 05, Steady Income). The
// recurring module decides; these functions store and read.

export type StoredIncomeSeries = typeof incomeSeries.$inferSelect;

// One posted Income Transaction on a checking or savings Account, for the checks: its Income in
// whole cents received.
export type PostedIncomeRow = {
  id: string;
  postedDate: string;
  accountId: string;
  merchantId: string | null;
  merchantCleanName: string | null;
  income: number;
};

// Income series use checking and savings Accounts only.
const SERIES_ACCOUNTS = ["checking", "savings"];

// Every posted Income Transaction on a checking or savings Account that shows, oldest first. A
// Transaction with more than one Income part counts once, with their sum.
export async function listPostedIncome(database: Database): Promise<PostedIncomeRow[]> {
  const rows = await database
    .select({
      id: transactions.id,
      postedDate: transactions.postedDate,
      accountId: transactions.accountId,
      merchantId: transactions.merchantId,
      merchantCleanName: transactions.merchantCleanName,
      amount: transactionParts.amount,
    })
    .from(transactionParts)
    .innerJoin(transactions, eq(transactions.id, transactionParts.transactionId))
    .innerJoin(householdAccounts, eq(householdAccounts.id, transactions.accountId))
    .where(
      and(
        eq(transactionParts.type, "Income"),
        eq(transactions.pending, false),
        isNull(transactions.hiddenReason),
        inArray(householdAccounts.subtype, SERIES_ACCOUNTS),
      ),
    )
    .orderBy(asc(transactions.postedDate), asc(transactions.id), asc(transactionParts.part));
  const found: PostedIncomeRow[] = [];
  for (const { amount, ...row } of rows) {
    const previous = found.at(-1);
    if (previous?.id === row.id) previous.income += amount;
    else found.push({ ...row, income: amount });
  }
  return found;
}

// The Household's total posted Income in each month from `from` up to but not including `to`,
// both the first of a month. A Transaction's month comes from its purchase date when it has one,
// else its posted date (spec 04, Which month a Transaction counts in). A month with no Income is
// left out.
export async function sumIncomeByMonth(
  database: Database,
  range: { from: string; to: string },
): Promise<Map<string, number>> {
  const day = sql<string>`coalesce(${transactions.authorizedDate}, ${transactions.postedDate})`;
  const month = sql<string>`substr(${day}, 1, 7)`;
  const rows = await database
    .select({ month, income: sql<number>`sum(${transactionParts.amount})` })
    .from(transactionParts)
    .innerJoin(transactions, eq(transactions.id, transactionParts.transactionId))
    .where(
      and(
        eq(transactionParts.type, "Income"),
        eq(transactions.pending, false),
        isNull(transactions.hiddenReason),
        gte(day, range.from),
        lt(day, range.to),
      ),
    )
    .groupBy(month);
  return new Map(rows.map((row) => [row.month, Number(row.income)]));
}

export async function listIncomeSeries(database: Database): Promise<StoredIncomeSeries[]> {
  return database
    .select()
    .from(incomeSeries)
    .orderBy(asc(incomeSeries.nextExpectedDate), asc(incomeSeries.id));
}

// Stores the Income series the checks found in place of every earlier one.
export async function replaceIncomeSeries(
  database: Database,
  series: readonly StoredIncomeSeries[],
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.delete(incomeSeries);
    if (series.length > 0) await tx.insert(incomeSeries).values([...series]);
  });
}

const TYPED_ROW = 1;

export type TypedSteadyIncome = { amount: number; typedAt: Date; typedBy: string | null };

export async function readTypedSteadyIncome(
  database: Database,
): Promise<TypedSteadyIncome | undefined> {
  const [row] = await database
    .select()
    .from(typedSteadyIncome)
    .where(eq(typedSteadyIncome.id, TYPED_ROW));
  if (row === undefined) return undefined;
  const { id: _id, ...typed } = row;
  return typed;
}

// Stores the figure a Member typed, or with null clears it.
export async function storeTypedSteadyIncome(
  database: Database,
  typed: TypedSteadyIncome | null,
): Promise<void> {
  if (typed === null) {
    await database.delete(typedSteadyIncome).where(eq(typedSteadyIncome.id, TYPED_ROW));
    return;
  }
  await database
    .insert(typedSteadyIncome)
    .values({ id: TYPED_ROW, ...typed })
    .onConflictDoUpdate({ target: typedSteadyIncome.id, set: typed });
}
