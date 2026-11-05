import { and, asc, desc, eq, exists, inArray, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { alertPresses, alerts, alertTransactions, anomalyChecks } from "./schema.ts";

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
  return rows.map((row) => ({
    ...row,
    transactionIds: about.get(row.id) ?? [],
    presses: presses.get(row.id) ?? [],
  }));
}

const ANOMALY_CHECKS_ROW = 1;

// Counts one failed run of the Anomaly checks. Returns the failed tries in a row.
export async function countAnomalyCheckFailure(database: Database): Promise<number> {
  const [row] = await database
    .insert(anomalyChecks)
    .values({ id: ANOMALY_CHECKS_ROW, failedTries: 1 })
    .onConflictDoUpdate({
      target: anomalyChecks.id,
      set: { failedTries: sql`${anomalyChecks.failedTries} + 1` },
    })
    .returning({ failedTries: anomalyChecks.failedTries });
  return row?.failedTries ?? 1;
}

// Starts the count of failed tries again after the run that gave up. The row stays, so the next
// run that succeeds knows a failure came before it.
export async function restartAnomalyCheckCount(database: Database): Promise<void> {
  await database
    .update(anomalyChecks)
    .set({ failedTries: 0 })
    .where(eq(anomalyChecks.id, ANOMALY_CHECKS_ROW));
}

// Forgets the failed tries after a run that succeeded. True when a failure came before it.
export async function clearAnomalyCheckFailures(database: Database): Promise<boolean> {
  const cleared = await database
    .delete(anomalyChecks)
    .where(eq(anomalyChecks.id, ANOMALY_CHECKS_ROW))
    .returning({ id: anomalyChecks.id });
  return cleared.length > 0;
}
