import {
  type Database,
  linkTransferByHand,
  listDecisionAccounts,
  listLoanLinksOf,
  listTransferCandidates,
  type OtherLink,
  type Queries,
  readDecisionRecords,
  readLink,
  refuseOtherLink,
  refuseTransferLink,
  storeOtherLink,
  type TransferPair,
} from "../db/index.ts";
import { followUpAgain } from "../follow-up/index.ts";
import { log } from "../log.ts";
import { followUpSoon } from "./matching.ts";
import { loanLinkedIds } from "./other-links.ts";
import { passesHandFilters } from "./transfers.ts";

// Hand links and Undo (spec 03, Undo and hand links). A Member links Transactions by hand, of any
// kind, and undoes any link. The app never makes an undone link again, and re-matching never
// breaks a hand link. Each change makes the Transactions it touches unhandled, and the follow-up
// job matches them again, so Matching never runs beside a sync.

// What a Member links by hand: a Transfer pair, a Refund or Reimbursement and the Spending it
// reduces, or a payment or payout and the Manual loan it belongs to.
export type HandLink = (TransferPair & { kind: "Transfer" }) | OtherLink;

export type HandLinkResult =
  | { outcome: "linked"; linkId: string }
  | { outcome: "not found" }
  | { outcome: "refused"; reason: string };

const REFUSED = {
  Transfer:
    "A Transfer pair is two posted Transactions on two Accounts the app counts: one takes money out, and the other brings the same amount in.",
  spending:
    "A Refund or a Reimbursement is money in, linked to Spending that took money out on or before its date.",
  loan: "A loan link ties a Transaction that moves money to a Manual loan.",
  pending: "A pending Transaction links once it posts.",
} as const;

const refused = (reason: string): HandLinkResult => ({ outcome: "refused", reason });

// Checks a hand link against the hard filters a Member's link must pass. Undefined when it passes.
async function checkHandLink(
  database: Database,
  link: HandLink,
): Promise<HandLinkResult | undefined> {
  if (link.kind === "Transfer") {
    const sides = [link.outTransactionId, link.inTransactionId];
    const shown = await readDecisionRecords(database, sides);
    if (shown.length !== 2 || shown.some((record) => record.hidden))
      return { outcome: "not found" };
    // Pairing reads only posted Transactions on Accounts that are not excluded.
    const found = new Map(
      (await listTransferCandidates(database, { ids: sides })).map((txn) => [txn.id, txn]),
    );
    const out = found.get(link.outTransactionId);
    const into = found.get(link.inTransactionId);
    if (out === undefined || into === undefined || !passesHandFilters(out, into)) {
      return refused(REFUSED.Transfer);
    }
    return undefined;
  }
  if (link.kind === "loan") {
    const [record] = await readDecisionRecords(database, [link.transactionId]);
    if (record === undefined || record.hidden) return { outcome: "not found" };
    // Until a link moves to the posted record that takes a pending one's place, only posted
    // Transactions link, as a Transfer pair does.
    if (record.pending) return refused(REFUSED.pending);
    const accounts = new Map(
      (await listDecisionAccounts(database)).map((account) => [account.id, account]),
    );
    const loan = accounts.get(link.loanAccountId);
    if (loan === undefined || loan.kind !== "loan" || loan.connected) {
      return { outcome: "not found" };
    }
    if (record.amount === 0 || accounts.get(record.accountId)?.kind === "loan") {
      return refused(REFUSED.loan);
    }
    return undefined;
  }
  const records = await readDecisionRecords(database, [
    link.transactionId,
    link.spendingTransactionId,
  ]);
  const money = records.find((record) => record.id === link.transactionId);
  const spent = records.find((record) => record.id === link.spendingTransactionId);
  if (money === undefined || spent === undefined || money.hidden || spent.hidden) {
    return { outcome: "not found" };
  }
  if (money.pending || spent.pending) return refused(REFUSED.pending);
  if (money.amount <= 0 || spent.amount >= 0 || spent.postedDate > money.postedDate) {
    return refused(REFUSED.spending);
  }
  return undefined;
}

// The Transactions a link's change touches: its own, and, for a loan, each other Transaction
// linked to that loan, whose interest counts from the one before it.
async function touchedBy(database: Database, link: HandLink): Promise<string[]> {
  if (link.kind === "Transfer") return [link.outTransactionId, link.inTransactionId];
  if (link.kind === "loan") {
    return [link.transactionId, ...(await loanLinkedIds(database, [link.loanAccountId]))];
  }
  return [link.transactionId, link.spendingTransactionId];
}

// A Member links Transactions by hand. The link takes the place of every other link its
// Transactions had. Its evidence says "Member".
export async function linkByHand(
  database: Database,
  link: HandLink,
  memberId: string,
  now = new Date(),
): Promise<HandLinkResult> {
  const problem = await checkHandLink(database, link);
  if (problem !== undefined) return problem;
  // A loan the Transaction leaves decides its other payments again too.
  const leaving =
    link.kind === "Transfer" ? [] : await listLoanLinksOf(database, [link.transactionId]);
  const touched = [
    ...(await touchedBy(database, link)),
    ...(await loanLinkedIds(
      database,
      leaving.map((old) => old.loanAccountId),
    )),
  ];
  const linkId = await database.transaction(async (tx) => {
    const made =
      link.kind === "Transfer"
        ? await linkTransferByHand(
            tx,
            { outTransactionId: link.outTransactionId, inTransactionId: link.inTransactionId },
            { memberId, at: now },
          )
        : await storeOtherLink(tx, link, {
            tier: "Unclear",
            signals: [],
            aiAnswer: null,
            aiConfidence: null,
            madeBy: "Member",
            memberId,
            createdAt: now,
          });
    await followUpAgain(tx, [...new Set([...touched, ...made.ended])]);
    return made.id;
  });
  await followUpSoon();
  log.info("A Member linked Transactions by hand", { kind: link.kind });
  return { outcome: "linked", linkId };
}

// A Member undoes a link of any kind. The app never makes that same link again, and matches both
// sides again without it. False when no link has the ID.
export async function undoLink(
  database: Database,
  linkId: string,
  memberId: string,
  now = new Date(),
): Promise<boolean> {
  const found = await readLink(database, linkId);
  if (found === undefined) return false;
  const link: HandLink =
    found.kind === "Transfer"
      ? {
          kind: "Transfer",
          outTransactionId: found.link.outTransactionId,
          inTransactionId: found.link.inTransactionId,
        }
      : found.kind === "loan"
        ? {
            kind: "loan",
            transactionId: found.link.transactionId,
            loanAccountId: found.link.loanAccountId,
          }
        : {
            kind: found.kind,
            transactionId: found.link.transactionId,
            spendingTransactionId: found.link.spendingTransactionId,
          };
  const touched = await touchedBy(database, link);
  const by = { refusedBy: "Member" as const, memberId, at: now };
  await database.transaction(async (tx: Queries) => {
    if (link.kind === "Transfer") await refuseTransferLink(tx, link, by);
    else await refuseOtherLink(tx, link, by);
    await followUpAgain(tx, touched);
  });
  await followUpSoon();
  log.info("A Member undid a link", { kind: link.kind });
  return true;
}
