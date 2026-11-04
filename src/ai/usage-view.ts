// The words and numbers of the AI usage page and the AI cost cap's System notices (spec 08, AI
// usage page). The server and the web app both use this file, so it uses no Node or browser API.

import { dollarsAndCents } from "../format.ts";

const NANOS_PER_CENT = 10_000_000;

// Whole cents, from billionths of a dollar. A half cent rounds up.
export function centsOfNanos(nanos: number): number {
  return Math.floor((nanos + NANOS_PER_CENT / 2) / NANOS_PER_CENT);
}

// The month's total against the cap: "$3.12 of $10.00".
export function capLine(totalNanos: number, capCents: number): string {
  return `${dollarsAndCents(centsOfNanos(totalNanos))} of ${dollarsAndCents(capCents)}`;
}

// One call's cost, to the hundredth of a cent: "$0.0012". Most calls cost less than a cent.
export function callCost(nanos: number): string {
  if (nanos === 0) return "$0";
  const tenThousandths = Math.floor((nanos + 50_000) / 100_000);
  if (tenThousandths === 0) return "under $0.0001";
  const dollars = Math.floor(tenThousandths / 10_000);
  const rest = String(tenThousandths % 10_000).padStart(4, "0");
  return `$${dollars}.${rest}`;
}

// The month total reaches the cap.
export function atCap(totalNanos: number, capCents: number): boolean {
  return totalNanos >= capCents * NANOS_PER_CENT;
}

// The month total reaches 80% of the cap.
export function nearCap(totalNanos: number, capCents: number): boolean {
  return totalNanos * 10 >= capCents * NANOS_PER_CENT * 8;
}

// "2026-11": the calendar month of a date written YYYY-MM-DD.
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

// The 1st of the month after `month`, written YYYY-MM-DD.
export function firstOfNextMonth(month: string): string {
  const [year = 0, number = 0] = month.split("-").map(Number);
  return number === 12 ? `${year + 1}-01-01` : `${year}-${String(number + 1).padStart(2, "0")}-01`;
}
