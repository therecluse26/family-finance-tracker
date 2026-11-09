import { and, asc, eq, exists, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { Database, Queries } from "./client.ts";
import {
  recurringChargePriceChanges,
  recurringCharges,
  recurringChargeTransactions,
  transactionParts,
  transactions,
} from "./schema.ts";

// Recurring charges in app.db (spec 06, What the app stores). The recurring module decides; these
// functions store and read.

type ChargeRow = typeof recurringCharges.$inferSelect;

// One Transaction in a Recurring charge: its posted date and amount in whole cents spent. True
// `addedByHand` when a Member added it.
export type StoredChargeEntry = {
  transactionId: string;
  date: string;
  amount: number;
  addedByHand: boolean;
};

// A price change (spec 06, Member edits): a new amount in whole cents spent from a date. `byHand`
// when a Member set it, else the checks found it.
export type StoredPriceChange = { id: string; fromDate: string; amount: number; byHand: boolean };

export type StoredRecurringCharge = Omit<ChargeRow, "oldPriceHistory"> & {
  // Its Transactions, oldest first.
  priceHistory: StoredChargeEntry[];
  // The Transactions a Member removed from it.
  removedByHand: string[];
  // Oldest first.
  priceChanges: StoredPriceChange[];
};

// A Recurring charge as the checks found it, before a Member's edits: its Transactions, oldest
// first, and the price changes the checks found in them.
export type FoundRecurringCharge = Omit<
  ChargeRow,
  "oldPriceHistory" | "name" | "handSetCategory" | "priceBand"
> & {
  priceHistory: { transactionId: string; date: string; amount: number; addedByHand?: boolean }[];
  priceChanges?: { fromDate: string; amount: number }[];
};

// What a Member may edit on a Recurring charge. A field left out stays; null clears it.
export type RecurringChargeEdits = {
  name?: string | null;
  handSetCategory?: string | null;
  priceBand?: number | null;
};

// One posted Spending Transaction for the checks: its Spending in whole cents with the
// Transaction's sign, and its first Spending part's Category.
export type PostedSpendingRow = {
  id: string;
  postedDate: string;
  authorizedDate: string | null;
  accountId: string;
  merchantId: string | null;
  merchantCleanName: string | null;
  spending: number;
  category: string | null;
  // True when it arrived in its Connection's history load.
  historyLoad: boolean;
};

const IDS_PER_QUERY = 500;
// Rows per insert, under SQLite's limit on bound values.
const ROWS_PER_INSERT = 500;

// Every posted Spending Transaction that shows, oldest first. A Transaction with more than one
// Spending part counts once, with their sum. A Transfer never counts. With `exceptCategory`, the
// Spending parts in that Category are left out, and a Transaction with no other Spending part. With
// `transactionIds`, only those Transactions.
export async function listPostedSpending(
  database: Queries,
  options: { exceptCategory?: string; transactionIds?: readonly string[] } = {},
): Promise<PostedSpendingRow[]> {
  const { exceptCategory, transactionIds } = options;
  const rows = await database
    .select({
      id: transactions.id,
      postedDate: transactions.postedDate,
      authorizedDate: transactions.authorizedDate,
      accountId: transactions.accountId,
      merchantId: transactions.merchantId,
      merchantCleanName: transactions.merchantCleanName,
      amount: transactionParts.amount,
      category: transactionParts.category,
      historyLoad: transactions.historyLoad,
    })
    .from(transactionParts)
    .innerJoin(transactions, eq(transactions.id, transactionParts.transactionId))
    .where(
      and(
        eq(transactionParts.type, "Spending"),
        eq(transactions.pending, false),
        isNull(transactions.hiddenReason),
        exceptCategory === undefined
          ? undefined
          : or(isNull(transactionParts.category), ne(transactionParts.category, exceptCategory)),
        transactionIds === undefined ? undefined : inArray(transactions.id, [...transactionIds]),
      ),
    )
    .orderBy(asc(transactions.postedDate), asc(transactions.id), asc(transactionParts.part));
  const found: PostedSpendingRow[] = [];
  for (const { amount, category, ...row } of rows) {
    const previous = found.at(-1);
    if (previous?.id === row.id) previous.spending += amount;
    else found.push({ ...row, spending: amount, category });
  }
  return found;
}

// The Transactions among `transactionIds` that still show: not hidden, such as removed by the bank.
export async function listShownTransactionIds(
  database: Queries,
  transactionIds: readonly string[],
): Promise<Set<string>> {
  const shown = new Set<string>();
  for (let start = 0; start < transactionIds.length; start += IDS_PER_QUERY) {
    const rows = await database
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          inArray(transactions.id, transactionIds.slice(start, start + IDS_PER_QUERY)),
          isNull(transactions.hiddenReason),
        ),
      );
    for (const row of rows) shown.add(row.id);
  }
  return shown;
}

// Each Recurring charge with its Transactions and price changes, from 3 reads.
async function withEntries(
  database: Queries,
  rows: readonly ChargeRow[],
): Promise<StoredRecurringCharge[]> {
  const ids = rows.map((row) => row.id);
  const entries = new Map<string, StoredChargeEntry[]>();
  const removed = new Map<string, string[]>();
  const changes = new Map<string, StoredPriceChange[]>();
  for (let start = 0; start < ids.length; start += IDS_PER_QUERY) {
    const chunk = ids.slice(start, start + IDS_PER_QUERY);
    const members = await database
      .select()
      .from(recurringChargeTransactions)
      .where(inArray(recurringChargeTransactions.chargeId, chunk))
      .orderBy(
        asc(recurringChargeTransactions.date),
        asc(recurringChargeTransactions.transactionId),
      );
    for (const { chargeId, transactionId, date, amount, byHand } of members) {
      if (byHand === "removed") {
        removed.set(chargeId, [...(removed.get(chargeId) ?? []), transactionId]);
        continue;
      }
      const list = entries.get(chargeId) ?? [];
      list.push({ transactionId, date, amount, addedByHand: byHand === "added" });
      entries.set(chargeId, list);
    }
    const prices = await database
      .select()
      .from(recurringChargePriceChanges)
      .where(inArray(recurringChargePriceChanges.chargeId, chunk))
      .orderBy(asc(recurringChargePriceChanges.fromDate), asc(recurringChargePriceChanges.byHand));
    for (const { chargeId, ...change } of prices) {
      changes.set(chargeId, [...(changes.get(chargeId) ?? []), change]);
    }
  }
  return rows.map(({ oldPriceHistory: _, ...row }) => ({
    ...row,
    priceHistory: entries.get(row.id) ?? [],
    removedByHand: removed.get(row.id) ?? [],
    priceChanges: changes.get(row.id) ?? [],
  }));
}

export async function listRecurringCharges(database: Queries): Promise<StoredRecurringCharge[]> {
  const rows = await database
    .select()
    .from(recurringCharges)
    .orderBy(asc(recurringCharges.nextExpectedDate), asc(recurringCharges.id));
  return withEntries(database, rows);
}

export async function readRecurringCharge(
  database: Queries,
  id: string,
): Promise<StoredRecurringCharge | undefined> {
  const rows = await database.select().from(recurringCharges).where(eq(recurringCharges.id, id));
  return (await withEntries(database, rows))[0];
}

// A Recurring charge a Member edited: one with a name, a Category, a price band, a price change, or
// a Transaction added or removed by hand. The checks keep it (spec 06, Member edits).
const keptByHand = sql`(${recurringCharges.name} IS NOT NULL OR ${recurringCharges.handSetCategory} IS NOT NULL OR ${recurringCharges.priceBand} IS NOT NULL OR EXISTS (SELECT 1 FROM ${recurringChargePriceChanges} WHERE ${recurringChargePriceChanges.chargeId} = ${recurringCharges.id} AND ${recurringChargePriceChanges.byHand} = 1) OR EXISTS (SELECT 1 FROM ${recurringChargeTransactions} WHERE ${recurringChargeTransactions.chargeId} = ${recurringCharges.id} AND ${recurringChargeTransactions.byHand} IS NOT NULL))`;

// Stores the Recurring charges the checks found in place of the ones not marked ended: of every
// Merchant, or with `covered`, of only those stored charges. A Member's edits stay: the checks never
// write a name, a Category, a band, a Member's price change, or a row marked by hand, and never
// delete a Recurring charge a Member edited, even one edited while they ran. `gone` are edited ones
// with no Transaction left, which go too. A Transaction a Member added leaves only once it is
// hidden.
export async function replaceRecurringCharges(
  database: Database,
  charges: readonly FoundRecurringCharge[],
  options: { covered?: readonly string[]; gone?: readonly string[] } = {},
): Promise<void> {
  await database.transaction(async (tx) => {
    // A Member who ended one while the checks ran keeps it as it was.
    const ended = new Set<string>();
    const found = charges.map((charge) => charge.id);
    for (let start = 0; start < found.length; start += IDS_PER_QUERY) {
      const rows = await tx
        .select({ id: recurringCharges.id })
        .from(recurringCharges)
        .where(
          and(
            inArray(recurringCharges.id, found.slice(start, start + IDS_PER_QUERY)),
            eq(recurringCharges.status, "ended"),
          ),
        );
      for (const row of rows) ended.add(row.id);
    }
    const writing = charges.filter((charge) => !ended.has(charge.id));
    const ids = writing.map((charge) => charge.id);
    const written = new Set(found);
    const covered =
      options.covered ??
      (
        await tx
          .select({ id: recurringCharges.id })
          .from(recurringCharges)
          .where(ne(recurringCharges.status, "ended"))
      ).map((row) => row.id);
    const dropped = covered.filter((id) => !written.has(id));
    for (let start = 0; start < dropped.length; start += IDS_PER_QUERY) {
      await tx
        .delete(recurringCharges)
        .where(
          and(
            inArray(recurringCharges.id, dropped.slice(start, start + IDS_PER_QUERY)),
            ne(recurringCharges.status, "ended"),
            sql`NOT ${keptByHand}`,
          ),
        );
    }
    const gone = options.gone ?? [];
    for (let start = 0; start < gone.length; start += IDS_PER_QUERY) {
      await tx
        .delete(recurringCharges)
        .where(
          and(
            inArray(recurringCharges.id, gone.slice(start, start + IDS_PER_QUERY)),
            ne(recurringCharges.status, "ended"),
          ),
        );
    }
    // The rows the checks wrote before, so a Transaction may move between Recurring charges, and
    // a Transaction a Member added that is hidden now.
    for (let start = 0; start < ids.length; start += IDS_PER_QUERY) {
      const chunk = ids.slice(start, start + IDS_PER_QUERY);
      await tx.delete(recurringChargeTransactions).where(
        and(
          inArray(recurringChargeTransactions.chargeId, chunk),
          or(
            isNull(recurringChargeTransactions.byHand),
            and(
              eq(recurringChargeTransactions.byHand, "added"),
              exists(
                tx
                  .select({ id: transactions.id })
                  .from(transactions)
                  .where(
                    and(
                      eq(transactions.id, recurringChargeTransactions.transactionId),
                      isNotNull(transactions.hiddenReason),
                    ),
                  ),
              ),
            ),
          ),
        ),
      );
      await tx
        .delete(recurringChargePriceChanges)
        .where(
          and(
            inArray(recurringChargePriceChanges.chargeId, chunk),
            eq(recurringChargePriceChanges.byHand, false),
          ),
        );
    }
    for (const { priceHistory: _, priceChanges: __, ...charge } of writing) {
      const { id: ___, foundAt: ____, ...facts } = charge;
      await tx
        .insert(recurringCharges)
        .values({ ...charge, oldPriceHistory: [] })
        .onConflictDoUpdate({
          target: recurringCharges.id,
          set: { ...facts, oldPriceHistory: [] },
        });
    }
    const members = writing.flatMap((charge) =>
      charge.priceHistory
        .filter((entry) => entry.addedByHand !== true)
        .map(({ transactionId, date, amount }) => ({
          chargeId: charge.id,
          transactionId,
          date,
          amount,
        })),
    );
    for (let start = 0; start < members.length; start += ROWS_PER_INSERT) {
      // A row a Member marked, or a Transaction in another Recurring charge, wins.
      await tx
        .insert(recurringChargeTransactions)
        .values(members.slice(start, start + ROWS_PER_INSERT))
        .onConflictDoNothing();
    }
    const changes = writing.flatMap((charge) =>
      (charge.priceChanges ?? []).map((change) => ({
        id: crypto.randomUUID(),
        chargeId: charge.id,
        ...change,
        byHand: false,
      })),
    );
    for (let start = 0; start < changes.length; start += ROWS_PER_INSERT) {
      await tx
        .insert(recurringChargePriceChanges)
        .values(changes.slice(start, start + ROWS_PER_INSERT))
        .onConflictDoNothing();
    }
  });
}

// Marks a Recurring charge ended. Returns it, or undefined when no Recurring charge has the ID. One
// already ended keeps its first end.
export async function endRecurringCharge(
  database: Database,
  id: string,
  ended: { memberId: string; at: Date },
): Promise<StoredRecurringCharge | undefined> {
  await database
    .update(recurringCharges)
    .set({ status: "ended", endedAt: ended.at, endedBy: ended.memberId })
    .where(and(eq(recurringCharges.id, id), ne(recurringCharges.status, "ended")));
  return readRecurringCharge(database, id);
}

// Stores a Member's name, Category, or price band on a Recurring charge. One marked ended takes a
// name and a Category, but no price band (owner decision D38). False when none has the ID, or a
// price band meets one marked ended.
export async function editRecurringCharge(
  database: Queries,
  id: string,
  edits: RecurringChargeEdits,
): Promise<boolean> {
  const updated = await database
    .update(recurringCharges)
    .set(edits)
    .where(
      edits.priceBand === undefined
        ? eq(recurringCharges.id, id)
        : and(eq(recurringCharges.id, id), ne(recurringCharges.status, "ended")),
    )
    .returning({ id: recurringCharges.id });
  return updated.length > 0;
}

// A Member adds a Transaction to a Recurring charge, or removes one from it. An added one leaves
// any other Recurring charge it was in. Writes only through `database`, so it may run inside the
// edit's transaction.
export async function markChargeTransaction(
  database: Queries,
  chargeId: string,
  entry: { transactionId: string; date: string; amount: number },
  byHand: "added" | "removed",
): Promise<void> {
  if (byHand === "added") {
    await database
      .delete(recurringChargeTransactions)
      .where(
        and(
          eq(recurringChargeTransactions.transactionId, entry.transactionId),
          ne(recurringChargeTransactions.chargeId, chargeId),
          or(
            isNull(recurringChargeTransactions.byHand),
            ne(recurringChargeTransactions.byHand, "removed"),
          ),
        ),
      );
  }
  await database
    .insert(recurringChargeTransactions)
    .values({ chargeId, ...entry, byHand })
    .onConflictDoUpdate({
      target: [recurringChargeTransactions.chargeId, recurringChargeTransactions.transactionId],
      set: { byHand },
    });
}

// The Recurring charge a Transaction is in, with its status and a Member's Category, or undefined
// when it is in none.
export async function readChargeOfTransaction(
  database: Queries,
  transactionId: string,
): Promise<
  { id: string; status: ChargeRow["status"]; handSetCategory: string | null } | undefined
> {
  const [row] = await database
    .select({
      id: recurringCharges.id,
      status: recurringCharges.status,
      handSetCategory: recurringCharges.handSetCategory,
    })
    .from(recurringChargeTransactions)
    .innerJoin(recurringCharges, eq(recurringCharges.id, recurringChargeTransactions.chargeId))
    .where(
      and(
        eq(recurringChargeTransactions.transactionId, transactionId),
        or(
          isNull(recurringChargeTransactions.byHand),
          ne(recurringChargeTransactions.byHand, "removed"),
        ),
      ),
    );
  return row;
}

// The name a Member gave the Recurring charge each of `transactionIds` is in, for those in a named
// one.
export async function readChargeNames(
  database: Queries,
  transactionIds: readonly string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (let start = 0; start < transactionIds.length; start += IDS_PER_QUERY) {
    const rows = await database
      .select({
        transactionId: recurringChargeTransactions.transactionId,
        name: recurringCharges.name,
      })
      .from(recurringChargeTransactions)
      .innerJoin(recurringCharges, eq(recurringCharges.id, recurringChargeTransactions.chargeId))
      .where(
        and(
          inArray(
            recurringChargeTransactions.transactionId,
            transactionIds.slice(start, start + IDS_PER_QUERY),
          ),
          or(
            isNull(recurringChargeTransactions.byHand),
            ne(recurringChargeTransactions.byHand, "removed"),
          ),
          isNotNull(recurringCharges.name),
        ),
      );
    for (const row of rows) if (row.name !== null) names.set(row.transactionId, row.name);
  }
  return names;
}

// A Member's price change from `fromDate`, in place of their earlier one on that date. Returns
// its ID.
export async function storeMemberPriceChange(
  database: Queries,
  chargeId: string,
  change: { fromDate: string; amount: number },
): Promise<string> {
  const [row] = await database
    .insert(recurringChargePriceChanges)
    .values({ id: crypto.randomUUID(), chargeId, ...change, byHand: true })
    .onConflictDoUpdate({
      target: [
        recurringChargePriceChanges.chargeId,
        recurringChargePriceChanges.byHand,
        recurringChargePriceChanges.fromDate,
      ],
      set: { amount: change.amount },
    })
    .returning({ id: recurringChargePriceChanges.id });
  if (row === undefined) throw new Error("The price change was not stored.");
  return row.id;
}

// Deletes a Member's price change on the Recurring charge. False when it has none with the ID.
export async function deleteMemberPriceChange(
  database: Queries,
  chargeId: string,
  changeId: string,
): Promise<boolean> {
  const deleted = await database
    .delete(recurringChargePriceChanges)
    .where(
      and(
        eq(recurringChargePriceChanges.id, changeId),
        eq(recurringChargePriceChanges.chargeId, chargeId),
        eq(recurringChargePriceChanges.byHand, true),
      ),
    )
    .returning({ id: recurringChargePriceChanges.id });
  return deleted.length > 0;
}

// Moves each price history from before recurring_charge_transactions into it, in one statement, and
// leaves the old column empty. A Transaction deleted since is left out. The start calls it once,
// before any job runs.
export async function moveOldPriceHistories(database: Database): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.run(sql`
      INSERT OR IGNORE INTO ${recurringChargeTransactions}
        (charge_id, transaction_id, date, amount, by_hand)
      SELECT ${recurringCharges.id}, entry.value ->> 'transactionId', entry.value ->> 'date',
        entry.value ->> 'amount', NULL
      FROM ${recurringCharges}, json_each(${recurringCharges.oldPriceHistory}) AS entry
      WHERE EXISTS (SELECT 1 FROM ${transactions} WHERE ${transactions.id} = entry.value ->> 'transactionId')`);
    await tx
      .update(recurringCharges)
      .set({ oldPriceHistory: [] })
      .where(ne(recurringCharges.oldPriceHistory, sql`'[]'`));
  });
}

// What the Reports page's Recurring charges report reads (spec 07, Reports), in 3 reads: every
// Recurring charge; every payment, oldest first by posted date, which is each posted Transaction in
// a charge that still shows, with its purchase date (else its posted date) and amount in whole
// cents spent; and every price change. A Transaction a Member removed is no payment.
export async function listRecurringReportRows(database: Queries): Promise<{
  charges: Pick<
    ChargeRow,
    "id" | "name" | "merchantId" | "merchantName" | "status" | "latestAmount"
  >[];
  payments: { chargeId: string; date: string; postedDate: string; amount: number }[];
  priceChanges: { chargeId: string; fromDate: string; amount: number; byHand: boolean }[];
}> {
  const charges = await database
    .select({
      id: recurringCharges.id,
      name: recurringCharges.name,
      merchantId: recurringCharges.merchantId,
      merchantName: recurringCharges.merchantName,
      status: recurringCharges.status,
      latestAmount: recurringCharges.latestAmount,
    })
    .from(recurringCharges);
  const payments = await database
    .select({
      chargeId: recurringChargeTransactions.chargeId,
      date: sql<string>`coalesce(${transactions.authorizedDate}, ${transactions.postedDate})`,
      postedDate: transactions.postedDate,
      amount: recurringChargeTransactions.amount,
    })
    .from(recurringChargeTransactions)
    .innerJoin(transactions, eq(transactions.id, recurringChargeTransactions.transactionId))
    .where(
      and(
        sql`${recurringChargeTransactions.byHand} IS NOT 'removed'`,
        eq(transactions.pending, false),
        isNull(transactions.hiddenReason),
      ),
    )
    .orderBy(asc(transactions.postedDate), asc(transactions.id));
  const priceChanges = await database
    .select({
      chargeId: recurringChargePriceChanges.chargeId,
      fromDate: recurringChargePriceChanges.fromDate,
      amount: recurringChargePriceChanges.amount,
      byHand: recurringChargePriceChanges.byHand,
    })
    .from(recurringChargePriceChanges)
    .orderBy(asc(recurringChargePriceChanges.fromDate));
  return { charges, payments, priceChanges };
}
