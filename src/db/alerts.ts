import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  notExists,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  alertDecisions,
  alertParts,
  alertPresses,
  alertSettings,
  alerts,
  alertTransactions,
  anomalyChecks,
  overspendingChecks,
  transactionParts,
  transactions,
} from "./schema.ts";

// Alerts in app.db (spec 06, The Alert list). The anomalies module decides; these functions store
// and read.

export type AlertKind = (typeof alerts.$inferSelect)["kind"];
export type AlertState = NonNullable<(typeof alerts.$inferSelect)["state"]>;

export type NewAlert = {
  id: string;
  kind: AlertKind;
  createdAt: Date;
  facts: Record<string, unknown>;
  text: string;
  category: string | null;
  state: AlertState | null;
  // The Transactions it is about, in the template's order.
  transactionIds: readonly string[];
};

export type StoredAlert = typeof alerts.$inferSelect & {
  transactionIds: string[];
  presses: { memberId: string | null; pressedAt: Date }[];
  // The merged Alert's first part, for a later part of a merged Alert. Null otherwise.
  mergedInto: string | null;
};

// SQLite takes at most 32,766 values in one statement. An Alert row has 8.
const ROWS_PER_INSERT = 1000;

// Stores the Alerts and the Transactions each is about, in one transaction.
export async function storeAlerts(database: Database, found: readonly NewAlert[]): Promise<void> {
  if (found.length === 0) return;
  await database.transaction(async (tx) => {
    for (let start = 0; start < found.length; start += ROWS_PER_INSERT) {
      const chunk = found.slice(start, start + ROWS_PER_INSERT);
      await tx
        .insert(alerts)
        .values(chunk.map(({ transactionIds: _, ...alert }) => ({ ...alert, advice: null })));
      const about = chunk.flatMap((alert) =>
        alert.transactionIds.map((transactionId) => ({ alertId: alert.id, transactionId })),
      );
      if (about.length > 0) await tx.insert(alertTransactions).values(about);
    }
  });
}

// The kinds of Alert each of these Transactions is already about.
export async function listAlertKindsOf(
  database: Database,
  transactionIds: readonly string[],
): Promise<Map<string, Set<AlertKind>>> {
  const found = new Map<string, Set<AlertKind>>();
  for (let start = 0; start < transactionIds.length; start += ROWS_PER_INSERT) {
    const chunk = transactionIds.slice(start, start + ROWS_PER_INSERT);
    const rows = await database
      .select({ transactionId: alertTransactions.transactionId, kind: alerts.kind })
      .from(alertTransactions)
      .innerJoin(alerts, eq(alerts.id, alertTransactions.alertId))
      .where(inArray(alertTransactions.transactionId, chunk));
    for (const { transactionId, kind } of rows) {
      const kinds = found.get(transactionId) ?? new Set<AlertKind>();
      kinds.add(kind);
      found.set(transactionId, kinds);
    }
  }
  return found;
}

// The facts of each Alert of `kind` that a Member pressed "Not a problem" on.
export async function listPressedAlertFacts(
  database: Database,
  kind: AlertKind,
): Promise<Record<string, unknown>[]> {
  const rows = await database
    .select({ facts: alerts.facts })
    .from(alerts)
    .where(
      and(
        eq(alerts.kind, kind),
        exists(
          database
            .select({ id: alertPresses.id })
            .from(alertPresses)
            .where(eq(alertPresses.alertId, alerts.id)),
        ),
      ),
    );
  return rows.map((row) => row.facts);
}

// Every Alert, newest first, with the Transactions it is about and its "Not a problem" presses.
export async function listAlerts(database: Database): Promise<StoredAlert[]> {
  const rows = await database
    .select()
    .from(alerts)
    .orderBy(desc(alerts.createdAt), desc(alerts.id));
  const about = new Map<string, string[]>();
  for (const row of await database.select().from(alertTransactions)) {
    const ids = about.get(row.alertId);
    if (ids === undefined) about.set(row.alertId, [row.transactionId]);
    else ids.push(row.transactionId);
  }
  const presses = new Map<string, StoredAlert["presses"]>();
  for (const row of await database.select().from(alertPresses).orderBy(asc(alertPresses.id))) {
    const press = { memberId: row.memberId, pressedAt: row.pressedAt };
    const each = presses.get(row.alertId);
    if (each === undefined) presses.set(row.alertId, [press]);
    else each.push(press);
  }
  const mergedInto = new Map<string, string>();
  for (const row of await database.select().from(alertParts)) {
    mergedInto.set(row.alertId, row.mergedInto);
  }
  return rows.map((row) => ({
    ...row,
    transactionIds: about.get(row.id) ?? [],
    presses: presses.get(row.id) ?? [],
    mergedInto: mergedInto.get(row.id) ?? null,
  }));
}

// An Alert the Alerts step has not decided yet.
export type UndecidedAlert = { id: string; kind: AlertKind; createdAt: Date };

// The Alerts whose state is not decided yet, oldest first.
export async function listUndecidedAlerts(database: Database): Promise<UndecidedAlert[]> {
  return database
    .select({ id: alerts.id, kind: alerts.kind, createdAt: alerts.createdAt })
    .from(alerts)
    .where(isNull(alerts.state))
    .orderBy(asc(alerts.createdAt), asc(alerts.id));
}

// A sent or held back Alert: an Alert of one part, or a merged Alert's first part.
export type DecidedAlert = UndecidedAlert & { state: "sent" | "held back (weekly cap)" };

// The sent and held back Alerts created at or after `since`, oldest first. A merged Alert's later
// parts are left out.
export async function listDecidedAlertsSince(
  database: Database,
  since: Date,
): Promise<DecidedAlert[]> {
  const rows = await database
    .select({
      id: alerts.id,
      kind: alerts.kind,
      createdAt: alerts.createdAt,
      state: alerts.state,
    })
    .from(alerts)
    .where(
      and(
        gte(alerts.createdAt, since),
        inArray(alerts.state, ["sent", "held back (weekly cap)"]),
        notExists(
          database
            .select({ id: alertParts.alertId })
            .from(alertParts)
            .where(eq(alertParts.alertId, alerts.id)),
        ),
      ),
    )
    .orderBy(asc(alerts.createdAt), asc(alerts.id));
  return rows.flatMap(({ state, ...row }) =>
    state === "sent" || state === "held back (weekly cap)" ? [{ ...row, state }] : [],
  );
}

// The Alerts step's decision on one Alert: its state, and the merged Alert it joins, if any.
export type AlertDecision = {
  id: string;
  state: "sent" | "held back (weekly cap)";
  mergedInto: string | null;
};

// Stores the decisions in one transaction. Only an Alert that is still undecided changes, in its
// state and in the merged Alert it joins, so a sent or held back Alert never does. Returns the IDs
// of the Alerts it decided.
export async function storeAlertDecisions(
  database: Database,
  decisions: readonly AlertDecision[],
): Promise<Set<string>> {
  const decided = new Set<string>();
  if (decisions.length === 0) return decided;
  await database.transaction(async (tx) => {
    for (const state of ["sent", "held back (weekly cap)"] as const) {
      const ids = decisions.filter((each) => each.state === state).map((each) => each.id);
      for (let start = 0; start < ids.length; start += ROWS_PER_INSERT) {
        const changed = await tx
          .update(alerts)
          .set({ state })
          .where(
            and(
              inArray(alerts.id, ids.slice(start, start + ROWS_PER_INSERT)),
              isNull(alerts.state),
            ),
          )
          .returning({ id: alerts.id });
        for (const { id } of changed) decided.add(id);
      }
    }
    const parts = decisions.flatMap(({ id, mergedInto }) =>
      mergedInto === null || !decided.has(id) ? [] : [{ alertId: id, mergedInto }],
    );
    for (let start = 0; start < parts.length; start += ROWS_PER_INSERT) {
      await tx
        .insert(alertParts)
        .values(parts.slice(start, start + ROWS_PER_INSERT))
        .onConflictDoNothing();
    }
  });
  return decided;
}

const SETTINGS_ROW = 1;

// The weekly cap a Member set, or undefined when none has.
export async function readWeeklyCap(database: Database): Promise<number | undefined> {
  const [row] = await database
    .select({ weeklyCap: alertSettings.weeklyCap })
    .from(alertSettings)
    .where(eq(alertSettings.id, SETTINGS_ROW));
  return row?.weeklyCap;
}

export async function storeWeeklyCap(database: Database, weeklyCap: number): Promise<void> {
  await database
    .insert(alertSettings)
    .values({ id: SETTINGS_ROW, weeklyCap })
    .onConflictDoUpdate({ target: alertSettings.id, set: { weeklyCap } });
}

// The Alerts of these kinds that are about a Category, with their facts, oldest first.
export async function listCategoryAlerts(
  database: Database,
  kinds: readonly AlertKind[],
): Promise<{ kind: AlertKind; category: string; facts: Record<string, unknown> }[]> {
  const rows = await database
    .select({ kind: alerts.kind, category: alerts.category, facts: alerts.facts })
    .from(alerts)
    .where(and(inArray(alerts.kind, [...kinds]), isNotNull(alerts.category)))
    .orderBy(asc(alerts.createdAt), asc(alerts.id));
  return rows.flatMap(({ category, ...row }) => (category === null ? [] : [{ ...row, category }]));
}

// One posted Spending part in a Category, with its Transaction's dates, Account, Merchant, and
// provider code.
export type CategoryPart = {
  transactionId: string;
  postedDate: string;
  authorizedDate: string | null;
  accountId: string;
  merchantId: string | null;
  merchantCleanName: string | null;
  providerCategory: string | null;
  // Negative: Spending is money out.
  amount: number;
  // True for a part of a tracked loan payment.
  keepsCategory: boolean;
};

// The posted Spending parts in `category`: those of these Transactions, or those whose purchase
// date, else posted date, is on or after `since` (YYYY-MM-DD). Pending and hidden Transactions are
// left out.
export async function listSpendingPartsIn(
  database: Database,
  category: string,
  filter: { transactionIds: readonly string[] } | { since: string },
): Promise<CategoryPart[]> {
  const read = (which: SQL | undefined) =>
    database
      .select({
        transactionId: transactions.id,
        postedDate: transactions.postedDate,
        authorizedDate: transactions.authorizedDate,
        accountId: transactions.accountId,
        merchantId: transactions.merchantId,
        merchantCleanName: transactions.merchantCleanName,
        providerCategory: transactions.providerCategory,
        amount: transactionParts.amount,
        keepsCategory: transactionParts.keepsCategory,
      })
      .from(transactionParts)
      .innerJoin(transactions, eq(transactions.id, transactionParts.transactionId))
      .where(
        and(
          which,
          eq(transactionParts.type, "Spending"),
          eq(transactionParts.category, category),
          eq(transactions.pending, false),
          isNull(transactions.hiddenReason),
        ),
      )
      .orderBy(asc(transactions.id), asc(transactionParts.part));
  if ("since" in filter) {
    return read(
      gte(sql`coalesce(${transactions.authorizedDate}, ${transactions.postedDate})`, filter.since),
    );
  }
  const found: CategoryPart[] = [];
  const ids = filter.transactionIds;
  for (let start = 0; start < ids.length; start += ROWS_PER_INSERT) {
    found.push(
      ...(await read(inArray(transactions.id, ids.slice(start, start + ROWS_PER_INSERT)))),
    );
  }
  return found;
}

// A one-row table that counts a check's failed tries in a row.
type FailureCount = typeof anomalyChecks | typeof overspendingChecks | typeof alertDecisions;

const FAILURE_COUNT_ROW = 1;

async function countFailure(database: Database, table: FailureCount): Promise<number> {
  const [row] = await database
    .insert(table)
    .values({ id: FAILURE_COUNT_ROW, failedTries: 1 })
    .onConflictDoUpdate({
      target: table.id,
      set: { failedTries: sql`${table.failedTries} + 1` },
    })
    .returning({ failedTries: table.failedTries });
  return row?.failedTries ?? 1;
}

async function restartCount(database: Database, table: FailureCount): Promise<void> {
  await database.update(table).set({ failedTries: 0 }).where(eq(table.id, FAILURE_COUNT_ROW));
}

async function clearFailures(database: Database, table: FailureCount): Promise<boolean> {
  const cleared = await database
    .delete(table)
    .where(eq(table.id, FAILURE_COUNT_ROW))
    .returning({ id: table.id });
  return cleared.length > 0;
}

// Counts one failed run of the Anomaly checks. Returns the failed tries in a row.
export function countAnomalyCheckFailure(database: Database): Promise<number> {
  return countFailure(database, anomalyChecks);
}

// Starts the count of failed tries again after the run that gave up. The row stays, so the next
// run that succeeds knows a failure came before it.
export function restartAnomalyCheckCount(database: Database): Promise<void> {
  return restartCount(database, anomalyChecks);
}

// Forgets the failed tries after a run that succeeded. True when a failure came before it.
export function clearAnomalyCheckFailures(database: Database): Promise<boolean> {
  return clearFailures(database, anomalyChecks);
}

// The same three for the Overspending checks.
export function countOverspendingCheckFailure(database: Database): Promise<number> {
  return countFailure(database, overspendingChecks);
}

export function restartOverspendingCheckCount(database: Database): Promise<void> {
  return restartCount(database, overspendingChecks);
}

export function clearOverspendingCheckFailures(database: Database): Promise<boolean> {
  return clearFailures(database, overspendingChecks);
}

// The same three for the Alerts step.
export function countAlertDecisionFailure(database: Database): Promise<number> {
  return countFailure(database, alertDecisions);
}

export function restartAlertDecisionCount(database: Database): Promise<void> {
  return restartCount(database, alertDecisions);
}

export function clearAlertDecisionFailures(database: Database): Promise<boolean> {
  return clearFailures(database, alertDecisions);
}
