import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, type Database, openDatabase } from "./client.ts";
import {
  appliedMigrations,
  applyMigrations,
  checkMigrations,
  NewerDatabaseError,
  SkippedMigrationError,
} from "./migrate.ts";
import {
  FIRST_MIGRATION,
  type FixtureMigration,
  MIDDLE_MIGRATION,
  rebuildMigrations,
  SECOND_MIGRATION,
  writeMigrationsFolder,
} from "./testing.ts";

const SHIPPED_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

const LATER_MIGRATION: FixtureMigration = {
  tag: "0002_later",
  when: SECOND_MIGRATION.when + 100_000,
  sql: "CREATE TABLE `later` (`id` integer PRIMARY KEY NOT NULL);",
};

const EDITED_FIRST_MIGRATION: FixtureMigration = {
  ...FIRST_MIGRATION,
  sql: "CREATE TABLE `edited` (`id` integer PRIMARY KEY NOT NULL);",
};

describe("the database", () => {
  let dir: string;
  let path: string;
  let opened: Database[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fft-db-"));
    path = join(dir, "app.db");
    opened = [];
  });

  afterEach(() => {
    for (const database of opened) closeDatabase(database);
    rmSync(dir, { recursive: true, force: true });
  });

  async function open(): Promise<Database> {
    const database = await openDatabase(`file:${path}`);
    opened.push(database);
    return database;
  }

  function folder(name: string, migrations: FixtureMigration[]): string {
    return writeMigrationsFolder(join(dir, name), migrations);
  }

  async function tables(database: Database): Promise<string[]> {
    const rows = await database.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name <> '__drizzle_migrations' ORDER BY name`,
    );
    return rows.map((row) => row.name);
  }

  it("creates the file when it is missing", async () => {
    expect(existsSync(path)).toBe(false);

    await open();

    expect(existsSync(path)).toBe(true);
  });

  it("turns on WAL mode and a busy timeout of 5000 ms on every connection", async () => {
    const database = await open();

    expect(await database.get(sql`SELECT * FROM pragma_journal_mode()`)).toEqual({
      journal_mode: "wal",
    });
    expect(await database.get(sql`SELECT * FROM pragma_busy_timeout()`)).toEqual({ timeout: 5000 });
    // A transaction holds one connection, so the driver opens another for this read.
    await database.transaction(async () => {
      expect(await database.get(sql`SELECT * FROM pragma_busy_timeout()`)).toEqual({
        timeout: 5000,
      });
    });
  });

  // No code sets foreign_keys, so the app relies on the driver's default.
  it("has foreign keys on for every connection", async () => {
    const database = await open();

    expect(await database.get(sql`SELECT * FROM pragma_foreign_keys()`)).toEqual({
      foreign_keys: 1,
    });
    await database.transaction(async () => {
      expect(await database.get(sql`SELECT * FROM pragma_foreign_keys()`)).toEqual({
        foreign_keys: 1,
      });
    });
  });

  it("applies every migration to a new database, and none on the next run", async () => {
    const database = await open();
    const v2 = folder("v2", [FIRST_MIGRATION, SECOND_MIGRATION]);

    expect(await applyMigrations(database, v2)).toBe(2);
    expect(await tables(database)).toEqual(["first", "second"]);
    const applied = await appliedMigrations(database);
    expect(applied.map((migration) => migration.createdAt)).toEqual([
      FIRST_MIGRATION.when,
      SECOND_MIGRATION.when,
    ]);

    expect(await applyMigrations(database, v2)).toBe(0);
    expect(await appliedMigrations(database)).toEqual(applied);
  });

  it("applies only the pending migrations", async () => {
    const database = await open();
    await applyMigrations(database, folder("v1", [FIRST_MIGRATION]));

    const v2 = folder("v2", [FIRST_MIGRATION, SECOND_MIGRATION]);

    expect(await applyMigrations(database, v2)).toBe(1);
    expect(await tables(database)).toEqual(["first", "second"]);
  });

  it("reports applied, pending, newer, and skipped migrations without changing app.db", async () => {
    const database = await open();
    const v2 = folder("v2", [FIRST_MIGRATION, SECOND_MIGRATION]);

    expect(await checkMigrations(database, v2)).toEqual({
      applied: 0,
      pending: 2,
      newer: 0,
      skipped: 0,
    });
    expect(await tables(database)).toEqual([]);

    await applyMigrations(database, folder("v1", [FIRST_MIGRATION, LATER_MIGRATION]));

    expect(await checkMigrations(database, v2)).toEqual({
      applied: 2,
      pending: 0,
      newer: 1,
      skipped: 1,
    });
  });

  it.each<[string, FixtureMigration[], string]>([
    [
      "a migration from a newer version",
      [FIRST_MIGRATION, SECOND_MIGRATION, LATER_MIGRATION],
      "a migration",
    ],
    [
      "a newer migration in place of a pending one",
      [FIRST_MIGRATION, LATER_MIGRATION],
      "a migration",
    ],
    ["an edited migration", [EDITED_FIRST_MIGRATION, LATER_MIGRATION], "2 migrations"],
  ])("refuses, unchanged, a database that holds %s", async (_kind, newer, count) => {
    const database = await open();
    await applyMigrations(database, folder("newer", newer));
    const migrationsBefore = await appliedMigrations(database);
    const tablesBefore = await tables(database);

    const result = applyMigrations(database, folder("v2", [FIRST_MIGRATION, SECOND_MIGRATION]));

    await expect(result).rejects.toThrow(NewerDatabaseError);
    await expect(result).rejects.toThrow(
      `app.db holds ${count} that this version of the app does not have, so a newer version wrote it.`,
    );
    expect(await appliedMigrations(database)).toEqual(migrationsBefore);
    expect(await tables(database)).toEqual(tablesBefore);
  });

  it("refuses, unchanged, to skip a shipped migration older than the newest one applied", async () => {
    const database = await open();
    await applyMigrations(database, folder("released", [FIRST_MIGRATION, SECOND_MIGRATION]));
    const migrationsBefore = await appliedMigrations(database);

    const result = applyMigrations(
      database,
      folder("next", [FIRST_MIGRATION, MIDDLE_MIGRATION, SECOND_MIGRATION]),
    );

    await expect(result).rejects.toThrow(SkippedMigrationError);
    await expect(result).rejects.toThrow(
      "app.db lacks a migration that this version ships, but holds a later one, so the migrator " +
        "would skip it. This version's migrations are out of order. app.db is unchanged.",
    );
    expect(await appliedMigrations(database)).toEqual(migrationsBefore);
    expect(await tables(database)).toEqual(["first", "second"]);
  });

  // The source search test checks that this output holds drizzle-kit's foreign-key bracket.
  it("keeps child rows and foreign keys through a table rebuild from drizzle-kit", async () => {
    const [create, rebuild] = await rebuildMigrations();
    expect(rebuild.sql).toContain("DROP TABLE `parent`;");
    const database = await open();
    await applyMigrations(database, folder("v1", [create]));
    await database.run(sql`INSERT INTO parent (id, name) VALUES (1, 'a'), (2, 'b')`);
    await database.run(sql`INSERT INTO child (id, parent_id) VALUES (10, 1), (11, 1), (20, 2)`);

    expect(await applyMigrations(database, folder("v2", [create, rebuild]))).toBe(1);

    expect(await database.all(sql`SELECT id, parent_id FROM child ORDER BY id`)).toEqual([
      { id: 10, parent_id: 1 },
      { id: 11, parent_id: 1 },
      { id: 20, parent_id: 2 },
    ]);
    expect(await database.get(sql`SELECT * FROM pragma_foreign_keys()`)).toEqual({
      foreign_keys: 1,
    });
    await database.transaction(async () => {
      expect(await database.get(sql`SELECT * FROM pragma_foreign_keys()`)).toEqual({
        foreign_keys: 1,
      });
    });
    await expect(
      database.run(sql`INSERT INTO child (id, parent_id) VALUES (30, 99)`),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("FOREIGN KEY constraint failed"),
      }),
    });
    await database.run(sql`DELETE FROM parent WHERE id = 1`);
    expect(await database.all(sql`SELECT id FROM child`)).toEqual([{ id: 20 }]);
  });

  it("applies the shipped migrations in drizzle/ to a new database", async () => {
    const journal = JSON.parse(readFileSync(join(SHIPPED_FOLDER, "meta", "_journal.json"), "utf8"));
    const database = await open();

    expect(await applyMigrations(database, SHIPPED_FOLDER)).toBe(journal.entries.length);
    expect(await appliedMigrations(database)).toHaveLength(journal.entries.length);
    expect(await applyMigrations(database, SHIPPED_FOLDER)).toBe(0);
  });
});
