import {
  type Direction,
  directionAgainstUsual,
  STATUS_ICON,
  type StatusTone,
  type StatusWord,
} from "../../format.ts";

// Spec 07, Status: color, icon, and word together. Color marks attention, and never carries
// meaning alone: every status shows its icon and its word too.

export const TONE_COLOR: Record<StatusTone, string> = {
  critical: "text-red-700",
  serious: "text-orange-700",
  good: "text-green-700",
  accent: "text-blue-700",
  muted: "text-gray-500",
};

export function Status<Tone extends StatusTone>(props: { tone: Tone; word: StatusWord<Tone> }) {
  return (
    <span className={`inline-flex items-center gap-1 ${TONE_COLOR[props.tone]}`}>
      <span aria-hidden="true">{STATUS_ICON[props.tone]}</span>
      <span>{props.word}</span>
    </span>
  );
}

// Direction against usual, such as "▲ $40 above usual". `moreIs` says whether a rise is good, as
// for Income or Cash on hand, or bad, as for Spending or Debt.
export function DirectionAgainstUsual(props: { changeCents: number; moreIs: "good" | "bad" }) {
  const direction: Direction = directionAgainstUsual(props.changeCents, props.moreIs);
  return <span className={TONE_COLOR[direction.tone]}>{direction.text}</span>;
}

// The small mark on AI-written text.
export function AiMark() {
  return (
    <span
      className="rounded border border-blue-700 px-1 text-xs font-semibold text-blue-700"
      title="Written by AI"
    >
      AI
    </span>
  );
}

// The word an estimated number always carries.
export function Estimated() {
  return <span className="text-sm text-gray-500">estimated</span>;
}
