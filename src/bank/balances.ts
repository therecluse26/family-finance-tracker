import { type Database, listDailyBalances, listPostedDayTotals } from "../db/index.ts";

// An Account's balance over time, for graphs (spec 02, Balances). From the first sync on, each day
// has the balance its last sync saved. Before that, the app works backward from the first saved
// balance by undoing each day's posted Transactions, and marks those balances "estimated". Hidden
// and pending Transactions never move an estimate. The estimates reach back to the first day with
// a posted Transaction. Balances use the Transaction sign: money owed is negative.

// One day's end balance, in whole cents. An estimated day has no available balance.
export type BalancePoint = {
  date: string;
  currentBalance: number | null;
  availableBalance: number | null;
  estimated: boolean;
};

// The last balance in a month, such as "2026-10".
export type MonthEndBalance = {
  month: string;
  date: string;
  currentBalance: number | null;
  estimated: boolean;
};

export type AccountBalances = { points: BalancePoint[]; monthEnds: MonthEndBalance[] };

// Calendar dates are written YYYY-MM-DD, and both ends are included.
export type BalanceRange = { from?: string; to?: string };

function dayBefore(date: string): string {
  const day = new Date(`${date}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

// The estimated balances before the first saved one, oldest first. `dayTotals` sums each day's
// posted Transactions, up to and including the first saved day.
export function estimateBefore(
  first: { date: string; currentBalance: number | null },
  dayTotals: readonly { date: string; total: number }[],
): BalancePoint[] {
  const earliest = dayTotals[0]?.date;
  if (first.currentBalance === null || earliest === undefined || earliest >= first.date) return [];
  const totals = new Map(dayTotals.map(({ date, total }) => [date, total]));
  const points: BalancePoint[] = [];
  let balance = first.currentBalance;
  let later = first.date;
  for (let date = dayBefore(first.date); date >= earliest; date = dayBefore(date)) {
    // The end of this day is the end of the next day, without the next day's Transactions.
    balance -= totals.get(later) ?? 0;
    points.push({ date, currentBalance: balance, availableBalance: null, estimated: true });
    later = date;
  }
  return points.reverse();
}

// The last point of each month, oldest month first. `points` are oldest first.
export function monthEnds(points: readonly BalancePoint[]): MonthEndBalance[] {
  const byMonth = new Map<string, BalancePoint>();
  for (const point of points) byMonth.set(point.date.slice(0, 7), point);
  return [...byMonth].map(([month, point]) => ({
    month,
    date: point.date,
    currentBalance: point.currentBalance,
    estimated: point.estimated,
  }));
}

// The balance line of an Account with no saved daily balances, such as an Unconnected account or a
// Manual loan, from the balance at the end of each day it changed, oldest first. The last balance
// holds through `today`, the Household's date, with the last step's mark.
export function balanceLine(
  steps: readonly { date: string; currentBalance: number; estimated: boolean }[],
  today: string,
  range: BalanceRange = {},
): AccountBalances {
  const points: BalancePoint[] = steps.map((step) => ({ ...step, availableBalance: null }));
  const last = points.at(-1);
  if (last !== undefined && last.date < today) points.push({ ...last, date: today });
  const shown = points.filter(
    ({ date }) =>
      (range.from === undefined || date >= range.from) &&
      (range.to === undefined || date <= range.to),
  );
  return { points: shown, monthEnds: monthEnds(shown) };
}

export async function accountBalances(
  database: Database,
  accountId: string,
  range: BalanceRange = {},
): Promise<AccountBalances> {
  const saved = await listDailyBalances(database, accountId);
  const first = saved[0];
  const estimated =
    first === undefined
      ? []
      : estimateBefore(first, await listPostedDayTotals(database, accountId, first.date));
  const points = [
    ...estimated,
    ...saved.map((row) => ({
      date: row.date,
      currentBalance: row.currentBalance,
      availableBalance: row.availableBalance,
      estimated: false,
    })),
  ].filter(
    ({ date }) =>
      (range.from === undefined || date >= range.from) &&
      (range.to === undefined || date <= range.to),
  );
  return { points, monthEnds: monthEnds(points) };
}
