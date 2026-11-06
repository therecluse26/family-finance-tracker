import { and, asc, eq, gt, gte, inArray, isNull, like, lt, ne, notExists, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Database } from "./client.ts";
import {
  householdAccounts,
  loanLinks,
  transactionParts,
  transactions,
  transferLinks,
} from "./schema.ts";

// What "Coming up" reads from app.db (spec 07, 6. Coming up). The server decides; these functions
// read.

// Every Account with the fields that say what it owes and when: its balance, a card's statement
// balance and due date, a connected loan's next payment, and a Manual loan's regular payment.
// Balances use the Transaction sign: money owed is negative.
export async function listDueAccounts(database: Database) {
  return database
    .select({
      id: householdAccounts.id,
      connectionId: householdAccounts.connectionId,
      name: householdAccounts.name,
      memberName: householdAccounts.memberName,
      kind: householdAccounts.kind,
      subtype: householdAccounts.subtype,
      // A connected loan's lender.
      institutionName: householdAccounts.institutionName,
      currentBalance: householdAccounts.currentBalance,
      statementBalance: householdAccounts.statementBalance,
      statementIssueDate: householdAccounts.statementIssueDate,
      minimumPayment: householdAccounts.minimumPayment,
      paymentDueDate: householdAccounts.paymentDueDate,
      regularPayment: householdAccounts.regularPayment,
      excluded: householdAccounts.excluded,
      closedAt: householdAccounts.closedAt,
    })
    .from(householdAccounts)
    .orderBy(asc(householdAccounts.name), asc(householdAccounts.id));
}

// The payments to these cards posted on `from` or later: the Transfer parts of shown, posted
// Transactions that bring money into the card. Oldest first.
export async function listCardPaymentsSince(
  database: Database,
  cardIds: readonly string[],
  from: string,
): Promise<{ accountId: string; postedDate: string; amount: number }[]> {
  if (cardIds.length === 0) return [];
  return database
    .select({
      accountId: transactions.accountId,
      postedDate: transactions.postedDate,
      amount: transactionParts.amount,
    })
    .from(transactionParts)
    .innerJoin(transactions, eq(transactions.id, transactionParts.transactionId))
    .where(
      and(
        inArray(transactions.accountId, [...cardIds]),
        eq(transactionParts.type, "Transfer"),
        gt(transactionParts.amount, 0),
        eq(transactions.pending, false),
        isNull(transactions.hiddenReason),
        gte(transactions.postedDate, from),
      ),
    )
    .orderBy(asc(transactions.postedDate), asc(transactions.id));
}

// The payments to these connected loans posted on `from` or later, oldest first, each at the
// paying Account's amount (money out is negative): the paying side of each Transfer pair into the
// loan, posted and shown.
export async function listPairedLoanPayments(
  database: Database,
  loanIds: readonly string[],
  from: string,
): Promise<{ loanAccountId: string; postedDate: string; amount: number }[]> {
  if (loanIds.length === 0) return [];
  const paying = alias(transactions, "paying_side");
  return database
    .select({
      loanAccountId: transactions.accountId,
      postedDate: paying.postedDate,
      amount: paying.amount,
    })
    .from(transferLinks)
    .innerJoin(transactions, eq(transactions.id, transferLinks.inTransactionId))
    .innerJoin(paying, eq(paying.id, transferLinks.outTransactionId))
    .where(
      and(
        inArray(transactions.accountId, [...loanIds]),
        lt(paying.amount, 0),
        eq(paying.pending, false),
        isNull(paying.hiddenReason),
        gte(paying.postedDate, from),
      ),
    )
    .orderBy(asc(paying.postedDate), asc(paying.id));
}

// Of these Transactions, each that is the paying side of a Transfer pair, with the Account of the
// side that brings the money in.
export async function listTransferTargets(
  database: Database,
  transactionIds: readonly string[],
): Promise<{ transactionId: string; accountId: string }[]> {
  if (transactionIds.length === 0) return [];
  const receiving = alias(transactions, "receiving_side");
  return database
    .select({ transactionId: transferLinks.outTransactionId, accountId: receiving.accountId })
    .from(transferLinks)
    .innerJoin(receiving, eq(receiving.id, transferLinks.inTransactionId))
    .where(inArray(transferLinks.outTransactionId, [...transactionIds]));
}

// The untracked loan payments (spec 03, Untracked loans) posted on `from` or later, oldest first:
// shown, posted money out under a LOAN_PAYMENTS_* code other than a card payment, in no Transfer
// pair, and linked to no Manual loan. Each with its Merchant, which names the lender.
export async function listUntrackedLoanPaymentsSince(
  database: Database,
  from: string,
): Promise<{ id: string; lender: string | null; postedDate: string; amount: number }[]> {
  const lines = await database
    .select({
      id: transactions.id,
      merchantName: transactions.merchantName,
      merchantCleanName: transactions.merchantCleanName,
      postedDate: transactions.postedDate,
      amount: transactions.amount,
    })
    .from(transactions)
    .where(
      and(
        like(transactions.providerCategory, "LOAN_PAYMENTS_%"),
        ne(transactions.providerCategory, "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"),
        lt(transactions.amount, 0),
        eq(transactions.pending, false),
        isNull(transactions.hiddenReason),
        gte(transactions.postedDate, from),
        notExists(
          database
            .select({ id: transferLinks.id })
            .from(transferLinks)
            .where(
              or(
                eq(transferLinks.outTransactionId, transactions.id),
                eq(transferLinks.inTransactionId, transactions.id),
              ),
            ),
        ),
        notExists(
          database
            .select({ id: loanLinks.id })
            .from(loanLinks)
            .where(eq(loanLinks.transactionId, transactions.id)),
        ),
      ),
    )
    .orderBy(asc(transactions.postedDate), asc(transactions.id));
  return lines.map(({ merchantName, merchantCleanName, ...line }) => ({
    ...line,
    lender: merchantCleanName ?? merchantName,
  }));
}
