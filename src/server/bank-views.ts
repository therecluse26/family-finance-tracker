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
  // Whole cents. A null balance is one the provider did not send, or a Closed Account's.
  currentBalance: number | null;
  availableBalance: number | null;
  creditLimit: number | null;
  excluded: boolean;
  closed: boolean;
  // When the Account became Closed, in UTC, or null while it is open.
  closedAt: string | null;
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

// One day's end balance of an Account, in whole cents; money owed is negative. A day before the
// first sync is estimated, and has no available balance.
export type BalancePointView = {
  date: string;
  currentBalance: number | null;
  availableBalance: number | null;
  estimated: boolean;
};

// The last balance in a month, such as "2026-10".
export type MonthEndView = {
  month: string;
  date: string;
  currentBalance: number | null;
  estimated: boolean;
};

export type BalancesView = { points: BalancePointView[]; monthEnds: MonthEndView[] };

// Calendar dates are written YYYY-MM-DD, and both ends are included.
export type BalanceQuery = { from?: string; to?: string };

export type BankViews = {
  accounts(): Promise<AccountView[]>;
  // A Member closes or reopens any Account. Undefined when no Account has the ID.
  closeAccount(id: string): Promise<AccountView | undefined>;
  reopenAccount(id: string): Promise<AccountView | undefined>;
  transactions(query: TransactionQuery): Promise<TransactionView[]>;
  // Undefined when no Account has the ID.
  balances(accountId: string, query: BalanceQuery): Promise<BalancesView | undefined>;
  connections(): Promise<ConnectionView[]>;
};
