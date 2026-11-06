import {
  aliasedTable,
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  min,
  ne,
  notExists,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
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
import type { PartType } from "./decisions.ts";
import { markTransactionsUnhandled } from "./follow-up.ts";
import { listHandLinkedOldOf } from "./link-carry-over.ts";
import { carryLinks } from "./links.ts";
import { countPlaidItem } from "./plaid-settings.ts";
import {
  alerts,
  alertTransactions,
  connectionCarryOvers,
  connections,
  dailyBalances,
  followUpMarks,
  historyWait,
  householdAccounts,
  householdSummary,
  insightCards,
  loanLinks,
  merchantNameAnswers,
  recurringCharges,
  reviewItems,
  spendingLinks,
  systemNotices,
  transactionParts,
  transactions,
  transferLinks,
  typedBalances,
  unconnectedAssignments,
} from "./schema.ts";

// Connections, Accounts, and Transactions in app.db (spec 02). The bank module decides; these
// functions store and read.

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

// SQLite takes at most 32,766 values in one statement.
const IDS_PER_STATEMENT = 500;

export type StoredConnection = typeof connections.$inferSelect;

export async function addConnection(
  database: Database,
  connection: {
    provider: Provider;
    bankId: string;
    bankName: string;
    origin: "linked" | "imported";
    // The minute past the hour of each scheduled sync, 0 to 59. Picked at random when not given.
    syncMinute?: number;
    // The provider credential's ciphertext, sealed for the new row's ID, which it is bound to.
    sealCredential?: (id: string) => string;
    // Link again (spec 02, Repair): the Broken Connection the new one replaces. It is removed in
    // the same transaction, so its Accounts are Closed before the new Connection's first sync, and
    // that sync carries them over. The System notice conditions in `endsConditions`, the replaced
    // Connection's, end in the same transaction, so its notice and banner cannot stay open.
    replaces?: string;
    endsConditions?: readonly string[];
    // A held Connection never syncs. It is held in this insert, so no sync can start before it is.
    syncHeld?: boolean;
  },
  at = new Date(),
): Promise<string> {
  const id = crypto.randomUUID();
  const { sealCredential, replaces, endsConditions = [], ...fields } = connection;
  const credential = sealCredential?.(id) ?? null;
  // A random minute spreads the Connections' syncs over the hour (spec 02, Sync schedule).
  const syncMinute = connection.syncMinute ?? Math.floor(Math.random() * 60);
  await database.transaction(async (tx) => {
    await tx.insert(connections).values({ id, ...fields, credential, syncMinute, createdAt: at });
    // N counts every Plaid Connection the app created or imported (spec 02, The 10 lifetime Items).
    if (connection.provider === "plaid") await countPlaidItem(tx);
    // Any hand-made links the replaced Connection's Accounts held for copies stop waiting. A
    // follow-up job after the new Connection's sync ends them, or, once it carries those Accounts
    // over, they wait for its own copies.
    if (replaces !== undefined) await removeConnection(tx, replaces, at);
    if (endsConditions.length > 0) {
      await tx
        .update(systemNotices)
        .set({ closedAt: at })
        .where(
          and(
            inArray(systemNotices.condition, [...endsConditions]),
            isNull(systemNotices.closedAt),
          ),
        );
    }
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

// A Connection's health and sync schedule (spec 02, Sync schedule and Back-off), and when it
// stopped holding back AI (spec 02, First history load).
export type SyncState = Partial<
  Pick<
    StoredConnection,
    | "health"
    | "lastSyncAttemptAt"
    | "nextSyncAt"
    | "retryingSince"
    | "failedSyncs"
    | "historyWaitReleasedAt"
  >
>;

export async function saveSyncState(
  database: Database,
  id: string,
  state: SyncState,
): Promise<void> {
  await database.update(connections).set(state).where(eq(connections.id, id));
}

// Records a Refresh of the Connection at `at`, unless one came after `after`. True when it records
// one: then the caller may ask the provider. Two Sync now presses at once record one Refresh.
export async function claimRefresh(
  database: Database,
  id: string,
  at: Date,
  after: Date,
): Promise<boolean> {
  const claimed = await database
    .update(connections)
    .set({ lastRefreshAt: at })
    .where(
      and(
        eq(connections.id, id),
        or(isNull(connections.lastRefreshAt), lte(connections.lastRefreshAt, after)),
      ),
    )
    .returning({ id: connections.id });
  return claimed.length === 1;
}

// Each Connection whose sync job is due at `now`: every one that is not Broken, held or removed and
// has no next sync time, or one that has come.
export async function listDueConnections(
  database: Database,
  now: Date,
): Promise<StoredConnection[]> {
  return database
    .select()
    .from(connections)
    .where(
      and(
        ne(connections.health, "broken"),
        isNull(connections.removedAt),
        eq(connections.syncHeld, false),
        or(isNull(connections.nextSyncAt), lte(connections.nextSyncAt, now)),
      ),
    )
    .orderBy(asc(connections.createdAt), asc(connections.id));
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
    statementIssueDate: snapshot.card?.statementIssueDate ?? null,
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
// on or after D are hidden now, and the new ones dated before D as they arrive. The same write
// records the old Connection on this one, and makes the hidden ones unhandled, so Matching ends
// their app-made links and moves their hand-made ones to the new copies (spec 02, Link carry-over).
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
    const hidden = await tx
      .update(transactions)
      .set({ hiddenReason: "replaced by re-link", hiddenAt: at })
      .where(
        and(
          eq(transactions.accountId, old.id),
          ne(transactions.connectionId, connection.id),
          gte(transactions.postedDate, historySplitDate),
          isNull(transactions.hiddenReason),
        ),
      )
      .returning({ id: transactions.id });
    for (let start = 0; start < hidden.length; start += IDS_PER_STATEMENT) {
      const chunk = hidden.slice(start, start + IDS_PER_STATEMENT).map((row) => row.id);
      await tx.delete(followUpMarks).where(inArray(followUpMarks.transactionId, chunk));
    }
    await tx
      .insert(connectionCarryOvers)
      .values({ connectionId: connection.id, oldConnectionId: old.connectionId, createdAt: at })
      .onConflictDoUpdate({
        target: connectionCarryOvers.connectionId,
        set: { oldConnectionId: old.connectionId },
      });
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

// An Account the app had not seen before a sync, which the sync now tracks (spec 02, New accounts
// at a bank). A carried Account is not new.
export type NewAccount = { id: string; name: string; mask: string | null };

// Adds or updates each Account by its provider ID, and returns each one's app ID by provider ID,
// with the Accounts it added. A new provider ID first looks for an old Account to carry on.
// `snapshots` is every Account the provider returns for the Connection.
async function storeAccounts(
  tx: Transaction,
  connection: StoredConnection,
  snapshots: AccountSnapshot[],
  at: Date,
  timeZone: string,
): Promise<{ ids: Map<string, string>; added: NewAccount[] }> {
  const ids = new Map<string, string>();
  const added: NewAccount[] = [];
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
    added.push({ id, name: snapshot.name, mask: snapshot.mask });
  }
  return { ids, added };
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

// What storing one page did: its Transaction counts, and the Accounts it added.
export type StoredPage = PageCounts & { newAccounts: NewAccount[] };

// Stores one sync page in one transaction: its Accounts, then each added or changed Transaction by
// its stable ID, then each removal. A page stored twice, as after a restarted sync, changes
// nothing the second time. A Member's own fields are never written. `timeZone` is the Household's,
// for day D of a carry-over. A changed or hidden Transaction loses its follow-up marks, so every
// follow-up step handles it again. A Transaction that arrives before the Connection's history has
// loaded gets the "history load" mark (spec 06, When checks run).
export async function storeSyncPage(
  database: Database,
  connectionId: string,
  page: Pick<SyncResult, "accounts" | "removed"> & { added: ArrivingTxn[]; changed: ArrivingTxn[] },
  at = new Date(),
  timeZone = "UTC",
): Promise<StoredPage> {
  return database.transaction(async (tx) => {
    const counts: PageCounts = { added: 0, changed: 0, removed: 0 };
    const [connection] = await tx
      .select()
      .from(connections)
      .where(eq(connections.id, connectionId));
    if (connection === undefined) throw new Error(`No Connection has the ID ${connectionId}.`);
    const { ids, added: newAccounts } = await storeAccounts(
      tx,
      connection,
      page.accounts,
      at,
      timeZone,
    );
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

      // Pending to posted: the posted record takes the pending one's hand-set fields and links,
      // and the pending one is hidden with the reason "posted". The other side of each carried
      // link is handled again, so Matching checks the link's hard filters.
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

      const id = found?.id ?? crypto.randomUUID();
      if (found === undefined) {
        await tx.insert(transactions).values({
          id,
          connectionId: connection.id,
          providerTransactionId: record.id,
          ...fields,
          handSet,
          historyLoad: !connection.historyLoaded,
          postedSeenAt: record.pending ? null : at,
          ...(replaced ? { hiddenReason: "replaced by re-link" as const, hiddenAt: at } : {}),
        });
        counts.added += 1;
      } else if (!holds(found, { ...fields, handSet })) {
        await tx
          .update(transactions)
          .set({
            ...fields,
            handSet,
            // A pending record that turns posted in place is posted from now on.
            ...(found.pending && !record.pending ? { postedSeenAt: at } : {}),
          })
          .where(eq(transactions.id, found.id));
        await unmark(found);
        if (replaced && found.hiddenReason === null) await hide(found, "replaced by re-link");
        counts.changed += 1;
      }
      if (pending !== undefined && pending.id !== id) {
        await markTransactionsUnhandled(tx, await carryLinks(tx, pending.id, id));
      }
    }

    for (const removal of page.removed) {
      const found = await findTransaction(tx, connection.id, removal.id);
      // A Transaction already hidden keeps its reason, such as "posted".
      if (found === undefined || found.hiddenReason !== null) continue;
      await hide(found, removal.reason);
      counts.removed += 1;
    }
    return { ...counts, newAccounts };
  });
}

// What finishSync stored about the history load: whether it has loaded, whether this sync loaded
// the history of a bank added later, whose hooks are now due, and how many old Transactions'
// hand-made links stopped waiting for a new copy, which the follow-up job now ends.
export type FinishedSync = {
  historyLoaded: boolean;
  laterHooksDue: boolean;
  copiesNoLongerAwaited: number;
};

// Ends a sync that stored every record, in one transaction: saves each returned Account's balance
// for the day, closes each Account the provider stopped returning, then saves the cursor. A history
// that has loaded stays loaded. When it loads for a Connection made after the wait for the first
// history load ended, the bank-added-later hooks become due, in the same transaction. When it
// loads, each old Transaction on the Connection's Accounts whose hand-made links still wait for a
// copy becomes unhandled, once, so Matching ends those links (spec 02, Link carry-over).
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
): Promise<FinishedSync> {
  return database.transaction(async (tx) => {
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
    const [before] = await tx
      .select({ historyLoaded: connections.historyLoaded, createdAt: connections.createdAt })
      .from(connections)
      .where(eq(connections.id, connectionId));
    const loadedBefore = before?.historyLoaded ?? false;
    const historyLoaded = loadedBefore || done.historyLoaded;
    const [wait] = await tx.select({ endedAt: historyWait.endedAt }).from(historyWait);
    const laterHooksDue =
      historyLoaded &&
      !loadedBefore &&
      before !== undefined &&
      wait?.endedAt != null &&
      before.createdAt.getTime() > wait.endedAt.getTime();
    await tx
      .update(connections)
      .set({
        syncCursor: done.cursor,
        historyLoaded,
        lastSyncedAt: done.at,
        ...(laterHooksDue ? { laterHooksStartedAt: done.at, laterHooksRestarts: 0 } : {}),
      })
      .where(eq(connections.id, connectionId));
    const awaited =
      historyLoaded && !loadedBefore ? await listHandLinkedOldOf(tx, connectionId) : [];
    await markTransactionsUnhandled(tx, awaited);
    return { historyLoaded, laterHooksDue, copiesNoLongerAwaited: awaited.length };
  });
}

// How far each of the given Connections' history has come: its Transactions so far, hidden ones
// left out, and the posted date of the oldest, by Connection ID. Only the Connections whose history
// still loads are given, so a page that reads this again while a load runs never counts the whole
// history.
export async function historyProgress(
  database: Database,
  connectionIds: readonly string[],
): Promise<Map<string, { transactions: number; oldestDate: string | null }>> {
  if (connectionIds.length === 0) return new Map();
  const rows = await database
    .select({
      connectionId: transactions.connectionId,
      transactions: count(),
      oldestDate: min(transactions.postedDate),
    })
    .from(transactions)
    .where(
      and(
        inArray(transactions.connectionId, [...connectionIds]),
        isNull(transactions.hiddenReason),
      ),
    )
    .groupBy(transactions.connectionId);
  return new Map(
    rows.map((row) => [
      row.connectionId,
      { transactions: row.transactions, oldestDate: row.oldestDate ?? null },
    ]),
  );
}

export async function readAccount(database: Database, id: string) {
  const [row] = await database
    .select({
      id: householdAccounts.id,
      connectionId: householdAccounts.connectionId,
      kind: householdAccounts.kind,
      closedAt: householdAccounts.closedAt,
    })
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

// A Member turns an Account's Exclude switch on or off (spec 02, Exclude). Sync never writes it.
export async function setAccountExcluded(
  database: Queries,
  id: string,
  excluded: boolean,
): Promise<"not found" | "unchanged" | "changed"> {
  const [account] = await database
    .select({ excluded: householdAccounts.excluded })
    .from(householdAccounts)
    .where(eq(householdAccounts.id, id));
  if (account === undefined) return "not found";
  if (account.excluded === excluded) return "unchanged";
  await database.update(householdAccounts).set({ excluded }).where(eq(householdAccounts.id, id));
  return "changed";
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

// What removing a Connection did: whether it removed it, and how many old Transactions' hand-made
// links stopped waiting for a new copy, which a follow-up job now ends.
export type RemovedConnection = { removed: boolean; copiesNoLongerAwaited: number };

// Removes a Connection (spec 02, Removing a Connection), in one transaction: it deletes the
// credential, stops the syncs, and closes the open Accounts with the reason "connection removed".
// Their history stays. N does not fall: it counts each Plaid Connection once, when it was added.
// A removed Connection never loads its history, so each old Transaction on its Accounts whose
// hand-made links waited for a copy becomes unhandled, and Matching ends those links (spec 02, Link
// carry-over). `removed` is false when no Connection has the ID, or it was already removed.
export async function markConnectionRemoved(
  database: Database,
  id: string,
  at = new Date(),
): Promise<RemovedConnection> {
  return database.transaction((tx) => removeConnection(tx, id, at));
}

async function removeConnection(tx: Transaction, id: string, at: Date): Promise<RemovedConnection> {
  const removed = await tx
    .update(connections)
    .set({ credential: null, removedAt: at, nextSyncAt: null, syncHeld: false })
    .where(and(eq(connections.id, id), isNull(connections.removedAt)))
    .returning({ id: connections.id });
  if (removed.length === 0) return { removed: false, copiesNoLongerAwaited: 0 };
  await tx
    .update(householdAccounts)
    .set({ closedAt: at, closedReason: "connection removed" })
    .where(and(eq(householdAccounts.connectionId, id), isNull(householdAccounts.closedAt)));
  const awaited = await listHandLinkedOldOf(tx, id);
  await markTransactionsUnhandled(tx, awaited);
  return { removed: true, copiesNoLongerAwaited: awaited.length };
}

// What Delete history removed.
export type DeletedHistory = { accounts: number; transactions: number };

// Deletes a removed Connection's history (spec 02, Removing a Connection), in one transaction: its
// Accounts and their Transactions. The daily balances go first, since their foreign key has no
// cascade, and so does each Recurring charge, ended or not, whose last Transaction landed on one of
// the Accounts. The follow-up job finds the other Recurring charges again. The links and decisions
// on the Transactions go with them by cascade. The other side of each undone Transfer link is
// marked for the follow-up job, so matching runs on it again. Each
// open Review list item about the deleted rows closes. The Connection's row goes too, unless an
// Account carried over to a newer Connection still holds some of its old Transactions. Returns
// undefined when no removed Connection has the ID.
export async function deleteRemovedConnection(
  database: Database,
  id: string,
  at = new Date(),
): Promise<DeletedHistory | undefined> {
  return database.transaction(async (tx) => {
    const [connection] = await tx
      .select({ removedAt: connections.removedAt })
      .from(connections)
      .where(eq(connections.id, id));
    if (connection === undefined || connection.removedAt === null) return undefined;
    const accountIds = (
      await tx
        .select({ id: householdAccounts.id })
        .from(householdAccounts)
        .where(eq(householdAccounts.connectionId, id))
    ).map((row) => row.id);
    const onAccounts = inArray(transactions.accountId, accountIds);
    const transactionIds = new Set(
      (await tx.select({ id: transactions.id }).from(transactions).where(onAccounts)).map(
        (row) => row.id,
      ),
    );
    const deleted = tx.select({ id: transactions.id }).from(transactions).where(onAccounts);
    const partners = (
      await tx
        .select({ out: transferLinks.outTransactionId, in: transferLinks.inTransactionId })
        .from(transferLinks)
        .where(
          or(
            inArray(transferLinks.outTransactionId, deleted),
            inArray(transferLinks.inTransactionId, deleted),
          ),
        )
    )
      .flatMap((link) => [link.out, link.in])
      .filter((transactionId) => !transactionIds.has(transactionId));
    // The other side of a Refund or Reimbursement link, and the other Transactions linked to a
    // Manual loan, whose interest counts from the payment before, are matched again too.
    const spendingPartners = (
      await tx
        .select({ money: spendingLinks.transactionId, spent: spendingLinks.spendingTransactionId })
        .from(spendingLinks)
        .where(
          or(
            inArray(spendingLinks.transactionId, deleted),
            inArray(spendingLinks.spendingTransactionId, deleted),
          ),
        )
    ).flatMap((link) => [link.money, link.spent]);
    const loansLeft = tx
      .select({ id: loanLinks.loanAccountId })
      .from(loanLinks)
      .where(inArray(loanLinks.transactionId, deleted));
    const loanPartners = (
      await tx
        .select({ id: loanLinks.transactionId })
        .from(loanLinks)
        .where(inArray(loanLinks.loanAccountId, loansLeft))
    ).map((link) => link.id);
    partners.push(
      ...[...spendingPartners, ...loanPartners].filter((other) => !transactionIds.has(other)),
    );
    // A one-sided Transfer on another Connection's Account may be tied to one of these Accounts,
    // such as an excluded one. It is decided again, with no account.
    const tiedHere = (
      await tx
        .select({ id: unconnectedAssignments.transactionId })
        .from(unconnectedAssignments)
        .where(inArray(unconnectedAssignments.accountId, accountIds))
    )
      .map((row) => row.id)
      .filter((transactionId) => !transactionIds.has(transactionId));
    await tx
      .delete(unconnectedAssignments)
      .where(inArray(unconnectedAssignments.accountId, accountIds));
    await markTransactionsUnhandled(tx, [...new Set([...partners, ...tiedHere])]);
    // One statement closes each open item with an Account or a Transaction among its subjects.
    const subject = sql`subject.value`;
    await tx
      .update(reviewItems)
      .set({ closedAt: at, closedReason: "history deleted" })
      .where(
        and(
          isNull(reviewItems.closedAt),
          exists(
            tx
              .select({ id: subject })
              .from(sql`json_each(${reviewItems.subjectIds}) as subject`)
              .where(or(inArray(subject, accountIds), inArray(subject, deleted))),
          ),
        ),
      );
    if (accountIds.length > 0) {
      await tx.delete(dailyBalances).where(inArray(dailyBalances.accountId, accountIds));
      await tx.delete(typedBalances).where(inArray(typedBalances.accountId, accountIds));
      await tx.delete(recurringCharges).where(inArray(recurringCharges.accountId, accountIds));
    }
    // An Alert about any of these Transactions goes with them.
    await tx
      .delete(alerts)
      .where(
        inArray(
          alerts.id,
          tx
            .select({ id: alertTransactions.alertId })
            .from(alertTransactions)
            .where(inArray(alertTransactions.transactionId, deleted)),
        ),
      );
    await tx.delete(transactions).where(onAccounts);
    // AI cleanup's answers keep bank description text, so each one no Transaction holds any more
    // goes with the history. One statement: SQLite reads the descriptions left once.
    await tx
      .delete(merchantNameAnswers)
      .where(
        notInArray(
          merchantNameAnswers.description,
          tx.select({ description: transactions.description }).from(transactions),
        ),
      );
    await tx.delete(householdAccounts).where(eq(householdAccounts.connectionId, id));
    // Today's Household summary holds numbers and Merchants from this history, so the next Writer
    // use builds it again without them.
    await tx.delete(householdSummary);
    // The Insight cards can hold the same, so they go too, with their Done marks. The AI box shows
    // none until the next run.
    await tx.delete(insightCards);
    const [carried] = await tx
      .select({ id: transactions.id })
      .from(transactions)
      .where(eq(transactions.connectionId, id))
      .limit(1);
    if (carried === undefined) await tx.delete(connections).where(eq(connections.id, id));
    // A removed Connection whose last Transaction or Account went with this history, such as one
    // whose Transactions it carried, goes too: no row is left that holds nothing.
    await tx
      .delete(connections)
      .where(
        and(
          isNotNull(connections.removedAt),
          notExists(
            tx
              .select({ id: transactions.id })
              .from(transactions)
              .where(eq(transactions.connectionId, connections.id)),
          ),
          notExists(
            tx
              .select({ id: householdAccounts.id })
              .from(householdAccounts)
              .where(eq(householdAccounts.connectionId, connections.id)),
          ),
        ),
      );
    return { accounts: accountIds.length, transactions: transactionIds.size };
  });
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

// The Transactions that are not hidden with these IDs, 500 IDs a statement. An unknown or hidden ID
// is left out.
export async function readShownTransactions(database: Database, ids: readonly string[]) {
  const unique = [...new Set(ids)];
  const rows = [];
  for (let start = 0; start < unique.length; start += 500) {
    rows.push(
      ...(await database
        .select({
          id: transactions.id,
          accountId: transactions.accountId,
          amount: transactions.amount,
          postedDate: transactions.postedDate,
          authorizedDate: transactions.authorizedDate,
          pending: transactions.pending,
          description: transactions.description,
          merchantName: transactions.merchantName,
          merchantCleanName: transactions.merchantCleanName,
        })
        .from(transactions)
        .where(
          and(
            inArray(transactions.id, unique.slice(start, start + 500)),
            isNull(transactions.hiddenReason),
          ),
        )),
    );
  }
  return rows;
}

export type TransactionFilter = {
  accountId?: string;
  // Posted dates, YYYY-MM-DD. Both ends are included.
  from?: string;
  to?: string;
  // The Merchant's clean name.
  merchant?: string;
  // A Transaction shows when one of its parts has the type, the Category, and the month, YYYY-MM,
  // each that is set. A part's month comes from the purchase date, else the posted date (spec 04,
  // Which month a Transaction counts in). A linked Refund or Reimbursement part has its Spending's
  // Categories and month (spec 03, Which month a link changes).
  type?: PartType;
  category?: string;
  month?: string;
};

// One page of the list: at most `limit` Transactions, after the one with the ID `after`.
export type TransactionPage = { limit: number; after?: string };

const LISTED = {
  id: transactions.id,
  accountId: transactions.accountId,
  amount: transactions.amount,
  postedDate: transactions.postedDate,
  authorizedDate: transactions.authorizedDate,
  pending: transactions.pending,
  description: transactions.description,
  merchantName: transactions.merchantName,
  merchantCleanName: transactions.merchantCleanName,
};

// The filter's conditions, in one statement: each part filter is one EXISTS on the Transaction's
// own parts, with its Spending through the link of a linked part.
function filtered(database: Queries, filter: TransactionFilter): SQL[] {
  const where: SQL[] = [isNull(transactions.hiddenReason)];
  if (filter.accountId !== undefined) where.push(eq(transactions.accountId, filter.accountId));
  if (filter.from !== undefined) where.push(gte(transactions.postedDate, filter.from));
  if (filter.to !== undefined) where.push(lte(transactions.postedDate, filter.to));
  if (filter.merchant !== undefined) {
    where.push(eq(transactions.merchantCleanName, filter.merchant));
  }
  const { type, category, month } = filter;
  if (type === undefined && category === undefined && month === undefined) return where;
  const spent = aliasedTable(transactions, "spent");
  const spentPart = aliasedTable(transactionParts, "spent_part");
  const ofPart: SQL[] = [eq(transactionParts.transactionId, transactions.id)];
  if (type !== undefined) ofPart.push(eq(transactionParts.type, type));
  if (category !== undefined) {
    const spentIn = database
      .select({ one: sql`1` })
      .from(spentPart)
      .where(
        and(
          eq(spentPart.transactionId, spent.id),
          eq(spentPart.type, "Spending"),
          eq(spentPart.category, category),
        ),
      );
    ofPart.push(
      or(
        and(isNull(spent.id), eq(transactionParts.category, category)),
        and(isNotNull(spent.id), exists(spentIn)),
      ) as SQL,
    );
  }
  if (month !== undefined) {
    ofPart.push(
      sql`substr(coalesce(${spent.authorizedDate}, ${spent.postedDate}, ${transactions.authorizedDate}, ${transactions.postedDate}), 1, 7) = ${month}`,
    );
  }
  where.push(
    exists(
      database
        .select({ one: sql`1` })
        .from(transactionParts)
        .leftJoin(
          spendingLinks,
          and(
            eq(transactionParts.linked, true),
            eq(spendingLinks.transactionId, transactionParts.transactionId),
          ),
        )
        .leftJoin(spent, eq(spent.id, spendingLinks.spendingTransactionId))
        .where(and(...ofPart)),
    ),
  );
  return where;
}

// The Transactions that are not hidden, newest first, that pass the filter.
export async function listTransactions(database: Database, filter: TransactionFilter = {}) {
  return database
    .select(LISTED)
    .from(transactions)
    .where(and(...filtered(database, filter)))
    .orderBy(desc(transactions.postedDate), asc(transactions.id));
}

// One page of listTransactions, and the ID to read the next page after, or null on the last page.
// Undefined when no Transaction has the ID `after`.
export async function listTransactionPage(
  database: Database,
  filter: TransactionFilter,
  page: TransactionPage,
) {
  const where = filtered(database, filter);
  if (page.after !== undefined) {
    const [anchor] = await database
      .select({ id: transactions.id, postedDate: transactions.postedDate })
      .from(transactions)
      .where(eq(transactions.id, page.after));
    if (anchor === undefined) return undefined;
    where.push(
      or(
        lt(transactions.postedDate, anchor.postedDate),
        and(eq(transactions.postedDate, anchor.postedDate), gt(transactions.id, anchor.id)),
      ) as SQL,
    );
  }
  const rows = await database
    .select(LISTED)
    .from(transactions)
    .where(and(...where))
    .orderBy(desc(transactions.postedDate), asc(transactions.id))
    .limit(page.limit + 1);
  const shown = rows.slice(0, page.limit);
  return {
    transactions: shown,
    next: rows.length > page.limit ? (shown.at(-1)?.id ?? null) : null,
  };
}
