import { aliasedTable, and, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Database, Queries } from "./client.ts";
import {
  householdAccounts,
  loanLinks,
  refusedLinks,
  refusedTransferLinks,
  spendingLinks,
  transactionDecisions,
  transactions,
  transferLinks,
} from "./schema.ts";

// Links in app.db (spec 03, Links, Evidence, Undo and hand links): Transfer pairs, a Refund or a
// Reimbursement and its Spending, and a Manual loan and its payment or payout. The money-movement
// module decides; these functions store and read.

// SQLite takes at most 32,766 values in one statement.
const IDS_PER_QUERY = 500;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += IDS_PER_QUERY) {
    out.push(items.slice(start, start + IDS_PER_QUERY));
  }
  return out;
}

export type StoredTransferLink = typeof transferLinks.$inferSelect;
export type NewTransferLink = Omit<StoredTransferLink, "id">;
export type TransferLinkMaker = StoredTransferLink["madeBy"];

// What Transfer pairing reads of a Transaction and its Account.
export type TransferCandidate = {
  id: string;
  accountId: string;
  amount: number;
  postedDate: string;
  description: string;
  providerCategory: string | null;
  counterparties: { name: string; type: string }[];
  handSet: Record<string, unknown>;
  accountKind: string;
  mask: string | null;
  institutionId: string | null;
  institutionName: string | null;
};

// Which Transactions to read for Transfer pairing: these IDs, or each one with one of these
// amounts, either way, posted from `from` to `to`.
export type TransferCandidateFilter =
  | { ids: readonly string[] }
  | { amounts: readonly number[]; from: string; to: string };

// The Transactions that could pair: each shown Transaction that the filter names. Pending
// Transactions pair at once, and their links carry over when they post (spec 03, Pending
// Transactions). An excluded Account's Transactions still pair: money between it and an included
// Account is a Transfer (spec 03, Transaction types).
export async function listTransferCandidates(
  database: Database,
  filter: TransferCandidateFilter,
): Promise<TransferCandidate[]> {
  const chosen =
    "ids" in filter
      ? chunks(filter.ids).map((chunk) => inArray(transactions.id, chunk))
      : chunks(filter.amounts.filter((amount) => amount !== 0)).map((chunk) =>
          and(
            inArray(transactions.amount, [...chunk, ...chunk.map((amount) => -amount)]),
            gte(transactions.postedDate, filter.from),
            lte(transactions.postedDate, filter.to),
          ),
        );
  const found: TransferCandidate[] = [];
  for (const where of chosen) {
    const rows = await database
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        amount: transactions.amount,
        postedDate: transactions.postedDate,
        description: transactions.description,
        providerCategory: transactions.providerCategory,
        counterparties: transactions.counterparties,
        handSet: transactions.handSet,
        accountKind: householdAccounts.kind,
        mask: householdAccounts.mask,
        institutionId: householdAccounts.institutionId,
        institutionName: householdAccounts.institutionName,
      })
      .from(transactions)
      .innerJoin(householdAccounts, eq(householdAccounts.id, transactions.accountId))
      .where(and(where, ne(transactions.amount, 0), isNull(transactions.hiddenReason)));
    found.push(...rows);
  }
  return found;
}

const touching = (ids: string[]) =>
  or(inArray(transferLinks.outTransactionId, ids), inArray(transferLinks.inTransactionId, ids));

// The links that use any of these Transactions.
export async function listTransferLinksOf(
  database: Queries,
  transactionIds: readonly string[],
): Promise<StoredTransferLink[]> {
  const found = new Map<string, StoredTransferLink>();
  for (const chunk of chunks(transactionIds)) {
    for (const link of await database.select().from(transferLinks).where(touching(chunk))) {
      found.set(link.id, link);
    }
  }
  return [...found.values()];
}

// Each link with an Account among these, with both sides' Accounts and posted dates.
export async function listTransferLinkDates(database: Database, accountIds: readonly string[]) {
  const outTxn = aliasedTable(transactions, "out_txn");
  const inTxn = aliasedTable(transactions, "in_txn");
  const found = new Map<
    string,
    {
      id: string;
      outTransactionId: string;
      inTransactionId: string;
      outAccountId: string;
      inAccountId: string;
      outDate: string;
      inDate: string;
    }
  >();
  for (const chunk of chunks(accountIds)) {
    const rows = await database
      .select({
        id: transferLinks.id,
        outTransactionId: transferLinks.outTransactionId,
        inTransactionId: transferLinks.inTransactionId,
        outAccountId: outTxn.accountId,
        inAccountId: inTxn.accountId,
        outDate: outTxn.postedDate,
        inDate: inTxn.postedDate,
      })
      .from(transferLinks)
      .innerJoin(outTxn, eq(outTxn.id, transferLinks.outTransactionId))
      .innerJoin(inTxn, eq(inTxn.id, transferLinks.inTransactionId))
      .where(or(inArray(outTxn.accountId, chunk), inArray(inTxn.accountId, chunk)));
    for (const row of rows) found.set(row.id, row);
  }
  return [...found.values()];
}

// The refused pairs whose money-out side is among these, as "out in" keys.
export async function listRefusedTransferLinks(
  database: Database,
  outTransactionIds: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const chunk of chunks(outTransactionIds)) {
    const rows = await database
      .select()
      .from(refusedTransferLinks)
      .where(inArray(refusedTransferLinks.outTransactionId, chunk));
    for (const row of rows) found.add(`${row.outTransactionId} ${row.inTransactionId}`);
  }
  return found;
}

// Removes, changes, and adds links in one transaction. Removals go first, so a Transaction may
// move from one pair to another.
export async function saveTransferLinks(
  database: Database,
  changes: {
    remove: readonly string[];
    update: readonly { id: string; fields: Partial<NewTransferLink> }[];
    add: readonly NewTransferLink[];
  },
): Promise<void> {
  const { remove, update, add } = changes;
  if (remove.length === 0 && update.length === 0 && add.length === 0) return;
  await database.transaction(async (tx) => {
    for (const chunk of chunks(remove)) {
      await tx.delete(transferLinks).where(inArray(transferLinks.id, chunk));
    }
    for (const { id, fields } of update) {
      await tx.update(transferLinks).set(fields).where(eq(transferLinks.id, id));
    }
    for (const chunk of chunks(add)) {
      await tx
        .insert(transferLinks)
        .values(chunk.map((link) => ({ id: crypto.randomUUID(), ...link })));
    }
  });
}

export type TransferPair = { outTransactionId: string; inTransactionId: string };

const isPair = (pair: TransferPair) =>
  and(
    eq(transferLinks.outTransactionId, pair.outTransactionId),
    eq(transferLinks.inTransactionId, pair.inTransactionId),
  );

// A Member links the pair by hand. It takes the place of any other link either side had. Writes
// only through `database`, so it may run inside a Review list answer's transaction. Returns the
// link's ID, and the Transactions whose other links ended with it.
export async function linkTransferByHand(
  database: Queries,
  pair: TransferPair,
  by: { memberId: string; at: Date },
): Promise<{ id: string; ended: string[] }> {
  const [existing] = await database.select().from(transferLinks).where(isPair(pair));
  if (existing !== undefined) {
    await database
      .update(transferLinks)
      .set({ madeBy: "Member", memberId: by.memberId, uncertain: false })
      .where(eq(transferLinks.id, existing.id));
    return { id: existing.id, ended: [] };
  }
  const ended = await endLinksUsing(database, [pair.outTransactionId, pair.inTransactionId]);
  const id = crypto.randomUUID();
  await database.insert(transferLinks).values({
    id,
    ...pair,
    tier: "Unclear",
    signals: [],
    madeBy: "Member",
    memberId: by.memberId,
    createdAt: by.at,
  });
  return { id, ended };
}

// Ends the pair's link, if it has one, and records that the app never makes it again. Writes only
// through `database`.
export async function refuseTransferLink(
  database: Queries,
  pair: TransferPair,
  by: { refusedBy: "AI" | "Member"; memberId?: string; at: Date },
): Promise<void> {
  await database.delete(transferLinks).where(isPair(pair));
  await database
    .insert(refusedTransferLinks)
    .values({ ...pair, refusedBy: by.refusedBy, memberId: by.memberId ?? null, refusedAt: by.at })
    .onConflictDoNothing();
}

// The Transfer link that uses this Transaction, or undefined.
export async function readTransferLink(
  database: Database,
  transactionId: string,
): Promise<StoredTransferLink | undefined> {
  const [link] = await listTransferLinksOf(database, [transactionId]);
  return link;
}

// Transactions the order decided by a link, at steps 2, 3, and 4, whose link has ended since.
export async function listUnlinkedTransferDecisions(database: Database): Promise<string[]> {
  const rows = await database
    .select({ id: transactionDecisions.transactionId })
    .from(transactionDecisions)
    .where(
      and(
        inArray(transactionDecisions.step, ["2", "3", "4"]),
        sql`NOT EXISTS (
          SELECT 1 FROM ${transferLinks}
          WHERE ${sql.identifier("out_transaction_id")} = "transaction_decisions"."transaction_id"
             OR ${sql.identifier("in_transaction_id")} = "transaction_decisions"."transaction_id"
        )`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${loanLinks}
          WHERE ${loanLinks.transactionId} = "transaction_decisions"."transaction_id"
        )`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${spendingLinks}
          WHERE ${spendingLinks.transactionId} = "transaction_decisions"."transaction_id"
        )`,
      ),
    );
  return rows.map((row) => row.id);
}

export type StoredSpendingLink = typeof spendingLinks.$inferSelect;
export type StoredLoanLink = typeof loanLinks.$inferSelect;
export type SpendingLinkKind = StoredSpendingLink["kind"];
export type LinkMaker = StoredLoanLink["madeBy"];

// What a link stores besides its Transactions (spec 03, Evidence).
export type LinkEvidence = Pick<
  StoredLoanLink,
  "tier" | "signals" | "aiAnswer" | "aiConfidence" | "madeBy" | "memberId" | "createdAt"
>;

// Ends every link of any kind that uses one of these Transactions, on either side. Returns the
// Transactions on the other sides.
async function endLinksUsing(database: Queries, ids: readonly string[]): Promise<string[]> {
  const others = new Set<string>();
  for (const link of await listTransferLinksOf(database, ids)) {
    others.add(link.outTransactionId).add(link.inTransactionId);
  }
  for (const link of await listSpendingLinksOf(database, ids)) {
    others.add(link.transactionId).add(link.spendingTransactionId);
  }
  for (const chunk of chunks(ids)) {
    await database.delete(transferLinks).where(touching(chunk));
    await database.delete(spendingLinks).where(spendingTouching(chunk));
    await database.delete(loanLinks).where(inArray(loanLinks.transactionId, chunk));
  }
  for (const id of ids) others.delete(id);
  return [...others];
}

const spendingTouching = (ids: string[]) =>
  or(inArray(spendingLinks.transactionId, ids), inArray(spendingLinks.spendingTransactionId, ids));

// The Refund and Reimbursement links that use any of these Transactions, on either side.
export async function listSpendingLinksOf(
  database: Queries,
  transactionIds: readonly string[],
): Promise<StoredSpendingLink[]> {
  const found = new Map<string, StoredSpendingLink>();
  for (const chunk of chunks(transactionIds)) {
    for (const link of await database.select().from(spendingLinks).where(spendingTouching(chunk))) {
      found.set(link.id, link);
    }
  }
  return [...found.values()];
}

// The Manual loan links of these Transactions.
export async function listLoanLinksOf(
  database: Queries,
  transactionIds: readonly string[],
): Promise<StoredLoanLink[]> {
  const found: StoredLoanLink[] = [];
  for (const chunk of chunks(transactionIds)) {
    found.push(
      ...(await database.select().from(loanLinks).where(inArray(loanLinks.transactionId, chunk))),
    );
  }
  return found;
}

// The Transactions among these that a Refund, Reimbursement, or loan link uses, so Transfer
// pairing leaves them out.
export async function listLinkedOtherwise(
  database: Database,
  transactionIds: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const link of await listSpendingLinksOf(database, transactionIds)) {
    found.add(link.transactionId).add(link.spendingTransactionId);
  }
  for (const link of await listLoanLinksOf(database, transactionIds)) found.add(link.transactionId);
  return found;
}

// Each shown Transaction linked to one of these Manual loans, with its date, amount, Account and
// Merchant, oldest first.
export async function listLoanLinkedTransactions(
  database: Database,
  loanAccountIds: readonly string[],
) {
  if (loanAccountIds.length === 0) return [];
  return database
    .select({
      loanAccountId: loanLinks.loanAccountId,
      transactionId: loanLinks.transactionId,
      madeBy: loanLinks.madeBy,
      amount: transactions.amount,
      postedDate: transactions.postedDate,
      accountId: transactions.accountId,
      merchantId: transactions.merchantId,
      merchantCleanName: transactions.merchantCleanName,
    })
    .from(loanLinks)
    .innerJoin(transactions, eq(transactions.id, loanLinks.transactionId))
    .where(
      and(inArray(loanLinks.loanAccountId, [...loanAccountIds]), isNull(transactions.hiddenReason)),
    )
    .orderBy(transactions.postedDate, transactions.id);
}

// A link of any kind, by its ID.
export type AnyLink =
  | { kind: "Transfer"; link: StoredTransferLink }
  | { kind: SpendingLinkKind; link: StoredSpendingLink }
  | { kind: "loan"; link: StoredLoanLink };

export async function readLink(database: Queries, id: string): Promise<AnyLink | undefined> {
  const [transfer] = await database.select().from(transferLinks).where(eq(transferLinks.id, id));
  if (transfer !== undefined) return { kind: "Transfer", link: transfer };
  const [spending] = await database.select().from(spendingLinks).where(eq(spendingLinks.id, id));
  if (spending !== undefined) return { kind: spending.kind, link: spending };
  const [loan] = await database.select().from(loanLinks).where(eq(loanLinks.id, id));
  return loan === undefined ? undefined : { kind: "loan", link: loan };
}

// A Refund or Reimbursement and its Spending, or a Manual loan and its payment or payout.
export type OtherLink =
  | { kind: SpendingLinkKind; transactionId: string; spendingTransactionId: string }
  | { kind: "loan"; transactionId: string; loanAccountId: string };

const otherIdOf = (link: OtherLink) =>
  link.kind === "loan" ? link.loanAccountId : link.spendingTransactionId;

// Makes a Refund, Reimbursement, or loan link, or gives the same link new evidence. It takes the
// place of every other link its Transaction had, and of the Spending's Transfer pair or loan link;
// the Spending keeps its other Refunds and Reimbursements. Writes only through `database`, so it
// may run inside a transaction. Returns the link's ID, and the Transactions whose other links
// ended with it.
export async function storeOtherLink(
  database: Queries,
  link: OtherLink,
  evidence: LinkEvidence,
): Promise<{ id: string; ended: string[] }> {
  if (link.kind === "loan") {
    const [existing] = await database
      .select()
      .from(loanLinks)
      .where(eq(loanLinks.transactionId, link.transactionId));
    if (existing?.loanAccountId === link.loanAccountId) {
      await database.update(loanLinks).set(evidence).where(eq(loanLinks.id, existing.id));
      return { id: existing.id, ended: [] };
    }
    const ended = await endLinksUsing(database, [link.transactionId]);
    const id = crypto.randomUUID();
    await database.insert(loanLinks).values({ id, ...link, ...evidence });
    return { id, ended };
  }
  const { kind, transactionId, spendingTransactionId } = link;
  const [existing] = await database
    .select()
    .from(spendingLinks)
    .where(eq(spendingLinks.transactionId, transactionId));
  if (existing?.spendingTransactionId === spendingTransactionId && existing.kind === kind) {
    await database.update(spendingLinks).set(evidence).where(eq(spendingLinks.id, existing.id));
    return { id: existing.id, ended: [] };
  }
  const ended = await endLinksUsing(database, [transactionId]);
  for (const pair of await listTransferLinksOf(database, [spendingTransactionId])) {
    ended.push(pair.outTransactionId, pair.inTransactionId);
    await database.delete(transferLinks).where(eq(transferLinks.id, pair.id));
  }
  await database.delete(loanLinks).where(eq(loanLinks.transactionId, spendingTransactionId));
  await database
    .delete(spendingLinks)
    .where(eq(spendingLinks.transactionId, spendingTransactionId));
  const id = crypto.randomUUID();
  await database
    .insert(spendingLinks)
    .values({ id, kind, transactionId, spendingTransactionId, ...evidence });
  return { id, ended: ended.filter((other) => other !== spendingTransactionId) };
}

// Ends a Refund, Reimbursement, or loan link, and records that the app never makes it again.
// Writes only through `database`.
export async function refuseOtherLink(
  database: Queries,
  link: OtherLink,
  by: { refusedBy: "AI" | "Member"; memberId?: string; at: Date },
): Promise<void> {
  if (link.kind === "loan") {
    await database
      .delete(loanLinks)
      .where(
        and(
          eq(loanLinks.transactionId, link.transactionId),
          eq(loanLinks.loanAccountId, link.loanAccountId),
        ),
      );
  } else {
    await database
      .delete(spendingLinks)
      .where(
        and(
          eq(spendingLinks.transactionId, link.transactionId),
          eq(spendingLinks.spendingTransactionId, link.spendingTransactionId),
        ),
      );
  }
  await database
    .insert(refusedLinks)
    .values({
      kind: link.kind,
      transactionId: link.transactionId,
      otherId: otherIdOf(link),
      refusedBy: by.refusedBy,
      memberId: by.memberId ?? null,
      refusedAt: by.at,
    })
    .onConflictDoNothing();
}

// Whether someone refused this Refund, Reimbursement, or loan link, so the app never makes it.
export async function isOtherLinkRefused(database: Queries, link: OtherLink): Promise<boolean> {
  const [row] = await database
    .select({ kind: refusedLinks.kind })
    .from(refusedLinks)
    .where(
      and(
        eq(refusedLinks.kind, link.kind),
        eq(refusedLinks.transactionId, link.transactionId),
        eq(refusedLinks.otherId, otherIdOf(link)),
      ),
    );
  return row !== undefined;
}

// Ends these Refund, Reimbursement, and loan links, by ID. The app may make them again.
export async function endOtherLinks(
  database: Database,
  ended: { spending: readonly string[]; loan: readonly string[] },
): Promise<void> {
  if (ended.spending.length === 0 && ended.loan.length === 0) return;
  await database.transaction(async (tx) => {
    for (const chunk of chunks(ended.spending)) {
      await tx.delete(spendingLinks).where(inArray(spendingLinks.id, chunk));
    }
    for (const chunk of chunks(ended.loan)) {
      await tx.delete(loanLinks).where(inArray(loanLinks.id, chunk));
    }
  });
}

// Pending to posted (spec 03, Pending Transactions; spec 02, Changes to synced data): moves every
// link and every refusal that uses the pending Transaction `from` to the posted one `to`. A link
// whose place `to` already holds, as one side of a Transfer pair or as a Refund, Reimbursement, or
// loan payment, ends instead. Matching then checks each carried link's hard filters again. Writes
// only through `database`, so it runs inside the sync page's transaction. Returns the Transactions
// on the other sides, which Matching decides again.
export async function carryLinks(database: Queries, from: string, to: string): Promise<string[]> {
  const others = new Set<string>();
  const taken = (await listTransferLinksOf(database, [to])).length > 0;
  for (const link of await listTransferLinksOf(database, [from])) {
    others.add(link.outTransactionId === from ? link.inTransactionId : link.outTransactionId);
    if (taken) {
      await database.delete(transferLinks).where(eq(transferLinks.id, link.id));
      continue;
    }
    await database
      .update(transferLinks)
      .set(link.outTransactionId === from ? { outTransactionId: to } : { inTransactionId: to })
      .where(eq(transferLinks.id, link.id));
  }
  for (const link of await listSpendingLinksOf(database, [from])) {
    if (link.transactionId === from) {
      others.add(link.spendingTransactionId);
      const [held] = await database
        .select({ id: spendingLinks.id })
        .from(spendingLinks)
        .where(eq(spendingLinks.transactionId, to));
      if (held === undefined && link.spendingTransactionId !== to) {
        await database
          .update(spendingLinks)
          .set({ transactionId: to })
          .where(eq(spendingLinks.id, link.id));
      } else {
        await database.delete(spendingLinks).where(eq(spendingLinks.id, link.id));
      }
    } else {
      others.add(link.transactionId);
      await database
        .update(spendingLinks)
        .set({ spendingTransactionId: to })
        .where(eq(spendingLinks.id, link.id));
    }
  }
  const [held] = await database
    .select({ id: loanLinks.id })
    .from(loanLinks)
    .where(eq(loanLinks.transactionId, to));
  if (held === undefined) {
    await database
      .update(loanLinks)
      .set({ transactionId: to })
      .where(eq(loanLinks.transactionId, from));
  } else {
    await database.delete(loanLinks).where(eq(loanLinks.transactionId, from));
  }
  // The app never makes an undone link again, on the posted record either.
  const refusedPairs = await database
    .select()
    .from(refusedTransferLinks)
    .where(
      or(
        eq(refusedTransferLinks.outTransactionId, from),
        eq(refusedTransferLinks.inTransactionId, from),
      ),
    );
  if (refusedPairs.length > 0) {
    const moved = (id: string) => (id === from ? to : id);
    await database
      .insert(refusedTransferLinks)
      .values(
        refusedPairs.map((row) => ({
          ...row,
          outTransactionId: moved(row.outTransactionId),
          inTransactionId: moved(row.inTransactionId),
        })),
      )
      .onConflictDoNothing();
  }
  const refused = await database
    .select()
    .from(refusedLinks)
    .where(or(eq(refusedLinks.transactionId, from), eq(refusedLinks.otherId, from)));
  if (refused.length > 0) {
    await database
      .insert(refusedLinks)
      .values(
        refused.map((row) => ({
          ...row,
          transactionId: row.transactionId === from ? to : row.transactionId,
          otherId: row.otherId === from ? to : row.otherId,
        })),
      )
      .onConflictDoNothing();
  }
  others.delete(from);
  others.delete(to);
  return [...others];
}
