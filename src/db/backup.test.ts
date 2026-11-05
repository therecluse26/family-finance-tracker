import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkDatabaseCopy, copyDatabaseInto } from "./backup.ts";
import { closeDatabase, type Database, openDatabase } from "./client.ts";
import { newTestDatabase, type TestDatabase } from "./testing.ts";

// The statements a backup runs (spec 11, How the app makes a backup): VACUUM INTO while the app
// keeps running, and the integrity check on the copy.

describe("copying app.db for a backup", () => {
  let test: TestDatabase;
  let dir: string;
  let other: Database;

  beforeEach(async () => {
    test = await newTestDatabase();
    dir = mkdtempSync(join(tmpdir(), "fft-copy-"));
    other = await openDatabase(`file:${test.path}`);
    await test.database.$client.execute(
      "CREATE TABLE probe (id integer PRIMARY KEY, label text NOT NULL)",
    );
  });

  afterEach(() => {
    closeDatabase(other);
    test.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function labelsIn(path: string): Promise<string[]> {
    const copy = createClient({ url: `file:${path}` });
    try {
      const result = await copy.execute("SELECT label FROM probe ORDER BY id");
      return result.rows.map((row) => String(row[0]));
    } finally {
      copy.close();
    }
  }

  it("keeps every committed row, and no uncommitted one, while another connection holds an open write", async () => {
    for (const label of ["first", "second", "third"]) {
      await test.database.$client.execute({
        sql: "INSERT INTO probe (label) VALUES (?)",
        args: [label],
      });
    }
    // A committed row from the other connection, still in the WAL file.
    await other.$client.execute("INSERT INTO probe (label) VALUES ('committed elsewhere')");
    expect(existsSync(`${test.path}-wal`)).toBe(true);
    const open = await other.$client.transaction("write");
    try {
      await open.execute("INSERT INTO probe (label) VALUES ('not committed')");
      const copy = join(dir, "copy.db");

      await copyDatabaseInto(test.database, copy);

      expect(await labelsIn(copy)).toEqual(["first", "second", "third", "committed elsewhere"]);
      expect(await checkDatabaseCopy(copy)).toBe(true);
    } finally {
      await open.rollback();
      open.close();
    }
  });

  it("refuses to copy over a file that already exists", async () => {
    const copy = join(dir, "copy.db");
    writeFileSync(copy, "already here");

    await expect(copyDatabaseInto(test.database, copy)).rejects.toThrow();
    expect(readFileSync(copy, "utf8")).toBe("already here");
  });

  it("fails the check on a damaged copy, and on a file that is not a database", async () => {
    await test.database.$client.execute("INSERT INTO probe (label) VALUES ('row')");
    const copy = join(dir, "copy.db");
    await copyDatabaseInto(test.database, copy);
    const bytes = readFileSync(copy);
    // Overwrite the second page onward, past the header, so SQLite can open the file but its
    // tables are damaged.
    bytes.fill(0x5a, 4096, Math.min(bytes.length, 4096 * 4));
    writeFileSync(copy, bytes);
    const notDatabase = join(dir, "not-a-database.db");
    writeFileSync(notDatabase, "x".repeat(8192));

    expect(await checkDatabaseCopy(copy)).toBe(false);
    expect(await checkDatabaseCopy(notDatabase)).toBe(false);
  });

  it("fails the check on a missing file, and creates none", async () => {
    const missing = join(dir, "missing.db");

    expect(await checkDatabaseCopy(missing)).toBe(false);
    expect(existsSync(missing)).toBe(false);
  });
});
