// The db module's interface. Other modules import from here.
export { APP_DB_URL, closeDatabase, type Database, openDatabase } from "./client.ts";
export {
  applyMigrations,
  checkMigrations,
  type MigrationCheck,
  NewerDatabaseError,
  SkippedMigrationError,
} from "./migrate.ts";
