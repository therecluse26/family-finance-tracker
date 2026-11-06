import type { StatusTone } from "../../format.ts";

// A bar that fills to a share, such as a Budget's Spending so far or a Merchant's Spending against
// the top Merchant's. A flexible Budget's meter has a "today" tick at the share of the month gone
// (spec 07, Left to spend). A meter shows a number its row already says in words, so screen
// readers skip it, unless it has a label of its own.

const FILL: Record<StatusTone, string> = {
  critical: "bg-critical",
  serious: "bg-serious",
  good: "bg-good-bar",
  accent: "bg-accent",
  muted: "bg-muted",
};
const HEIGHT = { small: "h-2", normal: "h-2.5", large: "h-3" };

const percent = (share: number) => `${Math.min(Math.max(share, 0), 1) * 100}%`;

export function Meter(props: {
  // From 0 to 1. A share outside is drawn at the end.
  share: number;
  // From 0 to 1: where the "today" tick goes.
  today?: number;
  tone?: StatusTone;
  // A grey track under the fill. Top Merchants draws bars with none.
  track?: boolean;
  size?: keyof typeof HEIGHT;
  label?: string;
  className?: string;
}) {
  const track = props.track ?? true;
  const height = HEIGHT[props.size ?? "normal"];
  const round = track ? "rounded-full" : "rounded-[3px]";
  return (
    <div
      className={`relative ${height} ${round} ${track ? "bg-line" : ""} ${props.className ?? ""}`}
      {...(props.label === undefined
        ? { "aria-hidden": true }
        : { role: "img", "aria-label": props.label })}
    >
      <div
        className={`${height} ${round} ${FILL[props.tone ?? "accent"]}`}
        style={{ width: percent(props.share) }}
        data-slot="meter-fill"
      />
      {props.today === undefined ? null : (
        <div
          className="absolute -top-1 -bottom-1 w-0.5 bg-ink"
          style={{ left: percent(props.today) }}
          data-slot="meter-today"
        />
      )}
    </div>
  );
}
