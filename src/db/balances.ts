import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import type { AccountSnapshot } from "../bank/adapter.ts";
import type { Database } from "./client.ts";
import { dailyBalances, transactions } from "./schema.ts";

// Daily balances in app.db (spec 02, Balances). The bank module decides; these functions store
// and read.

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type StoredDailyBalance = typeof dailyBalances.$inferSelect;

// Saves the day's balance and details of one Account. A later sync on the same day replaces it.
export async function saveDailyBalance(
  tx: Transaction,
  accountId: string,
  snapshot: AccountSnapshot,
  day: string,
  at: Date,
): Promise<void> {
  const fields = {
    currentBalance: snapshot.currentBalance,
    availableBalance: snapshot.availableBalance,
    creditLimit: snapshot.creditLimit,
    cardAprs: snapshot.card?.aprs ?? null,
    statementBalance: snapshot.card?.statementBalance ?? null,
    statementIssueDate: snapshot.card?.statementIssueDate ?? null,
    minimumPayment: snapshot.card?.minimumPayment ?? snapshot.loan?.minimumPayment ?? null,
    paymentDueDate: snapshot.card?.dueDate ?? snapshot.loan?.dueDate ?? null,
    loanApr: snapshot.loan?.apr ?? null,
    loanPrincipal: snapshot.loan?.principal ?? null,
    interestPaidThisYear: snapshot.loan?.interestPaidThisYear ?? null,
    syncedAt: at,
  };
  await tx
    .insert(dailyBalances)
    .values({ accountId, date: day, ...fields })
    .onConflictDoUpdate({ target: [dailyBalances.accountId, dailyBalances.date], set: fields });
}

// Every saved daily balance of one Account, oldest first.
export async function listDailyBalances(
  database: Database,
  accountId: string,
): Promise<StoredDailyBalance[]> {
  return database
    .select()
    .from(dailyBalances)
    .where(eq(dailyBalances.accountId, accountId))
    .orderBy(asc(dailyBalances.date));
}

// The sum of each day's posted Transactions on one Account up to a date, oldest day first.
// Hidden and pending Transactions are left out.
export async function listPostedDayTotals(
  database: Database,
  accountId: string,
  upTo: string,
): Promise<{ date: string; total: number }[]> {
  const rows = await database
    .select({ date: transactions.postedDate, total: sql<number>`sum(${transactions.amount})` })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, accountId),
        eq(transactions.pending, false),
        isNull(transactions.hiddenReason),
        lte(transactions.postedDate, upTo),
      ),
    )
    .groupBy(transactions.postedDate)
    .orderBy(asc(transactions.postedDate));
  return rows.map((row) => ({ date: row.date, total: Number(row.total) }));
}
