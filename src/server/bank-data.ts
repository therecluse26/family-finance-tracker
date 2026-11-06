import {
  accountBalances,
  adapterActions,
  adapterRuns,
  addUnconnectedAccount,
  balanceLine,
  editUnconnectedAccount,
  type Health,
  historyStatus,
  listUnconnectedAccounts,
  retryFirstRun,
  retryLaterHooks,
  syncNow,
  type TypedBalanceInput,
  UNCONNECTED,
  unconnectedBalanceSteps,
} from "../bank/index.ts";
import {
  closeAccount,
  type Database,
  listAccounts,
  listConnections,
  listPostedDayTotals,
  listTransactionPage,
  listTransactions,
  readAccount,
  reopenAccount,
} from "../db/index.ts";
import { calendarDateIn } from "../format.ts";
import { householdTimeZone } from "../household/index.ts";
import {
  decideOneSidedAgain,
  listManualLoanViews,
  type MonthTotals,
  manualLoanBalanceSteps,
  switchExclude,
  totalsByMonth,
} from "../money-movement/index.ts";
import type {
  AccountView,
  BalanceQuery,
  BalancesView,
  BankViews,
  NumberTileView,
  UnconnectedAccountBody,
} from "./bank-views.ts";
import { transactionRows } from "./transaction-rows.ts";
import { lastDayOf, median, monthsBefore } from "./usual.ts";

// A Connection that needs a Member or is Broken does not poll (spec 02, Connections).
const polls = (health: Health) => health === "healthy" || health === "retrying";

// An Account's balance at the end of each day in `days`, oldest first: its last point on or before
// that day, or undefined before its first point. `points` are oldest first.
function balancesOn(
  points: BalancesView["points"],
  days: readonly string[],
): (number | undefined)[] {
  let next = 0;
  let last: number | undefined;
  return days.map((day) => {
    for (; next < points.length && (points[next]?.date ?? "") <= day; next++) {
      last = points[next]?.currentBalance ?? last;
    }
    return last;
  });
}

// The bank API's reads from app.db, and a Member's changes to Accounts. Hidden Transactions are
// left out.
export function bankViews(database: Database): BankViews {
  async function accounts(): Promise<AccountView[]> {
    // An Unconnected account or a Manual loan has its estimate in place of a synced balance. A
    // Manual loan's is always estimated (spec 02, Balance and payoff); owed money is negative.
    const estimates = new Map<string, { balance: number; estimated: boolean }>(
      (await listUnconnectedAccounts(database)).map((account) => [
        account.id,
        { balance: account.estimate.balance, estimated: account.estimate.state === "estimated" },
      ]),
    );
    for (const loan of await listManualLoanViews(database)) {
      estimates.set(loan.id, { balance: -loan.currentBalance, estimated: true });
    }
    return (await listAccounts(database)).map(({ memberName, closedAt, ...account }) => {
      const closed = closedAt !== null;
      const estimate = estimates.get(account.id);
      const balance = estimate?.balance ?? account.currentBalance;
      // A Closed Account drops out of balances and balance totals (spec 02, Closed Accounts), and
      // so does an excluded one (spec 02, Exclude). Its saved daily balances and its Transactions
      // stay.
      const counted = !closed && !account.excluded;
      return {
        ...account,
        name: memberName ?? account.name,
        currentBalance: counted ? balance : null,
        availableBalance: counted ? account.availableBalance : null,
        estimated: estimate?.estimated ?? false,
        closed,
        closedAt: closedAt?.toISOString() ?? null,
      };
    });
  }

  // The Household's date. Until the wizard's step 4 sets the Household time zone, it is the date in
  // UTC.
  const householdToday = async (at = new Date()) =>
    calendarDateIn(at, (await householdTimeZone(database)) ?? "UTC");

  const accountView = async (id: string) => (await accounts()).find((account) => account.id === id);

  // A typed balance is saved with the Household's date (spec 02, Balance estimate).
  async function typed(
    body: UnconnectedAccountBody,
    memberId: string,
    at = new Date(),
  ): Promise<TypedBalanceInput | undefined> {
    if (body.balance === null) return undefined;
    return { balance: body.balance, today: await householdToday(at), memberId, at };
  }

  const input = ({ name, kind, institutionName, mask }: UnconnectedAccountBody) => ({
    name,
    kind,
    institutionName,
    mask,
  });

  // A synced Account has a saved balance for each day. An Unconnected account or a Manual loan
  // has none: its line steps at each day its estimate changed.
  async function balances(
    accountId: string,
    query: BalanceQuery,
  ): Promise<BalancesView | undefined> {
    const account = await readAccount(database, accountId);
    if (account === undefined) return undefined;
    if (account.connectionId !== null) return accountBalances(database, accountId, query);
    const today = await householdToday();
    if (account.kind === UNCONNECTED) {
      const steps = await unconnectedBalanceSteps(database, accountId);
      return balanceLine(
        steps.map(({ balance, ...step }) => ({ ...step, currentBalance: balance })),
        today,
        query,
      );
    }
    const steps = (await manualLoanBalanceSteps(database, accountId)) ?? [];
    return balanceLine(
      steps.map(({ date, owed }) => ({ date, currentBalance: -owed, estimated: true })),
      today,
      query,
    );
  }

  // An Account's balance before its first point (spec 02, Balance history): the first point with
  // that day's posted Transactions undone. Earlier days have no Transactions to undo, so the
  // balance holds back to the start of the history. A Manual loan's typed balance holds back the
  // same way, so a loan typed today counts in every past month-end too.
  async function balanceBefore(
    account: AccountView,
    first: BalancesView["points"][number],
  ): Promise<number> {
    const balance = first.currentBalance ?? 0;
    if (account.connectionId === null) return balance;
    const days = await listPostedDayTotals(database, account.id, first.date);
    return balance - (days.find((day) => day.date === first.date)?.total ?? 0);
  }

  // Cash on hand or Debt (spec 07, 4. Number tiles): today's current balances of `counted`, and
  // their sum at each of the 12 month-ends before `month` from `start`, the Household's first month
  // of history, on. Each Account counts at every one of those month-ends, before its first balance
  // too. Debt is what is owed, so `owed` turns the sign.
  async function balanceTile(
    counted: readonly AccountView[],
    month: string,
    today: string,
    owed: boolean,
    start: string | undefined,
  ): Promise<NumberTileView> {
    const shown = (cents: number) => (owed ? 0 - cents : cents);
    const months = monthsBefore(month, 12);
    const known = months.filter((each) => start !== undefined && each >= start);
    const ends = known.map(lastDayOf);
    const sums = ends.map(() => 0);
    for (const account of counted) {
      const { points = [] } = (await balances(account.id, {})) ?? {};
      const first = points[0];
      if (first === undefined) continue;
      const before = await balanceBefore(account, first);
      balancesOn(points, ends).forEach((balance, index) => {
        sums[index] = (sums[index] ?? 0) + (balance ?? before);
      });
    }
    const monthEnds = known.map((at, index) => ({ at, amount: shown(sums[index] ?? 0) }));
    const amount = shown(counted.reduce((sum, account) => sum + (account.currentBalance ?? 0), 0));
    // The trend line: the last 11 month-ends, then today.
    const recent = monthEnds.filter((point) => point.at >= (months[1] ?? ""));
    return {
      amount,
      usual: median(monthEnds.map((point) => point.amount)),
      trend: [...recent, { at: today, amount }],
    };
  }

  // The four number tiles (spec 07, 4. Number tiles). Excluded and Closed Accounts count in no
  // balance; Unconnected accounts are not in Cash on hand. The Household's history starts in the
  // month of its first posted Transaction. A month before it is left out of every tile's usual and
  // trend line.
  async function numberTiles() {
    const today = await householdToday();
    const month = today.slice(0, 7);
    const months = monthsBefore(month, 12);
    const lastMonth = months.at(-1) ?? month;
    const totals = await totalsByMonth(database);
    const first = totals[0]?.month;
    const byMonth = new Map(totals.map((each) => [each.month, each]));
    const known = months.filter((each) => first !== undefined && each >= first);
    const monthTile = (pick: (each: MonthTotals) => number): NumberTileView => {
      const amountIn = (each: string) => {
        const found = byMonth.get(each);
        return found === undefined ? 0 : pick(found);
      };
      const trend = known.map((at) => ({ at, amount: amountIn(at) }));
      return {
        amount: amountIn(lastMonth),
        usual: median(trend.map((point) => point.amount)),
        trend,
      };
    };

    const counted = (await accounts()).filter((account) => !account.closed && !account.excluded);
    const cash = counted.filter(
      (account) => account.kind === "depository" && account.connectionId !== null,
    );
    const debts = counted.filter((account) => account.kind === "credit" || account.kind === "loan");
    return {
      lastMonth,
      spending: monthTile((each) => each.spending),
      income: monthTile((each) => each.income),
      cashOnHand: await balanceTile(cash, month, today, false, first),
      debt: {
        ...(await balanceTile(debts, month, today, true, first)),
        estimatedLoans: debts.filter(
          (account) => account.kind === "loan" && account.connectionId === null,
        ).length,
      },
    };
  }

  return {
    accounts,
    numberTiles,
    balances,

    unconnectedAccounts() {
      return listUnconnectedAccounts(database);
    },

    // Each change to the Accounts may tie a one-sided Transfer to another account, so Money
    // movement decides them again.
    async addUnconnectedAccount(body, memberId) {
      const added = await addUnconnectedAccount(database, input(body), await typed(body, memberId));
      await decideOneSidedAgain(database);
      return added;
    },

    async editUnconnectedAccount(id, body, memberId) {
      const edited = await editUnconnectedAccount(
        database,
        id,
        input(body),
        await typed(body, memberId),
      );
      if (edited !== undefined) await decideOneSidedAgain(database);
      return edited;
    },

    async closeAccount(id) {
      if (!(await closeAccount(database, id))) return undefined;
      await decideOneSidedAgain(database);
      return accountView(id);
    },

    async reopenAccount(id) {
      if (!(await reopenAccount(database, id))) return undefined;
      await decideOneSidedAgain(database);
      return accountView(id);
    },

    // Matching and totals run again over all history.
    async setExcluded(id, excluded) {
      if (!(await switchExclude(database, id, excluded))) return undefined;
      return accountView(id);
    },

    // One page when the query has a limit, else every Transaction that passes the filters.
    async transactions({ limit, after, ...filter }) {
      if (limit === undefined) {
        const listed = await listTransactions(database, filter);
        return { transactions: await transactionRows(database, listed), next: null };
      }
      const page = await listTransactionPage(database, filter, {
        limit,
        ...(after === undefined ? {} : { after }),
      });
      if (page === undefined) return undefined;
      return { transactions: await transactionRows(database, page.transactions), next: page.next };
    },

    async connections() {
      return (await listConnections(database)).map((connection) => ({
        id: connection.id,
        provider: connection.provider,
        bankName: connection.bankName,
        health: connection.health,
        historyLoaded: connection.historyLoaded,
        lastSyncedAt: connection.lastSyncedAt?.toISOString() ?? null,
        nextSyncAt:
          polls(connection.health) && connection.removedAt === null
            ? (connection.nextSyncAt?.toISOString() ?? null)
            : null,
        actions: adapterActions(connection.provider),
        removed: connection.removedAt !== null,
        held: connection.syncHeld,
      }));
    },

    fakeBank() {
      return adapterRuns("fake");
    },

    historyStatus() {
      return historyStatus(database);
    },

    async retryHistoryJobs() {
      return { firstRun: await retryFirstRun(), banksAddedLater: await retryLaterHooks() };
    },

    async syncNow() {
      return (await syncNow()).map((result) =>
        result.outcome === "skipped"
          ? { ...result, canSyncAt: result.canSyncAt.toISOString() }
          : result,
      );
    },
  };
}
