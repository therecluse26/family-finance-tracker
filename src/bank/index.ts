// The bank module's interface. Other modules import from here. It is the only module that imports
// a Bank-data provider's package.
export type {
  AccountSnapshot,
  AdapterActions,
  BankConnection,
  BankDataAdapter,
  BankErrorKind,
  CardDetails,
  LinkResult,
  LinkSession,
  LoanDetails,
  NewConnection,
  Provider,
  RemovalReason,
  SyncResult,
  TxnRecord,
} from "./adapter.ts";
export { BankDataError } from "./adapter.ts";
export {
  type AccountBalances,
  accountBalances,
  type BalancePoint,
  type BalanceRange,
  type MonthEndBalance,
} from "./balances.ts";
export { SyncConnectionJob, startSync } from "./job.ts";
export {
  mapPlaidCategory,
  PLAID_V2_CODES,
  type PlaidCategoryMatch,
  type PlaidConfidence,
  plaidConfidence,
} from "./plaid-categories.ts";
export {
  type PlaidClientMaker,
  type PlaidKeysClient,
  plaidSettings,
  productionPlaidClient,
  readPlaidKeys,
} from "./plaid-keys.ts";
export {
  PLAID_ITEM_LIMIT,
  type PlaidKeys,
  type PlaidKeysCheck,
  type PlaidSettings,
  type PlaidView,
} from "./plaid-view.ts";
export {
  adapterActions,
  type SyncOptions,
  type SyncReport,
  startBank,
  syncConnection,
} from "./sync.ts";
export {
  addUnconnectedAccount,
  type BalanceEstimate,
  editUnconnectedAccount,
  estimateBalance,
  listUnconnectedAccounts,
  type TypedBalanceInput,
  type UnconnectedAccount,
  type UnconnectedAccountInput,
} from "./unconnected.ts";
export { UNCONNECTED, UNCONNECTED_KINDS, type UnconnectedKind } from "./unconnected-kinds.ts";
