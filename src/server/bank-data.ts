import { accountBalances, adapterActions } from "../bank/index.ts";
import {
  closeAccount,
  type Database,
  listAccounts,
  listConnections,
  listTransactions,
  readAccount,
  reopenAccount,
} from "../db/index.ts";
import type { AccountView, BankViews } from "./bank-views.ts";

// The bank API's reads from app.db, and a Member's changes to Accounts. Hidden Transactions are
// left out.
export function bankViews(database: Database): BankViews {
  async function accounts(): Promise<AccountView[]> {
    return (await listAccounts(database)).map(({ memberName, closedAt, ...account }) => {
      const closed = closedAt !== null;
      return {
        ...account,
        name: memberName ?? account.name,
        // A Closed Account drops out of balances and balance totals (spec 02, Closed Accounts).
        // Its saved daily balances and its Transactions stay.
        currentBalance: closed ? null : account.currentBalance,
        availableBalance: closed ? null : account.availableBalance,
        closed,
        closedAt: closedAt?.toISOString() ?? null,
      };
    });
  }

  const accountView = async (id: string) => (await accounts()).find((account) => account.id === id);

  return {
    accounts,

    async closeAccount(id) {
      return (await closeAccount(database, id)) ? accountView(id) : undefined;
    },

    async reopenAccount(id) {
      return (await reopenAccount(database, id)) ? accountView(id) : undefined;
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
        actions: adapterActions(connection.provider),
      }));
    },
  };
}
