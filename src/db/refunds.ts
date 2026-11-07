import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  sql,
} from "drizzle-orm";
import type { Database, Queries } from "./client.ts";
import type { LinkEvidence } from "./links.ts";
import {
  loanLinks,
  refusedLinks,
  spendingLinks,
  transactionParts,
  transactions,
  transferLinks,
} from "./schema.ts";

// Refunds and Reimbursements in app.db (spec 03, Refunds, Link shapes): the Spending a purchase
// has to reduce, and the money linked to it. The money-movement module decides; these functions
// read.

// SQLite takes at most 32,766 values in one statement.
const IDS_PER_QUERY = 500;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += IDS_PER_QUERY) {
    out.push(items.slice(start, start + IDS_PER_QUERY));
  }
  return out;
}

// The money in linked to one Spending, as a Refund or a Reimbursement, with the fixed key a tie
// breaks on: its dates, its provider ID, and its description.
export type ReducingLink = {
  transactionId: string;
  spendingTransactionId: string;
  amount: number;
  postedDate: string;
  authorizedDate: string | null;
  providerTransactionId: string;
  description: string;
};

// Each of these Transactions' Spending, positive and in whole cents: the sum of its Spending
// parts. And every shown Refund or Reimbursement linked to one of them. Two statements a chunk.
export async function readSpendingToReduce(
  database: Database,
  spendingIds: readonly string[],
): Promise<{ spending: Map<string, number>; links: ReducingLink[] }> {
  const spending = new Map<string, number>();
  const links: ReducingLink[] = [];
  for (const chunk of chunks([...new Set(spendingIds)])) {
    const sums = await database
      .select({
        id: transactionParts.transactionId,
        sum: sql<number>`sum(${transactionParts.amount})`,
      })
      .from(transactionParts)
      .where(
        and(inArray(transactionParts.transactionId, chunk), eq(transactionParts.type, "Spending")),
      )
      .groupBy(transactionParts.transactionId);
    for (const { id, sum } of sums) spending.set(id, Math.max(0, -Number(sum)));
    links.push(
      ...(await database
        .select({
          transactionId: spendingLinks.transactionId,
          spendingTransactionId: spendingLinks.spendingTransactionId,
          amount: transactions.amount,
          postedDate: transactions.postedDate,
          authorizedDate: transactions.authorizedDate,
          providerTransactionId: transactions.providerTransactionId,
          description: transactions.description,
        })
        .from(spendingLinks)
        .innerJoin(transactions, eq(transactions.id, spendingLinks.transactionId))
        .where(
          and(
            inArray(spendingLinks.spendingTransactionId, chunk),
            isNull(transactions.hiddenReason),
          ),
        )),
    );
  }
  return { spending, links };
}

// A purchase a Refund could link to: a shown Transaction with Spending and a Merchant, and with no
// Transfer pair or loan link.
export type RefundPurchase = {
  id: string;
  providerTransactionId: string;
  accountId: string;
  postedDate: string;
  authorizedDate: string | null;
  description: string;
  merchantId: string | null;
  merchantCleanName: string;
};

const boughtOn = sql<string>`coalesce(${transactions.authorizedDate}, ${transactions.postedDate})`;

// Stores the app's new Refund links, one statement for each 500. Neither side has another link to
// end: the Refunds are unlinked money in, and the purchases are money out with no Transfer or loan
// link. A Refund that has taken a link since keeps it.
export async function storeAppRefundLinks(
  database: Queries,
  links: readonly { transactionId: string; spendingTransactionId: string }[],
  evidence: LinkEvidence,
): Promise<void> {
  for (const chunk of chunks(links)) {
    await database
      .insert(spendingLinks)
      .values(
        chunk.map((link) => ({
          id: crypto.randomUUID(),
          kind: "Refund" as const,
          ...link,
          ...evidence,
        })),
      )
      .onConflictDoNothing();
  }
}

// The purchases on these Accounts bought from `from` to `to`, by purchase date when there is one,
// else by posted date, oldest posted first, then by provider ID. One statement a chunk of Accounts.
export async function listRefundPurchases(
  database: Database,
  accountIds: readonly string[],
  from: string,
  to: string,
): Promise<RefundPurchase[]> {
  const found: RefundPurchase[] = [];
  for (const chunk of chunks([...new Set(accountIds)])) {
    const rows = await database
      .selectDistinct({
        id: transactions.id,
        providerTransactionId: transactions.providerTransactionId,
        accountId: transactions.accountId,
        postedDate: transactions.postedDate,
        authorizedDate: transactions.authorizedDate,
        description: transactions.description,
        merchantId: transactions.merchantId,
        merchantCleanName: sql<string>`${transactions.merchantCleanName}`,
      })
      .from(transactions)
      .innerJoin(
        transactionParts,
        and(
          eq(transactionParts.transactionId, transactions.id),
          eq(transactionParts.type, "Spending"),
        ),
      )
      .where(
        and(
          inArray(transactions.accountId, chunk),
          // A purchase posts on or after the day it was bought.
          gte(transactions.postedDate, from),
          gte(boughtOn, from),
          lte(boughtOn, to),
          lt(transactions.amount, 0),
          isNull(transactions.hiddenReason),
          isNotNull(transactions.merchantCleanName),
          notExists(
            database
              .select({ id: transferLinks.id })
              .from(transferLinks)
              .where(eq(transferLinks.outTransactionId, transactions.id)),
          ),
          notExists(
            database
              .select({ id: loanLinks.id })
              .from(loanLinks)
              .where(eq(loanLinks.transactionId, transactions.id)),
          ),
        ),
      )
      .orderBy(asc(transactions.postedDate), asc(transactions.providerTransactionId));
    found.push(...rows);
  }
  return found.sort(
    (a, b) =>
      a.postedDate.localeCompare(b.postedDate) ||
      a.providerTransactionId.localeCompare(b.providerTransactionId),
  );
}

// Spending a Reimbursement could pay back: shown money out with a Spending part, on any Account.
export type ReimbursableSpending = {
  id: string;
  amount: number;
  postedDate: string;
  authorizedDate: string | null;
  description: string;
  merchantCleanName: string | null;
};

// The Spending bought from `from` to `to`, by purchase date when there is one, else by posted
// date, newest first. One statement.
export async function listReimbursableSpending(
  database: Database,
  from: string,
  to: string,
): Promise<ReimbursableSpending[]> {
  return database
    .selectDistinct({
      id: transactions.id,
      amount: transactions.amount,
      postedDate: transactions.postedDate,
      authorizedDate: transactions.authorizedDate,
      description: transactions.description,
      merchantCleanName: transactions.merchantCleanName,
    })
    .from(transactions)
    .innerJoin(
      transactionParts,
      and(
        eq(transactionParts.transactionId, transactions.id),
        eq(transactionParts.type, "Spending"),
      ),
    )
    .where(
      and(
        // A purchase posts on or after the day it was bought.
        gte(transactions.postedDate, from),
        gte(boughtOn, from),
        lte(boughtOn, to),
        lt(transactions.amount, 0),
        isNull(transactions.hiddenReason),
      ),
    )
    .orderBy(desc(boughtOn), desc(transactions.id));
}

// What each of these Transactions may never link to with a link of this kind, because someone
// refused that link, as "<Transaction ID> <other ID>": the Spending of a Refund or a
// Reimbursement, or a Manual loan.
export async function listRefusedOtherLinks(
  database: Database,
  kind: "Refund" | "Reimbursement" | "loan",
  transactionIds: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const chunk of chunks(transactionIds)) {
    const rows = await database
      .select({ transactionId: refusedLinks.transactionId, otherId: refusedLinks.otherId })
      .from(refusedLinks)
      .where(and(eq(refusedLinks.kind, kind), inArray(refusedLinks.transactionId, chunk)));
    for (const row of rows) found.add(`${row.transactionId} ${row.otherId}`);
  }
  return found;
}
