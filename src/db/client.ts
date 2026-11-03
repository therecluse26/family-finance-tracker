import { type Client, createClient } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema.ts";

export const APP_DB_URL = "file:/data/app.db";

const BUSY_TIMEOUT_MS = 5000;

export type Database = LibSQLDatabase<typeof schema> & { $client: Client };

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

export function closeDatabase(database: Database): void {
  database.$client.close();
}
