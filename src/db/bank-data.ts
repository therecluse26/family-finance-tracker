import { and, asc, desc, eq, gte, isNull, lte, type SQL } from "drizzle-orm";
import type {
  AccountSnapshot,
  Provider,
  RemovalReason,
  SyncResult,
  TxnRecord,
} from "../bank/adapter.ts";
import type { Database } from "./client.ts";
import { connections, householdAccounts, transactions } from "./schema.ts";

// Connections, Accounts, and Transactions in app.db (spec 02). The bank module decides; these
// functions store and read.

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type StoredConnection = typeof connections.$inferSelect;

export async function addConnection(
  database: Database,
  connection: {
    provider: Provider;
    bankId: string;
    bankName: string;
    origin: "linked" | "imported";
    syncMinute: number;
  },
  at = new Date(),
): Promise<string> {
  const id = crypto.randomUUID();
  await database.insert(connections).values({ id, ...connection, createdAt: at });
  return id;
}

export async function readConnection(
  database: Database,
  id: string,
): Promise<StoredConnection | undefined> {
  const [row] = await database.select().from(connections).where(eq(connections.id, id));
  return row;
}

// The provider's fields of an Account. A Member's own fields are left out, so sync never writes them.
function accountFields(snapshot: AccountSnapshot) {
  return {
    name: snapshot.name,
    kind: snapshot.type,
    subtype: snapshot.subtype,
    mask: snapshot.mask,
    currentBalance: snapshot.currentBalance,
    availableBalance: snapshot.availableBalance,
    creditLimit: snapshot.creditLimit,
    cardAprs: snapshot.card?.aprs ?? null,
    statementBalance: snapshot.card?.statementBalance ?? null,
    minimumPayment: snapshot.card?.minimumPayment ?? snapshot.loan?.minimumPayment ?? null,
    paymentDueDate: snapshot.card?.dueDate ?? snapshot.loan?.dueDate ?? null,
    loanApr: snapshot.loan?.apr ?? null,
    loanPrincipal: snapshot.loan?.principal ?? null,
    interestPaidThisYear: snapshot.loan?.interestPaidThisYear ?? null,
    raw: snapshot.raw ?? null,
  };
}

// The provider's fields of a Transaction. handSet and the hidden state are left out.
function transactionFields(record: TxnRecord, accountId: string) {
  return {
    accountId,
    amount: record.amount,
    postedDate: record.postedDate,
    authorizedDate: record.authorizedDate,
    pending: record.pending,
    pendingTransactionId: record.pendingTransactionId,
    description: record.description,
    merchantName: record.merchantName,
    merchantId: record.merchantId,
    counterparties: record.counterparties,
    providerCategory: record.category?.name ?? null,
    providerCategoryConfidence: record.category?.confidence ?? null,
    providerCategoryVersion: record.category?.version ?? null,
    mcc: record.category?.mcc ?? null,
    raw: record.raw ?? null,
  };
}

// Whether every field in `next` already holds that value in `row`.
function holds(row: Record<string, unknown>, next: Record<string, unknown>): boolean {
  return Object.entries(next).every(
    ([name, value]) => JSON.stringify(row[name] ?? null) === JSON.stringify(value ?? null),
  );
}

// Adds or updates each Account by its provider ID, and returns each one's app ID by provider ID.
async function storeAccounts(
  tx: Transaction,
  connection: StoredConnection,
  snapshots: AccountSnapshot[],
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const snapshot of snapshots) {
    const fields = {
      ...accountFields(snapshot),
      institutionId: connection.bankId,
      institutionName: connection.bankName,
    };
    const [found] = await tx
      .select({ id: householdAccounts.id })
      .from(householdAccounts)
      .where(
        and(
          eq(householdAccounts.connectionId, connection.id),
          eq(householdAccounts.providerAccountId, snapshot.id),
        ),
      );
    if (found === undefined) {
      const id = crypto.randomUUID();
      await tx.insert(householdAccounts).values({
        id,
        connectionId: connection.id,
        providerAccountId: snapshot.id,
        ...fields,
      });
      ids.set(snapshot.id, id);
    } else {
      await tx.update(householdAccounts).set(fields).where(eq(householdAccounts.id, found.id));
      ids.set(snapshot.id, found.id);
    }
  }
  return ids;
}

async function accountIdOf(
  tx: Transaction,
  connection: StoredConnection,
  ids: Map<string, string>,
  providerAccountId: string,
): Promise<string> {
  const known = ids.get(providerAccountId);
  if (known !== undefined) return known;
  const [found] = await tx
    .select({ id: householdAccounts.id })
    .from(householdAccounts)
    .where(
      and(
        eq(householdAccounts.connectionId, connection.id),
        eq(householdAccounts.providerAccountId, providerAccountId),
      ),
    );
  if (found === undefined) {
    throw new Error(`A Transaction names an Account the provider never returned.`);
  }
  ids.set(providerAccountId, found.id);
  return found.id;
}

async function findTransaction(tx: Transaction, connectionId: string, providerId: string) {
  const [row] = await tx
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.connectionId, connectionId),
        eq(transactions.providerTransactionId, providerId),
      ),
    );
  return row;
}

export type PageCounts = { added: number; changed: number; removed: number };

// Stores one sync page in one transaction: its Accounts, then each added or changed Transaction by
// its stable ID, then each removal. A page stored twice, as after a restarted sync, changes
// nothing the second time. A Member's own fields are never written.
export async function storeSyncPage(
  database: Database,
  connectionId: string,
  page: Pick<SyncResult, "accounts" | "added" | "changed" | "removed">,
  at = new Date(),
): Promise<PageCounts> {
  return database.transaction(async (tx) => {
    const counts: PageCounts = { added: 0, changed: 0, removed: 0 };
    const [connection] = await tx
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId));
    if (connection === undefined) throw new Error(`No Connection has the ID ${connectionId}.`);
    const ids = await storeAccounts(tx, connection, page.accounts);

    const hide = async (row: { id: string }, reason: RemovalReason) => {
      await tx
        .update(transactions)
        .set({ hiddenReason: reason, hiddenAt: at })
        .where(eq(transactions.id, row.id));
    };

    for (const record of [...page.added, ...page.changed]) {
      const accountId = await accountIdOf(tx, connection, ids, record.accountId);
      const fields = transactionFields(record, accountId);
      const found = await findTransaction(tx, connection.id, record.id);
      let handSet = found?.handSet ?? {};

      // Pending to posted: the posted record takes the pending one's hand-set fields, and the
      // pending one is hidden with the reason "posted".
      const pending =
        !record.pending && record.pendingTransactionId !== null
          ? await findTransaction(tx, connection.id, record.pendingTransactionId)
          : undefined;
      if (pending !== undefined) {
        handSet = { ...pending.handSet, ...handSet };
        if (pending.hiddenReason !== "posted") {
          if (pending.hiddenReason === null) counts.removed += 1;
          await hide(pending, "posted");
        }
      }

      if (found === undefined) {
        await tx.insert(transactions).values({
          id: crypto.randomUUID(),
          connectionId: connection.id,
          providerTransactionId: record.id,
          ...fields,
          handSet,
        });
        counts.added += 1;
      } else if (!holds(found, { ...fields, handSet })) {
        await tx
          .update(transactions)
          .set({ ...fields, handSet })
          .where(eq(transactions.id, found.id));
        counts.changed += 1;
      }
    }

    for (const removal of page.removed) {
      const found = await findTransaction(tx, connection.id, removal.id);
      // A Transaction already hidden keeps its reason, such as "posted".
      if (found === undefined || found.hiddenReason !== null) continue;
      await hide(found, removal.reason);
      counts.removed += 1;
    }
    return counts;
  });
}

// Saves the cursor after a sync stored every record.
export async function finishSync(
  database: Database,
  connectionId: string,
  done: { cursor: string; historyLoaded: boolean; at: Date },
): Promise<void> {
  await database
    .update(connections)
    .set({ syncCursor: done.cursor, historyLoaded: done.historyLoaded, lastSyncedAt: done.at })
    .where(eq(connections.id, connectionId));
}

// Sets fields a Member set by hand on a Transaction, such as its Category.
export async function setHandSetFields(
  database: Database,
  transactionId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const [row] = await database
    .select({ handSet: transactions.handSet })
    .from(transactions)
    .where(eq(transactions.id, transactionId));
  if (row === undefined) throw new Error(`No Transaction has the ID ${transactionId}.`);
  await database
    .update(transactions)
    .set({ handSet: { ...row.handSet, ...fields } })
    .where(eq(transactions.id, transactionId));
}

export async function listConnections(database: Database): Promise<StoredConnection[]> {
  return database.select().from(connections).orderBy(asc(connections.bankName));
}

export async function listAccounts(database: Database) {
  return database
    .select({
      id: householdAccounts.id,
      connectionId: householdAccounts.connectionId,
      name: householdAccounts.name,
      memberName: householdAccounts.memberName,
      kind: householdAccounts.kind,
      subtype: householdAccounts.subtype,
      institutionName: householdAccounts.institutionName,
      mask: householdAccounts.mask,
      currentBalance: householdAccounts.currentBalance,
      availableBalance: householdAccounts.availableBalance,
      creditLimit: householdAccounts.creditLimit,
      excluded: householdAccounts.excluded,
      closedAt: householdAccounts.closedAt,
    })
    .from(householdAccounts)
    .orderBy(asc(householdAccounts.institutionName), asc(householdAccounts.name));
}

export type TransactionFilter = { accountId?: string; from?: string; to?: string };

// The Transactions that are not hidden, newest first.
export async function listTransactions(database: Database, filter: TransactionFilter = {}) {
  const where: SQL[] = [isNull(transactions.hiddenReason)];
  if (filter.accountId !== undefined) where.push(eq(transactions.accountId, filter.accountId));
  if (filter.from !== undefined) where.push(gte(transactions.postedDate, filter.from));
  if (filter.to !== undefined) where.push(lte(transactions.postedDate, filter.to));
  return database
    .select({
      id: transactions.id,
      accountId: transactions.accountId,
      amount: transactions.amount,
      postedDate: transactions.postedDate,
      authorizedDate: transactions.authorizedDate,
      pending: transactions.pending,
      description: transactions.description,
      merchantName: transactions.merchantName,
    })
    .from(transactions)
    .where(and(...where))
    .orderBy(desc(transactions.postedDate), asc(transactions.id));
}
