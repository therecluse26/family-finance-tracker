// What the bank API routes answer. This file imports only types that import nothing, so the web
// app's type check can follow it through api.ts.
import type { AdapterActions, Provider } from "../bank/adapter.ts";
import type { UnconnectedKind } from "../bank/unconnected-kinds.ts";
import type { TransactionPartView, TransactionRowView } from "./money-movement-views.ts";

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
  // True when the current balance is an estimate: an Unconnected account's once an assigned
  // Transfer moved it, or with no typed balance, and a Manual loan's always.
  estimated: boolean;
  // A Member turned on its Exclude switch. Its balances are then null, like a Closed Account's.
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
  // A second Connection to a bank another Connection covers, which the provider did not end. It
  // never syncs, and the Member removes it.
  held: boolean;
};

// What Sync now did with one Healthy or Retrying Connection (spec 02, Sync now). A skipped one
// synced less than its adapter's minSyncGapHours ago, and says when it may sync again, in UTC.
// refreshed: the provider was asked for fresh data, so a second sync follows in 5 minutes.
export type SyncNowView = {
  connectionId: string;
  bankName: string;
} & ({ outcome: "syncing"; refreshed: boolean } | { outcome: "skipped"; canSyncAt: string });

// The first history load (spec 02, First history load): one row per Healthy or Retrying
// Connection whose history is still loading, for "loading history for <bank>".
export type HistoryStatusView = {
  // True once every Connection's history has loaded, or stopped holding back AI. The First run
  // job then runs once.
  waitEnded: boolean;
  // False while the first history load holds back every AI use.
  aiMayRun: boolean;
  loading: {
    connectionId: string;
    bankName: string;
    // Progress: the Transactions brought in so far, and the posted date of the oldest.
    transactions: number;
    oldestDate: string | null;
    // False once it stopped holding back AI, such as 24 hours after it was made.
    holdsBackAi: boolean;
  }[];
};

// The filters and the page of GET /api/transactions (spec 07, Transactions page). Calendar dates
// are written YYYY-MM-DD, and a month YYYY-MM.
export type TransactionQuery = {
  accountId?: string;
  // Posted dates. Both ends are included.
  from?: string;
  to?: string;
  // The Merchant's clean name.
  merchant?: string;
  // A Transaction shows when one of its parts has the type, the Category, and the month that are
  // set. A linked Refund or Reimbursement part has its Spending's Categories and month.
  type?: TransactionPartView["type"];
  category?: string;
  month?: string;
  // A page of at most `limit` Transactions, after the one with the ID `after`. Without a limit,
  // every Transaction that passes the filters.
  limit?: number;
  after?: string;
};

// The Transactions that pass the filters, newest first, and the ID to read the next page after, or
// null on the last page.
export type TransactionListView = { transactions: TransactionRowView[]; next: string | null };

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

// A number tile (spec 07, 4. Number tiles), in whole cents: its number, its 12-month usual, and
// its trend line. The usual is null before the first complete month of history.
export type NumberTileView = {
  amount: number;
  usual: number | null;
  // Up to 12 points, oldest first. Each is a month, YYYY-MM, or for today's balance a date,
  // YYYY-MM-DD.
  trend: { at: string; amount: number }[];
};

// Cash on hand or Debt. `estimatedUsual` is true when any month-end balance behind the usual is
// from before an Account's first sync, which is estimated (spec 02, Balance history).
export type BalanceTileView = NumberTileView & { estimatedUsual: boolean };

// The four number tiles. Spending and Income are the last complete month's; Cash on hand and Debt
// are today's current balances. Debt is what is owed, so it is positive.
export type NumberTilesView = {
  // The last complete month, YYYY-MM.
  lastMonth: string;
  spending: NumberTileView;
  income: NumberTileView;
  cashOnHand: BalanceTileView;
  // How many Manual loans the Debt counts: their balances are the app's own estimates.
  debt: BalanceTileView & { estimatedLoans: number };
};

export type BankViews = {
  accounts(): Promise<AccountView[]>;
  // The dashboard's four number tiles, on the Household's date.
  numberTiles(): Promise<NumberTilesView>;
  // A Member closes or reopens any Account. Undefined when no Account has the ID.
  closeAccount(id: string): Promise<AccountView | undefined>;
  reopenAccount(id: string): Promise<AccountView | undefined>;
  // A Member turns an Account's Exclude switch on or off. Undefined when no Account has the ID.
  setExcluded(id: string, excluded: boolean): Promise<AccountView | undefined>;
  // Undefined when no Transaction has the ID `after`.
  transactions(query: TransactionQuery): Promise<TransactionListView | undefined>;
  // Undefined when no Account has the ID.
  balances(accountId: string, query: BalanceQuery): Promise<BalancesView | undefined>;
  connections(): Promise<ConnectionView[]>;
  // True when the fake adapter runs, as under `pnpm dev`: Settings then offers its fake bank.
  fakeBank(): boolean;
  // Any Member presses Sync now.
  syncNow(): Promise<SyncNowView[]>;
  historyStatus(): Promise<HistoryStatusView>;
  // A Member pressed Retry on a stopped history job's notice. True for each kind that had stopped.
  retryHistoryJobs(): Promise<{ firstRun: boolean; banksAddedLater: boolean }>;
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
