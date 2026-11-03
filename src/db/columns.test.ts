import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { getTableConfig, integer, sqliteTable } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, type Database, openDatabase } from "./client.ts";
import { calendarDate, cents, moment } from "./columns.ts";

const example = sqliteTable("example", {
  id: integer("id").primaryKey(),
  amount: cents("amount"),
  postedOn: calendarDate("posted_on"),
  at: moment("at"),
});

type Row = typeof example.$inferInsert;

const ROW = {
  id: 1,
  amount: -1234,
  postedOn: "2024-02-29",
  at: new Date("2026-11-03T09:05:09-05:00"),
} satisfies Row;

describe("the column helpers", () => {
  let dir: string;
  let database: Database;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "fft-columns-"));
    database = await openDatabase(`file:${join(dir, "app.db")}`);
    await database.run(
      sql`CREATE TABLE example (id integer PRIMARY KEY, amount integer, posted_on text, at text)`,
    );
  });

  afterEach(() => {
    closeDatabase(database);
    rmSync(dir, { recursive: true, force: true });
  });

  async function insert(row: Row): Promise<void> {
    await database.insert(example).values(row);
  }

  it("declare integer cents, and text for calendar dates and moments", () => {
    const columns = getTableConfig(example).columns.map((c) => [c.name, c.getSQLType()]);

    expect(columns).toEqual([
      ["id", "integer"],
      ["amount", "integer"],
      ["posted_on", "text"],
      ["at", "text"],
    ]);
  });

  it("store cents as an integer, a date as YYYY-MM-DD, and a moment in UTC", async () => {
    await insert(ROW);

    const stored = await database.get(
      sql`SELECT amount, typeof(amount) AS amount_type, posted_on, typeof(posted_on) AS posted_on_type, at FROM example`,
    );
    expect(stored).toEqual({
      amount: -1234,
      amount_type: "integer",
      posted_on: "2024-02-29",
      posted_on_type: "text",
      at: "2026-11-03T14:05:09.000Z",
    });
    expect(await database.select().from(example)).toEqual([ROW]);
  });

  it.each([12.34, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "refuse an amount of %s",
    async (amount) => {
      await expect(insert({ ...ROW, amount })).rejects.toThrow("An amount must be whole cents");
    },
  );

  it.each([
    "2026-2-28",
    "2026-02-30",
    "2025-02-29",
    "2026-13-01",
    "02/28/2026",
    "2026-02-28T00:00Z",
  ])("refuse the calendar date %s", async (postedOn) => {
    await expect(insert({ ...ROW, postedOn })).rejects.toThrow(
      "A calendar date must be a real date written YYYY-MM-DD",
    );
  });

  it("refuse an invalid moment", async () => {
    await expect(insert({ ...ROW, at: new Date(Number.NaN) })).rejects.toThrow(
      "A moment must be a valid Date.",
    );
  });

  it("refuse to read a moment stored without its UTC zone", async () => {
    await database.run(sql`INSERT INTO example (id, at) VALUES (2, '2026-11-03 14:05:09')`);

    await expect(database.select().from(example)).rejects.toThrow("is not a moment in UTC");
  });
});
