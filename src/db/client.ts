import { chmod } from "node:fs/promises";
import { type Client, createClient, type ResultSet } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { log } from "../log.ts";
import * as schema from "./schema.ts";

export const APP_DB_URL = "file:/data/app.db";

const BUSY_TIMEOUT_MS = 5000;

export type Database = LibSQLDatabase<typeof schema> & { $client: Client };

// app.db, or a transaction on it: what a function needs that may run inside another one's
// transaction.
export type Queries = BaseSQLiteDatabase<"async", ResultSet, typeof schema>;

// Makes each file the app's user's alone (spec 11, What a backup holds), whatever the umask or an
// older version left. A missing file is skipped. A file system that refuses the change, such as
// some NAS shares, gets a warning, and the app goes on.
export async function makeFilesOwnerOnly(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    await chmod(path, 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return;
      log.warn("Could not make a file readable by the app's user alone", {
        file: path,
        code: error.code,
      });
    });
  }
}

// An SQLite file with its -wal and -shm files. SQLite makes a new -wal or -shm file with the main
// file's own mode, so once the main file is owner-only, the later ones are too.
export function sqliteFiles(file: string): string[] {
  return [file, `${file}-wal`, `${file}-shm`];
}

// app.db and its -wal and -shm files. It reads the path from SQLite itself, so it changes the file
// SQLite opened.
async function makeOwnerOnly(client: Client): Promise<void> {
  const result = await client.execute("SELECT file FROM pragma_database_list WHERE name = 'main'");
  const file = String(result.rows[0]?.[0] ?? "");
  // An in-memory database has no file.
  if (file === "") return;
  await makeFilesOwnerOnly(sqliteFiles(file));
}

// The driver setup, and the only code that changes an SQLite setting: WAL mode, which is kept in the
// file itself. The driver applies the busy timeout to every connection it opens.
export async function openDatabase(url: string): Promise<Database> {
  const client = createClient({ url, timeout: BUSY_TIMEOUT_MS });
  try {
    await client.execute("PRAGMA journal_mode = WAL");
    await makeOwnerOnly(client);
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
