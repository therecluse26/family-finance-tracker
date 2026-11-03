import { adapterActions } from "../bank/index.ts";
import { type Database, listAccounts, listConnections, listTransactions } from "../db/index.ts";
import type { BankViews } from "./bank-views.ts";

// The bank API's reads from app.db. Hidden Transactions are left out.
export function bankViews(database: Database): BankViews {
  return {
    async accounts() {
      return (await listAccounts(database)).map(({ memberName, closedAt, ...account }) => ({
        ...account,
        name: memberName ?? account.name,
        closed: closedAt !== null,
      }));
    },

    transactions(query) {
      return listTransactions(database, query);
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
