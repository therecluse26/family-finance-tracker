import { and, asc, eq, gt, inArray, isNull, like, ne, notExists } from "drizzle-orm";
import type { Database } from "./client.ts";
import type { LoanType } from "./loans.ts";
import {
  householdAccounts,
  loanLinks,
  spendingLinks,
  transactions,
  transferLinks,
  typedBalances,
} from "./schema.ts";

// Manual loans in app.db (spec 02, Manual loans): Accounts of kind "loan" with no Connection. The
// subtype is the loan type the Member picked. The balances a Member typed, with their dates, are
// typed balances, negative because the money is owed. The money-movement module decides; these
// functions store and read.

export const MANUAL_LOAN_TYPES = [
  "personal",
  "car",
  "student",
  "mortgage",
  "buy now pay later",
] as const;
export type ManualLoanType = (typeof MANUAL_LOAN_TYPES)[number];

export type ManualLoanFields = {
  lender: string;
  subtype: ManualLoanType;
  // A percent, such as 7.3.
  apr: number;
  // Whole cents, or null.
  regularPayment: number | null;
  escrow: number | null;
  // A Member's choice, or null while the app decides.
  loanType: LoanType | null;
};

export type StoredManualLoan = ManualLoanFields & {
  id: string;
  // Every balance a Member typed, oldest first. Owed money is negative.
  balances: { date: string; balance: number }[];
};

export type TypedLoanBalance = {
  date: string;
  balance: number;
  typedAt: Date;
  typedBy: string | null;
};

const isManualLoan = and(
  eq(householdAccounts.kind, "loan"),
  isNull(householdAccounts.connectionId),
);

const columnsOf = (fields: ManualLoanFields) => ({
  name: fields.lender,
  institutionName: fields.lender,
  subtype: fields.subtype,
  memberApr: fields.apr,
  regularPayment: fields.regularPayment,
  escrow: fields.escrow,
  loanType: fields.loanType,
});

function typedRow(accountId: string, typed: TypedLoanBalance) {
  return { accountId, ...typed };
}

export async function addManualLoan(
  database: Database,
  fields: ManualLoanFields,
  typed: TypedLoanBalance,
): Promise<string> {
  const id = crypto.randomUUID();
  await database.transaction(async (tx) => {
    await tx.insert(householdAccounts).values({ id, kind: "loan", ...columnsOf(fields) });
    await tx.insert(typedBalances).values(typedRow(id, typed));
  });
  return id;
}

// Saves a Member's edit, and a corrected balance when one is given. A balance on the same day
// replaces that day's. False when no Manual loan has the ID.
export async function updateManualLoan(
  database: Database,
  id: string,
  fields: ManualLoanFields,
  typed: TypedLoanBalance | undefined,
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const updated = await tx
      .update(householdAccounts)
      .set(columnsOf(fields))
      .where(and(eq(householdAccounts.id, id), isManualLoan))
      .returning({ id: householdAccounts.id });
    if (updated.length !== 1) return false;
    if (typed !== undefined) {
      const { date, ...rest } = typed;
      await tx
        .insert(typedBalances)
        .values(typedRow(id, typed))
        .onConflictDoUpdate({
          target: [typedBalances.accountId, typedBalances.date],
          set: { ...rest },
        });
    }
    return true;
  });
}

// Every Manual loan, or the ones with these IDs, by lender.
export async function listManualLoans(
  database: Database,
  ids?: readonly string[],
): Promise<StoredManualLoan[]> {
  if (ids !== undefined && ids.length === 0) return [];
  const rows = await database
    .select({
      id: householdAccounts.id,
      lender: householdAccounts.name,
      subtype: householdAccounts.subtype,
      apr: householdAccounts.memberApr,
      regularPayment: householdAccounts.regularPayment,
      escrow: householdAccounts.escrow,
      loanType: householdAccounts.loanType,
    })
    .from(householdAccounts)
    .where(
      ids === undefined ? isManualLoan : and(isManualLoan, inArray(householdAccounts.id, [...ids])),
    )
    .orderBy(asc(householdAccounts.name), asc(householdAccounts.id));
  if (rows.length === 0) return [];
  const balances = await database
    .select({
      accountId: typedBalances.accountId,
      date: typedBalances.date,
      balance: typedBalances.balance,
    })
    .from(typedBalances)
    .where(
      inArray(
        typedBalances.accountId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(typedBalances.date));
  return rows.map((row) => ({
    ...row,
    subtype: row.subtype as ManualLoanType,
    apr: row.apr ?? 0,
    balances: balances
      .filter((each) => each.accountId === row.id)
      .map(({ date, balance }) => ({ date, balance })),
  }));
}

// A loan payout the app may link to a Manual loan (spec 03, Loan payouts): shown, posted money in
// under a LOAN_DISBURSEMENTS_* code, on an Account that is not a loan, with no Transfer pair, no
// Refund or Reimbursement link, and no link to a Manual loan yet.
export async function listUnlinkedLoanPayouts(database: Database) {
  return database
    .select({
      id: transactions.id,
      postedDate: transactions.postedDate,
      description: transactions.description,
      merchantName: transactions.merchantName,
      counterparties: transactions.counterparties,
    })
    .from(transactions)
    .innerJoin(householdAccounts, eq(householdAccounts.id, transactions.accountId))
    .where(
      and(
        like(transactions.providerCategory, "LOAN_DISBURSEMENTS_%"),
        gt(transactions.amount, 0),
        isNull(transactions.hiddenReason),
        eq(transactions.pending, false),
        ne(householdAccounts.kind, "loan"),
        notExists(
          database
            .select({ id: loanLinks.id })
            .from(loanLinks)
            .where(eq(loanLinks.transactionId, transactions.id)),
        ),
        notExists(
          database
            .select({ id: transferLinks.id })
            .from(transferLinks)
            .where(eq(transferLinks.inTransactionId, transactions.id)),
        ),
        // Nor a Refund or Reimbursement link, which a Member may have made by hand.
        notExists(
          database
            .select({ id: spendingLinks.id })
            .from(spendingLinks)
            .where(eq(spendingLinks.transactionId, transactions.id)),
        ),
      ),
    )
    .orderBy(asc(transactions.postedDate), asc(transactions.id));
}
