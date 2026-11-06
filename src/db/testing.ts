import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Client, createClient, type ResultSet } from "@libsql/client";
import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  closeDatabase,
  type Database,
  type DatabaseOptions,
  openDatabase,
  type Queries,
} from "./client.ts";
import { applyMigrations } from "./migrate.ts";

// Test support: a new migrated app.db, app.db's settings, and migration folders in drizzle-kit's
// layout, for one app version or the next.

export type TestDatabase = { database: Database; path: string; close(): void };

// A new app.db in a new folder, with the app's own migrations applied.
export async function newTestDatabase(options?: DatabaseOptions): Promise<TestDatabase> {
  const dir = mkdtempSync(join(tmpdir(), "fft-db-"));
  const path = join(dir, "app.db");
  const database = await openDatabase(`file:${path}`, options);
  await applyMigrations(database, SHIPPED_FOLDER);
  return {
    database,
    path,
    close() {
      closeDatabase(database);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type Settings = {
  journal_mode: string;
  foreign_keys: number;
  synchronous: number;
  busy_timeout: number;
};

// Reads app.db's settings on one connection, through SQLite's table-valued functions, which read a
// setting but never change one.
export function readSettings(database: Database): Promise<Settings> {
  return database.get<Settings>(sql`
    SELECT
      (SELECT journal_mode FROM pragma_journal_mode()) AS journal_mode,
      (SELECT foreign_keys FROM pragma_foreign_keys()) AS foreign_keys,
      (SELECT synchronous FROM pragma_synchronous()) AS synchronous,
      (SELECT timeout FROM pragma_busy_timeout()) AS busy_timeout
  `);
}

// Every row of each of app.db's own tables, by table name, for a test that a step writes only where
// it should. Drizzle's migration table is left out.
export async function readEveryTable(database: Database): Promise<Record<string, unknown[]>> {
  const tables = await database.all<{ name: string }>(sql`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'
  `);
  const rows: Record<string, unknown[]> = {};
  for (const { name } of tables) {
    rows[name] = await database.all(sql`SELECT * FROM ${sql.identifier(name)} ORDER BY rowid`);
  }
  return rows;
}

// Names in pragma_pragma_list() that are not settings, so readEverySetting leaves them out.
const NOT_SETTINGS = new Set([
  "collation_list", // What SQLite was built with.
  "compile_options", // What SQLite was built with.
  "data_version", // Counts the file's changes, so it moves with each write.
  "database_list", // Names the file's path, which differs for each file.
  "foreign_key_check", // Checks the rows, which differ with the file's contents.
  "foreign_key_list", // Describes one table, so it needs a table name.
  "freelist_count", // Counts free pages, which change with the file's contents.
  "function_list", // What SQLite was built with.
  "index_info", // Describes one index, so it needs an index name.
  "index_list", // Describes one table, so it needs a table name.
  "index_xinfo", // Describes one index, so it needs an index name.
  "integrity_check", // Checks the file's contents.
  "module_list", // What SQLite was built with, in no fixed order.
  "optimize", // An action, not a setting: it runs ANALYZE where useful.
  "page_count", // Counts pages, which grow with the file's contents.
  "pragma_list", // The list of names itself.
  "quick_check", // Checks the file's contents.
  "schema_version", // Counts schema changes, such as each migration.
  "table_info", // Describes one table, so it needs a table name.
  "table_list", // Lists the file's tables.
  "table_xinfo", // Describes one table, so it needs a table name.
]);

// Settings that SQLite gives no table-valued function, each with the statement that reads it. With
// a name and no value, the statement only reads. The search test allows exactly these three lines
// in this file, each written whole, and flags any of them with a value, or in any other file.
const READ_BY_STATEMENT: Record<string, string> = {
  mmap_size: "PRAGMA mmap_size",
  temp_store_directory: "PRAGMA temp_store_directory",
  wal_autocheckpoint: "PRAGMA wal_autocheckpoint",
};

// Settings that no statement reads, each read by its effect instead.
const READ_BY_EFFECT: Record<string, string> = {
  // 1 when on, as LIKE then tells 'a' from 'A', and 0 when off.
  case_sensitive_like: "SELECT 'a' NOT LIKE 'A'",
};

export type EverySetting = {
  // Each setting's value: a single value, or a list of rows.
  values: Record<string, unknown>;
  // Names in the list that are actions, not settings, so no query can read them.
  unreadable: string[];
};

// Reads every setting on one connection: through SQLite's table-valued functions where they exist,
// else through the settings statement with no value, which only reads, else through its effect.
export async function readEverySetting(client: Pick<Client, "execute">): Promise<EverySetting> {
  const listed = await client.execute("SELECT name FROM pragma_pragma_list() ORDER BY name");
  const values: Record<string, unknown> = {};
  const unreadable: string[] = [];
  for (const row of listed.rows) {
    const name = String(row.name);
    if (!/^[a-z_]+$/.test(name)) throw new Error(`An unexpected setting name: ${name}`);
    if (NOT_SETTINGS.has(name)) continue;
    let result: ResultSet;
    try {
      result = await client.execute(`SELECT * FROM pragma_${name}()`);
    } catch (error) {
      if (!String(error).includes(`no such table: pragma_${name}`)) throw error;
      const read = READ_BY_STATEMENT[name] ?? READ_BY_EFFECT[name];
      if (read === undefined) {
        unreadable.push(name);
        continue;
      }
      result = await client.execute(read);
    }
    const rows = result.rows.map((cells) => result.columns.map((_column, i) => cells[i]));
    values[name] = rows.length === 1 && rows[0]?.length === 1 ? rows[0][0] : rows;
  }
  return { values, unreadable };
}

// Runs each statement in a transaction, so on app.db's write connection, which a read on the
// database never uses. A failed statement throws the driver's own error, as the client does.
export function onTransaction(tx: Queries): Pick<Client, "execute"> {
  const execute = async (statement: string) => {
    try {
      return await tx.run(sql.raw(statement));
    } catch (error) {
      throw error instanceof Error && error.cause !== undefined ? error.cause : error;
    }
  };
  return { execute: execute as Client["execute"] };
}

// Reads every setting on a plain libSQL connection, with none of the driver setup's options.
export async function readPlainSettings(url: string): Promise<EverySetting> {
  const client = createClient({ url });
  try {
    return await readEverySetting(client);
  } finally {
    client.close();
  }
}

// Each setting whose value differs from the plain connection's, with its value on this one.
export function changedSettings(
  plain: Record<string, unknown>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const names = new Set([...Object.keys(plain), ...Object.keys(values)]);
  return Object.fromEntries(
    [...names]
      .filter((name) => JSON.stringify(plain[name]) !== JSON.stringify(values[name]))
      .map((name) => [name, values[name]]),
  );
}

export type FixtureMigration = { tag: string; when: number; sql: string };

export const FIRST_MIGRATION: FixtureMigration = {
  tag: "0000_first",
  when: 1_790_000_000_000,
  sql: "CREATE TABLE `first` (`id` integer PRIMARY KEY NOT NULL);",
};

export const SECOND_MIGRATION: FixtureMigration = {
  tag: "0001_second",
  when: 1_790_000_100_000,
  sql: "CREATE TABLE `second` (`id` integer PRIMARY KEY NOT NULL);\n--> statement-breakpoint\nCREATE INDEX `second_id` ON `second` (`id`);",
};

// Made after SECOND_MIGRATION was released, but with an earlier time.
export const MIDDLE_MIGRATION: FixtureMigration = {
  tag: "0001_middle",
  when: 1_790_000_050_000,
  sql: "CREATE TABLE `middle` (`id` integer PRIMARY KEY NOT NULL);",
};

const SHIPPED_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

// The app's own migrations from drizzle/, for a folder that adds fixture migrations after them.
// Each gets a time before FIRST_MIGRATION's, so the fixtures stay the newest.
export function appMigrations(): FixtureMigration[] {
  const journal = readFileSync(join(SHIPPED_FOLDER, "meta", "_journal.json"), "utf8");
  const entries: { tag: string }[] = JSON.parse(journal).entries;
  return entries.map(({ tag }, i) => ({
    tag,
    when: FIRST_MIGRATION.when - (entries.length - i) * 1000,
    sql: readFileSync(join(SHIPPED_FOLDER, `${tag}.sql`), "utf8"),
  }));
}

// Joins statements as `drizzle-kit generate` does in a migration file.
function migrationSql(statements: string[]): string {
  return statements.join("--> statement-breakpoint\n");
}

// drizzle-kit's own output for a parent table with cascade children, then for a change that makes
// it rebuild the parent.
export async function rebuildMigrations(): Promise<[FixtureMigration, FixtureMigration]> {
  const { generateSQLiteDrizzleJson, generateSQLiteMigration } = await import("drizzle-kit/api");
  const parentV1 = sqliteTable("parent", { id: integer("id").primaryKey(), name: text("name") });
  const childV1 = sqliteTable("child", {
    id: integer("id").primaryKey(),
    parentId: integer("parent_id").references(() => parentV1.id, { onDelete: "cascade" }),
  });
  const parentV2 = sqliteTable("parent", {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
  });
  const childV2 = sqliteTable("child", {
    id: integer("id").primaryKey(),
    parentId: integer("parent_id").references(() => parentV2.id, { onDelete: "cascade" }),
  });
  const empty = await generateSQLiteDrizzleJson({});
  const v1 = await generateSQLiteDrizzleJson({ parentV1, childV1 });
  const v2 = await generateSQLiteDrizzleJson({ parentV2, childV2 });
  return [
    {
      tag: "0000_parent_child",
      when: FIRST_MIGRATION.when,
      sql: migrationSql(await generateSQLiteMigration(empty, v1)),
    },
    {
      tag: "0001_rebuild_parent",
      when: SECOND_MIGRATION.when,
      sql: migrationSql(await generateSQLiteMigration(v1, v2)),
    },
  ];
}

export function writeMigrationsFolder(folder: string, migrations: FixtureMigration[]): string {
  mkdirSync(join(folder, "meta"), { recursive: true });
  for (const migration of migrations) {
    writeFileSync(join(folder, `${migration.tag}.sql`), migration.sql);
  }
  const entries = migrations.map((migration, idx) => ({
    idx,
    version: "6",
    when: migration.when,
    tag: migration.tag,
    breakpoints: true,
  }));
  writeFileSync(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "sqlite", entries }),
  );
  return folder;
}
