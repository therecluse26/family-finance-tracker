import type { ReactNode } from "react";

// Spec 07, Number formats: a signed amount, such as "−$80.56" or "+$1,865.90", reads as one
// number. A browser may break a line between the sign and the "$", so each signed amount in a line
// of text stays on one line. The rest of the line still wraps.

const SIGNED_AMOUNT = /[−+]\$[\d,]+(?:\.\d{2})?/g;

export function keepAmountsWhole(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const match of text.matchAll(SIGNED_AMOUNT)) {
    if (match.index > at) parts.push(text.slice(at, match.index));
    parts.push(
      <span key={match.index} className="whitespace-nowrap">
        {match[0]}
      </span>,
    );
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}
