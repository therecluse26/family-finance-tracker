// The 12-month usual (spec 07, 4. Number tiles; 5. "A usual month"): the median of the last 12
// complete months. A month before the history starts has no number, so it is left out.

// The `count` months before `month`, oldest first, each written YYYY-MM. The 12 before "2026-10"
// run from "2025-10" to "2026-09".
export function monthsBefore(month: string, count: number): string[] {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1;
  return Array.from({ length: count }, (_, n) => {
    const at = new Date(Date.UTC(year, index - count + n, 1));
    return at.toISOString().slice(0, 7);
  });
}

// The last day of a month written YYYY-MM, such as "2026-02-28".
export function lastDayOf(month: string): string {
  const at = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
  return at.toISOString().slice(0, 10);
}

// The median of whole-cent amounts: the middle one, or the two middle ones' mean, rounded to the
// cent. Null with none.
export function median(amounts: readonly number[]): number | null {
  if (amounts.length === 0) return null;
  const sorted = [...amounts].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const high = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return high;
  return Math.round(((sorted[middle - 1] ?? 0) + high) / 2);
}
