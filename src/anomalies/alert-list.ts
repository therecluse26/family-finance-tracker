import { type AlertKind, type AlertState, type Database, listAlerts } from "../db/index.ts";
import type { AlertFacts } from "./templates.ts";

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
};

// Every Alert, newest first.
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
  }));
}
