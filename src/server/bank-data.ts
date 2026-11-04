import {
  accountBalances,
  adapterActions,
  addUnconnectedAccount,
  editUnconnectedAccount,
  type Health,
  historyStatus,
  listUnconnectedAccounts,
  retryFirstRun,
  retryLaterHooks,
  syncNow,
  type TypedBalanceInput,
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
import { decideOneSidedAgain, switchExclude } from "../money-movement/index.ts";
import type { AccountView, BankViews, UnconnectedAccountBody } from "./bank-views.ts";

// A Connection that needs a Member or is Broken does not poll (spec 02, Connections).
const polls = (health: Health) => health === "healthy" || health === "retrying";

// The bank API's reads from app.db, and a Member's changes to Accounts. Hidden Transactions are
// left out.
export function bankViews(database: Database): BankViews {
  async function accounts(): Promise<AccountView[]> {
    // An Unconnected account has its balance estimate in place of a synced balance.
    const estimates = new Map(
      (await listUnconnectedAccounts(database)).map((account) => [account.id, account.estimate]),
    );
    return (await listAccounts(database)).map(({ memberName, closedAt, ...account }) => {
      const closed = closedAt !== null;
      const balance = estimates.get(account.id)?.balance ?? account.currentBalance;
      // A Closed Account drops out of balances and balance totals (spec 02, Closed Accounts), and
      // so does an excluded one (spec 02, Exclude). Its saved daily balances and its Transactions
      // stay.
      const counted = !closed && !account.excluded;
      return {
        ...account,
        name: memberName ?? account.name,
        currentBalance: counted ? balance : null,
        availableBalance: counted ? account.availableBalance : null,
        closed,
        closedAt: closedAt?.toISOString() ?? null,
      };
    });
  }

  const accountView = async (id: string) => (await accounts()).find((account) => account.id === id);

  // A typed balance is saved with the Household's date (spec 02, Balance estimate).
  async function typed(
    body: UnconnectedAccountBody,
    memberId: string,
    at = new Date(),
  ): Promise<TypedBalanceInput | undefined> {
    if (body.balance === null) return undefined;
    const today = calendarDateIn(at, (await householdTimeZone(database)) ?? "UTC");
    return { balance: body.balance, today, memberId, at };
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

    async balances(accountId, query) {
      if ((await readAccount(database, accountId)) === undefined) return undefined;
      return accountBalances(database, accountId, query);
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
