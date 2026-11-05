import { type Database, storeAlertPress } from "../db/index.ts";
import type { Alert } from "./alert-list.ts";

// "Not a problem" (spec 06, "Not a problem"). Any Member may press it on any Alert, for the whole
// Household. The press only stores who pressed it and when, and makes no AI call. The Anomaly
// checks read the presses on each run, so the same Alert does not come back:
// - Duplicate charge: each Transaction it is about is cleared, and never joins a Duplicate charge
//   again.
// - Large purchase: its Transaction never fires a Large purchase again, as no Transaction does.
// - Price increase: the new price is accepted. A later Price increase in that Recurring charge is
//   measured from it.
// - New Recurring charge: its Merchant and amount are known. That Merchant never fires a New
//   Recurring charge again at an amount within 7.5% of it.
// - Over Budget, On pace, Card interest or fee: nothing else changes.
// The next scheduled AI call reads the presses from the Alert list, to learn which Alerts this
// Household does not care about.

// Records a Member's press on one Alert, or one part of a merged Alert. A Member's second press on
// it records nothing. Returns its presses, oldest first, or undefined when no Alert has the ID.
export async function markNotAProblem(
  database: Database,
  alertId: string,
  memberId: string,
  now = new Date(),
): Promise<Alert["notAProblem"] | undefined> {
  return storeAlertPress(database, { alertId, memberId, pressedAt: now });
}
