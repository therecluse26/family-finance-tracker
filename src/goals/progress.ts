import { MINUS, wholeDollars } from "../format.ts";

// Goal progress math (spec 05, Progress). The app computes every number; the AI never does. Every
// amount is in whole cents, and every date is written YYYY-MM-DD.

// The target sets the kind: a Category or a Merchant, Saving or Accounts, or one tracked loan.
export type GoalKind = "spend less" | "save toward an amount" | "pay down a loan";

// The change the words ask for: an amount in whole cents, or a percent such as 20.
export type GoalChange = { amount: number } | { percent: number };

export type GoalState = "On track" | "Behind" | "Done";

export type GoalProgress = {
  kind: GoalKind;
  // A whole number from 0 to 100, or null before the Goal amount is set.
  percentage: number | null;
  // Null before the Goal amount is set, and for a save or loan Goal with no deadline, which shows
  // the percentage only.
  state: GoalState | null;
  detail: string;
  // True when the Goal's money sits in an Unconnected account, whose balance is an estimate.
  estimated: boolean;
  // True when the Goal meets its "Done when" rule today.
  met: boolean;
};

export const NO_GOAL_AMOUNT = "Goal amount not set yet";

// `part` ÷ `whole` as a whole percentage from 0 to 100. With nothing to gain (`whole` at or below
// $0), it is 100% unless the part went backward.
export function wholePercent(part: number, whole: number): number {
  if (whole <= 0) return part >= whole ? 100 : 0;
  return Math.min(100, Math.max(0, Math.round((part * 100) / whole)));
}

const DAY_MS = 86_400_000;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

// The straight line on `today` = start + (Goal amount − start) × days since the start ÷ days from
// the start to the deadline. It stops at the Goal amount once the deadline passes.
export function straightLine(
  start: number,
  goalAmount: number,
  startsOn: string,
  deadline: string,
  today: string,
): number {
  const span = daysBetween(startsOn, deadline);
  const share = span <= 0 ? 1 : Math.min(1, Math.max(0, daysBetween(startsOn, today) / span));
  return Math.round(start + (goalAmount - start) * share);
}

// The Goal amount the reading's change gives, from the start (spec 05, Progress), or null when it
// must come from a Proposal. A percent change applies to the baseline, the start balance, or the
// loan's balance at the start.
// - Spend less: the baseline minus the change. It still takes effect only through a Proposal.
// - Save toward an amount: the start balance plus the change.
// - Pay down a loan: the change, or with no change, the whole balance at the start.
export function goalAmountFrom(
  kind: GoalKind,
  change: GoalChange | null,
  start: number,
): number | null {
  const by = (amount: number) =>
    change === null
      ? 0
      : "amount" in change
        ? change.amount
        : Math.round((amount * change.percent) / 100);
  switch (kind) {
    case "spend less":
      return change === null ? null : Math.max(0, start - by(start));
    case "save toward an amount":
      return change === null ? null : start + by(start);
    case "pay down a loan":
      return change === null ? start : by(start);
  }
}

const pace = (ahead: number) =>
  ahead >= 0 ? `${wholeDollars(ahead)} ahead of pace` : `${wholeDollars(-ahead)} behind pace`;

// One piece of a progress detail: its words, or one of its whole-dollar amounts, in cents.
export type DetailPiece = string | { cents: number };

// A whole-dollar amount as wholeDollars writes it, such as "$12,480" or "−$5".
const AMOUNT = String.raw`${MINUS}?\$\d{1,3}(?:,\d{3})*`;
const DETAIL = new RegExp(
  `^(?:On pace for ${AMOUNT} this month; Goal is ${AMOUNT}|${AMOUNT} of ${AMOUNT}(?: paid)?(?:; ${AMOUNT} (?:ahead of|behind) pace)?)$`,
  "u",
);

// A progress detail that one of the templates below wrote, in pieces, with each amount in cents, so
// an AI use can send each as a typed value (spec 08, Privacy filter). Any other detail, such as
// NO_GOAL_AMOUNT, is one piece of words.
export function progressDetailPieces(detail: string): DetailPiece[] {
  if (!DETAIL.test(detail)) return [detail];
  return detail.split(new RegExp(`(${AMOUNT})`, "u")).flatMap((each, index): DetailPiece[] => {
    if (index % 2 === 0) return each === "" ? [] : [each];
    const cents = Number(each.replace(/\D/gu, "")) * 100;
    return [{ cents: each.startsWith(MINUS) ? -cents : cents }];
  });
}

// A spend less Goal: P is this month's projected Spending. Percentage = (baseline − P) ÷
// (baseline − Goal amount). On track when P ≤ the Goal amount. Its "Done when" rule reads complete
// months, so the caller decides `met`.
export function spendLessProgress(input: {
  baseline: number;
  goalAmount: number;
  projected: number;
}): Omit<GoalProgress, "estimated" | "met"> {
  const { baseline, goalAmount, projected } = input;
  return {
    kind: "spend less",
    percentage: wholePercent(baseline - projected, baseline - goalAmount),
    state: projected <= goalAmount ? "On track" : "Behind",
    detail: `On pace for ${wholeDollars(projected)} this month; Goal is ${wholeDollars(goalAmount)}`,
  };
}

type Pace = { startsOn: string; deadline: string | null; today: string };

// A save Goal: percentage = (balance − start) ÷ (Goal amount − start). On track when the balance is
// at or above the straight line. Done when the balance reaches the Goal amount.
export function saveProgress(
  input: Pace & { start: number; goalAmount: number; balance: number },
): Omit<GoalProgress, "estimated"> {
  const { start, goalAmount, balance, startsOn, deadline, today } = input;
  const percentage = wholePercent(balance - start, goalAmount - start);
  const met = balance >= goalAmount;
  const shown = `${wholeDollars(balance)} of ${wholeDollars(goalAmount)}`;
  if (deadline === null)
    return { kind: "save toward an amount", percentage, state: null, detail: shown, met };
  const ahead = balance - straightLine(start, goalAmount, startsOn, deadline, today);
  return {
    kind: "save toward an amount",
    percentage,
    state: ahead >= 0 ? "On track" : "Behind",
    detail: `${shown}; ${pace(ahead)}`,
    met,
  };
}

// A loan Goal: percentage = principal paid since the start ÷ the Goal amount. On track when the
// principal paid is at or above the straight line, which starts at $0 paid. Done when the principal
// paid reaches the Goal amount, or the loan's balance owed reaches $0.
export function loanProgress(
  input: Pace & { goalAmount: number; paid: number; owed: number },
): Omit<GoalProgress, "estimated"> {
  const { goalAmount, paid, owed, startsOn, deadline, today } = input;
  const percentage = wholePercent(paid, goalAmount);
  const met = paid >= goalAmount || owed <= 0;
  const shown = `${wholeDollars(Math.max(0, paid))} of ${wholeDollars(goalAmount)} paid`;
  if (deadline === null)
    return { kind: "pay down a loan", percentage, state: null, detail: shown, met };
  const ahead = paid - straightLine(0, goalAmount, startsOn, deadline, today);
  return {
    kind: "pay down a loan",
    percentage,
    state: ahead >= 0 ? "On track" : "Behind",
    detail: `${shown}; ${pace(ahead)}`,
    met,
  };
}
