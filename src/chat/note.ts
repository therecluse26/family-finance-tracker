import {
  type HouseholdAi,
  type SummaryPart,
  typedAmount,
  typedCount,
  typedDate,
  typedMonth,
} from "../ai/index.ts";
import {
  type Alert,
  type AlertWriter,
  alertList,
  alertNotes,
  alertPieces,
  alertTitle,
  mergedAlertList,
} from "../anomalies/index.ts";
import {
  type AlertState,
  type Database,
  listInsightCards,
  readShownTransactions,
} from "../db/index.ts";
import { calendarDateIn } from "../format.ts";
import { householdTimeZone } from "../household/index.ts";
import { openProposals } from "../proposals/index.ts";

// The note a Chat thread starts from with "Ask about this" (spec 08, Threads): an Alert note, an
// open Proposal, or an Insight card in the AI box. Or the Alert a thread starts from with "Ask the
// AI" in the Alert list (spec 06, "Ask the AI"). The app reads the note itself from its ID, never
// from the browser, and keeps a copy with the thread: the words the thread shows, and the pieces
// the AI reads, with each amount, date, and month as a typed value (src/ai/typed.ts).

const NOTE_KINDS = ["Alert note", "Proposal", "Insight card", "Alert"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

// One piece of the note the AI reads: text, or a number the app made. app.db stores the pieces as
// JSON, never a typed value, whose mark is new each time the app starts.
type Piece = string | { amount: number } | { date: string } | { month: string } | { count: number };

export type ChatNote = {
  kind: NoteKind;
  // The note's title, which the drafted question names, and its lines as the thread shows them.
  title: string;
  lines: string[];
  pieces: Piece[];
};

// The note as the thread shows it.
export type ChatNoteView = Pick<ChatNote, "kind" | "title" | "lines">;

// Every control character, and the line and paragraph separators.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters it replaces.
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu;

// Text a bank, a Member, or the AI wrote, on one line: well-formed, with a space for each control
// character, so it cannot start a line of its own. A piece keeps the spaces at its ends, which
// part it from the pieces beside it: a name glued to the word before it would pass the privacy
// filter.
const oneLine = (text: string) => text.toWellFormed().replace(CONTROL, " ").replace(/ {2,}/g, " ");

// The same, as a whole value with no space at either end.
const plain = (text: string) => oneLine(text).trim();

const money = (cents: number): Piece => ({ amount: Math.round(cents) || 0 });

// An amount in whole dollars, as "$" and a count. An amount too large for a count goes in an
// amount's form.
function dollars(cents: number): Piece[] {
  const whole = Math.floor((Math.abs(cents) + 50) / 100);
  const sign = cents < 0 && whole > 0 ? "-" : "";
  return [`${sign}$`, whole < 1_000_000_000 ? { count: whole } : money(whole * 100)];
}

// An Alert's template (src/anomalies/templates.ts) as pieces: each amount as "$" and a typed
// value, each date and month typed, and its words and the names in it as text.
const ALERT_WRITER: AlertWriter<Piece[]> = {
  text: (text) => [oneLine(text)],
  cents: (cents) => [cents < 0 ? "-$" : "$", money(Math.abs(cents))],
  dollars,
  percent: (ratio) => {
    const whole = Math.floor(Math.abs(ratio) * 100 + 0.5);
    const sign = ratio < 0 && whole > 0 ? "-" : "";
    return [sign, whole < 1_000_000_000 ? { count: whole } : String(whole), "%"];
  },
  date: (date) => [{ date }],
  month: (month) => [{ month }],
  year: (year) => [{ count: Number(year) }],
};

// An Alert's parts, oldest first, as pieces: one line each. An Account in its facts goes as its
// label: the facts hold the Account's name as it was, which may name a Member.
async function partPieces(
  database: Database,
  ai: Pick<HouseholdAi, "accountLabels">,
  parts: readonly Alert[],
): Promise<Piece[]> {
  const labels = await ai.accountLabels();
  const accountOf = new Map(
    (
      await readShownTransactions(
        database,
        parts.flatMap((alert) => alert.transactionIds),
      )
    ).map((txn) => [txn.id, txn.accountId]),
  );
  const pieces: Piece[] = [];
  for (const alert of parts) {
    let facts = alert.facts;
    if (facts.kind === "Duplicate charge" || facts.kind === "Card interest or fee") {
      const accountId = alert.transactionIds
        .map((txnId) => accountOf.get(txnId))
        .find((each) => each !== undefined);
      const account = (accountId === undefined ? undefined : labels.get(accountId)) ?? "an Account";
      facts = { ...facts, account };
    }
    pieces.push("\n- ", ...alertPieces(facts, ALERT_WRITER).flat());
  }
  return pieces;
}

// The Alert note in the box at `now` with this ID, with its parts, oldest first.
async function alertNote(
  database: Database,
  ai: Pick<HouseholdAi, "accountLabels">,
  id: string,
  now: Date,
): Promise<ChatNote | undefined> {
  const note = (await alertNotes(database, now)).find((each) => each.id === id);
  if (note === undefined) return undefined;
  const parts = (await alertList(database))
    .filter((alert) => alert.id === id || alert.mergedInto === id)
    .toReversed();
  const pieces: Piece[] = [
    `An Alert note: ${note.kind}.`,
    ...(await partPieces(database, ai, parts)),
  ];
  if (note.nextStep !== null) pieces.push(`\nThe next step the AI gave: ${plain(note.nextStep)}`);
  return {
    kind: "Alert note",
    title: note.title,
    lines: [...note.why, ...(note.nextStep === null ? [] : [`Next step: ${note.nextStep}`])],
    pieces,
  };
}

// What the Alerts step did with an Alert, as the AI reads it.
const STATE_WORDS: Record<AlertState, string> = {
  sent: "The app sent it to the Members.",
  "held back (weekly cap)": "The weekly cap held it back, so the app sent no message for it.",
  "found in history": "The app found it in loaded history, so it sent no message for it.",
};

// The Alert in the Alert list with this ID, the merged Alert's or any of its parts', with every
// part, oldest first, titled on the Household's date at `now`. `alertId` is the merged Alert's ID.
export async function listedAlert(
  database: Database,
  ai: Pick<HouseholdAi, "accountLabels">,
  id: string,
  now: Date,
): Promise<{ alertId: string; note: ChatNote } | undefined> {
  const alert = (await mergedAlertList(database)).find((each) =>
    each.parts.some((part) => part.id === id),
  );
  const [first, ...later] = alert?.parts ?? [];
  if (alert === undefined || first === undefined) return undefined;
  const today = calendarDateIn(now, (await householdTimeZone(database)) ?? "UTC");
  const title = alertTitle(alert.kind, [first.facts, ...later.map((part) => part.facts)], today);
  const advice = [
    ...new Set(alert.parts.flatMap((part) => (part.advice === null ? [] : [part.advice]))),
  ];
  const nextStep = advice.length === 0 ? null : advice.join(" ");
  const pieces: Piece[] = [
    `An Alert from the Alert list: ${alert.kind}.`,
    ...(await partPieces(database, ai, alert.parts)),
  ];
  if (alert.state !== null) pieces.push(`\n${STATE_WORDS[alert.state]}`);
  const marked = alert.parts.filter((part) => part.notAProblem.length > 0).length;
  if (marked > 0) {
    pieces.push(
      ...(later.length === 0
        ? ['\nA Member marked it "Not a problem".']
        : ["\nMembers marked ", { count: marked }, ' of its parts "Not a problem".']),
    );
  }
  if (nextStep !== null) pieces.push(`\nThe next step the AI gave: ${plain(nextStep)}`);
  return {
    alertId: alert.id,
    note: {
      kind: "Alert",
      title,
      lines: [
        ...alert.parts.map((part) => part.text),
        ...(nextStep === null ? [] : [`Next step: ${nextStep}`]),
      ],
      pieces,
    },
  };
}

// The open Proposal at `now` with this ID.
async function proposalNote(
  database: Database,
  id: string,
  now: Date,
): Promise<ChatNote | undefined> {
  const proposal = (await openProposals(database, now)).find((each) => each.id === id);
  if (proposal === undefined) return undefined;
  const pieces: Piece[] = [`An open Proposal from ${proposal.source}: ${proposal.kind}.`];
  for (const budget of proposal.budgets) {
    const each = budget.period === "yearly" ? " a year" : " a month";
    pieces.push(
      `\n- ${plain(budget.category)} Budget: `,
      ...(budget.from === null ? ["no Budget"] : [...dollars(budget.from), each]),
      " to ",
      ...dollars(budget.to),
      each,
    );
  }
  if (proposal.goal !== null) {
    pieces.push(
      `\n- The Goal "${plain(proposal.goal.words)}": a Goal amount of `,
      ...dollars(proposal.goal.goalAmount),
    );
  }
  if (proposal.words !== null) pieces.push(`\n- A new Goal: "${plain(proposal.words)}"`);
  pieces.push(`\nIts reason: ${plain(proposal.reason)}`);
  return {
    kind: "Proposal",
    title: proposal.changes.join("; "),
    lines: [...proposal.changes, proposal.reason],
    pieces,
  };
}

// Each card group by the name the AI box shows.
const CARD_GROUPS = {
  worth_acting_on: "Worth acting on",
  heads_up: "Heads up",
  good_news: "Good news",
} as const;

// The largest figure a card shows (src/insights/cards.ts): past it, the card shows none.
const MAX_FIGURE = 1e12;

// A card's figure as pieces: whole dollars as "$" and a typed value, a count typed, and a percent
// as a typed count and "%". A figure too large for a typed count goes as text.
function figurePieces(figure: number, kind: "dollars" | "count" | "percent"): Piece[] {
  if (kind === "dollars") return dollars(Math.round(figure * 100));
  const whole = Math.floor(Math.abs(figure) + 0.5);
  const sign = figure < 0 && whole > 0 ? "-" : "";
  return [
    sign,
    whole < 1_000_000_000 ? { count: whole } : String(whole),
    kind === "percent" ? "%" : "",
  ];
}

// The current Insight card with this ID. A card from an older run is gone: each run replaces every
// card. Every word on a card is the AI's, stored with each Member's name for the screen, so each
// goes as text through the privacy filter; its figure is a number the app checked, so it goes typed.
async function insightCardNote(database: Database, id: string): Promise<ChatNote | undefined> {
  const card = (await listInsightCards(database)).find((each) => each.id === id);
  if (card === undefined) return undefined;
  const goodNews = card.group === "good_news";
  const pieces: Piece[] = [
    `An Insight card in ${CARD_GROUPS[card.group]}, about ${plain(card.about)}: ${plain(card.title)}`,
  ];
  if (card.figure !== null && Number.isFinite(card.figure) && Math.abs(card.figure) < MAX_FIGURE) {
    pieces.push(
      "\n- Its figure: ",
      ...figurePieces(card.figure, card.figureKind),
      ` ${plain(card.figureLabel)}`,
    );
  }
  pieces.push(
    `\n- Why: ${plain(card.why)}`,
    goodNews
      ? `\n- What it means: ${plain(card.nextStep)}`
      : `\n- Next step: ${plain(card.nextStep)}`,
  );
  return {
    kind: "Insight card",
    title: card.title,
    lines: [card.why, goodNews ? card.nextStep : `Next step: ${card.nextStep}`],
    pieces,
  };
}

// The note in the AI box at `now` with this kind and ID, or undefined when none is there now.
export function readNote(
  database: Database,
  ai: Pick<HouseholdAi, "accountLabels">,
  note: { kind: Exclude<NoteKind, "Alert">; id: string },
  now: Date,
): Promise<ChatNote | undefined> {
  switch (note.kind) {
    case "Alert note":
      return alertNote(database, ai, note.id, now);
    case "Proposal":
      return proposalNote(database, note.id, now);
    case "Insight card":
      return insightCardNote(database, note.id);
  }
}

const isPiece = (piece: unknown): piece is Piece => {
  if (typeof piece === "string") return true;
  if (typeof piece !== "object" || piece === null || Object.keys(piece).length !== 1) return false;
  const [[key, value] = []] = Object.entries(piece);
  if (key === "amount" || key === "count") return typeof value === "number";
  return (key === "date" || key === "month") && typeof value === "string";
};

// The note stored with a thread, or undefined when it holds anything else.
export function storedNote(json: unknown): ChatNote | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const note = json as Partial<ChatNote>;
  const fits =
    NOTE_KINDS.some((kind) => kind === note.kind) &&
    typeof note.title === "string" &&
    Array.isArray(note.lines) &&
    note.lines.every((line) => typeof line === "string") &&
    Array.isArray(note.pieces) &&
    note.pieces.every(isPiece);
  return fits ? (note as ChatNote) : undefined;
}

// The note's pieces as Chat sends them, with each number a typed value. Text next to text goes as
// one. A piece that no longer fits its typed form, such as from an older app, leaves the note out.
export function noteParts(note: ChatNote): SummaryPart[] | undefined {
  const parts: SummaryPart[] = [
    note.kind === "Alert"
      ? "The Member asks about this Alert from the Alert list.\n"
      : "The Member asks about this note from the AI box.\n",
  ];
  try {
    for (const piece of note.pieces) {
      const part: SummaryPart =
        typeof piece === "string"
          ? piece
          : "amount" in piece
            ? typedAmount(piece.amount)
            : "date" in piece
              ? typedDate(piece.date)
              : "month" in piece
                ? typedMonth(piece.month)
                : typedCount(piece.count);
      const last = parts.at(-1);
      if (typeof part === "string" && typeof last === "string") {
        parts[parts.length - 1] = last + part;
      } else if (part !== "") {
        parts.push(part);
      }
    }
  } catch {
    return undefined;
  }
  return parts;
}
