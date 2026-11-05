import {
  type AlertDecision,
  type AlertKind,
  clearAlertDecisionFailures,
  countAlertDecisionFailure,
  type Database,
  type DecidedAlert,
  listAlertTexts,
  listDecidedAlertsSince,
  listUndecidedAlerts,
  type NewAlertDelivery,
  readWeeklyCap,
  restartAlertDecisionCount,
  storeAlertDecisions,
  storeWeeklyCap,
  type UndecidedAlert,
} from "../db/index.ts";
import { registerFollowUpStep } from "../follow-up/index.ts";
import { calendarDateIn } from "../format.ts";
import { householdTimeZone } from "../household/index.ts";
import { log } from "../log.ts";
import { askForDelivery, endCondition, raiseNotice } from "../notify/index.ts";
import { addDays } from "../recurring/index.ts";
import { mergedHeading } from "./templates.ts";

// The Alerts step (spec 06, Sending Alerts; The weekly cap; Merging). It runs last among the
// follow-up job's Alert steps and decides each new Alert's state when it is created:
// - Alerts of one kind created on one day, Household time, merge into one Alert that counts once.
//   An Alert created after that day's Alert of its kind was sent or held back joins it, with that
//   state, and sends nothing itself.
// - The weekly cap: at most this many Alerts are sent a week, Monday to Sunday, Household time.
//   The cap counts Alerts, not Members: every Member gets the same Alert. Within one batch, slots
//   go by priority; across batches, earlier Alerts take them. An Alert over the cap is "held back
//   (weekly cap)": no channel sends it, now or later, and the Monthly review lists it.
// - Duplicate charge and Card interest or fee Alerts always go out and never use a slot.
// The step decides an Alert once and never changes it again, so an Alert that went out stays as it
// was, even when a later Refund or Reimbursement changes its month.
// Each Alert the step newly sends gets a delivery record with its decision, holding its message as
// it reads then, and the step asks the notify module to deliver it to every Member, by each
// Member's channels. Only these decisions send: an Alert that joins a sent Alert, or that is held
// back or found in history, sends nothing. An Alert decided late, such as after the step gave up
// at its cap and a later follow-up job decided it, is sent when it is decided.

// The weekly cap until a Member changes it.
export const DEFAULT_WEEKLY_CAP = 3;

// A failed run counts a try. The run that reaches this cap leaves its Alerts undecided, so the
// follow-up job goes on, and raises one System notice. The next run decides them.
export const ALERT_SENDING_CAP = 3;

// The System notice condition while the Alerts step has given up. The next run that succeeds ends
// it.
export const ALERT_SENDING_STOPPED = "alert sending stopped";

// Priority within the weekly cap (spec 06, Alert kinds and priority): 1 is the most urgent. A kind
// outside the cap has none.
const PRIORITY: Record<AlertKind, number | undefined> = {
  "Duplicate charge": undefined,
  "Card interest or fee": undefined,
  "Over Budget": 1,
  "Price increase": 2,
  "New Recurring charge": 3,
  "On pace": 4,
  "Large purchase": 5,
};

// The weekly cap: how many Alerts the app sends a week.
export async function weeklyCap(database: Database): Promise<number> {
  return (await readWeeklyCap(database)) ?? DEFAULT_WEEKLY_CAP;
}

// Any Member may change the cap, to any whole number from 0. It holds from the next Alert on.
export async function setWeeklyCap(database: Database, cap: number): Promise<number> {
  if (!Number.isSafeInteger(cap) || cap < 0) {
    throw new Error("The weekly cap is a whole number from 0.");
  }
  await storeWeeklyCap(database, cap);
  return cap;
}

// The Monday on or before a date, YYYY-MM-DD.
function mondayOf(date: string): string {
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

// The Alerts of one kind created on one day.
type DayOfKind = { kind: AlertKind; day: string; alerts: UndecidedAlert[] };

const dayOfKind = (kind: AlertKind, day: string) => `${kind} ${day}`;

// A sent Alert's message: its kind as the title, and its template text. A merged Alert has its
// heading, then each part's line. The AI's advice follows, when any part has some.
function alertMessage(
  kind: AlertKind,
  ids: readonly string[],
  texts: Map<string, { text: string; advice: string | null }>,
  createdAt: Date,
): NewAlertDelivery | undefined {
  const [first] = ids;
  if (first === undefined) return undefined;
  const parts = ids.flatMap((id) => {
    const part = texts.get(id);
    return part === undefined ? [] : [part];
  });
  const lines = parts.map((part) => part.text);
  const text =
    lines.length > 1
      ? [mergedHeading(kind, lines.length), ...lines.map((line) => `- ${line}`)].join("\n")
      : (lines[0] ?? "");
  const advice = parts.flatMap((part) => (part.advice === null ? [] : [part.advice]));
  return {
    alertId: first,
    title: kind,
    text,
    advice: advice.length === 0 ? null : advice.join("\n"),
    createdAt,
  };
}

// Decides the state of each Alert not decided yet. Returns how many Alerts it sent and held back,
// counting a merged Alert once, how many joined an Alert already decided, and the IDs of the
// Alerts it newly sent: an Alert of one part, or a merged Alert's first part.
export async function decideAlerts(
  database: Database,
): Promise<{ sent: number; heldBack: number; joined: number; sentIds: string[] }> {
  const done = { sent: 0, heldBack: 0, joined: 0 };
  const undecided = await listUndecidedAlerts(database);
  const [oldest] = undecided;
  if (oldest === undefined) return { ...done, sentIds: [] };
  const timeZone = (await householdTimeZone(database)) ?? "UTC";
  const dayOf = (at: Date) => calendarDateIn(at, timeZone);
  const cap = await weeklyCap(database);

  // The Alerts already decided in the oldest new Alert's week and since. A day before its Monday
  // in UTC is before that Monday in every time zone.
  const firstMonday = mondayOf(dayOf(oldest.createdAt));
  const since = new Date(`${addDays(firstMonday, -1)}T00:00:00.000Z`);
  const decided = new Map<string, DecidedAlert>();
  const slotsUsed = new Map<string, number>();
  for (const alert of await listDecidedAlertsSince(database, since)) {
    const day = dayOf(alert.createdAt);
    if (day < firstMonday) continue;
    const key = dayOfKind(alert.kind, day);
    if (!decided.has(key)) decided.set(key, alert);
    if (alert.state === "sent" && PRIORITY[alert.kind] !== undefined) {
      const week = mondayOf(day);
      slotsUsed.set(week, (slotsUsed.get(week) ?? 0) + 1);
    }
  }

  const groups = new Map<string, DayOfKind>();
  for (const alert of undecided) {
    const day = dayOf(alert.createdAt);
    const key = dayOfKind(alert.kind, day);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { kind: alert.kind, day, alerts: [alert] });
    else group.alerts.push(alert);
  }
  // By day, then the most urgent first. Kinds outside the cap use no slot, so their place does not
  // matter.
  const ordered = [...groups.values()].sort(
    (a, b) => a.day.localeCompare(b.day) || (PRIORITY[a.kind] ?? 0) - (PRIORITY[b.kind] ?? 0),
  );

  const decisions: AlertDecision[] = [];
  const sending: { kind: AlertKind; ids: string[] }[] = [];
  for (const { kind, day, alerts } of ordered) {
    const joins = decided.get(dayOfKind(kind, day));
    if (joins !== undefined) {
      for (const alert of alerts) {
        decisions.push({ id: alert.id, state: joins.state, mergedInto: joins.id });
      }
      done.joined += alerts.length;
      continue;
    }
    let state: AlertDecision["state"] = "sent";
    if (PRIORITY[kind] !== undefined) {
      const week = mondayOf(day);
      const used = slotsUsed.get(week) ?? 0;
      if (used < cap) slotsUsed.set(week, used + 1);
      else state = "held back (weekly cap)";
    }
    const [first, ...later] = alerts;
    if (first === undefined) continue;
    decisions.push({ id: first.id, state, mergedInto: null });
    for (const alert of later) decisions.push({ id: alert.id, state, mergedInto: first.id });
    if (state === "sent") {
      done.sent += 1;
      sending.push({ kind, ids: alerts.map((alert) => alert.id) });
    } else done.heldBack += 1;
  }
  const texts = await listAlertTexts(
    database,
    sending.flatMap((each) => each.ids),
  );
  const sentAt = new Date();
  const deliveries = sending.flatMap(({ kind, ids }) => {
    const message = alertMessage(kind, ids, texts, sentAt);
    return message === undefined ? [] : [message];
  });
  const stored = await storeAlertDecisions(database, decisions, deliveries);
  const sentIds = deliveries.flatMap((each) => (stored.has(each.alertId) ? [each.alertId] : []));
  log.info("Decided Alerts", done);
  return { ...done, sentIds };
}

// Registers the Alerts step, after the Overspending checks. A run that fails counts a try and
// throws, so the follow-up job runs again. The run that reaches the cap raises one System notice
// and leaves its Alerts undecided: they send nothing, and the job goes on. The next run decides
// them, and the next run that succeeds ends the notice. A run that sends Alerts asks for their
// delivery once their decisions are stored. The start calls it before jobs run.
export function startAlertSending(options: { database: Database }): { stop(): void } {
  const { database } = options;
  const stop = registerFollowUpStep("alerts", async () => {
    let sentIds: string[];
    try {
      ({ sentIds } = await decideAlerts(database));
    } catch (error) {
      const tries = await countAlertDecisionFailure(database);
      // Only the error's name: a failed query's message holds its values.
      log.error("The Alerts step failed", {
        tries,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      if (tries < ALERT_SENDING_CAP) throw new Error("The Alerts step failed.");
      await restartAlertDecisionCount(database);
      await raiseNotice({
        kind: "condition",
        condition: ALERT_SENDING_STOPPED,
        text: "The app could not decide which new Alerts to send, so they wait. It tries again after each sync.",
      });
      return undefined;
    }
    if (await clearAlertDecisionFailures(database)) await endCondition(ALERT_SENDING_STOPPED);
    if (sentIds.length > 0) await askForDelivery();
    return undefined;
  });
  return { stop };
}
