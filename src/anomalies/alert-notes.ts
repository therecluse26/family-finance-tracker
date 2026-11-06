import {
  type AlertKind,
  type AlertNoteRow,
  type Database,
  listAlertNoteRows,
  storeAlertNoteDone,
} from "../db/index.ts";
import { calendarDateIn, dateLabel, dollarsAndCents, monthLabel, wholeDollars } from "../format.ts";
import { householdTimeZone } from "../household/index.ts";
import { type AlertFacts, mergedHeading } from "./templates.ts";

// Alert notes in the dashboard's AI box (spec 07, 1. AI box): each Alert shows at once, as a note
// built from its template facts, and leaves 7 days after it. An Alert found in a history load
// never shows. A merged Alert is one note (spec 06, Merging). Done marks a note for every Member
// and makes no AI call.

// How long an Alert note stays in the box, in milliseconds.
export const ALERT_NOTE_MS = 7 * 24 * 60 * 60 * 1000;

export type AlertNoteGroup = "Worth acting on" | "Heads up";

// The group of each kind's note.
const GROUP_OF: Record<AlertKind, AlertNoteGroup> = {
  "Over Budget": "Worth acting on",
  "Duplicate charge": "Worth acting on",
  "Card interest or fee": "Worth acting on",
  "Price increase": "Worth acting on",
  "On pace": "Heads up",
  "New Recurring charge": "Heads up",
  "Large purchase": "Heads up",
};

export type AlertNote = {
  // The merged Alert's first part, or the Alert of one part.
  id: string;
  kind: AlertKind;
  createdAt: Date;
  group: AlertNoteGroup;
  // The left column: the number, and a short label under it, such as "$36.00" over "interest on
  // Oct 9".
  figure: string;
  figureLabel: string;
  // What it is about: a Category, a Merchant, an Account, or the kind.
  about: string;
  title: string;
  // The reason under "Why?": the template text, or each part's for a merged Alert.
  why: string[];
  // The AI's advice. Null without advice: the note then has no Next step line.
  nextStep: string | null;
  done: boolean;
};

// The note's words for one Alert's facts, on the Household's date `today`.
function noteWords(
  facts: AlertFacts,
  today: string,
): Pick<AlertNote, "figure" | "figureLabel" | "about" | "title"> {
  const day = (date: string) => dateLabel(date, today);
  const money = dollarsAndCents;
  switch (facts.kind) {
    case "Duplicate charge":
      return {
        figure: money(facts.amount),
        figureLabel: `charged twice by ${day(facts.dates[1])}`,
        about: facts.merchant.name,
        title: `Possible duplicate charge at ${facts.merchant.name}`,
      };
    case "Price increase":
      return {
        figure: `+${money(facts.amount - facts.base)}`,
        figureLabel: `price rise on ${day(facts.date)}`,
        about: facts.merchant.name,
        title: `${facts.merchant.name} went up to ${money(facts.amount)}`,
      };
    case "New Recurring charge":
      return {
        figure: money(facts.amount),
        figureLabel: `next on ${day(facts.nextDate)}`,
        about: facts.merchant.name,
        title: `New Recurring charge at ${facts.merchant.name}?`,
      };
    case "Large purchase":
      return {
        figure: money(facts.amount),
        figureLabel: `on ${day(facts.date)}`,
        about: facts.budget?.category ?? facts.merchant.name,
        title: `Large purchase at ${facts.merchant.name}`,
      };
    case "Over Budget": {
      const { budget } = facts;
      return {
        figure: wholeDollars(budget.spent - budget.budget),
        figureLabel: "over Budget",
        about: budget.category,
        title:
          budget.period === "yearly"
            ? `${budget.category} is over its ${budget.span} Budget`
            : `${budget.category} is over Budget for ${monthLabel(`${budget.span}-01`)}`,
      };
    }
    case "On pace":
      return {
        figure: wholeDollars(facts.projected - facts.budget.budget),
        figureLabel: "on pace over Budget",
        about: facts.budget.category,
        title: `${facts.budget.category} is on pace to go over Budget`,
      };
    case "Card interest or fee":
      return {
        figure: money(facts.amount),
        figureLabel: `${facts.cardInterest ? "interest" : "fee"} on ${day(facts.date)}`,
        about: facts.account,
        title: facts.cardInterest
          ? `Card interest on ${facts.account}`
          : `Fee${facts.merchant === null ? "" : ` at ${facts.merchant.name}`} on ${facts.account}`,
      };
  }
}

// An Alert's short title, such as "Card interest on Ally credit card", from its parts' facts, oldest
// first: the one part's title, or the merged heading (spec 06, Merging).
export function alertTitle(
  kind: AlertKind,
  facts: readonly [AlertFacts, ...AlertFacts[]],
  today: string,
): string {
  return facts.length === 1 ? noteWords(facts[0], today).title : mergedHeading(kind, facts.length);
}

// One note for an Alert of one part or more, oldest part first.
function noteOf(parts: [AlertNoteRow, ...AlertNoteRow[]], today: string, timeZone: string) {
  const [first] = parts;
  const advice = [...new Set(parts.flatMap((part) => (part.advice === null ? [] : [part.advice])))];
  const words =
    parts.length === 1
      ? noteWords(first.facts as AlertFacts, today)
      : {
          figure: `${parts.length}`,
          figureLabel: `Alerts on ${dateLabel(calendarDateIn(first.createdAt, timeZone), today)}`,
          about: first.kind,
          title: mergedHeading(first.kind, parts.length),
        };
  return {
    id: first.id,
    kind: first.kind,
    createdAt: first.createdAt,
    group: GROUP_OF[first.kind],
    ...words,
    why: parts.map((part) => part.text),
    nextStep: advice.length === 0 ? null : advice.join(" "),
    done: first.done,
  };
}

// The Alert notes in the box at `now`, newest first. A later part whose merged Alert has left the
// box leaves with it.
export async function alertNotes(database: Database, now: Date): Promise<AlertNote[]> {
  const timeZone = (await householdTimeZone(database)) ?? "UTC";
  const today = calendarDateIn(now, timeZone);
  const rows = await listAlertNoteRows(database, new Date(now.getTime() - ALERT_NOTE_MS));
  const later = new Map<string, AlertNoteRow[]>();
  for (const row of rows.toReversed()) {
    if (row.mergedInto === null) continue;
    const parts = later.get(row.mergedInto);
    if (parts === undefined) later.set(row.mergedInto, [row]);
    else parts.push(row);
  }
  return rows.flatMap((row) =>
    row.mergedInto === null ? [noteOf([row, ...(later.get(row.id) ?? [])], today, timeZone)] : [],
  );
}

// Marks an Alert note Done for every Member, or clears the mark. It makes no AI call. False when
// no Alert note in the box at `now` has the ID.
export function markAlertNote(
  database: Database,
  mark: { alertId: string; memberId: string; done: boolean },
  now: Date,
): Promise<boolean> {
  return storeAlertNoteDone(database, {
    ...mark,
    at: now,
    since: new Date(now.getTime() - ALERT_NOTE_MS),
  });
}
