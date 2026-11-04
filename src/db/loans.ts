import { and, asc, eq, gt, inArray, isNotNull, isNull, like, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Database } from "./client.ts";
import { dailyBalances, householdAccounts, transactions, transferLinks } from "./schema.ts";

// What the order of decisions reads of connected loans, and what a Member sets on one (spec 02,
// Connected loans; spec 03, Loans). The money-movement module decides; these functions store and
// read.

export type LoanType = NonNullable<(typeof householdAccounts.$inferSelect)["loanType"]>;

// A connected loan: an Account of kind "loan" from a Connection.
const isConnectedLoan = (id: string) =>
  and(
    eq(householdAccounts.id, id),
    eq(householdAccounts.kind, "loan"),
    isNotNull(householdAccounts.connectionId),
  );

// The fields a Member sets on a connected loan: the loan type, and an APR as a percent, such as
// 6.5. Null leaves it to the app.
export type LoanFields = { loanType: LoanType | null; memberApr: number | null };

// Undefined when no connected loan has the ID.
export async function readLoanFields(
  database: Database,
  id: string,
): Promise<LoanFields | undefined> {
  const [row] = await database
    .select({ loanType: householdAccounts.loanType, memberApr: householdAccounts.memberApr })
    .from(householdAccounts)
    .where(isConnectedLoan(id));
  return row;
}

// Sets a Member's fields on a connected loan. Fields left out keep their value. False when no
// connected loan has the ID.
export async function storeLoanFields(
  database: Database,
  id: string,
  fields: Partial<LoanFields>,
): Promise<boolean> {
  if (Object.keys(fields).length === 0) return (await readLoanFields(database, id)) !== undefined;
  const updated = await database
    .update(householdAccounts)
    .set(fields)
    .where(isConnectedLoan(id))
    .returning({ id: householdAccounts.id });
  return updated.length === 1;
}

// A shown, posted Transaction.
const counts = and(isNull(transactions.hiddenReason), eq(transactions.pending, false));

export type LoanHistory = {
  // The loan's daily balances, oldest first. Owed money is negative.
  balances: { date: string; currentBalance: number | null; interestPaidThisYear: number | null }[];
  // The money into the loan, its payments, oldest first.
  payments: { id: string; postedDate: string; amount: number }[];
};

export async function readLoanHistory(database: Database, loanId: string): Promise<LoanHistory> {
  const balances = await database
    .select({
      date: dailyBalances.date,
      currentBalance: dailyBalances.currentBalance,
      interestPaidThisYear: dailyBalances.interestPaidThisYear,
    })
    .from(dailyBalances)
    .where(eq(dailyBalances.accountId, loanId))
    .orderBy(asc(dailyBalances.date));
  const payments = await database
    .select({
      id: transactions.id,
      postedDate: transactions.postedDate,
      amount: transactions.amount,
    })
    .from(transactions)
    .where(and(eq(transactions.accountId, loanId), gt(transactions.amount, 0), counts))
    .orderBy(asc(transactions.postedDate), asc(transactions.id));
  return { balances, payments };
}

export type LoanPayouts = {
  // The loans that are the money-out side of a Transfer pair into an Account that is not a loan.
  pairedLoanIds: string[];
  // Each shown money-in Transaction under a LOAN_DISBURSEMENTS_* code, on an Account that is not
  // a loan, with what may name its lender, oldest first.
  disbursements: {
    id: string;
    description: string;
    counterparties: { name: string; type: string }[];
    // The Merchant, cleaned when cleanup has run.
    merchant: string | null;
  }[];
};

// The loan payouts the app has seen land in an Account (spec 03, Loan payouts).
export async function listLoanPayouts(database: Database): Promise<LoanPayouts> {
  const loan = alias(householdAccounts, "loan");
  const into = alias(transactions, "into_side");
  const intoAccount = alias(householdAccounts, "into_account");
  const paired = await database
    .selectDistinct({ loanId: transactions.accountId })
    .from(transferLinks)
    .innerJoin(transactions, eq(transactions.id, transferLinks.outTransactionId))
    .innerJoin(loan, eq(loan.id, transactions.accountId))
    .innerJoin(into, eq(into.id, transferLinks.inTransactionId))
    .innerJoin(intoAccount, eq(intoAccount.id, into.accountId))
    .where(and(eq(loan.kind, "loan"), ne(intoAccount.kind, "loan")));
  const lines = await database
    .select({
      id: transactions.id,
      description: transactions.description,
      counterparties: transactions.counterparties,
      merchantName: transactions.merchantName,
      merchantCleanName: transactions.merchantCleanName,
    })
    .from(transactions)
    .innerJoin(householdAccounts, eq(householdAccounts.id, transactions.accountId))
    .where(
      and(
        like(transactions.providerCategory, "LOAN_DISBURSEMENTS_%"),
        gt(transactions.amount, 0),
        ne(householdAccounts.kind, "loan"),
        counts,
      ),
    )
    .orderBy(asc(transactions.postedDate), asc(transactions.id));
  const disbursements = lines.map(({ merchantName, merchantCleanName, ...line }) => ({
    ...line,
    merchant: merchantCleanName ?? merchantName,
  }));
  return { pairedLoanIds: paired.map((row) => row.loanId), disbursements };
}

// Every shown Transaction whose result depends on the loan: the money into it, and the paying side
// of each of those that is paired.
export async function listLoanPaymentIds(database: Database, loanId: string): Promise<string[]> {
  const into = await database
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, loanId),
        gt(transactions.amount, 0),
        isNull(transactions.hiddenReason),
      ),
    );
  const ids = into.map((row) => row.id);
  const paying: string[] = [];
  for (let start = 0; start < ids.length; start += 500) {
    const rows = await database
      .select({ id: transferLinks.outTransactionId })
      .from(transferLinks)
      .where(inArray(transferLinks.inTransactionId, ids.slice(start, start + 500)));
    paying.push(...rows.map((row) => row.id));
  }
  return [...ids, ...paying];
}
