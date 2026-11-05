import { type AlertKind, type AlertState, type Database, listAlerts } from "../db/index.ts";
import { calendarDateIn } from "../format.ts";
import { householdTimeZone } from "../household/index.ts";
import { type AlertFacts, mergedHeading } from "./templates.ts";

// The Alert list (spec 06, The Alert list): every Alert, including those held back by the weekly
// cap and those found in history.

export type Alert = {
  id: string;
  kind: AlertKind;
  createdAt: Date;
  // The template's facts, and its text from them.
  facts: AlertFacts;
  text: string;
  // The Transactions it is about, in the template's order, or the Category.
  transactionIds: string[];
  category: string | null;
  // The AI's advice, if any.
  advice: string | null;
  // Each "Not a problem" press: who, and when. A removed Member's press keeps its time.
  notAProblem: { memberId: string | null; pressedAt: Date }[];
  // "sent", "held back (weekly cap)", or "found in history". Null until the Alerts step decides.
  state: AlertState | null;
  // For a later part of a merged Alert (spec 06, Merging): the merged Alert's first part. It
  // shares that part's state and is never sent itself. Null otherwise.
  mergedInto: string | null;
};

// Every stored Alert, newest first. A merged Alert's parts are each listed.
export async function alertList(database: Database): Promise<Alert[]> {
  return (await listAlerts(database)).map((stored) => ({
    id: stored.id,
    kind: stored.kind,
    createdAt: stored.createdAt,
    facts: stored.facts as AlertFacts,
    text: stored.text,
    transactionIds: stored.transactionIds,
    category: stored.category,
    advice: stored.advice,
    notAProblem: stored.presses,
    state: stored.state,
    mergedInto: stored.mergedInto,
  }));
}

// An Alert as Members see it (spec 06, Merging): one part, or the parts of one kind created on one
// day, Household time, under one heading. Its ID, time, and state are its first part's.
export type MergedAlert = {
  id: string;
  kind: AlertKind;
  createdAt: Date;
  // Such as "2 Categories are over Budget", for two or more parts. Null for one part.
  heading: string | null;
  // The first part, then each later part, oldest first.
  parts: Alert[];
  state: AlertState | null;
};

// Every Alert as Members see it, newest first.
export async function mergedAlertList(database: Database): Promise<MergedAlert[]> {
  const stored = await alertList(database);
  const later = new Map<string, Alert[]>();
  for (const alert of stored.toReversed()) {
    if (alert.mergedInto === null) continue;
    const parts = later.get(alert.mergedInto);
    if (parts === undefined) later.set(alert.mergedInto, [alert]);
    else parts.push(alert);
  }
  return stored.flatMap((alert) => {
    if (alert.mergedInto !== null) return [];
    const parts = [alert, ...(later.get(alert.id) ?? [])];
    return [
      {
        id: alert.id,
        kind: alert.kind,
        createdAt: alert.createdAt,
        heading: parts.length > 1 ? mergedHeading(alert.kind, parts.length) : null,
        parts,
        state: alert.state,
      },
    ];
  });
}

// The Alerts the weekly cap held back that were created in `month` (YYYY-MM), Household time,
// oldest first: the Monthly review's "Alerts you did not get" (spec 07, Reviews page).
export async function alertsHeldBack(database: Database, month: string): Promise<MergedAlert[]> {
  const timeZone = (await householdTimeZone(database)) ?? "UTC";
  return (await mergedAlertList(database))
    .filter(
      (alert) =>
        alert.state === "held back (weekly cap)" &&
        calendarDateIn(alert.createdAt, timeZone).startsWith(`${month}-`),
    )
    .toReversed();
}
