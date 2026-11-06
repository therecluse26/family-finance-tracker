import type { ReactNode } from "react";
import {
  type Direction,
  directionAgainstUsual,
  STATUS_ICON,
  type StatusTone,
  type StatusWord,
} from "../../format.ts";
import { Pill } from "./Pill.tsx";

// Spec 07, Status: color, icon, and word together. Color marks attention, and never carries
// meaning alone: every status shows its icon and its word too.

// Each tone's text color, from the tokens in styles.css.
export const TONE_COLOR: Record<StatusTone, string> = {
  critical: "text-critical",
  serious: "text-serious",
  good: "text-good",
  accent: "text-accent",
  muted: "text-muted",
};

// A status word, such as "◆ Behind". A detail follows the word, as in "◆ Behind · 38%".
export function Status<Tone extends StatusTone>(props: {
  tone: Tone;
  word: StatusWord<Tone>;
  detail?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1 ${TONE_COLOR[props.tone]}`}>
      <span aria-hidden="true">{STATUS_ICON[props.tone]}</span>
      <span>{props.detail === undefined ? props.word : `${props.word} · ${props.detail}`}</span>
    </span>
  );
}

// A status line the app writes in full, such as "On pace to end $140 under Budget". It shows the
// tone's icon before the text, so the color is never alone.
export function StatusText(props: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className={TONE_COLOR[props.tone]}>
      <span aria-hidden="true">{`${STATUS_ICON[props.tone]} `}</span>
      {props.children}
    </span>
  );
}

// Direction against usual, such as "▲ $40 above usual". `moreIs` says whether a rise is good, as
// for Income or Cash on hand, or bad, as for Spending or Debt.
export function DirectionAgainstUsual(props: { changeCents: number; moreIs: "good" | "bad" }) {
  const direction: Direction = directionAgainstUsual(props.changeCents, props.moreIs);
  return <span className={TONE_COLOR[direction.tone]}>{direction.text}</span>;
}

// The small AI tag on AI-written text.
export function AiMark() {
  return (
    <span
      className="inline-block rounded-tag bg-ai-soft px-1.5 py-px align-middle text-[10px] font-bold tracking-[.05em] text-ai"
      title="Written by AI"
    >
      AI
    </span>
  );
}

// The word an estimated number always carries.
export function Estimated() {
  return <Pill>estimated</Pill>;
}
