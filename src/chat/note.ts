import {
  type HouseholdAi,
  type SummaryPart,
  typedAmount,
  typedCount,
  typedDate,
  typedMonth,
} from "../ai/index.ts";
import { type AlertWriter, alertList, alertNotes, alertPieces } from "../anomalies/index.ts";
import { type Database, readShownTransactions } from "../db/index.ts";
import { openProposals } from "../proposals/index.ts";

// The note a Chat thread starts from with "Ask about this" (spec 08, Threads): an Alert note or an
// open Proposal in the AI box. The app reads the note itself from its ID, never from the browser,
// and keeps a copy with the thread: the words the thread shows, and the pieces the AI reads, with
// each amount, date, and month as a typed value (src/ai/typed.ts).

export type NoteKind = "Alert note" | "Proposal";

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

// The Alert note in the box at `now` with this ID, with its parts, oldest first. An Account in its
// facts goes as its label: the facts hold the Account's name as it was, which may name a Member.
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
  const labels = await ai.accountLabels();
  const accountOf = new Map(
    (
      await readShownTransactions(
        database,
        parts.flatMap((alert) => alert.transactionIds),
      )
    ).map((txn) => [txn.id, txn.accountId]),
  );
  const pieces: Piece[] = [`An Alert note: ${note.kind}.`];
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
  if (note.nextStep !== null) pieces.push(`\nThe next step the AI gave: ${plain(note.nextStep)}`);
  return {
    kind: "Alert note",
    title: note.title,
    lines: [...note.why, ...(note.nextStep === null ? [] : [`Next step: ${note.nextStep}`])],
    pieces,
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

// The note in the AI box at `now` with this kind and ID, or undefined when none is there now.
export function readNote(
  database: Database,
  ai: Pick<HouseholdAi, "accountLabels">,
  note: { kind: NoteKind; id: string },
  now: Date,
): Promise<ChatNote | undefined> {
  return note.kind === "Alert note"
    ? alertNote(database, ai, note.id, now)
    : proposalNote(database, note.id, now);
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
    (note.kind === "Alert note" || note.kind === "Proposal") &&
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
  const parts: SummaryPart[] = ["The Member asks about this note from the AI box.\n"];
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
