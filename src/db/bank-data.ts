import { and, asc, desc, eq, gte, isNotNull, isNull, lte, ne, type SQL } from "drizzle-orm";
import type {
  AccountSnapshot,
  Provider,
  RemovalReason,
  SyncResult,
  TxnRecord,
} from "../bank/adapter.ts";
import { calendarDateIn } from "../format.ts";
import { saveDailyBalance } from "./balances.ts";
import type { Database, Queries } from "./client.ts";
import { countPlaidItem } from "./plaid-settings.ts";
import { connections, followUpMarks, householdAccounts, transactions } from "./schema.ts";

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
  await database.transaction(async (tx) => {
    await tx.insert(connections).values({ id, ...connection, createdAt: at });
    // N counts every Plaid Connection the app created or imported (spec 02, The 10 lifetime Items).
    if (connection.provider === "plaid") await countPlaidItem(tx);
  });
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

// A Transaction as it arrives in a sync: the provider's record, with the Merchant that the bank
// module's cleanup rules gave it (spec 04, Names).
export type ArrivingTxn = TxnRecord & {
  merchant: { cleanName: string | null; needsAi: boolean };
};

// The provider's fields of a Transaction, and its Merchant. handSet and the hidden state are left
// out.
function transactionFields(record: ArrivingTxn, accountId: string) {
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
    merchantCleanName: record.merchant.cleanName,
    merchantNeedsAi: record.merchant.needsAi,
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

// The old Account that a new one carries on (spec 02, Carrying Accounts over): an Account at the
// same bank with the same type, subtype, and last 4 digits that is Closed, or that vanished from
// this Connection in this sync. One that vanished here comes first, then the latest closed.
async function carriedAccount(
  tx: Transaction,
  connection: StoredConnection,
  snapshot: AccountSnapshot,
  returned: ReadonlySet<string>,
) {
  if (snapshot.mask === null) return undefined;
  const candidates = await tx
    .select({
      id: householdAccounts.id,
      connectionId: householdAccounts.connectionId,
      providerAccountId: householdAccounts.providerAccountId,
      closedAt: householdAccounts.closedAt,
    })
    .from(householdAccounts)
    .where(
      and(
        isNotNull(householdAccounts.connectionId),
        eq(householdAccounts.institutionId, connection.bankId),
        eq(householdAccounts.kind, snapshot.type),
        snapshot.subtype === null
          ? isNull(householdAccounts.subtype)
          : eq(householdAccounts.subtype, snapshot.subtype),
        eq(householdAccounts.mask, snapshot.mask),
      ),
    );
  const vanishedHere = (row: (typeof candidates)[number]) =>
    row.connectionId === connection.id && !returned.has(row.providerAccountId ?? "");
  const returnedHere = (row: (typeof candidates)[number]) =>
    row.connectionId === connection.id && returned.has(row.providerAccountId ?? "");
  const eligible = candidates.filter(
    (row) => !returnedHere(row) && (vanishedHere(row) || row.closedAt !== null),
  );
  return (
    eligible.find(vanishedHere) ??
    eligible.sort((a, b) => (b.closedAt?.getTime() ?? 0) - (a.closedAt?.getTime() ?? 0))[0]
  );
}

// Moves an old Account onto this Connection under its new provider ID. It keeps its ID, hand-set
// fields, and history, and is open again. When its Transactions came from another Connection,
// history splits at day D, the old Connection's last successful sync: the old Transactions dated
// on or after D are hidden now, and the new ones dated before D as they arrive.
async function carryOver(
  tx: Transaction,
  connection: StoredConnection,
  old: { id: string; connectionId: string | null },
  snapshot: AccountSnapshot,
  fields: Partial<typeof householdAccounts.$inferInsert>,
  at: Date,
  timeZone: string,
): Promise<void> {
  let historySplitDate: string | undefined;
  if (old.connectionId !== null && old.connectionId !== connection.id) {
    const [oldConnection] = await tx
      .select({ lastSyncedAt: connections.lastSyncedAt })
      .from(connections)
      .where(eq(connections.id, old.connectionId));
    // An old Connection that never finished a sync splits at the day of the carry-over.
    historySplitDate = calendarDateIn(oldConnection?.lastSyncedAt ?? at, timeZone);
    await tx
      .update(transactions)
      .set({ hiddenReason: "replaced by re-link", hiddenAt: at })
      .where(
        and(
          eq(transactions.accountId, old.id),
          ne(transactions.connectionId, connection.id),
          gte(transactions.postedDate, historySplitDate),
          isNull(transactions.hiddenReason),
        ),
      );
  }
  await tx
    .update(householdAccounts)
    .set({
      ...fields,
      connectionId: connection.id,
      providerAccountId: snapshot.id,
      closedAt: null,
      closedReason: null,
      providerMissing: false,
      ...(historySplitDate === undefined ? {} : { historySplitDate }),
    })
    .where(eq(householdAccounts.id, old.id));
}

// Adds or updates each Account by its provider ID, and returns each one's app ID by provider ID.
// A new provider ID first looks for an old Account to carry on. `snapshots` is every Account the
// provider returns for the Connection.
async function storeAccounts(
  tx: Transaction,
  connection: StoredConnection,
  snapshots: AccountSnapshot[],
  at: Date,
  timeZone: string,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const returned = new Set(snapshots.map((snapshot) => snapshot.id));
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
    if (found !== undefined) {
      await tx.update(householdAccounts).set(fields).where(eq(householdAccounts.id, found.id));
      ids.set(snapshot.id, found.id);
      continue;
    }
    const old = await carriedAccount(tx, connection, snapshot, returned);
    if (old !== undefined) {
      await carryOver(tx, connection, old, snapshot, fields, at, timeZone);
      ids.set(snapshot.id, old.id);
      continue;
    }
    const id = crypto.randomUUID();
    await tx.insert(householdAccounts).values({
      id,
      connectionId: connection.id,
      providerAccountId: snapshot.id,
      ...fields,
    });
    ids.set(snapshot.id, id);
  }
  return ids;
}

// The day D of each Account's last carry-over from another Connection, or null, by app ID.
async function historySplitDateOf(
  tx: Transaction,
  splits: Map<string, string | null>,
  accountId: string,
): Promise<string | null> {
  const known = splits.get(accountId);
  if (known !== undefined) return known;
  const [row] = await tx
    .select({ historySplitDate: householdAccounts.historySplitDate })
    .from(householdAccounts)
    .where(eq(householdAccounts.id, accountId));
  const split = row?.historySplitDate ?? null;
  splits.set(accountId, split);
  return split;
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
// nothing the second time. A Member's own fields are never written. `timeZone` is the Household's,
// for day D of a carry-over. A changed or hidden Transaction loses its follow-up marks, so every
// follow-up step handles it again.
export async function storeSyncPage(
  database: Database,
  connectionId: string,
  page: Pick<SyncResult, "accounts" | "removed"> & { added: ArrivingTxn[]; changed: ArrivingTxn[] },
  at = new Date(),
  timeZone = "UTC",
): Promise<PageCounts> {
  return database.transaction(async (tx) => {
    const counts: PageCounts = { added: 0, changed: 0, removed: 0 };
    const [connection] = await tx
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId));
    if (connection === undefined) throw new Error(`No Connection has the ID ${connectionId}.`);
    const ids = await storeAccounts(tx, connection, page.accounts, at, timeZone);
    const splits = new Map<string, string | null>();

    const unmark = async (row: { id: string }) => {
      await tx.delete(followUpMarks).where(eq(followUpMarks.transactionId, row.id));
    };

    const hide = async (row: { id: string }, reason: RemovalReason) => {
      await tx
        .update(transactions)
        .set({ hiddenReason: reason, hiddenAt: at })
        .where(eq(transactions.id, row.id));
      await unmark(row);
    };

    for (const record of [...page.added, ...page.changed]) {
      const accountId = await accountIdOf(tx, connection, ids, record.accountId);
      const fields = transactionFields(record, accountId);
      const found = await findTransaction(tx, connection.id, record.id);
      // After a carry-over from another Connection, the old Connection's Transactions cover the
      // days before D.
      const split = await historySplitDateOf(tx, splits, accountId);
      const replaced = split !== null && record.postedDate < split;
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
          ...(replaced ? { hiddenReason: "replaced by re-link" as const, hiddenAt: at } : {}),
        });
        counts.added += 1;
      } else if (!holds(found, { ...fields, handSet })) {
        await tx
          .update(transactions)
          .set({ ...fields, handSet })
          .where(eq(transactions.id, found.id));
        await unmark(found);
        if (replaced && found.hiddenReason === null) await hide(found, "replaced by re-link");
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

// Ends a sync that stored every record, in one transaction: saves each returned Account's balance
// for the day, closes each Account the provider stopped returning, then saves the cursor.
export async function finishSync(
  database: Database,
  connectionId: string,
  done: {
    cursor: string;
    historyLoaded: boolean;
    // The Accounts the sync's last page returned.
    accounts: AccountSnapshot[];
    // The day of the sync in the Household's time zone, YYYY-MM-DD.
    day: string;
    at: Date;
  },
): Promise<void> {
  await database.transaction(async (tx) => {
    const stored = await tx
      .select({
        id: householdAccounts.id,
        providerAccountId: householdAccounts.providerAccountId,
        closedAt: householdAccounts.closedAt,
        closedReason: householdAccounts.closedReason,
        providerMissing: householdAccounts.providerMissing,
      })
      .from(householdAccounts)
      .where(eq(householdAccounts.connectionId, connectionId));
    const returned = new Map(done.accounts.map((snapshot) => [snapshot.id, snapshot]));
    for (const account of stored) {
      const snapshot = returned.get(account.providerAccountId ?? "");
      if (snapshot !== undefined) {
        await saveDailyBalance(tx, account.id, snapshot, done.day, done.at);
        // Returned again: an Account that closed when it vanished opens again.
        if (account.providerMissing) {
          await tx
            .update(householdAccounts)
            .set({
              providerMissing: false,
              ...(account.closedReason === "vanished"
                ? { closedAt: null, closedReason: null }
                : {}),
            })
            .where(eq(householdAccounts.id, account.id));
        }
      } else if (!account.providerMissing) {
        // Disappeared Account: it becomes Closed once, with the date. No System notice goes out.
        await tx
          .update(householdAccounts)
          .set({
            providerMissing: true,
            ...(account.closedAt === null
              ? { closedAt: done.at, closedReason: "vanished" as const }
              : {}),
          })
          .where(eq(householdAccounts.id, account.id));
      }
    }
    await tx
      .update(connections)
      .set({ syncCursor: done.cursor, historyLoaded: done.historyLoaded, lastSyncedAt: done.at })
      .where(eq(connections.id, connectionId));
  });
}

export async function readAccount(database: Database, id: string) {
  const [row] = await database
    .select({ id: householdAccounts.id, closedAt: householdAccounts.closedAt })
    .from(householdAccounts)
    .where(eq(householdAccounts.id, id));
  return row;
}

// Sets fields a Member set by hand on a Transaction, such as its Category.
export async function setHandSetFields(
  database: Queries,
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

// A Member closes any Account by hand. An Account already Closed keeps its date and reason.
// Returns false when no Account has the ID.
export async function closeAccount(
  database: Database,
  id: string,
  at = new Date(),
): Promise<boolean> {
  const account = await readAccount(database, id);
  if (account === undefined) return false;
  if (account.closedAt === null) {
    await database
      .update(householdAccounts)
      .set({ closedAt: at, closedReason: "closed by a member" })
      .where(eq(householdAccounts.id, id));
  }
  return true;
}

// A Member reopens any Closed Account. Returns false when no Account has the ID.
export async function reopenAccount(database: Database, id: string): Promise<boolean> {
  const account = await readAccount(database, id);
  if (account === undefined) return false;
  await database
    .update(householdAccounts)
    .set({ closedAt: null, closedReason: null })
    .where(eq(householdAccounts.id, id));
  return true;
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
