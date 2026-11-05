import { and, desc, eq, gt, isNull, ne, notExists, or, type SQL } from "drizzle-orm";
import type { AlertKind, AlertState } from "./alerts.ts";
import type { Database } from "./client.ts";
import { alertNotesDone, alertParts, alerts } from "./schema.ts";

// The dashboard's AI box in app.db (spec 07, 1. AI box): the Alerts it shows as Alert notes, and
// each note's Done mark. The anomalies module decides; these functions store and read.

// An Alert shown as an Alert note, with its Done mark.
export type AlertNoteRow = {
  id: string;
  kind: AlertKind;
  createdAt: Date;
  facts: Record<string, unknown>;
  text: string;
  advice: string | null;
  state: AlertState | null;
  // For a later part of a merged Alert: the merged Alert's first part. Null otherwise.
  mergedInto: string | null;
  done: boolean;
};

// An Alert found in a history load never shows in the AI box. One the Alerts step has not decided
// yet shows at once.
const notFromHistory = (): SQL | undefined =>
  or(isNull(alerts.state), ne(alerts.state, "found in history"));

// The Alerts created after `since` that are not found in history, newest first.
export async function listAlertNoteRows(database: Database, since: Date): Promise<AlertNoteRow[]> {
  const rows = await database
    .select({
      id: alerts.id,
      kind: alerts.kind,
      createdAt: alerts.createdAt,
      facts: alerts.facts,
      text: alerts.text,
      advice: alerts.advice,
      state: alerts.state,
      mergedInto: alertParts.mergedInto,
      doneId: alertNotesDone.alertId,
    })
    .from(alerts)
    .leftJoin(alertParts, eq(alertParts.alertId, alerts.id))
    .leftJoin(alertNotesDone, eq(alertNotesDone.alertId, alerts.id))
    .where(and(gt(alerts.createdAt, since), notFromHistory()))
    .orderBy(desc(alerts.createdAt), desc(alerts.id));
  return rows.map(({ doneId, ...row }) => ({ ...row, done: doneId !== null }));
}

// Marks one Alert note Done for every Member, or clears the mark, in one transaction. The note is
// an Alert created after `since`, not found in history, and not a later part of a merged Alert,
// whose note is its first part's. Marking a done note again keeps the first mark. Returns false,
// and changes nothing, when no such Alert has the ID.
export async function storeAlertNoteDone(
  database: Database,
  mark: { alertId: string; memberId: string; at: Date; since: Date; done: boolean },
): Promise<boolean> {
  const { alertId, memberId, at, since, done } = mark;
  return database.transaction(async (tx) => {
    const [note] = await tx
      .select({ id: alerts.id })
      .from(alerts)
      .where(
        and(
          eq(alerts.id, alertId),
          gt(alerts.createdAt, since),
          notFromHistory(),
          notExists(
            tx
              .select({ id: alertParts.alertId })
              .from(alertParts)
              .where(eq(alertParts.alertId, alerts.id)),
          ),
        ),
      );
    if (note === undefined) return false;
    if (done) {
      await tx
        .insert(alertNotesDone)
        .values({ alertId, memberId, doneAt: at })
        .onConflictDoNothing();
    } else {
      await tx.delete(alertNotesDone).where(eq(alertNotesDone.alertId, alertId));
    }
    return true;
  });
}
