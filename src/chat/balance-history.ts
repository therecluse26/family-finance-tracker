import {
  accountBalances,
  type BalancePoint,
  balanceLine,
  UNCONNECTED,
  unconnectedBalanceSteps,
} from "../bank/index.ts";
import type { Database, listAccounts } from "../db/index.ts";
import { manualLoanBalanceSteps } from "../money-movement/index.ts";
import { addDays, addMonths, daysBetween } from "../recurring/index.ts";

// Balances over time for Chat's get_balance_history (spec 08, Lookup tools): one Account, Cash on
// hand, or Debt. Balances use the Transaction sign, so money owed is negative.

// A range of this many days or fewer gets daily balances; a longer one gets month-end balances.
export const DAILY_DAYS = 92;

type StoredAccount = Awaited<ReturnType<typeof listAccounts>>[number];

// The Accounts each tile counts (spec 07, Tiles): Cash on hand is every connected checking and
// savings Account; Debt is every credit card and every loan, Manual loans included. Excluded and
// Closed Accounts count in neither.
export function tileAccounts(
  accounts: readonly StoredAccount[],
  tile: "Cash on hand" | "Debt",
): StoredAccount[] {
  return accounts.filter((account) => {
    if (account.excluded || account.closedAt !== null) return false;
    if (tile === "Debt") return account.kind === "credit" || account.kind === "loan";
    return (
      account.connectionId !== null &&
      account.kind === "depository" &&
      (account.subtype === "checking" || account.subtype === "savings")
    );
  });
}

// Every balance of one Account, oldest first, as its Account page draws it: a synced Account's
// saved balances and the estimates before them, or the steps of an Unconnected account's or a
// Manual loan's estimate, held through today.
async function pointsOf(
  database: Database,
  account: StoredAccount,
  today: string,
): Promise<BalancePoint[]> {
  if (account.connectionId !== null) return (await accountBalances(database, account.id)).points;
  if (account.kind === UNCONNECTED) {
    const steps = await unconnectedBalanceSteps(database, account.id);
    return balanceLine(
      steps.map(({ balance, ...step }) => ({ ...step, currentBalance: balance })),
      today,
    ).points;
  }
  const steps = (await manualLoanBalanceSteps(database, account.id)) ?? [];
  return balanceLine(
    steps.map(({ date, owed }) => ({ date, currentBalance: -owed, estimated: true })),
    today,
  ).points;
}

// The dates to read: each day of a short range, else each month's last day, and the range's last
// day for its last month. None after today.
function datesIn(from: string, to: string, today: string): string[] {
  const last = to < today ? to : today;
  const dates: string[] = [];
  if (daysBetween(from, to) + 1 <= DAILY_DAYS) {
    for (let date = from; date <= last; date = addDays(date, 1)) dates.push(date);
    return dates;
  }
  for (let month = `${from.slice(0, 7)}-01`; month <= last; month = addMonths(month, 1)) {
    const monthEnd = addDays(addMonths(month, 1), -1);
    if (monthEnd >= last) dates.push(last);
    else dates.push(monthEnd);
  }
  return dates;
}

export type HistoryPoint = { date: string; balance: number; estimated: boolean };

// The summed balance of `accounts` at the end of each date to read, from `from` to `to`. Each
// Account holds its last balance until its next one. A date before any of them has a balance is
// left out. A point is estimated when any balance in it is.
export async function balanceHistory(
  database: Database,
  accounts: readonly StoredAccount[],
  range: { from: string; to: string },
  today: string,
): Promise<{ daily: boolean; points: HistoryPoint[] }> {
  const lines = await Promise.all(
    accounts.map(async (account) =>
      (await pointsOf(database, account, today)).filter((point) => point.currentBalance !== null),
    ),
  );
  const next = lines.map(() => 0);
  const held = lines.map((): BalancePoint | undefined => undefined);
  const points: HistoryPoint[] = [];
  for (const date of datesIn(range.from, range.to, today)) {
    let balance = 0;
    let estimated = false;
    let any = false;
    lines.forEach((line, index) => {
      let at = next[index] ?? 0;
      while (at < line.length && (line[at]?.date ?? "") <= date) {
        held[index] = line[at];
        at += 1;
      }
      next[index] = at;
      const point = held[index];
      if (point === undefined) return;
      any = true;
      balance += point.currentBalance ?? 0;
      estimated ||= point.estimated;
    });
    if (any) points.push({ date, balance, estimated });
  }
  return { daily: daysBetween(range.from, range.to) + 1 <= DAILY_DAYS, points };
}
