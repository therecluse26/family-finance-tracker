import {
  type AnyColumn,
  aliasedTable,
  and,
  eq,
  exists,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Database, Queries } from "./client.ts";
import { markTransactionsUnhandled } from "./follow-up.ts";
import {
  connectionCarryOvers,
  connections,
  householdAccounts,
  loanLinks,
  refusedLinks,
  refusedTransferLinks,
  spendingLinks,
  transactions,
  transferLinks,
} from "./schema.ts";

// Link carry-over in app.db (spec 02, Carrying Accounts over; spec 03, Undo and hand links): after
// Link again or a new link of a removed bank, an old Transaction hidden as "replaced by re-link"
// hands its hand-made links to its new copy. The money-movement module pairs old and new; these
// functions read and store.

// SQLite takes at most 32,766 values in one statement.
const IDS_PER_QUERY = 500;
const MOVES_PER_STATEMENT = 200;

function chunks<T>(items: readonly T[], size = IDS_PER_QUERY): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    out.push(items.slice(start, start + size));
  }
  return out;
}

// What pairing an old Transaction with its new copy reads.
export type CarryOverTransaction = {
  id: string;
  accountId: string;
  amount: number;
  postedDate: string;
  description: string;
};

const CARRY_OVER_FIELDS = {
  id: transactions.id,
  accountId: transactions.accountId,
  amount: transactions.amount,
  postedDate: transactions.postedDate,
  description: transactions.description,
};

// A link a Member made that uses the Transaction, of any kind.
function handLinked(database: Queries): SQL {
  const id = transactions.id;
  return or(
    exists(
      database
        .select({ id: transferLinks.id })
        .from(transferLinks)
        .where(
          and(
            eq(transferLinks.madeBy, "Member"),
            or(eq(transferLinks.outTransactionId, id), eq(transferLinks.inTransactionId, id)),
          ),
        ),
    ),
    exists(
      database
        .select({ id: spendingLinks.id })
        .from(spendingLinks)
        .where(
          and(
            eq(spendingLinks.madeBy, "Member"),
            or(eq(spendingLinks.transactionId, id), eq(spendingLinks.spendingTransactionId, id)),
          ),
        ),
    ),
    exists(
      database
        .select({ id: loanLinks.id })
        .from(loanLinks)
        .where(and(eq(loanLinks.madeBy, "Member"), eq(loanLinks.transactionId, id))),
    ),
  ) as SQL;
}

// A refusal that names the Transaction on either side: an undone Transfer pair, or an undone
// Refund, Reimbursement, or loan link (spec 03, Undo and hand links).
function refused(database: Queries): SQL {
  const id = transactions.id;
  return or(
    exists(
      database
        .select({ one: sql`1` })
        .from(refusedTransferLinks)
        .where(
          or(
            eq(refusedTransferLinks.outTransactionId, id),
            eq(refusedTransferLinks.inTransactionId, id),
          ),
        ),
    ),
    exists(
      database
        .select({ one: sql`1` })
        .from(refusedLinks)
        .where(or(eq(refusedLinks.transactionId, id), eq(refusedLinks.otherId, id))),
    ),
  ) as SQL;
}

// An old Transaction of a carried Account: hidden as "replaced by re-link", and from another
// Connection than the one its Account now belongs to.
const replacedOld = and(
  eq(transactions.hiddenReason, "replaced by re-link"),
  ne(transactions.connectionId, householdAccounts.connectionId),
);

// Of these Transactions, each that may be a new copy: shown, from the Connection its Account
// belongs to, and with no link of any kind, so a moved link takes no other link's place.
export async function listPossibleCopies(
  database: Database,
  transactionIds: readonly string[],
): Promise<CarryOverTransaction[]> {
  const found: CarryOverTransaction[] = [];
  for (const chunk of chunks(transactionIds)) {
    const rows = await database
      .select(CARRY_OVER_FIELDS)
      .from(transactions)
      .innerJoin(householdAccounts, eq(householdAccounts.id, transactions.accountId))
      .where(
        and(
          inArray(transactions.id, chunk),
          isNull(transactions.hiddenReason),
          eq(transactions.connectionId, householdAccounts.connectionId),
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
              .select({ id: spendingLinks.id })
              .from(spendingLinks)
              .where(
                or(
                  eq(spendingLinks.transactionId, transactions.id),
                  eq(spendingLinks.spendingTransactionId, transactions.id),
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
      );
    found.push(...rows);
  }
  return found;
}

// The old Transactions on these Accounts, posted on these days, that a Member linked by hand, or
// that a refusal names, so the refusal moves to the copy too and the app never makes the undone
// link again on it.
export async function listHandLinkedOld(
  database: Database,
  filter: { accountIds: readonly string[]; postedDates: readonly string[] },
): Promise<CarryOverTransaction[]> {
  const found: CarryOverTransaction[] = [];
  for (const accounts of chunks(filter.accountIds)) {
    for (const dates of chunks(filter.postedDates)) {
      const rows = await database
        .select(CARRY_OVER_FIELDS)
        .from(transactions)
        .innerJoin(householdAccounts, eq(householdAccounts.id, transactions.accountId))
        .where(
          and(
            inArray(transactions.accountId, accounts),
            inArray(transactions.postedDate, dates),
            replacedOld,
            or(handLinked(database), refused(database)),
          ),
        );
      found.push(...rows);
    }
  }
  return found;
}

// Of these Transactions, the old ones whose hand-made links still wait for a new copy (spec 02,
// Link carry-over). The wait ends when the first history load of their Account's Connection ends,
// when that Connection is removed, or when the sync schedule's job first tries to end it at the
// cap after the carry-over.
export async function listAwaitingCopies(
  database: Database,
  transactionIds: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (const chunk of chunks(transactionIds)) {
    const rows = await database
      .select({ id: transactions.id })
      .from(transactions)
      .innerJoin(householdAccounts, eq(householdAccounts.id, transactions.accountId))
      .innerJoin(connections, eq(connections.id, householdAccounts.connectionId))
      .innerJoin(connectionCarryOvers, eq(connectionCarryOvers.connectionId, connections.id))
      .where(
        and(
          inArray(transactions.id, chunk),
          replacedOld,
          eq(connections.historyLoaded, false),
          isNull(connections.removedAt),
          eq(connectionCarryOvers.copiesWaitEndTries, 0),
        ),
      );
    for (const row of rows) found.add(row.id);
  }
  return found;
}

// Counts one more try to end each wait for copies that began on or before `before`, has not ended
// yet, and has had fewer than `cap` tries. The first try ends the wait. Returns the Connections it
// counted a try for, each with its try's number. The count is its own write, so a try that fails
// still counts.
export async function claimCopyWaitEndTries(
  database: Database,
  before: Date,
  cap: number,
): Promise<{ connectionId: string; tries: number }[]> {
  return database
    .update(connectionCarryOvers)
    .set({ copiesWaitEndTries: sql`${connectionCarryOvers.copiesWaitEndTries} + 1` })
    .where(
      and(
        isNull(connectionCarryOvers.copiesWaitEndedAt),
        lte(connectionCarryOvers.createdAt, before),
        lt(connectionCarryOvers.copiesWaitEndTries, cap),
      ),
    )
    .returning({
      connectionId: connectionCarryOvers.connectionId,
      tries: connectionCarryOvers.copiesWaitEndTries,
    });
}

// Ends these Connections' waits for copies, which claimCopyWaitEndTries just claimed, in one
// transaction: records the time, so no later try claims them, and makes each old Transaction whose
// hand-made links waited unhandled, so Matching ends those links. Returns how many it made
// unhandled.
export async function endCopyWaits(
  database: Database,
  connectionIds: readonly string[],
  at: Date,
): Promise<number> {
  if (connectionIds.length === 0) return 0;
  return database.transaction(async (tx) => {
    const ended = await tx
      .update(connectionCarryOvers)
      .set({ copiesWaitEndedAt: at })
      .where(inArray(connectionCarryOvers.connectionId, [...connectionIds]))
      .returning({ connectionId: connectionCarryOvers.connectionId });
    let unhandled = 0;
    // One row per Connection, so a handful at most.
    for (const { connectionId } of ended) {
      const awaited = await listHandLinkedOldOf(tx, connectionId);
      await markTransactionsUnhandled(tx, awaited);
      await endRefusalsWithNoCopy(tx, connectionId);
      unhandled += awaited.length;
    }
    return unhandled;
  });
}

// When a Connection's wait for copies ends, the refusals on its old Transactions that have no copy
// end too, as their hand-made links do, so a copy that comes later takes none. An old Transaction
// whose copy is stored keeps its refusals for the follow-up job that moves them. One statement a
// refusal table.
export async function endRefusalsWithNoCopy(tx: Queries, connectionId: string): Promise<void> {
  const copy = aliasedTable(transactions, "copy");
  const noCopy = tx
    .select({ id: transactions.id })
    .from(transactions)
    .innerJoin(householdAccounts, eq(householdAccounts.id, transactions.accountId))
    .where(
      and(
        eq(householdAccounts.connectionId, connectionId),
        replacedOld,
        notExists(
          tx
            .select({ one: sql`1` })
            .from(copy)
            .where(
              and(
                eq(copy.accountId, transactions.accountId),
                eq(copy.postedDate, transactions.postedDate),
                eq(copy.amount, transactions.amount),
                eq(copy.connectionId, householdAccounts.connectionId),
                isNull(copy.hiddenReason),
              ),
            ),
        ),
      ),
    );
  await tx
    .delete(refusedTransferLinks)
    .where(
      or(
        inArray(refusedTransferLinks.outTransactionId, noCopy),
        inArray(refusedTransferLinks.inTransactionId, noCopy),
      ),
    );
  await tx
    .delete(refusedLinks)
    .where(or(inArray(refusedLinks.transactionId, noCopy), inArray(refusedLinks.otherId, noCopy)));
}

// The old Transactions on a Connection's Accounts whose hand-made links wait for a copy. The end of
// the wait, by its first history load, its removal, or the cap, makes them unhandled, so Matching
// ends those links.
export async function listHandLinkedOldOf(tx: Queries, connectionId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .innerJoin(householdAccounts, eq(householdAccounts.id, transactions.accountId))
    .where(and(eq(householdAccounts.connectionId, connectionId), replacedOld, handLinked(tx)));
  return rows.map((row) => row.id);
}

// An old Transaction and the new copy its hand-made links move to.
export type LinkMove = { from: string; to: string };

// `column`, with each move's old Transaction swapped for its copy.
function moved(column: AnyColumn, moves: readonly LinkMove[]): SQL {
  const cases = moves.map((move) => sql`WHEN ${move.from} THEN ${move.to}`);
  return sql`CASE ${column} ${sql.join(cases, sql` `)} ELSE ${column} END`;
}

// Moves every link a Member made, and every refusal, from each old Transaction to its copy, in one
// transaction, one statement a table. Each link keeps its ID, kind, evidence, and who made it. Returns the
// Transactions on the links' other sides, and the Manual loans whose links moved.
export async function moveHandLinks(
  database: Database,
  moves: readonly LinkMove[],
): Promise<{ others: string[]; loanAccountIds: string[] }> {
  const others = new Set<string>();
  const loanAccountIds = new Set<string>();
  if (moves.length === 0) return { others: [], loanAccountIds: [] };
  await database.transaction(async (tx) => {
    for (const chunk of chunks(moves, MOVES_PER_STATEMENT)) {
      const from = chunk.map((move) => move.from);
      const transfers = await tx
        .update(transferLinks)
        .set({
          outTransactionId: moved(transferLinks.outTransactionId, chunk),
          inTransactionId: moved(transferLinks.inTransactionId, chunk),
        })
        .where(
          and(
            eq(transferLinks.madeBy, "Member"),
            or(
              inArray(transferLinks.outTransactionId, from),
              inArray(transferLinks.inTransactionId, from),
            ),
          ),
        )
        .returning({ out: transferLinks.outTransactionId, in: transferLinks.inTransactionId });
      for (const link of transfers) others.add(link.out).add(link.in);
      const spending = await tx
        .update(spendingLinks)
        .set({
          transactionId: moved(spendingLinks.transactionId, chunk),
          spendingTransactionId: moved(spendingLinks.spendingTransactionId, chunk),
        })
        .where(
          and(
            eq(spendingLinks.madeBy, "Member"),
            or(
              inArray(spendingLinks.transactionId, from),
              inArray(spendingLinks.spendingTransactionId, from),
            ),
          ),
        )
        .returning({
          money: spendingLinks.transactionId,
          spent: spendingLinks.spendingTransactionId,
        });
      for (const link of spending) others.add(link.money).add(link.spent);
      const loans = await tx
        .update(loanLinks)
        .set({ transactionId: moved(loanLinks.transactionId, chunk) })
        .where(and(eq(loanLinks.madeBy, "Member"), inArray(loanLinks.transactionId, from)))
        .returning({ loanAccountId: loanLinks.loanAccountId });
      for (const link of loans) loanAccountIds.add(link.loanAccountId);
      // Every refusal moves with the hand-made links, on either side, so the app never makes an
      // undone link again on the copy. One the copy already holds stays on the old Transaction.
      const takenPair = aliasedTable(refusedTransferLinks, "taken_pair");
      await tx
        .update(refusedTransferLinks)
        .set({
          outTransactionId: moved(refusedTransferLinks.outTransactionId, chunk),
          inTransactionId: moved(refusedTransferLinks.inTransactionId, chunk),
        })
        .where(
          and(
            or(
              inArray(refusedTransferLinks.outTransactionId, from),
              inArray(refusedTransferLinks.inTransactionId, from),
            ),
            notExists(
              tx
                .select({ one: sql`1` })
                .from(takenPair)
                .where(
                  and(
                    eq(
                      takenPair.outTransactionId,
                      moved(refusedTransferLinks.outTransactionId, chunk),
                    ),
                    eq(
                      takenPair.inTransactionId,
                      moved(refusedTransferLinks.inTransactionId, chunk),
                    ),
                  ),
                ),
            ),
          ),
        );
      const taken = aliasedTable(refusedLinks, "taken");
      await tx
        .update(refusedLinks)
        .set({
          transactionId: moved(refusedLinks.transactionId, chunk),
          otherId: moved(refusedLinks.otherId, chunk),
        })
        .where(
          and(
            or(inArray(refusedLinks.transactionId, from), inArray(refusedLinks.otherId, from)),
            notExists(
              tx
                .select({ one: sql`1` })
                .from(taken)
                .where(
                  and(
                    eq(taken.kind, refusedLinks.kind),
                    eq(taken.transactionId, moved(refusedLinks.transactionId, chunk)),
                    eq(taken.otherId, moved(refusedLinks.otherId, chunk)),
                  ),
                ),
            ),
          ),
        );
    }
  });
  for (const move of moves) others.delete(move.to);
  return { others: [...others], loanAccountIds: [...loanAccountIds] };
}
