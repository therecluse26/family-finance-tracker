import { and, asc, eq, gte, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { householdAccounts, transactionParts, transactions } from "./schema.ts";

// What the app draws its pictures from (spec 08, Picture menu). The pictures module decides; these
// functions read.

// One Spending part of a posted Transaction that shows. `date` is the purchase date when there is
// one, else the posted date (spec 04, Which month a Transaction counts in).
export type SpendingPartRow = {
  transactionId: string;
  date: string;
  category: string | null;
  merchantCleanName: string | null;
};

// Every Spending part whose purchase date is in the range, both ends included, oldest first. A
// purchase posts on or after its purchase date, so the posted date bounds the read from below.
export async function listSpendingParts(
  database: Database,
  range: { from: string; to: string },
): Promise<SpendingPartRow[]> {
  const day = sql<string>`coalesce(${transactions.authorizedDate}, ${transactions.postedDate})`;
  return database
    .select({
      transactionId: transactions.id,
      date: day,
      category: transactionParts.category,
      merchantCleanName: transactions.merchantCleanName,
    })
    .from(transactionParts)
    .innerJoin(transactions, eq(transactions.id, transactionParts.transactionId))
    .where(
      and(
        eq(transactionParts.type, "Spending"),
        eq(transactions.pending, false),
        isNull(transactions.hiddenReason),
        gte(transactions.postedDate, range.from),
        gte(day, range.from),
        lte(day, range.to),
      ),
    )
    .orderBy(asc(day), asc(transactions.id), asc(transactionParts.part));
}

// A credit card that counts in Debt: open and not Excluded (spec 07, Tiles).
export type CreditCardRow = {
  id: string;
  // The Member's rename, or the name from the provider.
  name: string;
  // Whole cents, with the Transaction sign: money owed is negative. Null when the bank sent none.
  currentBalance: number | null;
  aprs: { type: string; apr: number }[] | null;
};

export async function listCreditCards(database: Database): Promise<CreditCardRow[]> {
  const rows = await database
    .select({
      id: householdAccounts.id,
      name: householdAccounts.name,
      memberName: householdAccounts.memberName,
      currentBalance: householdAccounts.currentBalance,
      aprs: householdAccounts.cardAprs,
    })
    .from(householdAccounts)
    .where(
      and(
        eq(householdAccounts.kind, "credit"),
        eq(householdAccounts.excluded, false),
        isNull(householdAccounts.closedAt),
      ),
    )
    .orderBy(asc(householdAccounts.institutionName), asc(householdAccounts.name));
  return rows.map(({ memberName, name, ...row }) => ({ ...row, name: memberName ?? name }));
}
