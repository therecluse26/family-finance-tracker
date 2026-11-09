import { sumDayEnds } from "../server/bank-data.ts";
import type { AccountDayEndsView, AccountView } from "../server/bank-views.ts";
import type {
  BalanceAmountPoint,
  BalancesReportAccount,
  BalancesReportView,
  CreditUsePoint,
  PrincipalPoint,
} from "../server/reports-views.ts";
import { lastDayOf } from "../server/usual.ts";

// Balances and debt (spec 07, Reports): Cash on hand and Debt at each month-end of the range, each
// credit card's credit use, and each loan's pay-down. The Accounts each line counts, and each
// Account's balance at each month-end, come from the number tiles' own helpers in bank-data.ts.
// No net worth (spec 13).

// One saved daily balance's details, oldest first.
export type DailyDetails = {
  date: string;
  creditLimit: number | null;
  loanPrincipal: number | null;
};

// The report's day for each month, oldest first: the month's last day, or `today` in the current
// month.
export function reportDays(months: readonly string[], today: string): string[] {
  return months.map((month) => (month === today.slice(0, 7) ? today : lastDayOf(month)));
}

// The last of `rows` on or before each of `days`, oldest first.
function lastOn<T extends { date: string }>(
  rows: readonly T[],
  days: readonly string[],
): (T | undefined)[] {
  let next = 0;
  let last: T | undefined;
  return days.map((day) => {
    for (; next < rows.length && (rows[next]?.date ?? "") <= day; next++) last = rows[next];
    return last;
  });
}

const named = ({ account }: AccountDayEndsView): BalancesReportAccount => ({
  id: account.id,
  name: account.name,
  kind: account.kind,
});

// What a card or loan owes, in whole cents: positive. A card in credit owes nothing.
const owedOf = (balance: number) => Math.max(0, 0 - balance);

// A card's credit use each day: what it owes over its credit limit that day, from that day's saved
// balance, else the Account's own limit. A day with no limit has no share.
function cardUse(line: AccountDayEndsView, details: readonly DailyDetails[], months: string[]) {
  const limits = lastOn(
    details,
    line.ends.map((end) => end.date),
  );
  return line.ends.map((end, index) => {
    const limit = limits[index]?.creditLimit ?? line.account.creditLimit;
    const usable = limit !== null && limit > 0 ? limit : null;
    return { month: months[index] ?? "", end, owed: owedOf(end.balance), limit: usable };
  });
}

// A loan's principal each day. A synced loan's is the one its bank sent with that day's saved
// balance; before its first sync there is none. A Manual loan's is what it owes, the app's own
// estimate.
function principalLine(
  line: AccountDayEndsView,
  details: readonly DailyDetails[],
  months: string[],
): PrincipalPoint[] {
  const manual = line.account.connectionId === null;
  const rows = lastOn(
    details,
    line.ends.map((end) => end.date),
  );
  return line.ends.map((end, index) => ({
    month: months[index] ?? "",
    date: end.date,
    principal: manual ? owedOf(end.balance) : (rows[index]?.loanPrincipal ?? null),
    estimated: manual || end.estimated,
  }));
}

// Cash on hand, Debt, credit use, and loan pay-down at each of `months`' ends, on `days`, from
// `reportDays`. `cash` and `debts` are the number tiles' Account sets with each Account's balance
// at each of `days`;
// `details` holds each synced card's and loan's saved daily balances, oldest first.
export function balanceLines(input: {
  months: string[];
  days: readonly string[];
  cash: readonly AccountDayEndsView[];
  debts: readonly AccountDayEndsView[];
  details: ReadonlyMap<string, readonly DailyDetails[]>;
}): Pick<BalancesReportView, "cashOnHand" | "debt" | "creditUse" | "loans"> {
  const { months, days, cash, debts, details } = input;
  const total = (lines: readonly AccountDayEndsView[], owed: boolean): BalanceAmountPoint[] =>
    sumDayEnds(lines, months.length).map((sum, index) => ({
      month: months[index] ?? "",
      date: days[index] ?? "",
      amount: owed ? 0 - sum.amount : sum.amount,
      estimated: sum.estimated,
    }));
  const detailsOf = (account: AccountView) => details.get(account.id) ?? [];

  const cards = debts
    .filter((line) => line.account.kind === "credit")
    .map((line) => ({ line, uses: cardUse(line, detailsOf(line.account), months) }))
    .filter(({ uses }) => uses.some((use) => use.limit !== null));
  const all: CreditUsePoint[] = months.map((month, index) => {
    const that = cards.flatMap(({ uses }) => {
      const use = uses[index];
      return use === undefined || use.limit === null ? [] : [{ ...use, limit: use.limit }];
    });
    const limit = that.reduce((sum, use) => sum + use.limit, 0);
    return {
      month,
      date: days[index] ?? "",
      share: limit > 0 ? that.reduce((sum, use) => sum + use.owed, 0) / limit : null,
      estimated: that.some((use) => use.end.estimated),
    };
  });

  return {
    cashOnHand: total(cash, false),
    debt: total(debts, true),
    creditUse: {
      cards: cards.map(({ line, uses }) => ({
        ...named(line),
        points: uses.map(({ month, end, owed, limit }) => ({
          month,
          date: end.date,
          share: limit === null ? null : owed / limit,
          estimated: end.estimated,
        })),
      })),
      all: cards.length === 0 ? [] : all,
    },
    loans: debts
      .filter((line) => line.account.kind === "loan")
      .map((line) => ({
        ...named(line),
        points: principalLine(line, detailsOf(line.account), months),
      }))
      .filter(({ points }) => points.some((point) => point.principal !== null)),
  };
}
