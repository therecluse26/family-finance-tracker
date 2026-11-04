import {
  type Database,
  listDecisionAccounts,
  listLoanLinkedTransactions,
  listManualLoans,
  type listPostedParts,
  listTransferLinksOf,
  readLoanHistory,
} from "../db/index.ts";

// Payments on tracked loans (spec 03, Payments on a tracked loan): a connected loan or a Manual
// loan. Which Transactions are payments comes from the loans' own reads: a connected loan's are
// the money into it (readLoanHistory), and a Manual loan's are the money out linked to it
// (listLoanLinkedTransactions). Their dates and Spending parts come from the posted parts the
// draft has already read.

export type PostedPart = Awaited<ReturnType<typeof listPostedParts>>[number];

export type TrackedLoanPayment = {
  loanId: string;
  // True when the loan is Closed.
  closed: boolean;
  // The Transaction that holds the payment's parts: the paying side of a connected loan's Transfer
  // pair, or the loan's own Transaction when no shown, posted Household Transaction sent it, or the
  // Transaction linked to a Manual loan.
  transactionId: string;
  postedDate: string;
  authorizedDate: string | null;
  // The payment's Spending parts, with the Transaction's sign.
  spending: { category: string | null; amount: number }[];
};

type Held = Omit<TrackedLoanPayment, "loanId" | "closed" | "transactionId">;

// Every shown, posted payment on a tracked loan, oldest first. One loan-history read for each
// connected loan, and a fixed number of others.
export async function listTrackedLoanPayments(
  database: Database,
  posted: readonly PostedPart[],
): Promise<TrackedLoanPayment[]> {
  // Each shown, posted Transaction's dates and Spending parts. A linked Refund or Reimbursement
  // part carries its Spending's dates, so it gives none.
  const held = new Map<string, Held>();
  for (const part of posted) {
    if (part.spendingTransactionId !== null) continue;
    let found = held.get(part.transactionId);
    if (found === undefined) {
      found = { postedDate: part.postedDate, authorizedDate: part.authorizedDate, spending: [] };
      held.set(part.transactionId, found);
    }
    if (part.type === "Spending") {
      found.spending.push({ category: part.category, amount: part.amount });
    }
  }

  const payments: TrackedLoanPayment[] = [];
  const landed: { loanId: string; closed: boolean; id: string; postedDate: string }[] = [];
  for (const account of await listDecisionAccounts(database)) {
    if (account.kind !== "loan" || !account.connected) continue;
    for (const payment of (await readLoanHistory(database, account.id)).payments) {
      landed.push({ loanId: account.id, closed: account.closed, ...payment });
    }
  }
  const landedIds = new Set(landed.map((payment) => payment.id));
  const paying = new Map<string, string>();
  for (const link of await listTransferLinksOf(database, [...landedIds])) {
    if (landedIds.has(link.inTransactionId)) {
      paying.set(link.inTransactionId, link.outTransactionId);
    }
  }
  for (const { loanId, closed, id, postedDate } of landed) {
    const payingId = paying.get(id);
    const payingSide = payingId === undefined ? undefined : held.get(payingId);
    if (payingId !== undefined && payingSide !== undefined) {
      payments.push({ loanId, closed, transactionId: payingId, ...payingSide });
    } else {
      const own = held.get(id) ?? { postedDate, authorizedDate: null, spending: [] };
      payments.push({ loanId, closed, transactionId: id, ...own });
    }
  }

  const manual = await listManualLoans(database);
  const closed = new Map(manual.map((loan) => [loan.id, loan.closed]));
  for (const txn of await listLoanLinkedTransactions(
    database,
    manual.map((loan) => loan.id),
  )) {
    // A payout is money in: only the money out is a payment.
    if (txn.amount >= 0) continue;
    // A pending one has no posted parts yet.
    const found = held.get(txn.transactionId);
    if (found === undefined) continue;
    payments.push({
      loanId: txn.loanAccountId,
      closed: closed.get(txn.loanAccountId) ?? false,
      transactionId: txn.transactionId,
      ...found,
    });
  }
  return payments.sort(
    (a, b) =>
      a.postedDate.localeCompare(b.postedDate) || a.transactionId.localeCompare(b.transactionId),
  );
}
