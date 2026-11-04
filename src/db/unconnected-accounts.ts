import { and, asc, desc, eq, gt, inArray, isNull, ne, type SQL } from "drizzle-orm";
import { UNCONNECTED } from "../bank/unconnected-kinds.ts";
import type { Database } from "./client.ts";
import {
  householdAccounts,
  transactions,
  typedBalances,
  unconnectedAssignments,
} from "./schema.ts";

// Unconnected accounts in app.db (spec 02, Unconnected accounts): Accounts with no Connection,
// whose kind is "unconnected" and whose subtype is the Unconnected account's kind. The bank module
// decides; these functions store and read.

// SQLite takes at most 32,766 values in one statement.
const IDS_PER_QUERY = 500;

export type UnconnectedFields = {
  name: string;
  // An UnconnectedKind.
  subtype: string;
  institutionName: string | null;
  mask: string | null;
};

export type StoredUnconnectedAccount = UnconnectedFields & { id: string; closedAt: Date | null };

const isUnconnected = (id: string): SQL =>
  and(
    eq(householdAccounts.id, id),
    isNull(householdAccounts.connectionId),
    eq(householdAccounts.kind, UNCONNECTED),
  ) as SQL;

const COLUMNS = {
  id: householdAccounts.id,
  name: householdAccounts.name,
  subtype: householdAccounts.subtype,
  institutionName: householdAccounts.institutionName,
  mask: householdAccounts.mask,
  closedAt: householdAccounts.closedAt,
};

function stored(row: {
  id: string;
  name: string;
  subtype: string | null;
  institutionName: string | null;
  mask: string | null;
  closedAt: Date | null;
}): StoredUnconnectedAccount {
  return { ...row, subtype: row.subtype ?? "other" };
}

export async function addUnconnectedAccount(
  database: Database,
  fields: UnconnectedFields,
): Promise<string> {
  const id = crypto.randomUUID();
  await database.insert(householdAccounts).values({ id, kind: UNCONNECTED, ...fields });
  return id;
}

// True when an Unconnected account has the ID.
export async function updateUnconnectedAccount(
  database: Database,
  id: string,
  fields: UnconnectedFields,
): Promise<boolean> {
  const updated = await database
    .update(householdAccounts)
    .set(fields)
    .where(isUnconnected(id))
    .returning({ id: householdAccounts.id });
  return updated.length === 1;
}

export async function readUnconnectedAccount(
  database: Database,
  id: string,
): Promise<StoredUnconnectedAccount | undefined> {
  const [row] = await database.select(COLUMNS).from(householdAccounts).where(isUnconnected(id));
  return row === undefined ? undefined : stored(row);
}

export async function listUnconnectedAccounts(
  database: Database,
): Promise<StoredUnconnectedAccount[]> {
  const rows = await database
    .select(COLUMNS)
    .from(householdAccounts)
    .where(and(isNull(householdAccounts.connectionId), eq(householdAccounts.kind, UNCONNECTED)))
    .orderBy(asc(householdAccounts.name));
  return rows.map(stored);
}

export type TypedBalance = { date: string; balance: number };

// Saves a typed balance with its day. A later one on the same day replaces it.
export async function storeTypedBalance(
  database: Database,
  typed: TypedBalance & { accountId: string; typedAt: Date; typedBy: string | null },
): Promise<void> {
  const { accountId, date, ...fields } = typed;
  await database
    .insert(typedBalances)
    .values({ accountId, date, ...fields })
    .onConflictDoUpdate({ target: [typedBalances.accountId, typedBalances.date], set: fields });
}

export async function readLastTypedBalance(
  database: Database,
  accountId: string,
): Promise<TypedBalance | undefined> {
  const [row] = await database
    .select({ date: typedBalances.date, balance: typedBalances.balance })
    .from(typedBalances)
    .where(eq(typedBalances.accountId, accountId))
    .orderBy(desc(typedBalances.date))
    .limit(1);
  return row;
}

// Assigns a Transaction to an Unconnected account, in place of any earlier assignment.
export async function assignToUnconnectedAccount(
  database: Database,
  transactionId: string,
  accountId: string,
  at = new Date(),
): Promise<void> {
  await database
    .insert(unconnectedAssignments)
    .values({ transactionId, accountId, assignedAt: at })
    .onConflictDoUpdate({
      target: unconnectedAssignments.transactionId,
      set: { accountId, assignedAt: at },
    });
}

// Keeps each Transaction's assignment in step with the order of decisions' last result: an
// account ID assigns it, and null ends any assignment it had.
export async function saveUnconnectedAssignments(
  database: Database,
  assignments: readonly { transactionId: string; accountId: string | null }[],
  at = new Date(),
): Promise<void> {
  const ended = assignments.filter((a) => a.accountId === null).map((a) => a.transactionId);
  const kept = assignments.flatMap(({ transactionId, accountId }) =>
    accountId === null ? [] : [{ transactionId, accountId }],
  );
  if (ended.length === 0 && kept.length === 0) return;
  await database.transaction(async (tx) => {
    for (let start = 0; start < ended.length; start += IDS_PER_QUERY) {
      const chunk = ended.slice(start, start + IDS_PER_QUERY);
      await tx
        .delete(unconnectedAssignments)
        .where(inArray(unconnectedAssignments.transactionId, chunk));
    }
    for (const { transactionId, accountId } of kept) {
      await tx
        .insert(unconnectedAssignments)
        .values({ transactionId, accountId, assignedAt: at })
        .onConflictDoUpdate({
          target: unconnectedAssignments.transactionId,
          set: { accountId, assignedAt: at },
          // An assignment that stays as it was keeps its time.
          setWhere: ne(unconnectedAssignments.accountId, accountId),
        });
    }
  });
}

// The amounts of the posted Transactions assigned to the account, posted after `after` when it is
// given. Each amount has the connected Account's sign: money out of it, into the Unconnected
// account, is negative. Hidden and pending Transactions are left out.
export async function listAssignedAmounts(
  database: Database,
  accountId: string,
  after?: string,
): Promise<number[]> {
  const rows = await database
    .select({ amount: transactions.amount })
    .from(unconnectedAssignments)
    .innerJoin(transactions, eq(transactions.id, unconnectedAssignments.transactionId))
    .where(
      and(
        eq(unconnectedAssignments.accountId, accountId),
        eq(transactions.pending, false),
        isNull(transactions.hiddenReason),
        after === undefined ? undefined : gt(transactions.postedDate, after),
      ),
    );
  return rows.map((row) => row.amount);
}
