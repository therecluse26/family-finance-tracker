import { type Client, createClient, type ResultSet } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import * as schema from "./schema.ts";

export const APP_DB_URL = "file:/data/app.db";

const BUSY_TIMEOUT_MS = 5000;

export type Database = LibSQLDatabase<typeof schema> & { $client: Client };

// app.db, or a transaction on it: what a function needs that may run inside another one's
// transaction.
export type Queries = BaseSQLiteDatabase<"async", ResultSet, typeof schema>;

// The driver setup, and the only code that changes an SQLite setting: WAL mode, which is kept in the
// file itself. The driver applies the busy timeout to every connection it opens.
export async function openDatabase(url: string): Promise<Database> {
  const client = createClient({ url, timeout: BUSY_TIMEOUT_MS });
  try {
    await client.execute("PRAGMA journal_mode = WAL");
  } catch (error) {
    client.close();
    throw error;
  }
  return drizzle(client, { schema });
}

// A copy of app.db that no app uses, such as a backup that `fft restore` checks and changes before
// it puts it in place. It changes no setting, so the copy keeps its journal mode, as VACUUM INTO
// wrote it, and leaves no write-ahead log beside it to move with it.
export function openDatabaseCopy(path: string): Database {
  return drizzle(createClient({ url: `file:${path}`, timeout: BUSY_TIMEOUT_MS }), { schema });
}

export function closeDatabase(database: Database): void {
  database.$client.close();
}
