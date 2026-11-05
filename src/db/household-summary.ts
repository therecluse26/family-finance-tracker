import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { householdAccounts, householdSummary, transactionParts, transactions } from "./schema.ts";

// The Household summary in app.db (spec 08, Household summary). The summary module decides; these
// functions store and read.

const SUMMARY_ROW = 1;

export type StoredSummary = { day: string; text: string };

// The stored summary and the Household date it was built for, or undefined with none.
export async function readHouseholdSummary(database: Database): Promise<StoredSummary | undefined> {
  const [row] = await database
    .select({ day: householdSummary.day, text: householdSummary.text })
    .from(householdSummary)
    .where(eq(householdSummary.id, SUMMARY_ROW));
  return row;
}

// Stores the summary built for `day`, in place of the one before.
export async function storeHouseholdSummary(
  database: Database,
  summary: StoredSummary,
  at: Date,
): Promise<void> {
  const row = { ...summary, builtAt: at };
  await database
    .insert(householdSummary)
    .values({ id: SUMMARY_ROW, ...row })
    .onConflictDoUpdate({ target: householdSummary.id, set: row });
}

// One Spending part as the Habit counts read it: its Transaction, amount spent in whole cents
// (positive), Category, purchase date, and Merchant.
export type HabitSpending = {
  transactionId: string;
  amount: number;
  category: string | null;
  date: string;
  merchantId: string | null;
  merchantName: string | null;
};

// The Spending parts of shown, posted Transactions whose purchase date is from `from` to `to`,
// written YYYY-MM-DD. Refunds and Reimbursements are left out: a Habit count counts purchases.
export async function listHabitSpending(
  database: Database,
  from: string,
  to: string,
): Promise<HabitSpending[]> {
  const date = sql<string>`coalesce(${transactions.authorizedDate}, ${transactions.postedDate})`;
  const rows = await database
    .select({
      transactionId: transactionParts.transactionId,
      amount: transactionParts.amount,
      category: transactionParts.category,
      date,
      merchantId: transactions.merchantId,
      merchantName: transactions.merchantCleanName,
    })
    .from(transactionParts)
    .innerJoin(transactions, eq(transactions.id, transactionParts.transactionId))
    .where(
      and(
        eq(transactionParts.type, "Spending"),
        eq(transactions.pending, false),
        isNull(transactions.hiddenReason),
        sql`${date} >= ${from}`,
        sql`${date} <= ${to}`,
      ),
    );
  return rows.map((row) => ({ ...row, amount: -row.amount }));
}

// Each Account's balance and the card and loan details its bank sends, for the Household summary.
// Money owed has the Transaction sign: negative.
export async function listAccountBalances(database: Database) {
  return database
    .select({
      id: householdAccounts.id,
      connectionId: householdAccounts.connectionId,
      kind: householdAccounts.kind,
      currentBalance: householdAccounts.currentBalance,
      cardAprs: householdAccounts.cardAprs,
      statementBalance: householdAccounts.statementBalance,
      minimumPayment: householdAccounts.minimumPayment,
      paymentDueDate: householdAccounts.paymentDueDate,
      loanApr: householdAccounts.loanApr,
      memberApr: householdAccounts.memberApr,
      excluded: householdAccounts.excluded,
      closedAt: householdAccounts.closedAt,
    })
    .from(householdAccounts)
    .orderBy(asc(householdAccounts.institutionName), asc(householdAccounts.name));
}
