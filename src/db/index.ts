// The db module's interface. Other modules import from here.
export {
  addConnection,
  finishSync,
  listAccounts,
  listConnections,
  listTransactions,
  type PageCounts,
  readConnection,
  type StoredConnection,
  setHandSetFields,
  storeSyncPage,
  type TransactionFilter,
} from "./bank-data.ts";
export { APP_DB_URL, closeDatabase, type Database, openDatabase } from "./client.ts";
export { readDataKeys, type StoredDataKey, storeDataKey } from "./data-keys.ts";
export { loginTables } from "./login-tables.ts";
export {
  applyMigrations,
  checkMigrations,
  type MigrationCheck,
  NewerDatabaseError,
  SkippedMigrationError,
} from "./migrate.ts";
export {
  PLAID_SETTINGS_ROW,
  readPlaidSettings,
  type StoredPlaidSettings,
  storeItemsUsed,
  storePlaidKeys,
} from "./plaid-settings.ts";
export { scheduledTasks } from "./schema.ts";
export { hasMember, markSetupStep, readSetupSteps, type SetupStepStatus } from "./setup-steps.ts";
export {
  addSignInTries,
  countSignInTries,
  removeSignInTries,
  removeSignInTriesUpTo,
} from "./sign-in-tries.ts";
export { claimTotpStep } from "./totp-steps.ts";
