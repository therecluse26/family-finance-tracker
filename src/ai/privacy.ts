import type { LanguageModelMiddleware } from "ai";
import { isNeverSentToAi } from "../household/index.ts";
import { log } from "../log.ts";
import { typedValueOf } from "./typed.ts";

// The privacy filter (spec 08, Privacy filter; spec 01, 11. Privacy). It rewrites every request
// before it leaves for the AI provider: Member names become "Member A", "Member B", and so on, by
// the order Members joined; email addresses, Account and card numbers, the ZIP code, and ages are
// removed; Account names become plain labels, such as "Ally checking". Names of people outside the
// Household pass. When it cannot decide, such as for a file or a value marked never sent to an AI
// provider, it refuses, and the call does not go out.

type CallOptions = Parameters<NonNullable<LanguageModelMiddleware["transformParams"]>>[0]["params"];
type Prompt = CallOptions["prompt"];
type ToolResultOutput = Extract<
  Prompt[number]["content"][number],
  { type: "tool-result" }
>["output"];

// The AI provider tools the filter lets through: the Merchant lookup's web search tools
// (src/ai/providers.ts), and no other. Their settings are the app's own constants, such as at most
// 2 searches, never Household data.
const WEB_SEARCH_TOOL_IDS: ReadonlySet<string> = new Set([
  "anthropic.web_search_20260318",
  "openai.web_search",
]);

// A Member, with the number of their label: 0 is "Member A" (src/db/members.ts).
export type PrivacyMember = { name: string; email: string; labelNumber: number };

// A removed Member's label number and name. The filter never looks for the name, but AI text from
// before the removal shows it in place of the label.
export type RemovedMember = { labelNumber: number; name: string };

export type PrivacyAccount = {
  id: string;
  name: string;
  memberName: string | null;
  institutionName: string | null;
  kind: string;
  subtype: string | null;
  // The last 4 digits.
  mask: string | null;
};

// What the filter hides. Members come in the order they joined.
export type PrivacyFacts = {
  members: readonly PrivacyMember[];
  removedMembers: readonly RemovedMember[];
  accounts: readonly PrivacyAccount[];
  zipCode: string | undefined;
  ages: readonly number[];
};

// The mark on a message a Member typed, such as a Chat message or an earlier AI reply in a Chat's
// history (spec 08, Privacy filter). The filter runs on its text as on any other, but the final
// check skips it, so it never refuses the call. A message without the mark is app-built text.
export const MEMBER_TYPED = { privacyFilter: { memberTyped: true } } as const;

function isMemberTyped(message: { providerOptions?: unknown }): boolean {
  const options = message.providerOptions as
    | { privacyFilter?: { memberTyped?: unknown } }
    | undefined;
  return options?.privacyFilter?.memberTyped === true;
}

// The mark on one text part of the Household summary that holds a typed value (src/ai/typed.ts),
// such as an amount: the part's text is the value's bare form. The filter keeps it as it is, and
// its final check skips it, as for a typed value in a tool result. Only src/ai/prompt.ts sets it.
export const TYPED_PART = "typed";

// The message's provider options without the mark, which only the filter reads.
function withoutMark<Message extends { providerOptions?: Record<string, unknown> }>(
  message: Message,
): Message {
  if (message.providerOptions?.privacyFilter === undefined) return message;
  const { privacyFilter: _, ...others } = message.providerOptions;
  const { providerOptions: __, ...rest } = message;
  return (
    Object.keys(others).length === 0 ? rest : { ...rest, providerOptions: others }
  ) as Message;
}

// The filter could not decide, so the call does not go out. The message never holds the value.
export class PrivacyRefusal extends Error {
  override name = "PrivacyRefusal";
}

// What the AI reads in place of a tool result the filter refuses on its own (spec 08, Privacy
// filter). The rest of the call goes out, so the AI answers from what is left.
export const HELD_BACK = "The privacy filter held back this result.";

export type PrivacyFilter = {
  text(text: string): string;
  // Whether the filter finds anything to remove in the text, such as a Member's name or a protected
  // number, or the text holds the filter's own "[removed]", where an earlier call's text lost
  // something, such as a name the AI cleaned from a filtered description. Each text the filter only
  // normalizes counts as clean.
  matches(text: string): boolean;
  // A tool result: plain JSON data. Its typed values pass as they are (src/ai/typed.ts).
  json(value: unknown): unknown;
  // The whole request, as the AI SDK hands it to the model.
  params(params: CallOptions): CallOptions;
  // Each Account's label, by its ID.
  accountLabels: ReadonlyMap<string, string>;
  // AI text for the screen: each "Member A" label becomes that Member's name, or a removed
  // Member's kept name.
  showMemberNames(text: string): string;
};

const REMOVED = "[removed]";

// Letters, digits, and the underscore end a whole word. So does an accent mark written after a
// letter, in NFD form.
const WORD_BEFORE = String.raw`(?<![\p{L}\p{M}\p{N}_])`;
const WORD_AFTER = String.raw`(?![\p{L}\p{N}_])`;

// Any email address, a Member's or not. It starts only where its first part starts, so a long
// run of such characters is read once.
const EMAIL =
  /(?<![\p{L}\p{M}\p{N}.!#$%&'*+/=?^_`{|}~-])[\p{L}\p{M}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{M}\p{N}-]+(?:\.[\p{L}\p{M}\p{N}-]+)+/gu;

// Every text is normalized before any rule looks at it, and the AI provider gets the normalized
// text: NFKC folds fullwidth letters and digits, such as a fullwidth "Dana" or "4111", into plain
// ones; invisible format characters, such as a zero-width space or a soft hyphen, are dropped; and
// any run of horizontal whitespace, such as two spaces, a tab, or a no-break space, becomes one
// space. Line breaks stay.
const INVISIBLE = /\p{Cf}/gu;
const HORIZONTAL_SPACE = /[^\S\n\r\v\f\p{Zl}\p{Zp}]+/gu;

export function normalizeText(text: string): string {
  return text
    .replace(MARKERS, "")
    .replace(INVISIBLE, "")
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(HORIZONTAL_SPACE, " ");
}

// Characters the filter once used for its own place markers, never let in from outside.
const MARKERS = /[\u{E000}\u{E001}]/gu;

// Each rule matches on a skeleton of the text, then removes what it matched from the text itself,
// so the text keeps its own characters around what is removed. A skeleton keeps, for each of its
// characters, the place in the text it came from. A combining mark, such as an accent or a
// keycap, is left out of every skeleton and goes with the character before it.
type Skeleton = { text: string; from: number[]; to: number[] } | { text: string; same: true };
type Span = { start: number; end: number; label: string };
type Pair = readonly [number, number];

const IS_DIGIT = /^\p{Nd}$/u;
const IS_MARK = /^\p{M}$/u;
const IS_LETTER = /^\p{L}$/u;
const ASCII = /^\p{ASCII}*$/u;

function skeletonOf(text: string, form: (char: string) => string): Skeleton {
  let out = "";
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const char of text) {
    const end = at + char.length;
    if (char >= "\u0300" && IS_MARK.test(char)) {
      if (to.length > 0 && to[to.length - 1] === at) to[to.length - 1] = end;
    } else {
      const piece = form(char);
      for (let unit = 0; unit < piece.length; unit++) {
        from.push(at);
        to.push(end);
      }
      out += piece;
    }
    at = end;
  }
  return { text: out, from, to };
}

// The place in the text of the skeleton's characters from `start` up to `end`.
function placeOf(skeleton: Skeleton, [start, end]: Pair): { start: number; end: number } {
  if ("same" in skeleton) return { start, end };
  return { start: skeleton.from[start] ?? 0, end: skeleton.to[end - 1] ?? 0 };
}

// Each text span replaced by its label. Spans with the same label that overlap or touch become
// one.
function replaceSpans(text: string, spans: readonly Span[]): string {
  const merged: Span[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last !== undefined && span.start <= last.end && span.label === last.label) {
      last.end = Math.max(last.end, span.end);
    } else if (last === undefined || span.start >= last.end) {
      merged.push({ ...span });
    }
  }
  let out = "";
  let at = 0;
  for (const span of merged) {
    out += text.slice(at, span.start) + span.label;
    at = span.end;
  }
  return out + text.slice(at);
}

// The digit skeleton: every Unicode digit becomes 0 to 9, and everything else stays. Unicode gives
// each script's digits as a run of ten, from 0 to 9, so a digit's value is its place in its run.
const digitValues = new Map<string, string>();

function digitForm(char: string): string {
  if (char < "\u0080" || !IS_DIGIT.test(char)) return char;
  let value = digitValues.get(char);
  if (value === undefined) {
    const code = char.codePointAt(0) ?? 0;
    let zero = code;
    while (IS_DIGIT.test(String.fromCodePoint(zero - 1))) zero--;
    value = String((code - zero) % 10);
    digitValues.set(char, value);
  }
  return value;
}

// In the digit skeleton, a run of one symbol, such as ---- or ......, keeps only 2 of it, so a
// longer run splits digit groups no more than -- does.
const SYMBOL = /^[^\p{L}\p{N}\p{M}\s]$/u;
const SYMBOL_RUN = /([^\p{L}\p{N}\p{M}\s])\1\1/u;

function digitSkeleton(text: string): Skeleton {
  if (ASCII.test(text) && !SYMBOL_RUN.test(text)) return { text, same: true };
  const skeleton = skeletonOf(text, digitForm);
  if ("same" in skeleton || !SYMBOL_RUN.test(skeleton.text)) return skeleton;
  let out = "";
  const from: number[] = [];
  const to: number[] = [];
  let before = "";
  let times = 0;
  for (let at = 0; at < skeleton.text.length; at++) {
    const char = skeleton.text.charAt(at);
    times = char === before ? times + 1 : 1;
    before = char;
    const last = to.length - 1;
    if (times > 2 && SYMBOL.test(char)) {
      to[last] = skeleton.to[at] ?? to[last] ?? 0;
    } else {
      out += char;
      from.push(skeleton.from[at] ?? 0);
      to.push(skeleton.to[at] ?? 0);
    }
  }
  return { text: out, from, to };
}

// Letters that carry no accent mark in NFKD form, but that a bank writes as a plain letter.
const PLAIN_LETTERS: Record<string, string> = {
  ø: "o",
  ł: "l",
  đ: "d",
  ð: "d",
  ħ: "h",
  ı: "i",
  ß: "ss",
  æ: "ae",
  œ: "oe",
};

// The letter skeleton: only letters, in lower case, with no accents. Spaces, digits, the
// underscore, and every other character are left out, so "Dana Whitfield", "dana_whitfield",
// "DANAWHITFIELD", and "D.a.n.a" give the same letters.
const letterForms = new Map<string, string>();

function letterForm(char: string): string {
  const code = char.charCodeAt(0);
  if (code < 128) {
    if (code >= 65 && code <= 90) return String.fromCharCode(code + 32);
    return code >= 97 && code <= 122 ? char : "";
  }
  let form = letterForms.get(char);
  if (form === undefined) {
    form = [...char.normalize("NFKD").toLowerCase().normalize("NFKD")]
      .filter((part) => IS_LETTER.test(part))
      .map((part) => PLAIN_LETTERS[part] ?? part)
      .join("");
    letterForms.set(char, form);
  }
  return form;
}

function lettersOf(text: string): string {
  return skeletonOf(normalizeText(text), letterForm).text;
}

// Whether a letter comes right before `at`, or right after `at`, in the text. Combining marks
// belong to the letter they follow.
function letterBefore(text: string, at: number): boolean {
  let place = at;
  while (place > 0) {
    let start = place - 1;
    const unit = text.charCodeAt(start);
    if (unit >= 0xdc00 && unit <= 0xdfff && start > 0) start--;
    const char = String.fromCodePoint(text.codePointAt(start) ?? 0);
    if (!IS_MARK.test(char)) return IS_LETTER.test(char);
    place = start;
  }
  return false;
}

function letterAfter(text: string, at: number): boolean {
  let place = at;
  while (place < text.length) {
    const char = String.fromCodePoint(text.codePointAt(place) ?? 0);
    if (!IS_MARK.test(char)) return IS_LETTER.test(char);
    place += char.length;
  }
  return false;
}

// A name to replace, as letters, longest first. With `inside`, the name matches inside a longer
// word too.
type NamePhrase = { letters: string; label: string; inside?: boolean };

// A name of two or more words, glued, matches inside a longer word when it has at least this many
// letters, such as "morganlee" in "VENMOMORGANLEE". A shorter one, such as "alli" for "Al Li",
// would match ordinary words such as "ALLIANCE", so it keeps the word-edge rule.
const INSIDE_A_WORD = 6;

// Each place the text holds one of the names, as letters with anything but letters between them,
// and with no letter right before or right after it, unless the name matches inside a word. So
// "Dana2", "@danawhitfield", "dana_whitfield", and "VENMODANAWHITFIELD" hold a name, and "Danaher"
// does not.
function findNames(text: string, phrases: readonly NamePhrase[]): Span[] {
  if (phrases.length === 0) return [];
  const skeleton = skeletonOf(text, letterForm);
  if ("same" in skeleton) return [];
  const taken = new Uint8Array(skeleton.text.length);
  const spans: Span[] = [];
  // Names at word edges first, then the names that match inside a word in what is left, so a
  // glued name never takes letters from two names next to each other, such as "rokafor RaviO".
  for (const inside of [false, true]) {
    for (const phrase of phrases) {
      if (inside && phrase.inside !== true) continue;
      let at = skeleton.text.indexOf(phrase.letters);
      while (at !== -1) {
        const end = at + phrase.letters.length;
        const place = placeOf(skeleton, [at, end]);
        if (
          !taken.subarray(at, end).includes(1) &&
          (inside || (!letterBefore(text, place.start) && !letterAfter(text, place.end)))
        ) {
          taken.fill(1, at, end);
          spans.push({ ...place, label: phrase.label });
          at = skeleton.text.indexOf(phrase.letters, end);
        } else {
          at = skeleton.text.indexOf(phrase.letters, at + 1);
        }
      }
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

// The pairs of skeleton places where `pattern` matches `text`, or where its named `group` does,
// moved by `offset`. The pattern needs the g flag, and the d flag for a group.
function pairsOf(pattern: RegExp, text: string, offset = 0, group?: string): Pair[] {
  const pairs: Pair[] = [];
  for (const match of text.matchAll(pattern)) {
    const place = group === undefined ? undefined : match.indices?.groups?.[group];
    if (group === undefined) {
      pairs.push([offset + match.index, offset + match.index + match[0].length]);
    } else if (place !== undefined) {
      pairs.push([offset + place[0], offset + place[1]]);
    }
  }
  return pairs;
}

// The parts of the skeleton outside what `safe` matches, each with its place. Each part starts and
// ends next to a character that is not a digit, so a pattern in it sees whole numbers.
function partsOutside(text: string, safe: RegExp): [string, number][] {
  const parts: [string, number][] = [];
  let last = 0;
  for (const match of text.matchAll(safe)) {
    parts.push([text.slice(last, match.index), last]);
    last = match.index + match[0].length;
  }
  parts.push([text.slice(last), last]);
  return parts;
}

// What may stand between the digit groups of one number: any spaces and line breaks, and up to 3
// other characters that are neither letters nor digits, in any script, such as - – — | ; : ' " ( )
// [ ] / \ · or an emoji. So 4111 2222 3333 5555, 4111–2222–3333–5555, 4111 -- 2222 -- 3333 -- 5555,
// and [4111][2222][3333][5555] are each one number. The final check takes up to 6.
const GAP = String.raw`(?:\s*[^\p{L}\p{Nd}\s]){0,3}\s*`;
const WIDE_GAP = String.raw`(?:\s*[^\p{L}\p{Nd}\s]){0,6}\s*`;

// A masked number, such as XXXX1234, ****1234, ...1234, or x1234.
const MASKED = new RegExp(
  String.raw`(?<![\p{L}\p{N}*•#.…])(?:(?:[Xx*•#]{2,}|\.{2,}|…)${GAP}\p{Nd}{2,}|[Xx*•#]\p{Nd}{3,})`,
  "gu",
);
const ENDING_IN = new RegExp(
  String.raw`\b(?:ending(?:\s+in)?|last\s+(?:4|four)(?:\s+digits)?)[\s:#]+(?<number>\p{Nd}+(?:${GAP}\p{Nd}+)*)`,
  "giud",
);

// Digit groups joined by a GAP. A run with 8 or more digits outside its dates, times, and amounts
// is removed whole: any run of 8 or more digits, and a card or Account number however it is split.
const DIGIT_RUN = new RegExp(String.raw`(?<!\p{Nd})\p{Nd}+(?:${GAP}\p{Nd}+)*`, "gu");

// A card number: 13 to 19 digits that pass the Luhn check, with up to 6 symbols between groups,
// or split into fields, such as {"a":"4111","b":"1111"} or a=4111&b=1111. It is removed.
const FIELD = String.raw`["']?\s*[,;&]\s*["']?[\p{L}_][\p{L}\p{Nd}_]{0,23}["']?\s*[:=]\s*["']?`;
const CARD_RUN = new RegExp(
  String.raw`(?<!\p{Nd})\p{Nd}+(?:(?:${FIELD}|${WIDE_GAP})\p{Nd}+)*`,
  "gu",
);

const WIDE_RUN = new RegExp(String.raw`(?<!\p{Nd})\p{Nd}+(?:${WIDE_GAP}\p{Nd}+)*`, "gu");

// Whether a run holds a card number: its digits, or with `parts`, any of its groups in a row, such
// as the first four groups of 4111 1111 1111 1111 77, after field names are left out.
function holdsACard(run: string, parts = false): boolean {
  const groups = run
    .replace(/[\p{L}_][\p{L}\p{Nd}_]*/gu, " ")
    .split(PIECE_SPLIT)
    .filter((piece) => !SAFE_PIECES.some((safe) => safe.test(piece)))
    .map((piece) => piece.replace(/\D/gu, ""))
    .filter((digits) => digits !== "");
  const isCard = (digits: string) =>
    digits.length >= 13 && digits.length <= 19 && passesLuhn(digits);
  if (!parts) return isCard(groups.join(""));
  for (let first = 0; first < groups.length; first++) {
    let digits = "";
    for (let last = first; last < groups.length && digits.length < 19; last++) {
      digits += groups[last];
      if (isCard(digits)) return true;
    }
  }
  return false;
}

// A real date, a real time, and an amount with cents.
const ISO_DATE = String.raw`(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])`;
const US_DATE = String.raw`(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])\/(?:\d{4}|\d{2})`;
const US_DAY = String.raw`(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])`;
const TIME = String.raw`(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?`;

// A run's pieces: its groups, split by every gap but a single - . / or :. A date, a time, or an
// amount with cents, such as 2026-10-14, 10/14/2026, 9:30, or 412.50, does not count toward the 8
// digits. Thousands commas split an amount into pieces, so $1,234,567 counts 7 digits.
const PIECE_SPLIT = /[^\p{Nd}]{2,}|[^\p{Nd}\-./:]/u;
const SAFE_PIECES = [ISO_DATE, US_DATE, TIME, String.raw`\d{1,7}\.\d{1,2}`].map(
  (piece) => new RegExp(`^(?:${piece})$`, "u"),
);

function unsafeDigits(run: string): string {
  return run
    .split(PIECE_SPLIT)
    .filter((piece) => !SAFE_PIECES.some((safe) => safe.test(piece)))
    .join("")
    .replace(/\D/gu, "");
}

// Digit groups split by symbols, such as 12-34-56-78, 123.456.789, or 1-800-555-1212. Each is
// removed unless it is a date, a time, an amount, or a short range.
const DIGIT_GROUPS = /\p{Nd}+(?:[-./_#*:\p{Pd}−]\p{Nd}+)+/gu;
const SAFE_GROUPS = [ISO_DATE, US_DATE, US_DAY, TIME, String.raw`\d+\.\d+`].map(
  (group) => new RegExp(`^(?:${group})$`, "u"),
);
// A range, such as 10-15 or 10–15, of fewer than 8 digits in all.
const RANGE = /^\p{Nd}{1,4}[-\p{Pd}−]\p{Nd}{1,4}$/u;

// A real date or time. An Account's last 4 digits are never looked for inside one, so a last 4 of
// 2026 leaves the year in 2026-10-14, and a last 4 of 1000 leaves 10:00. Inside an amount, a last 4
// is removed.
const EDGE_BEFORE = String.raw`(?<![\d.,:/])`;
const EDGE_AFTER = String.raw`(?!\d|[.,:/]\d)`;
const DATES_AND_TIMES = new RegExp(
  `${EDGE_BEFORE}(?:${ISO_DATE}|${US_DATE}|${TIME})${EDGE_AFTER}`,
  "gu",
);
// A date, a time, or an amount with thousands commas or cents that are not all zero, such as
// 1,000 or 8.41. Ages are never looked for inside one, so 8.41 stays. 41.0 is the age 41.
const SAFE_FOR_AGES = new RegExp(
  `${EDGE_BEFORE}(?:${ISO_DATE}|${US_DATE}|${TIME}|` +
    String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d*[1-9]\d*)${EDGE_AFTER}`,
  "gu",
);

// A ZIP code named as one.
const ZIP_NAMED =
  /\b(?:zip(?:\s*code)?|postal\s*code)\b[^\p{Nd}\n]{0,12}(?<number>\p{Nd}{5}(?:\s*\p{Pd}\s*\p{Nd}{4})?)/dgiu;

// A number on its own, not part of a longer one, with its digits split by a GAP, such as a last 4
// of 4821 written 48 21, 48-21, 4,821, or 48:21.
function wholeNumber(digits: string): string {
  return String.raw`(?<!\p{Nd})${[...digits].join(GAP)}(?!\p{Nd})`;
}

// An age in words, such as "eight" or "forty-one", written "forty one" or "fortyone" too.
const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const WORD_GAP = String.raw`[\s\p{Pd}]?`;

function numberWords(n: number): string {
  if (n < 20) return ONES[n] ?? "";
  if (n < 100) {
    const tens = TENS[Math.floor(n / 10)] ?? "";
    return n % 10 === 0 ? tens : `${tens}${WORD_GAP}${ONES[n % 10]}`;
  }
  const hundreds = `${ONES[Math.floor(n / 100) % 10]}${WORD_GAP}hundred`;
  return n % 100 === 0
    ? hundreds
    : `${hundreds}(?:${WORD_GAP}and)?${WORD_GAP}${numberWords(n % 100)}`;
}

// Field names that hold a Household fact: zip, zipCode, postal_code, age, ages.
const FACT_FIELD_WORDS = new Set(["zip", "zipcode", "postal", "postalcode", "age", "ages", "aged"]);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

// What may break up the letters of an email address, such as "d.a.n.a".
const LETTER_SPLIT = "[.·•*_-]?";

// An email address as a whole-word pattern, in any case. It runs on normalized NFD text, and each
// letter matches with or without accent marks.
function wholePhrase(phrase: string): RegExp {
  const letters = (word: string) =>
    [...normalizeText(word).normalize("NFD").replace(/\p{M}/gu, "")]
      .map((letter) => {
        const plain = PLAIN_LETTERS[letter.toLowerCase()];
        const either = plain === undefined ? escapeRegExp(letter) : `(?:${letter}|${plain})`;
        return String.raw`${either}\p{M}*`;
      })
      .join(LETTER_SPLIT);
  const words = normalizeText(phrase).trim().split(/\s+/u).map(letters).join(String.raw`\s+`);
  return new RegExp(`${WORD_BEFORE}${words}${WORD_AFTER}`, "giu");
}

// "Member A" for label number 0, the first Member to join, then B to Z, then AA, AB, and so on.
export function memberLabel(labelNumber: number): string {
  let letters = "";
  for (let n = labelNumber + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return `Member ${letters}`;
}

function fieldWords(name: string): string[] {
  return name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
}

function namesAFact(name: string): boolean {
  const words = fieldWords(name);
  return words.some((word) => FACT_FIELD_WORDS.has(word)) || FACT_FIELD_WORDS.has(words.join(""));
}

function wordCount(text: string): number {
  return text
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== "").length;
}

function digitCount(text: string): number {
  return text.match(/\p{Nd}/gu)?.length ?? 0;
}

// The Luhn check that every card number passes.
function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let place = 0; place < digits.length; place++) {
    let digit = digits.charCodeAt(digits.length - 1 - place) - 48;
    if (place % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}

function isTextOrNumber(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

// Each text the AI model reads in the prompt, in order.
function promptTexts(messages: Prompt): string[] {
  return messages.flatMap((message): string[] =>
    message.role === "system"
      ? [message.content]
      : message.content.flatMap((part) =>
          "text" in part && typeof part.text === "string" ? [part.text] : [],
        ),
  );
}

export function privacyFilter(facts: PrivacyFacts): PrivacyFilter {
  const members = facts.members.map((member) => ({
    ...member,
    full: member.name.trim(),
    label: memberLabel(member.labelNumber),
  }));

  // Each Member's name as letters, in these forms: the whole name; the first word; every other
  // word, and every part of a hyphenated word, of 3 or more letters, such as "Ortega" in "Luis
  // Ortega Ruiz" or "Park" in "Zoë O'Neil-Park"; any two of those glued either way round, such as
  // "zoepark" or "okaforravi"; and, when 5 letters or more, the first initial with each of them,
  // such as "lortega", and the first word with the last initial, such as "RaviO". A name that two
  // Members share names both, such as "Member A or Member B". The whole name of two or more words,
  // and any two words glued, match inside a longer word too, such as "VENMOMORGANLEE PMT".
  const memberPhrases = new Map<string, string[]>();
  const glued = new Set<string>();
  for (const member of members) {
    const words = normalizeText(member.name).trim().split(/\s+/u);
    const first = lettersOf(words[0] ?? "");
    const lastWord = lettersOf(words.at(-1) ?? "");
    const parts = words
      .slice(1)
      .flatMap((word) => [word, ...word.split(/\p{Pd}/u)])
      .map(lettersOf)
      .filter((part) => part.length >= 3);
    const units = [...new Set([first, ...parts])].filter((unit) => unit !== "");
    const forms = [lettersOf(member.name), ...units];
    if (words.length >= 2) glued.add(lettersOf(member.name));
    for (const one of units) {
      for (const other of units) {
        if (one === other) continue;
        forms.push(one + other);
        glued.add(one + other);
      }
    }
    if (words.length >= 2 && first !== "") {
      forms.push(
        ...[...parts.map((part) => first.slice(0, 1) + part), first + lastWord.slice(0, 1)].filter(
          (form) => form.length >= 5,
        ),
      );
    }
    for (const letters of new Set(forms)) {
      if (letters === "") continue;
      memberPhrases.set(letters, [
        ...new Set([...(memberPhrases.get(letters) ?? []), member.label]),
      ]);
    }
  }
  const byLength = (a: NamePhrase, b: NamePhrase) => b.letters.length - a.letters.length;
  const memberNamePhrases: NamePhrase[] = [...memberPhrases]
    .map(([letters, labels]) => ({
      letters,
      label: labels.join(" or "),
      inside: glued.has(letters) && letters.length >= INSIDE_A_WORD,
    }))
    .sort(byLength);

  // Labels by bank and type, in a fixed order, so each Account keeps its number.
  const accountLabels = new Map<string, string>();
  const taken = new Map<string, number>();
  for (const account of [...facts.accounts].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const parts = [account.institutionName, account.subtype ?? account.kind]
      .map((part) => part?.trim() ?? "")
      .filter((part) => part !== "");
    const named = normalizeText(parts.join(" ") || "Account");
    const base = replaceSpans(named, findNames(named, memberNamePhrases));
    const key = base.toLowerCase();
    const count = (taken.get(key) ?? 0) + 1;
    taken.set(key, count);
    accountLabels.set(account.id, count === 1 ? base : `${base} ${count}`);
  }

  // An Account name of one word, such as "Bills", is too likely an ordinary word to replace.
  const accountPhrases: NamePhrase[] = facts.accounts.flatMap((account) =>
    [account.name, account.memberName]
      .filter((name): name is string => name !== null && wordCount(name) >= 2)
      .map((name) => ({
        letters: lettersOf(name),
        label: accountLabels.get(account.id) ?? "Account",
      }))
      .filter((phrase) => phrase.letters !== ""),
  );
  const namePhrases = [...accountPhrases, ...memberNamePhrases].sort(byLength);

  const emails = members.map((member) => wholePhrase(member.email));

  // The stored facts as digits, each matched with its digits split by a GAP.
  const digitsOf = (value: string) => digitSkeleton(normalizeText(value)).text.replace(/\D/gu, "");
  const masks = facts.accounts
    .map((account) => digitsOf(account.mask ?? ""))
    .filter((mask) => mask !== "")
    .map((mask) => new RegExp(wholeNumber(mask), "gu"));
  // The ZIP code, and any +4. It is looked for everywhere, amounts included, so 30301.00 loses its
  // ZIP code.
  const zipCode = digitsOf(facts.zipCode ?? "");
  const zip =
    zipCode === ""
      ? undefined
      : new RegExp(String.raw`${wholeNumber(zipCode)}(?:${GAP}\p{Nd}{4}(?!\p{Nd}))?`, "gu");

  // A stored age, in digits with no letter next to them, as 41.0, or in words, so the 9s in an ID
  // such as 9c26-9ab8 are not ages. A list of 2 or more stored ages, in any order,
  // with any separator of up to 12 other characters and with or without an age word, such as
  // "8, 41, 39", "39 and 8", or "forty-one and eight", is removed anywhere outside dates, times,
  // and amounts. A single age is too common a number to look for on its own; the rules for named
  // ages cover it.
  const ageNumbers = [...new Set(facts.ages.map((age) => Math.trunc(age)))].filter(
    (age) => age >= 0 && age < 1000,
  );
  const ageDigits = ageNumbers.map(String).sort((a, b) => b.length - a.length);
  const ageWords = String.raw`(?<!\p{L})(?:${ageNumbers.map(numberWords).join("|")})(?!\p{L})`;
  const storedAge =
    ageNumbers.length === 0
      ? undefined
      : String.raw`(?:(?<![\p{L}\p{Nd}])(?:${ageDigits.join("|")})(?:\.0+)?(?![\p{L}\p{Nd}])|${ageWords})`;
  const ages =
    storedAge === undefined || facts.ages.length < 2
      ? undefined
      : new RegExp(String.raw`${storedAge}(?:[^\p{Nd}]{1,12}${storedAge})+`, "giu");

  // An age named as one: "age 34", "age is 34", "ages 34 and 7", "aged 34", "turned 34", "34 years
  // old", "34 years of age", "34yrs", "34-year-old", "7yo", or a stored age in words. A stored age
  // right after a Member and "is" or "was", such as "Member A is 41", is named as one too.
  const anyAge = String.raw`(?:(?<!\p{Nd})\p{Nd}{1,3}(?:\.0+)?(?!\p{Nd})${storedAge === undefined ? "" : `|${ageWords}`})`;
  const ANY_AGE = new RegExp(anyAge, "giu");
  // At most 8 ages in a row, so a long list of small numbers is read once, not once per number.
  const ageList = String.raw`${anyAge}(?:\s*(?:,|&|\/|and)\s*${anyAge}){0,7}`;
  const namedAges = [
    String.raw`\b(?:ages?|aged|turned|turns)\b(?:[\s:="'\[(]|\b(?:is|was|now|of|are|were)\b){0,8}(?<list>${ageList})`,
    String.raw`(?<list>${ageList})(?=\s*\p{Pd}?\s*(?:years?|yrs?)\s*\p{Pd}?\s*old\b|\s*(?:years?|yrs?)\s+of\s+age\b|\s*yrs\b|\s*(?:yo|y\/o|y\.o\.)(?!\p{L}))`,
    ...(storedAge === undefined
      ? []
      : [
          String.raw`\bmember [a-z]{1,3}\s+(?:is|was|turned|turns)\s+(?:now\s+)?(?<list>${storedAge})`,
        ]),
  ].map((rule) => new RegExp(rule, "giud"));

  // Every place the digit skeleton holds a number to remove.
  function numberPairs(text: string): Pair[] {
    return [
      ...pairsOf(MASKED, text),
      ...pairsOf(ENDING_IN, text, 0, "number"),
      ...pairsOf(DIGIT_RUN, text).filter(
        ([start, end]) => unsafeDigits(text.slice(start, end)).length >= 8,
      ),
      ...pairsOf(DIGIT_GROUPS, text).filter(([start, end]) => {
        const group = text.slice(start, end);
        if (SAFE_GROUPS.some((safe) => safe.test(group))) return false;
        return !(RANGE.test(group) && digitCount(group) < 8);
      }),
      ...partsOutside(text, DATES_AND_TIMES).flatMap(([part, at]) =>
        masks.flatMap((mask) => pairsOf(mask, part, at)),
      ),
      ...pairsOf(CARD_RUN, text).filter(([start, end]) => holdsACard(text.slice(start, end), true)),
      ...pairsOf(ZIP_NAMED, text, 0, "number"),
      ...(zip === undefined ? [] : pairsOf(zip, text)),
      ...partsOutside(text, SAFE_FOR_AGES).flatMap(([part, at]) => [
        ...(ages === undefined ? [] : pairsOf(ages, part, at)),
        ...namedAges.flatMap((rule) =>
          pairsOf(rule, part, at, "list").flatMap(([start, end]) =>
            pairsOf(ANY_AGE, text.slice(start, end), start),
          ),
        ),
      ]),
    ];
  }

  function removeNumbers(text: string): string {
    const skeleton = digitSkeleton(text);
    return replaceSpans(
      text,
      numberPairs(skeleton.text).map((pair) => ({ ...placeOf(skeleton, pair), label: REMOVED })),
    );
  }

  // Whether the text still holds the ZIP code, a list of stored ages, an Account's last 4 digits,
  // or a card number: 13 to 19 digits that pass the Luhn check, outside dates, times, and amounts,
  // with up to 6 other characters between groups.
  function holdsAFact(text: string): boolean {
    const digits = digitSkeleton(text).text;
    if (zip !== undefined && digits.search(zip) !== -1) return true;
    const maskParts = partsOutside(digits, DATES_AND_TIMES);
    if (masks.some((mask) => maskParts.some(([part]) => part.search(mask) !== -1))) return true;
    if (ages !== undefined) {
      if (partsOutside(digits, SAFE_FOR_AGES).some(([part]) => part.search(ages) !== -1)) {
        return true;
      }
    }
    return [...digits.matchAll(WIDE_RUN)].some(([run]) => holdsACard(run));
  }

  function text(input: string): string {
    if (typeof input !== "string") throw new PrivacyRefusal("The privacy filter takes only text.");
    let out = normalizeText(input).normalize("NFD");
    for (const email of emails) out = out.replace(email, REMOVED);
    out = out.replace(EMAIL, REMOVED).normalize("NFC");
    out = replaceSpans(out, findNames(out, namePhrases));
    // A removal can bring two numbers close, such as two stored ages, so the number rules run
    // again until the text stops changing, at most 3 times. The final check then passes what the
    // filter wrote.
    for (let round = 0; round < 3; round++) {
      const again = removeNumbers(out);
      if (again === out) break;
      out = again;
    }
    return out;
  }

  // Text and number values of one array or object, as filtered, that each pass alone but together
  // hold a fact, such as [4111, 1111, 1111, 1111] or { a: 41, b: 39 }: each is removed.
  function together(filtered: unknown[]): unknown[] {
    if (!holdsAFactTogether(filtered)) return filtered;
    return filtered.map((value) => (isTextOrNumber(value) ? REMOVED : value));
  }

  function holdsAFactTogether(values: readonly unknown[]): boolean {
    const kept = values.filter(isTextOrNumber).map((value) => normalizeText(String(value)));
    return kept.length >= 2 && holdsAFact(kept.join(" "));
  }

  // JSON data, filtered. In a tool result or a Quick batch row, a typed value passes as it is,
  // still marked, so the final check knows it (src/ai/typed.ts). Anywhere else, such as in a tool
  // input, a value marked typed is filtered as any other object is.
  function json(value: unknown, keepTyped = false): unknown {
    if (value === null || typeof value === "boolean" || value === undefined) return value;
    if (keepTyped && typedIn(value) !== undefined) return value;
    if (typeof value === "string") return text(value);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return value;
      const filtered = text(String(value));
      return filtered === String(value) ? value : filtered;
    }
    if (typeof value !== "object" || isNeverSentToAi(value)) {
      throw new PrivacyRefusal("The privacy filter refused a value it cannot send.");
    }
    if (Array.isArray(value)) return together(value.map((item) => json(item, keepTyped)));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new PrivacyRefusal("The privacy filter takes only plain JSON data.");
    }
    const entries = Object.entries(value);
    const names = entries.map(([name]) => {
      if (namesAFact(name)) {
        throw new PrivacyRefusal("The privacy filter refused a field that names a Household fact.");
      }
      return text(name);
    });
    const inner = entries.map(([, item]) => item);
    const filtered = together(inner.map((item) => json(item, keepTyped)));
    return Object.fromEntries(names.map((name, index) => [name, filtered[index]]));
  }

  function output(result: ToolResultOutput): ToolResultOutput {
    switch (result.type) {
      case "text":
      case "error-text":
        return { ...result, value: text(result.value) };
      case "json":
      case "error-json":
        return {
          ...result,
          value: withoutJsonCrossings(json(result.value, true)) as typeof result.value,
        };
      case "execution-denied":
        return result.reason === undefined ? result : { ...result, reason: text(result.reason) };
      case "content":
        return {
          ...result,
          value: result.value.map((part) => {
            if (part.type !== "text") throw refusePart();
            return { ...part, text: text(part.text) };
          }),
        };
      default:
        throw refusePart();
    }
  }

  // A file, an image, or a part the filter does not know: it cannot read what is in it.
  function refusePart(): PrivacyRefusal {
    return new PrivacyRefusal("The privacy filter cannot read this part of the request.");
  }

  // A Quick batch row is one JSON object with its row number first (src/ai/prompt.ts). Its field
  // names and values are filtered one by one, as JSON data is, so a removal never takes a quote, a
  // field name, or the next field with it, and the row stays one JSON object. Its JSON then holds
  // no escape but \" and \\, so the AI reads the characters the filter read. Each amount, date,
  // and count the app made is a typed value, which passes as it is, still marked, as in a tool
  // result; a crossing at its edge is removed as there. Only app-built text is read this way: a
  // Member who types something like a row gets the filter's best effort on the text, never a
  // refusal (spec 08, Privacy filter).
  function rowOrText(input: string): string {
    const row = rowIn(input);
    if (row === undefined) return text(input);
    const out = JSON.stringify(withoutJsonCrossings(json(row, true)));
    if (out.replace(/\\[\\"]/g, "").includes("\\")) {
      throw new PrivacyRefusal("The privacy filter wrote a row the AI would read differently.");
    }
    return out;
  }

  // A text's JSON object when the text is a Quick batch row, or undefined for any other text.
  function rowIn(input: string): Record<string, unknown> | undefined {
    if (!input.startsWith('{"row":')) return undefined;
    let row: unknown;
    try {
      row = JSON.parse(input);
    } catch {
      return undefined;
    }
    return row === null || typeof row !== "object" || Array.isArray(row)
      ? undefined
      : (row as Record<string, unknown>);
  }

  function prompt(messages: Prompt): Prompt {
    return messages.map((message): Prompt[number] =>
      filterMessage(withoutMark(message), isMemberTyped(message)),
    );
  }

  function filterMessage(message: Prompt[number], typed: boolean): Prompt[number] {
    switch (message.role) {
      case "system":
        return { ...message, content: text(message.content) };
      case "user": {
        const content = message.content.map((part) => {
          if (part.type !== "text") throw refusePart();
          // A typed value passes as it is, still marked, so the final check knows it. A message
          // a Member typed holds none.
          if (typedPartIn(part) !== undefined) {
            if (typed) throw refusePart();
            return part;
          }
          return { ...part, text: typed ? text(part.text) : rowOrText(part.text) };
        });
        return { ...message, content: withoutPartCrossings(content) };
      }
      case "assistant":
        return {
          ...message,
          content: message.content.map((part) => {
            // Only the Household summary, a user message, holds typed parts.
            if (isMarked(part)) throw refusePart();
            switch (part.type) {
              case "text":
              case "reasoning":
                return { ...part, text: text(part.text) };
              case "tool-call":
                return { ...part, input: json(part.input) };
              case "tool-result":
                return { ...part, output: output(part.output) };
              default:
                throw refusePart();
            }
          }),
        };
      case "tool":
        return {
          ...message,
          content: message.content.map((part) => {
            if (isMarked(part)) throw refusePart();
            switch (part.type) {
              case "tool-result":
                return { ...part, output: output(part.output) };
              case "tool-approval-response":
                return part.reason === undefined ? part : { ...part, reason: text(part.reason) };
              default:
                throw refusePart();
            }
          }),
        };
      default:
        throw refusePart();
    }
  }

  // A text the AI reads as one, put together from pieces: the text parts and typed parts of a
  // Household summary message, or the values of a tool result's JSON. Each piece has its place in
  // the joined text; a JSON piece the filter may change has `set`.
  type Piece = { start: number; end: number; typed: boolean; set?: (value: string) => void };

  // Each place where a rule matches across the edge of a typed value, in the text the AI reads.
  // Each text is filtered alone and each typed value passes as it is, so only the joined text
  // shows such a match, such as the Merchant "Pasta 482" next to a count of 2 when an Account's
  // last 4 is 4822. A match wholly inside one typed value is the app's own number, which the
  // filter keeps. So is a number match across two or more typed values whose text adds no digit,
  // such as "day 20 of 30 days" when the ages are 20 and 30: the app wrote both numbers, and
  // taking out " of " would leave "20 [removed] 30", which the rule still matches.
  function crossings(joined: string, pieces: readonly Piece[]): Span[] {
    const typedPieces = pieces.filter((piece) => piece.typed);
    if (typedPieces.length === 0) return [];
    const overlaps = (piece: Piece, span: Span) => piece.start < span.end && span.start < piece.end;
    const textDigit = (span: Span) =>
      pieces.some(
        (piece) =>
          !piece.typed &&
          overlaps(piece, span) &&
          /\p{Nd}/u.test(
            joined.slice(Math.max(piece.start, span.start), Math.min(piece.end, span.end)),
          ),
      );
    const crosses = (span: Span, isNumber: boolean) => {
      const touched = typedPieces.filter((piece) => overlaps(piece, span));
      const [one] = touched;
      if (one === undefined) return false;
      if (touched.length === 1) return !(one.start <= span.start && span.end <= one.end);
      return !isNumber || textDigit(span);
    };
    const skeleton = digitSkeleton(joined);
    const numbers = numberPairs(skeleton.text).map((pair) => ({
      ...placeOf(skeleton, pair),
      label: REMOVED,
    }));
    const words = [
      ...findNames(joined, namePhrases),
      ...pairsOf(EMAIL, joined).map(([start, end]) => ({ start, end, label: REMOVED })),
    ];
    return [
      ...numbers.filter((span) => crosses(span, true)),
      ...words.filter((span) => crosses(span, false)),
    ];
  }

  // A summary message's parts as one text, with each part's place.
  function joinParts(parts: readonly { text: string; typed: boolean }[]) {
    let joined = "";
    const pieces: Piece[] = [];
    for (const part of parts) {
      pieces.push({
        start: joined.length,
        end: joined.length + part.text.length,
        typed: part.typed,
      });
      joined += part.text;
    }
    return { joined, pieces };
  }

  // A summary message's parts with each crossing taken out of its text side: the text characters
  // the match takes become "[removed]", and every typed value stays as it is. A space at the edge
  // of a typed value stays, so "Pasta 482 " next to a count of 2 reads "Pasta [removed] 2". Two
  // typed values with no text between them would read as one number, so they are refused.
  function withoutPartCrossings<Part extends { type: "text"; text: string }>(
    content: readonly Part[],
  ): Part[] {
    let parts = content.map((part) => ({ part, typed: typedPartIn(part) !== undefined }));
    if (!parts.some((each) => each.typed)) return [...content];
    const kept = parts.filter((each) => each.typed || each.part.text !== "");
    if (kept.some((each, index) => each.typed && kept[index - 1]?.typed === true)) {
      throw new PrivacyRefusal("The privacy filter refused two typed values with no text between.");
    }
    for (let round = 0; round < 3; round++) {
      const { joined, pieces } = joinParts(
        parts.map((each) => ({ text: each.part.text, typed: each.typed })),
      );
      const spans = crossings(joined, pieces);
      if (spans.length === 0) break;
      parts = parts.map((each, index) => {
        const piece = pieces[index];
        if (each.typed || piece === undefined) return each;
        const removed = spans.flatMap((span): Span[] => {
          let start = Math.max(piece.start, span.start);
          let end = Math.min(piece.end, span.end);
          if (start >= end) return [];
          const [from, to] = [start, end];
          if (to === piece.end) while (end > start && /\s/u.test(joined.charAt(end - 1))) end--;
          if (from === piece.start) while (start < end && /\s/u.test(joined.charAt(start))) start++;
          if (start === end) [start, end] = [from, to];
          return [{ start: start - piece.start, end: end - piece.start, label: REMOVED }];
        });
        return removed.length === 0
          ? each
          : { ...each, part: { ...each.part, text: replaceSpans(each.part.text, removed) } };
      });
    }
    return parts.map((each) => each.part);
  }

  // A tool result's JSON as the AI reads it, as JSON.stringify writes it, with the place of each
  // value and field name in it. Each typed value is its bare value.
  function jsonPieces(value: unknown): { joined: string; pieces: Piece[] } {
    let joined = "";
    const pieces: Piece[] = [];
    const add = (written: string, piece?: Omit<Piece, "start" | "end">) => {
      if (piece !== undefined) {
        pieces.push({ start: joined.length, end: joined.length + written.length, ...piece });
      }
      joined += written;
    };
    const walk = (item: unknown, set?: (value: string) => void): void => {
      const bare = typedIn(item);
      if (bare !== undefined) {
        add(JSON.stringify(bare), { typed: true });
      } else if (typeof item === "string" || typeof item === "number") {
        add(JSON.stringify(item), { typed: false, set });
      } else if (item === null || item === undefined || typeof item !== "object") {
        add(JSON.stringify(item ?? null));
      } else if (Array.isArray(item)) {
        add("[");
        item.forEach((each, index) => {
          if (index > 0) add(",");
          walk(each, (changed) => {
            item[index] = changed;
          });
        });
        add("]");
      } else {
        walkObject(item as Record<string, unknown>);
      }
    };
    const walkObject = (item: Record<string, unknown>) => {
      add("{");
      let first = true;
      for (const [name, each] of Object.entries(item)) {
        if (each === undefined) continue;
        if (!first) add(",");
        first = false;
        add(JSON.stringify(name), { typed: false });
        add(":");
        walk(each, (changed) => {
          item[name] = changed;
        });
      }
      add("}");
    };
    walk(value);
    return { joined, pieces };
  }

  // A tool result's JSON, as filtered, with each value that a crossing takes in removed whole, as
  // values that hold a fact together are. The filter made the JSON anew, so it changes it in
  // place. A crossing that takes in no value, only a field name, is refused.
  function withoutJsonCrossings(value: unknown): unknown {
    for (let round = 0; round < 3; round++) {
      const { joined, pieces } = jsonPieces(value);
      const spans = crossings(joined, pieces);
      if (spans.length === 0) break;
      for (const span of spans) {
        const hit = pieces.filter(
          (piece) => !piece.typed && piece.start < span.end && span.start < piece.end,
        );
        if (!hit.some((piece) => piece.set !== undefined)) {
          throw new PrivacyRefusal("The privacy filter found a fact across a field name.");
        }
        for (const piece of hit) piece.set?.(REMOVED);
      }
    }
    return value;
  }

  // Whether a summary message, a Quick batch row, or a tool result, joined as the AI reads it,
  // still holds a fact across the edge of a typed value. The final check refuses the call when one
  // does.
  function holdsACrossing(messages: Prompt): boolean {
    const crossesIn = (value: unknown) => {
      const { joined, pieces } = jsonPieces(value);
      return crossings(joined, pieces).length > 0;
    };
    return messages.some((message) => {
      if (message.role === "user") {
        const parts = message.content.map((part) => {
          if (part.type !== "text") throw refusePart();
          return { text: part.text, typed: typedPartIn(part) !== undefined };
        });
        if (
          parts.some(({ text: each }) => {
            const row = rowIn(each);
            return row !== undefined && crossesIn(row);
          })
        ) {
          return true;
        }
        const { joined, pieces } = joinParts(parts);
        return crossings(joined, pieces).length > 0;
      }
      if (message.role !== "assistant" && message.role !== "tool") return false;
      return (message.content as { type: string }[]).some((part) => {
        if (part.type !== "tool-result") return false;
        const { output } = part as unknown as { output: ToolResultOutput };
        if (output.type !== "json" && output.type !== "error-json") return false;
        return crossesIn(output.value);
      });
    });
  }

  // Whether the prompt's texts, read in order and joined by spaces, hold a fact that no one of them
  // holds, such as a card number split into fields. One text alone is read by the other checks.
  function holdsAFactAcross(texts: readonly string[]): boolean {
    if (texts.length < 2) return false;
    const read = normalizeText(texts.join(" "));
    return (
      holdsAFact(read) ||
      holdsAName(read) ||
      [...digitSkeleton(read).text.matchAll(CARD_RUN)].some(([run]) => holdsACard(run, true))
    );
  }

  // What must never be in app-built text once it is filtered. Any of it left refuses the call: the
  // stored ZIP code anywhere; the stored ages listed together and an Account's last 4 digits,
  // outside dates and times, as the filter removes them; a card number; and each Member's email
  // address and names. Each text is normalized first, as the filter's text is.
  //
  // The check reads every text and number in the request on its own, and the texts and numbers of
  // each array or object together, as the filter does, so it never refuses what the filter wrote.
  // It also reads the app-built texts of the prompt in order, joined by spaces, so a fact split
  // across two parts is found, such as a card number split into fields.
  //
  // Member-typed text is left out (spec 08, Privacy filter): the filter does its best on it, and
  // a leak there never refuses the call. Tool input schemas and the response schema are the app's
  // own code, never Household data, so the check leaves them out too: a Member named Will would
  // otherwise refuse a schema that says "will". The prompt, the tools, the response format, the
  // headers, the provider options, and the stop sequences are checked.
  function checkLeaks(params: CallOptions, typed: readonly boolean[]): void {
    const appBuilt = params.prompt.map((message, index) =>
      typed[index] === true && message.role !== "system"
        ? {
            ...message,
            content: (message.content as { type: string }[]).filter(
              (part) => part.type !== "text" && part.type !== "reasoning",
            ),
          }
        : message,
    ) as Prompt;
    const checked = [
      appBuilt,
      (params.tools ?? []).map((tool) =>
        tool.type === "function"
          ? { ...tool, inputSchema: undefined }
          : { ...tool, args: undefined },
      ),
      params.responseFormat?.type === "json"
        ? { ...params.responseFormat, schema: undefined }
        : (params.responseFormat ?? {}),
      params.headers ?? {},
      params.providerOptions ?? {},
      params.stopSequences ?? [],
    ];
    if (leaks(checked) || holdsAFactAcross(promptTexts(appBuilt))) {
      throw new PrivacyRefusal("The privacy filter found private data it did not remove.");
    }
  }

  function holdsAName(checked: string): boolean {
    return (
      emails.some((email) => checked.normalize("NFD").search(email) !== -1) ||
      findNames(checked, memberNamePhrases).length > 0
    );
  }

  function leaks(value: unknown): boolean {
    if (typeof value === "string") {
      const checked = normalizeText(value);
      return holdsAFact(checked) || holdsAName(checked);
    }
    if (typeof value === "number") return leaks(String(value));
    if (value === null || typeof value !== "object") return false;
    const values = Array.isArray(value) ? value : Object.values(value);
    const names = Array.isArray(value) ? [] : Object.keys(value);
    return names.some(leaks) || values.some(leaks) || holdsAFactTogether(values);
  }

  // A typed value's bare value, or undefined for anything else. A value marked typed in another
  // form is refused.
  function typedIn(value: unknown): string | number | undefined {
    try {
      return typedValueOf(value);
    } catch {
      throw new PrivacyRefusal("The privacy filter refused a typed value in another form.");
    }
  }

  // Whether a part carries the filter's own mark in its provider options.
  const isMarked = (part: { providerOptions?: unknown }) =>
    (part.providerOptions as { privacyFilter?: unknown } | undefined)?.privacyFilter !== undefined;

  // The bare value of a Household summary part marked typed, or undefined for a part without the
  // mark. A mark on a value in another form, or on a part whose text is not that value, is refused.
  function typedPartIn(part: { text: string; providerOptions?: unknown }): string | undefined {
    if (!isMarked(part)) return undefined;
    const options = part.providerOptions as { privacyFilter: unknown };
    const mark = options.privacyFilter as Record<string, unknown> | null;
    const bare =
      mark !== null && typeof mark === "object" && Object.keys(mark).length === 1
        ? typedIn(mark[TYPED_PART])
        : undefined;
    if (bare === undefined || String(bare) !== part.text) {
      throw new PrivacyRefusal("The privacy filter refused a typed value in another form.");
    }
    return part.text;
  }

  // The prompt without its typed summary parts, for the final check, or with each user message
  // that holds one joined into one text part, as the AI reads it: the filtered text parts and the
  // bare typed values, in order, with no mark.
  function changeTypedParts(messages: Prompt, change: "drop" | "join"): Prompt {
    return messages.map((message): Prompt[number] => {
      if (message.role !== "user") return message;
      if (
        !message.content.some((part) => part.type === "text" && typedPartIn(part) !== undefined)
      ) {
        return message;
      }
      const texts = message.content.flatMap((part) => {
        if (part.type !== "text") throw refusePart();
        return change === "drop" && typedPartIn(part) !== undefined ? [] : [part.text];
      });
      return {
        ...message,
        content:
          change === "drop"
            ? texts.map((each) => ({ type: "text", text: each }))
            : [{ type: "text", text: texts.join("") }],
      };
    });
  }

  // The prompt with each typed value in a tool result or a Quick batch row changed, such as to its
  // bare value. A row without one stays as it is.
  function changeTypedValues(messages: Prompt, change: (bare: string | number) => unknown): Prompt {
    let changed = false;
    const inValue = (value: unknown): unknown => {
      const bare = typedIn(value);
      if (bare !== undefined) {
        changed = true;
        return change(bare);
      }
      if (Array.isArray(value)) return value.map(inValue);
      if (value === null || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, inValue(item)]));
    };
    const inPart = <Part extends { type: string }>(part: Part): Part => {
      if (part.type !== "tool-result") return part;
      const { output } = part as Part & { output: ToolResultOutput };
      return output.type === "json" || output.type === "error-json"
        ? { ...part, output: { ...output, value: inValue(output.value) } }
        : part;
    };
    const inRow = <Part extends { type: string; text?: string }>(part: Part): Part => {
      const row = part.type === "text" ? rowIn(part.text ?? "") : undefined;
      if (row === undefined) return part;
      changed = false;
      const written = JSON.stringify(inValue(row));
      return changed ? { ...part, text: written } : part;
    };
    return messages.map((message): Prompt[number] => {
      switch (message.role) {
        case "user":
          return { ...message, content: message.content.map(inRow) };
        case "assistant":
          return { ...message, content: message.content.map(inPart) };
        case "tool":
          return { ...message, content: message.content.map(inPart) };
        default:
          return message;
      }
    });
  }

  // A tool result the filter refuses on its own, such as one with a store number it cannot cut
  // from a typed amount, is held back: the AI reads HELD_BACK in its place, and the rest of the
  // call goes out. A part that carries the filter's mark is an app bug: it keeps its mark when held
  // back, so it still refuses the call. Each held-back result is logged by its tool's name and the
  // rule, never its value.
  function withHeldBack(messages: Prompt): Prompt {
    return messages.map((message): Prompt[number] => {
      if (message.role !== "tool" && message.role !== "assistant") return message;
      let changed = false;
      const content = message.content.map((part) => {
        if (part.type !== "tool-result") return part;
        try {
          filterParams({ prompt: [{ role: message.role, content: [part] }] as Prompt });
          return part;
        } catch (error) {
          if (!(error instanceof PrivacyRefusal)) throw error;
          changed = true;
          log.warn("The privacy filter held back a tool result", {
            tool: part.toolName,
            rule: error.message,
          });
          return { ...part, output: { type: "error-text" as const, value: HELD_BACK } };
        }
      });
      return changed ? ({ ...message, content } as Prompt[number]) : message;
    });
  }

  // Where a refused call fails, for the log: the first message the filter refuses on its own, by
  // its place and role, and its tools' names for tool results. Never a value.
  function refusedPlace(input: CallOptions): string {
    for (const [index, message] of input.prompt.entries()) {
      try {
        filterParams({ prompt: [message] });
      } catch (error) {
        if (!(error instanceof PrivacyRefusal)) throw error;
        const tools = Array.isArray(message.content)
          ? message.content.flatMap((part) => ("toolName" in part ? [part.toolName] : []))
          : [];
        return `message ${index + 1} of ${input.prompt.length} (${message.role}${
          tools.length === 0 ? "" : `: ${tools.join(", ")}`
        })`;
      }
    }
    try {
      filterParams({ prompt: [] as Prompt, tools: input.tools });
    } catch {
      return "the tools";
    }
    return "across messages or in the call's options";
  }

  // The whole request, filtered, with each refused tool result held back. A refusal anywhere else
  // refuses the call, and is logged by its place and rule.
  function params(input: CallOptions): CallOptions {
    const held = { ...input, prompt: withHeldBack(input.prompt) };
    try {
      return filterParams(held);
    } catch (error) {
      if (error instanceof PrivacyRefusal) {
        log.warn("The privacy filter refused an AI call", {
          rule: error.message,
          place: refusedPlace(held),
        });
      }
      throw error;
    }
  }

  function filterParams(input: CallOptions): CallOptions {
    const filtered: CallOptions = {
      ...input,
      prompt: prompt(input.prompt),
      ...(input.tools === undefined
        ? {}
        : {
            tools: input.tools.map((tool) => {
              // An AI provider's own web search, whose settings are the app's own constants.
              if (tool.type === "provider" && WEB_SEARCH_TOOL_IDS.has(tool.id)) return tool;
              if (tool.type !== "function") throw refusePart();
              return tool.description === undefined
                ? tool
                : { ...tool, description: text(tool.description) };
            }),
          }),
      ...(input.responseFormat?.type === "json" && input.responseFormat.description !== undefined
        ? {
            responseFormat: {
              ...input.responseFormat,
              description: text(input.responseFormat.description),
            },
          }
        : {}),
      ...(input.headers === undefined
        ? {}
        : {
            headers: Object.fromEntries(
              Object.entries(input.headers).map(([name, value]) => [
                text(name),
                value === undefined ? value : text(value),
              ]),
            ),
          }),
      ...(input.providerOptions === undefined
        ? {}
        : { providerOptions: json(input.providerOptions) as CallOptions["providerOptions"] }),
      ...(input.stopSequences === undefined
        ? {}
        : { stopSequences: input.stopSequences.map(text) }),
    };
    // The final check skips typed values, and the AI reads each one bare, without its mark. It
    // also reads each summary message and tool result joined, as the AI reads it, for a fact
    // across the edge of a typed value.
    if (holdsACrossing(filtered.prompt)) {
      throw new PrivacyRefusal("The privacy filter found private data it did not remove.");
    }
    checkLeaks(
      {
        ...filtered,
        prompt: changeTypedParts(
          changeTypedValues(filtered.prompt, () => null),
          "drop",
        ),
      },
      input.prompt.map(isMemberTyped),
    );
    return {
      ...filtered,
      prompt: changeTypedParts(
        changeTypedValues(filtered.prompt, (bare) => bare),
        "join",
      ),
    };
  }

  // Each label's name on the screen. A label is never given again, so one from before a removal
  // still means the removed Member.
  const shownNames = new Map<string, string>([
    ...facts.removedMembers.map(({ labelNumber, name }): [string, string] => [
      memberLabel(labelNumber),
      name.trim(),
    ]),
    ...members.map(({ label, full }): [string, string] => [label, full]),
  ]);

  function showMemberNames(aiText: string): string {
    return aiText.replace(
      new RegExp(`${WORD_BEFORE}[Mm]ember ([A-Z]{1,3})${WORD_AFTER}`, "gu"),
      (label, letters: string) => shownNames.get(`Member ${letters}`) || label,
    );
  }

  return {
    text,
    matches: (input) =>
      text(input) !== normalizeText(input).normalize("NFD").normalize("NFC") ||
      normalizeText(input).toLowerCase().includes(REMOVED),
    json: (value) => json(value, true),
    params,
    accountLabels,
    showMemberNames,
  };
}
