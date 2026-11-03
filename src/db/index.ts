// The db module's interface. Other modules import from here.
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
export { scheduledTasks } from "./schema.ts";
export {
  addSignInTries,
  countSignInTries,
  removeSignInTries,
  removeSignInTriesUpTo,
} from "./sign-in-tries.ts";
export { claimTotpStep } from "./totp-steps.ts";
