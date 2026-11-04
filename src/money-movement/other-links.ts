import {
  type Database,
  endOtherLinks,
  type LinkMaker,
  listLoanLinkedTransactions,
  listLoanLinksOf,
  listSpendingLinksOf,
  readDecisionRecords,
} from "../db/index.ts";
import { log } from "../log.ts";
import { passesRefundFilters } from "./refunds.ts";
import { purchaseDate } from "./totals.ts";

// Refund, Reimbursement, and Manual loan links after a provider change (spec 03, Undo and hand
// links). A deleted Transaction's links end with it in app.db. A link whose Transaction no longer
// shows, or no longer passes its link's hard filters, ends here. Transfer pairs end in pairing.

// The Transactions linked to these Manual loans, payments and payouts. A payment's interest counts
// from the one before it, so a change to one decides the loan's others again.
export async function loanLinkedIds(
  database: Database,
  loanAccountIds: readonly string[],
): Promise<string[]> {
  const linked = await listLoanLinkedTransactions(database, loanAccountIds);
  return linked.map((link) => link.transactionId);
}

// Ends the Refund, Reimbursement, and loan links of these Transactions that no longer pass their
// hard filters:
// - a Refund or Reimbursement is money in, its Spending is money out, both show, and the Spending
//   posted first;
// - a Refund the app linked is on its purchase's Account, from the same Merchant, at most 120 days
//   after it;
// - a loan's payment or payout shows, and moves money.
// Returns the Transactions to decide again: each side of an ended link, and every Transaction
// linked to a Manual loan whose links changed or ended.
export async function endBrokenOtherLinks(
  database: Database,
  transactionIds: readonly string[],
): Promise<string[]> {
  const spending = await listSpendingLinksOf(database, transactionIds);
  const loans = await listLoanLinksOf(database, transactionIds);
  if (spending.length === 0 && loans.length === 0) return [];
  const records = new Map(
    (
      await readDecisionRecords(database, [
        ...spending.flatMap((link) => [link.transactionId, link.spendingTransactionId]),
        ...loans.map((link) => link.transactionId),
      ])
    ).map((record) => [record.id, record]),
  );
  const endedSpending = spending.filter((link) => {
    const money = records.get(link.transactionId);
    const spent = records.get(link.spendingTransactionId);
    return (
      money === undefined ||
      spent === undefined ||
      money.hidden ||
      spent.hidden ||
      money.amount <= 0 ||
      spent.amount >= 0 ||
      purchaseDate(spent) > money.postedDate ||
      (link.kind === "Refund" && link.madeBy !== "Member" && !passesRefundFilters(money, spent))
    );
  });
  const endedLoans = loans.filter((link) => {
    const record = records.get(link.transactionId);
    return record === undefined || record.hidden || record.amount === 0;
  });
  await endOtherLinks(database, {
    spending: endedSpending.map((link) => link.id),
    loan: endedLoans.map((link) => link.id),
  });
  const ended = endedSpending.length + endedLoans.length;
  if (ended > 0) log.info("Ended links that no longer pass their hard filters", { ended });
  return [
    ...endedSpending.flatMap((link) => [link.transactionId, link.spendingTransactionId]),
    ...endedLoans.map((link) => link.transactionId),
    ...(await loanLinkedIds(database, [...new Set(loans.map((link) => link.loanAccountId))])),
  ];
}

// A Refund, Reimbursement, or loan link's evidence (spec 03, Evidence).
export type OtherLinkEvidence = {
  id: string;
  kind: "Refund" | "Reimbursement" | "loan";
  // The Transaction on the other side, for a Refund or a Reimbursement; else null.
  otherTransactionId: string | null;
  // The Manual loan, for a loan link; else null.
  loanAccountId: string | null;
  tier: "Strong" | "Unclear";
  signals: string[];
  aiAnswer: "yes" | "no" | null;
  aiConfidence: "high" | "medium" | "low" | null;
  madeBy: LinkMaker;
};

// The Refund, Reimbursement, and loan links that use the Transaction, with their evidence.
export async function readOtherLinkEvidence(
  database: Database,
  transactionId: string,
): Promise<OtherLinkEvidence[]> {
  const spending = (await listSpendingLinksOf(database, [transactionId])).map((link) => ({
    id: link.id,
    kind: link.kind,
    otherTransactionId:
      link.transactionId === transactionId ? link.spendingTransactionId : link.transactionId,
    loanAccountId: null,
    tier: link.tier,
    signals: link.signals,
    aiAnswer: link.aiAnswer,
    aiConfidence: link.aiConfidence,
    madeBy: link.madeBy,
  }));
  const loans = (await listLoanLinksOf(database, [transactionId])).map((link) => ({
    id: link.id,
    kind: "loan" as const,
    otherTransactionId: null,
    loanAccountId: link.loanAccountId,
    tier: link.tier,
    signals: link.signals,
    aiAnswer: link.aiAnswer,
    aiConfidence: link.aiConfidence,
    madeBy: link.madeBy,
  }));
  return [...spending, ...loans];
}
