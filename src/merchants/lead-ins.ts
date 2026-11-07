// Card and Account numbers in a bank description, with the words that introduce them (spec 04,
// Names). A lead-in, such as "ENDING IN", "ACCT ENDING", "CARD ENDING IN", "ACCOUNT #", "ACCT NO.",
// "LAST 4", or a mask such as "XXXX" or "****", goes with the number it introduced, wherever it
// stands. The rules find them with a scan over the words, digit runs, and gaps of the line, so the
// work grows with the length of the line and never more (K3).

// Plain forms, before any rule reads the text:
// - every Unicode digit becomes 0 to 9, and so does a superscript, circled, or other compatibility
//   digit, such as "⁴" or "④", and a circled digit with no such form, such as "❹";
// - a full-width letter or symbol becomes its plain form;
// - every dash becomes "-";
// - format characters, such as a zero-width space, go;
// - a combining mark on a letter stays, as in "Café", and one on anything else goes, as in "4́".
const IS_DIGIT = /^\p{Nd}$/u;
const IS_LETTER = /^\p{L}$/u;
const IS_MARK = /^\p{M}$/u;
const IS_FORMAT = /^\p{Cf}$/u;
const IS_DASH = /^\p{Pd}$/u;
// A compatibility form that is a number, such as "④" (4), "⑴" ((1)), or "⒋" (4.).
const NUMBER_FORM = /^\(?(\p{Nd}+)[.)]?$/u;
const IS_OTHER_NUMBER = /^\p{No}$/u;
// Circled digits with no compatibility form, as runs: first character, value of the first, length.
const CIRCLED_RUNS: [number, number, number][] = [
  [0x24eb, 11, 10], // ⓫ to ⓴
  [0x24f5, 1, 10], // ⓵ to ⓾
  [0x24ff, 0, 1], // ⓿
  [0x2776, 1, 10], // ❶ to ❿
  [0x2780, 1, 10], // ➀ to ➉
  [0x278a, 1, 10], // ➊ to ➓
  [0x1f10b, 0, 2], // 🄋 and 🄌
];

// Any other number sign with no plain form counts as the digit 0, so it never hides a card number.
function otherNumber(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  const run = CIRCLED_RUNS.find(([first, , length]) => code >= first && code < first + length);
  return run === undefined ? "0" : String(run[1] + code - run[0]);
}

const digitValues = new Map<string, string>();

// Unicode gives each script's digits as a run of ten, from 0 to 9, so a digit's value is its place
// in its run.
function asciiDigit(char: string): string {
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

const asciiDigits = (digits: string) => [...digits].map(asciiDigit).join("");

export function plainForms(text: string): string {
  let out = "";
  let afterLetter = false;
  for (const char of text) {
    let plain = char;
    if (char < "\u0080") {
      plain = char;
    } else if (IS_FORMAT.test(char)) {
      continue;
    } else if (IS_MARK.test(char)) {
      if (afterLetter) out += char;
      continue;
    } else if (char >= "！" && char <= "～") {
      plain = String.fromCharCode((char.codePointAt(0) ?? 0) - 0xfee0);
    } else if (IS_DIGIT.test(char)) {
      plain = asciiDigit(char);
    } else if (IS_DASH.test(char)) {
      plain = "-";
    } else if (!IS_LETTER.test(char)) {
      const number = NUMBER_FORM.exec(char.normalize("NFKC"));
      if (number?.[1] !== undefined) plain = asciiDigits(number[1]);
      else if (IS_OTHER_NUMBER.test(char) && char.normalize("NFKC") === char)
        plain = otherNumber(char);
    }
    out += plain;
    afterLetter = IS_LETTER.test(plain);
  }
  return out;
}

// The line as words (letters, with their marks), digit runs, and gaps (everything else).
type Token = { kind: "word" | "digits" | "gap"; start: number; end: number; fold: string };

const kindOf = (char: string): Token["kind"] =>
  char >= "0" && char <= "9"
    ? "digits"
    : IS_LETTER.test(char) || IS_MARK.test(char)
      ? "word"
      : "gap";

// A word without case or marks, so "ÉNDING" is "ending".
const foldWord = (word: string) => word.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

function tokensOf(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  for (const char of text) {
    const kind = kindOf(char);
    const last = tokens.at(-1);
    if (last !== undefined && last.kind === kind) last.end = at + char.length;
    else tokens.push({ kind, start: at, end: at + char.length, fold: "" });
    at += char.length;
  }
  for (const token of tokens) {
    const piece = text.slice(token.start, token.end);
    token.fold = token.kind === "word" ? foldWord(piece) : piece;
  }
  return tokens;
}

// The symbols of a mask, such as "****" or "••••". A "#" is a label, not a mask, as in "REF#1234".
const MASK_SYMBOLS = /[*•●∙]/u;
const MASK_GAP = /^[\s*•●∙#\-.·/_:]+$/u;
// A word that is only the letter x, such as "XXXX".
const X_MASK = /^x+$/;
const GLUED_MASK = /^(?:in|with)x+$/;

// A gap that may sit inside a lead-in, or between a lead-in and its number: 1 to 3 characters, or a
// run of mask symbols with spaces and dashes, as in " **** **** ".
const shortGap = (token: Token | undefined) => token?.kind === "gap" && token.fold.length <= 3;
const joiningGap = (token: Token | undefined) =>
  token?.kind === "gap" && (token.fold.length <= 3 || MASK_GAP.test(token.fold));
const isMaskGap = (token: Token | undefined) =>
  token?.kind === "gap" && MASK_SYMBOLS.test(token.fold) && MASK_GAP.test(token.fold);
const isXMask = (token: Token | undefined) => token?.kind === "word" && X_MASK.test(token.fold);
const wordIs = (token: Token | undefined, words: ReadonlySet<string>) =>
  token?.kind === "word" && words.has(token.fold);

const ACCOUNT_WORDS = new Set(["acct", "accnt", "account", "acc", "card", "crd"]);
const CARD_WORDS = new Set(["card", "crd"]);
const ENDING_WORDS = new Set(["ending", "ends"]);
const ENDING_AFTER = new Set(["in", "with"]);
const NUMBER_LABELS = new Set(["no", "nbr", "num", "number"]);
const FOUR = new Set(["four"]);
const DIGITS_WORD = new Set(["digits"]);
const LAST = new Set(["last"]);

// The longest an account-number lead-in or its number runs, in tokens. It keeps the scan linear.
const MAX_NUMBER_TOKENS = 24;

type LeadIn = { end: number; strong: boolean; labelled: boolean };

// "ENDING", "ENDING IN", "ENDS WITH", from token `at`. Returns the token after it.
function endingAt(tokens: readonly Token[], at: number): number | undefined {
  if (!wordIs(tokens[at], ENDING_WORDS)) return undefined;
  if (shortGap(tokens[at + 1]) && wordIs(tokens[at + 2], ENDING_AFTER)) return at + 3;
  return at + 1;
}

// "LAST 4", "LAST4", "LAST FOUR", "LAST 4 DIGITS", from token `at`.
function lastFourAt(tokens: readonly Token[], at: number): number | undefined {
  if (!wordIs(tokens[at], LAST)) return undefined;
  let next = at + 1;
  if (shortGap(tokens[next])) next += 1;
  const four = tokens[next];
  if (!((four?.kind === "digits" && four.fold === "4") || wordIs(four, FOUR))) return undefined;
  next += 1;
  if (shortGap(tokens[next]) && wordIs(tokens[next + 1], DIGITS_WORD)) next += 2;
  return next;
}

// The account word at token `at`: "ACCT", "CARD", or "A/C". Returns the token after it.
function accountWordAt(tokens: readonly Token[], at: number): number | undefined {
  if (wordIs(tokens[at], ACCOUNT_WORDS)) return at + 1;
  const [a, slash, c] = [tokens[at], tokens[at + 1], tokens[at + 2]];
  if (a?.fold === "a" && a.kind === "word" && slash?.fold === "/" && c?.fold === "c") return at + 3;
  return undefined;
}

// The lead-in that starts at token `at`. A strong lead-in says it introduces a number, such as
// "ACCT ENDING", "CARD NO.", "ENDING IN", "LAST 4", or "ACCT" alone. "CARD" alone is weak.
function leadInAt(tokens: readonly Token[], at: number): LeadIn | undefined {
  const account = accountWordAt(tokens, at);
  if (account !== undefined) {
    if (shortGap(tokens[account])) {
      const after = account + 1;
      const end =
        endingAt(tokens, after) ??
        lastFourAt(tokens, after) ??
        (wordIs(tokens[after], NUMBER_LABELS) ? after + 1 : undefined);
      if (end !== undefined) return { end, strong: true, labelled: true };
    }
    // "ACCOUNT # 4821" or "ACCT #: 4821": the "#" is the label.
    if (joiningGap(tokens[account]) && tokens[account]?.fold.includes("#")) {
      return { end: account, strong: true, labelled: true };
    }
    // "ACCT 4821" says it is an Account number; "CARD 2500" may be part of a name, as in "Gift Card".
    return { end: account, strong: !wordIs(tokens[at], CARD_WORDS), labelled: false };
  }
  const end = endingAt(tokens, at) ?? lastFourAt(tokens, at);
  if (end === undefined) return undefined;
  // A lead-in word left in a name is "labelled" when it cannot be part of the name: "ENDING IN",
  // "ENDS WITH", or "LAST 4". A lone "ENDING", as in "Ending Books", can.
  return { end, strong: true, labelled: end - at > 1 || wordIs(tokens[at], LAST) };
}

type NumberRun = { end: number; digits: number; masks: number; masked: boolean; glued: boolean };

// The card or Account number that starts at token `at`: digit runs and masks, such as "4821",
// "X4821", "XXXX-XXXX-4821", "**** 4821", or "4.8.2.1", joined by short gaps. It ends in a digit
// run that ends a word, so an order code such as "2K4JD8" is no number. `masked` when a mask is in
// it, `glued` when nothing stands between the token before it and its first part.
function numberAt(tokens: readonly Token[], at: number): NumberRun | undefined {
  let index = at;
  const glued = tokens[at]?.kind !== "gap";
  let digits = 0;
  let masks = 0;
  let found: NumberRun | undefined;
  for (let steps = 0; steps < MAX_NUMBER_TOKENS && index < tokens.length; steps++, index++) {
    const token = tokens[index];
    if (token === undefined) break;
    if (token.kind === "gap") {
      if (!joiningGap(token)) break;
      if (isMaskGap(token)) masks += 1;
    } else if (token.kind === "word") {
      // "ENDING INXXXX4821": "IN" glued to the mask, right after the lead-in.
      if (!isXMask(token) && !(steps <= 1 && GLUED_MASK.test(token.fold))) break;
      masks += 1;
    } else {
      if (tokens[index + 1]?.kind === "word" && !isXMask(tokens[index + 1])) break;
      digits += token.fold.length;
      found = { end: index + 1, digits, masks, masked: masks > 0, glued };
    }
  }
  return found;
}

// Whether a number run counts as the card or Account number a lead-in introduced. A strong lead-in
// takes 4 or more digits, or 2 or more after a mask. A weak one, "CARD" or "ACCT" alone, takes a
// masked number, a number glued to it as in "CARD1234", or, on a card payment line, 4 or more
// digits.
function takes(leadIn: LeadIn, number: NumberRun, cardPayment: boolean): boolean {
  if (number.digits >= 4) return leadIn.strong || number.masked || number.glued || cardPayment;
  return number.digits >= 2 && number.masked;
}

// What the scan found: spans to remove, and whether the rules are unsure.
type Found = { spans: { start: number; end: number }[]; unsure: boolean };

function scan(text: string, cardPayment: boolean): Found {
  const tokens = tokensOf(text);
  const spans: Found["spans"] = [];
  let unsure = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === undefined || token.kind === "digits") continue;
    if (index > 0 && token.kind === "word" && tokens[index - 1]?.kind === "digits") continue;

    // A lead-in and its number.
    const leadIn = token.kind === "word" ? leadInAt(tokens, index) : undefined;
    if (leadIn !== undefined) {
      const number = numberAt(tokens, leadIn.end);
      if (number !== undefined && takes(leadIn, number, cardPayment)) {
        spans.push({ start: token.start, end: tokens[number.end - 1]?.end ?? token.end });
        index = number.end - 1;
        continue;
      }
      // "STARBUCKS CARD 1234" or "ACCT 2024 TAX": the number may be a card's or part of the name.
      if (number !== undefined && number.digits >= 4) unsure = true;
      index = leadIn.end - 1;
      continue;
    }

    // A mask alone, such as "XXXX 4821", "**** 4821", or "X4821", with 4 or more digits. One "X"
    // takes only digits glued to it, or another mask, so "MOVIE X 2024 FEST" keeps its words.
    // A mask in a gap stands apart from the word before it, so "REF*1234" stays one word.
    const apart = index === 0 || /^\s/.test(token.fold);
    const mask = isXMask(token) || (isMaskGap(token) && apart);
    if (!mask) continue;
    const number = numberAt(tokens, index);
    const lone = token.kind === "word" && token.fold.length === 1;
    if (lone && tokens[index + 1]?.kind !== "digits" && (number?.masks ?? 0) < 2) continue;
    if (number !== undefined && number.digits >= 4) {
      spans.push({ start: token.start, end: tokens[number.end - 1]?.end ?? token.end });
      index = number.end - 1;
    }
  }
  return { spans, unsure };
}

function removeSpans(text: string, spans: Found["spans"], mark: string): string {
  let out = "";
  let at = 0;
  for (const span of spans) {
    out += `${text.slice(at, span.start)} ${mark} `;
    at = span.end;
  }
  return out + text.slice(at);
}

// Every card or Account number in the text, with its lead-in, becomes `mark`, so the rules after
// it treat it as one number. `unsure` when a number may be a card's, as in "STARBUCKS CARD 1234".
export function markAccountNumbers(
  text: string,
  mark: string,
  options: { cardPayment: boolean },
): { text: string; unsure: boolean } {
  const { spans, unsure } = scan(text, options.cardPayment);
  return { text: removeSpans(text, spans, mark), unsure };
}

// A lead-in left in a clean name. One at the end, as when the bank cut the line short ("CHASE CARD
// ENDING IN"), goes. Any lead-in, or a mask such as "XXXX", left in the name makes the rules unsure,
// so the name is marked for AI cleanup. A lone "ENDING" or "CARD" stays, as in "Ending Books".
export function leftLeadIns(name: string): { name: string; unsure: boolean } {
  const tokens = tokensOf(name);
  const lastWord = tokens.findLastIndex((token) => token.kind !== "gap");
  let unsure = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token?.kind !== "word") continue;
    if (isXMask(token) && token.fold.length >= 2) unsure = true;
    const leadIn = leadInAt(tokens, index);
    if (leadIn === undefined || !leadIn.labelled) continue;
    unsure = true;
    if (leadIn.end > lastWord) {
      return { name: name.slice(0, token.start).trim(), unsure };
    }
  }
  return { name, unsure };
}
