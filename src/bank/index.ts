// The bank module's interface. Other modules import from here. It is the only module that imports
// a Bank-data provider's package.
export type {
  AccountSnapshot,
  AdapterActions,
  BankConnection,
  BankDataAdapter,
  BankErrorKind,
  CardDetails,
  LinkedAccount,
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
  balanceLine,
  type MonthEndBalance,
} from "./balances.ts";
export { bankConnecting, connectionRepairing } from "./connect.ts";
export {
  type BankConnecting,
  CONFIRM_ITEMS_FROM,
  type ConnectionRemoving,
  type ConnectionRepairing,
  type CoveringConnection,
  type DeleteHistoryOutcome,
  type ImportFinish,
  type ImportPreview,
  type LinkFinish,
  type LinkOptions,
  type LinkStart,
  type RemoveOutcome,
  type UpdateModeFinish,
  type UpdateModeStart,
} from "./connect-view.ts";
export {
  endHistoryWait,
  FIRST_RUN_STEPS,
  FIRST_RUN_STOPPED_TEXT,
  FirstRunJob,
  type FirstRunStep,
  type FirstRunStepName,
  HISTORY_READY,
  type LostJobOutcome,
  registerFirstRunStep,
  restartLostFirstRun,
  retryFirstRun,
  runFirstRun,
} from "./first-run.ts";
export { connectionToRepair, type Health } from "./health.ts";
export {
  aiMayRun,
  type HistoryLoading,
  type HistoryStatus,
  historyJobToRetry,
  historyStatus,
} from "./history-load.ts";
export {
  catchUpSyncs,
  SyncConnectionJob,
  SyncScheduleJob,
  startDueSyncs,
  startSync,
} from "./job.ts";
export {
  type BankAddedLaterHook,
  BankAddedLaterJob,
  LATER_HOOKS_STOPPED_TEXT,
  registerBankAddedLaterHook,
  restartLostLaterHooks,
  retryLaterHooks,
  runLaterHooks,
} from "./later-hooks.ts";
export { type PlaidClient, type PlaidClientFor, plaidAdapter } from "./plaid.ts";
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
export { connectionRemoving } from "./remove.ts";
export {
  adapterActions,
  runSyncJob,
  type SyncJobOutcome,
  type SyncOptions,
  type SyncReport,
  startBank,
  syncConnection,
} from "./sync.ts";
export { type SyncNowResult, syncNow } from "./sync-now.ts";
export {
  addUnconnectedAccount,
  type BalanceEstimate,
  editUnconnectedAccount,
  estimateBalance,
  listUnconnectedAccounts,
  type TypedBalanceInput,
  type UnconnectedAccount,
  type UnconnectedAccountInput,
  unconnectedBalanceSteps,
} from "./unconnected.ts";
export { UNCONNECTED, UNCONNECTED_KINDS, type UnconnectedKind } from "./unconnected-kinds.ts";
