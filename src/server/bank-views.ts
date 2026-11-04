// What the bank API routes answer. This file imports only types that import nothing, so the web
// app's type check can follow it through api.ts.
import type { AdapterActions, Provider } from "../bank/adapter.ts";
import type { UnconnectedKind } from "../bank/unconnected-kinds.ts";

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
  // The last successful sync, for "last synced <date>".
  lastSyncedAt: string | null;
  // When the next sync is due. Empty while the Connection needs a Member or is Broken, since it
  // does not poll, and for a new Connection, which syncs at once.
  nextSyncAt: string | null;
  // The adapter's actions, so a screen hides the button for each missing one.
  actions: AdapterActions;
  // A Member removed it: it has no credential and never syncs. Its Closed Accounts keep their
  // history until a Member deletes it.
  removed: boolean;
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

// An Unconnected account (spec 02, Unconnected accounts), with its balance estimate.
export type UnconnectedAccountView = {
  id: string;
  name: string;
  kind: UnconnectedKind;
  institutionName: string | null;
  // The last 4 digits.
  mask: string | null;
  closed: boolean;
  estimate: {
    // Whole cents. Money in the account is positive.
    balance: number;
    // "typed" right after a Member types the balance; "estimated" once an assigned Transfer moves
    // it, or when no balance was ever typed.
    state: "typed" | "estimated";
    // The day of the last typed balance, YYYY-MM-DD, or null.
    typedOn: string | null;
  };
};

// The form's fields. A balance, in whole cents, is the true balance a Member typed today; null
// leaves the estimate as it is.
export type UnconnectedAccountBody = {
  name: string;
  kind: UnconnectedKind;
  institutionName: string | null;
  mask: string | null;
  balance: number | null;
};

export type BankViews = {
  accounts(): Promise<AccountView[]>;
  // A Member closes or reopens any Account. Undefined when no Account has the ID.
  closeAccount(id: string): Promise<AccountView | undefined>;
  reopenAccount(id: string): Promise<AccountView | undefined>;
  transactions(query: TransactionQuery): Promise<TransactionView[]>;
  // Undefined when no Account has the ID.
  balances(accountId: string, query: BalanceQuery): Promise<BalancesView | undefined>;
  connections(): Promise<ConnectionView[]>;
  unconnectedAccounts(): Promise<UnconnectedAccountView[]>;
  addUnconnectedAccount(
    body: UnconnectedAccountBody,
    memberId: string,
  ): Promise<UnconnectedAccountView>;
  // Undefined when no Unconnected account has the ID.
  editUnconnectedAccount(
    id: string,
    body: UnconnectedAccountBody,
    memberId: string,
  ): Promise<UnconnectedAccountView | undefined>;
};
