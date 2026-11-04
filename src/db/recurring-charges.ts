import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { Database } from "./client.ts";
import { recurringCharges, transactionParts, transactions } from "./schema.ts";

// Recurring charges in app.db (spec 06, What the app stores). The recurring module decides; these
// functions store and read.

export type StoredRecurringCharge = typeof recurringCharges.$inferSelect;

// One posted Spending Transaction for the checks: its Spending in whole cents with the
// Transaction's sign, and its first Spending part's Category.
export type PostedSpendingRow = {
  id: string;
  postedDate: string;
  accountId: string;
  merchantId: string | null;
  merchantCleanName: string | null;
  spending: number;
  category: string | null;
};

// Every posted Spending Transaction that shows, oldest first. A Transaction with more than one
// Spending part counts once, with their sum. A Transfer never counts.
export async function listPostedSpending(database: Database): Promise<PostedSpendingRow[]> {
  const rows = await database
    .select({
      id: transactions.id,
      postedDate: transactions.postedDate,
      accountId: transactions.accountId,
      merchantId: transactions.merchantId,
      merchantCleanName: transactions.merchantCleanName,
      amount: transactionParts.amount,
      category: transactionParts.category,
    })
    .from(transactionParts)
    .innerJoin(transactions, eq(transactions.id, transactionParts.transactionId))
    .where(
      and(
        eq(transactionParts.type, "Spending"),
        eq(transactions.pending, false),
        isNull(transactions.hiddenReason),
      ),
    )
    .orderBy(asc(transactions.postedDate), asc(transactions.id), asc(transactionParts.part));
  const found: PostedSpendingRow[] = [];
  for (const { amount, category, ...row } of rows) {
    const previous = found.at(-1);
    if (previous?.id === row.id) previous.spending += amount;
    else found.push({ ...row, spending: amount, category });
  }
  return found;
}

export async function listRecurringCharges(database: Database): Promise<StoredRecurringCharge[]> {
  return database
    .select()
    .from(recurringCharges)
    .orderBy(asc(recurringCharges.nextExpectedDate), asc(recurringCharges.id));
}

// Stores the Recurring charges the checks found in place of every one not marked ended.
export async function replaceRecurringCharges(
  database: Database,
  charges: readonly StoredRecurringCharge[],
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.delete(recurringCharges).where(ne(recurringCharges.status, "ended"));
    for (const charge of charges) await tx.insert(recurringCharges).values(charge);
  });
}

// Marks a Recurring charge ended. Returns it, or undefined when no Recurring charge has the ID. One
// already ended keeps its first end.
export async function endRecurringCharge(
  database: Database,
  id: string,
  ended: { memberId: string; at: Date },
): Promise<StoredRecurringCharge | undefined> {
  await database
    .update(recurringCharges)
    .set({ status: "ended", endedAt: ended.at, endedBy: ended.memberId })
    .where(and(eq(recurringCharges.id, id), ne(recurringCharges.status, "ended")));
  const [row] = await database.select().from(recurringCharges).where(eq(recurringCharges.id, id));
  return row;
}
