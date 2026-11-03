// What the bank API routes answer. This file imports only types that import nothing, so the web
// app's type check can follow it through api.ts.
import type { AdapterActions, Provider } from "../bank/adapter.ts";

export type AccountView = {
  id: string;
  connectionId: string | null;
  // The Member's rename, or the name from the provider.
  name: string;
  kind: string;
  subtype: string | null;
  institutionName: string | null;
  mask: string | null;
  // Whole cents. A null balance is one the provider did not send.
  currentBalance: number | null;
  availableBalance: number | null;
  creditLimit: number | null;
  excluded: boolean;
  closed: boolean;
};

export type TransactionView = {
  id: string;
  accountId: string;
  // Whole cents. Money into the Account is positive.
  amount: number;
  postedDate: string;
  authorizedDate: string | null;
  pending: boolean;
  description: string;
  merchantName: string | null;
};

export type ConnectionView = {
  id: string;
  provider: Provider;
  bankName: string;
  health: "healthy" | "retrying" | "needs a member" | "broken";
  historyLoaded: boolean;
  lastSyncedAt: string | null;
  // The adapter's actions, so a screen hides the button for each missing one.
  actions: AdapterActions;
};

// Calendar dates are written YYYY-MM-DD.
export type TransactionQuery = { accountId?: string; from?: string; to?: string };

export type BankViews = {
  accounts(): Promise<AccountView[]>;
  transactions(query: TransactionQuery): Promise<TransactionView[]>;
  connections(): Promise<ConnectionView[]>;
};
