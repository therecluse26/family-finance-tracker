import {
  accountBalances,
  adapterActions,
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
  listTransactions,
  readAccount,
  reopenAccount,
} from "../db/index.ts";
import { calendarDateIn } from "../format.ts";
import { householdTimeZone } from "../household/index.ts";
import {
  decideOneSidedAgain,
  listManualLoanViews,
  manualLoanBalanceSteps,
  switchExclude,
} from "../money-movement/index.ts";
import type { AccountView, BankViews, UnconnectedAccountBody } from "./bank-views.ts";

// A Connection that needs a Member or is Broken does not poll (spec 02, Connections).
const polls = (health: Health) => health === "healthy" || health === "retrying";

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

  return {
    accounts,

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

    transactions(query) {
      return listTransactions(database, query);
    },

    // A synced Account has a saved balance for each day. An Unconnected account or a Manual loan
    // has none: its line steps at each day its estimate changed.
    async balances(accountId, query) {
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
