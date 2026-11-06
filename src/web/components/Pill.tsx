import type { ReactNode } from "react";

// A small grey mark beside a row, such as "pending", "on card", "Excluded" or "estimated".
export function Pill(props: { children: ReactNode }) {
  return (
    <span className="inline-block rounded-full bg-line-soft px-2 py-0.5 text-xs font-semibold text-ink-soft">
      {props.children}
    </span>
  );
}
