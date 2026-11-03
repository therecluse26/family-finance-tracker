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
export { SyncConnectionJob, startSync } from "./job.ts";
export { adapterActions, type SyncReport, startBank, syncConnection } from "./sync.ts";
