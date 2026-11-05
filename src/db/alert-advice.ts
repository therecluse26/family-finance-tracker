import { and, asc, desc, eq, inArray, isNull, max } from "drizzle-orm";
import type { AlertKind } from "./alerts.ts";
import type { Database } from "./client.ts";
import {
  alertPresses,
  alerts,
  alertTransactions,
  transactionParts,
  transactions,
} from "./schema.ts";

// The AI's advice on Alerts in app.db (spec 06, The AI's advice). The anomalies module decides;
// these functions store and read.

// SQLite takes at most 32,766 values in one statement.
const IDS_PER_QUERY = 1000;

// An Alert as the advice call reads it: its kind and template facts, the Category it is about,
// and the first Account and Category of the Transactions it is about.
export type AlertForAdvice = {
  id: string;
  kind: AlertKind;
  facts: Record<string, unknown>;
  category: string | null;
  // The Account of a Transaction it is about, or null with none.
  accountId: string | null;
  // The Category of a Transaction it is about, from its first part with one, or null with none.
  transactionCategory: string | null;
};

// The first Account and Category of the Transactions each of these Alerts is about, by Alert.
async function aboutOf(
  database: Database,
  alertIds: readonly string[],
): Promise<Map<string, { accountId: string; category: string | null }>> {
  const found = new Map<string, { accountId: string; category: string | null }>();
  for (let start = 0; start < alertIds.length; start += IDS_PER_QUERY) {
    const rows = await database
      .select({
        alertId: alertTransactions.alertId,
        accountId: transactions.accountId,
        category: transactionParts.category,
      })
      .from(alertTransactions)
      .innerJoin(transactions, eq(transactions.id, alertTransactions.transactionId))
      .leftJoin(transactionParts, eq(transactionParts.transactionId, transactions.id))
      .where(inArray(alertTransactions.alertId, alertIds.slice(start, start + IDS_PER_QUERY)))
      .orderBy(asc(alertTransactions.transactionId), asc(transactionParts.part));
    for (const { alertId, accountId, category } of rows) {
      const about = found.get(alertId);
      if (about === undefined) found.set(alertId, { accountId, category });
      else if (about.category === null) about.category = category;
    }
  }
  return found;
}

const withAbout = async (
  database: Database,
  rows: readonly Omit<AlertForAdvice, "accountId" | "transactionCategory">[],
): Promise<AlertForAdvice[]> => {
  const about = await aboutOf(
    database,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    ...row,
    accountId: about.get(row.id)?.accountId ?? null,
    transactionCategory: about.get(row.id)?.category ?? null,
  }));
};

// The Alerts the next advice call covers, oldest first: each Alert the Alerts step has not decided
// yet that no advice call has been done with. An Alert found in a history load is decided when it
// is created, so it gets no advice.
export async function listAlertsToAdvise(database: Database): Promise<AlertForAdvice[]> {
  const rows = await database
    .select({ id: alerts.id, kind: alerts.kind, facts: alerts.facts, category: alerts.category })
    .from(alerts)
    .where(and(isNull(alerts.state), isNull(alerts.advisedAt)))
    .orderBy(asc(alerts.createdAt), asc(alerts.id));
  return withAbout(database, rows);
}

// The latest `limit` Alerts a Member pressed "Not a problem" on, the latest press first.
export async function listNotAProblemAlerts(
  database: Database,
  limit: number,
): Promise<AlertForAdvice[]> {
  const lastPress = max(alertPresses.pressedAt);
  const rows = await database
    .select({ id: alerts.id, kind: alerts.kind, facts: alerts.facts, category: alerts.category })
    .from(alerts)
    .innerJoin(alertPresses, eq(alertPresses.alertId, alerts.id))
    .groupBy(alerts.id)
    .orderBy(desc(lastPress), asc(alerts.id))
    .limit(limit);
  return withAbout(database, rows);
}

// Stores the advice call's end for these Alerts, in one transaction: each one's advice, if any,
// and the time the call was done with it. Only an Alert that is still undecided and not yet done
// with changes, so a sent Alert never gets advice later. Returns the IDs of the Alerts it changed.
export async function storeAlertAdvice(
  database: Database,
  alertIds: readonly string[],
  advice: ReadonlyMap<string, string>,
  at: Date,
): Promise<Set<string>> {
  const done = new Set<string>();
  const covered = new Set(alertIds);
  const open = (ids: readonly string[]) =>
    and(inArray(alerts.id, ids), isNull(alerts.state), isNull(alerts.advisedAt));
  await database.transaction(async (tx) => {
    for (const [id, text] of advice) {
      if (!covered.has(id)) continue;
      const changed = await tx
        .update(alerts)
        .set({ advice: text, advisedAt: at })
        .where(open([id]))
        .returning({ id: alerts.id });
      for (const row of changed) done.add(row.id);
    }
    for (let start = 0; start < alertIds.length; start += IDS_PER_QUERY) {
      const changed = await tx
        .update(alerts)
        .set({ advisedAt: at })
        .where(open(alertIds.slice(start, start + IDS_PER_QUERY)))
        .returning({ id: alerts.id });
      for (const row of changed) done.add(row.id);
    }
  });
  return done;
}
