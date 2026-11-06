import { setTimeout as sleep } from "node:timers/promises";
import { type Client, createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../log.ts";
import type { Database, DatabaseOptions } from "./client.ts";
import { newTestDatabase, type TestDatabase } from "./testing.ts";

// app.db's one write queue: every write through the Database waits its turn, a read never does, and
// a turn has a time limit. Each test fires its writes together, as two Members or the AI SDK's
// tools would.

const probe = sqliteTable("probe", {
  id: integer().primaryKey(),
  label: text().notNull(),
});

// SQLite's own wait, kept short so a write that would wait out the busy timeout fails fast.
const BUSY_TIMEOUT_MS = 100;
const WRITE_LIMIT_MS = 300;

const LIMIT_LINE = "A write held app.db past its time limit and was rolled back";
const OWN_TRANSACTION =
  "A write on the database inside its own transaction would wait for that transaction. Write through the transaction instead.";

// A promise that settles only when the test lets it.
function gate(): { wait: Promise<void>; open(): void } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

const NEVER = new Promise<never>(() => {});

describe("app.db's write queue", () => {
  let test: TestDatabase;
  let database: Database;
  let other: Client | undefined;

  async function open(options: DatabaseOptions = {}) {
    test = await newTestDatabase({
      busyTimeoutMs: BUSY_TIMEOUT_MS,
      writeLimitMs: WRITE_LIMIT_MS,
      ...options,
    });
    database = test.database;
    await database.$client.execute(
      "CREATE TABLE probe (id integer PRIMARY KEY, label text NOT NULL)",
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
    other?.close();
    other = undefined;
    test.close();
  });

  const labels = async () =>
    (await database.select().from(probe).orderBy(probe.id)).map((row) => row.label);

  it("runs 15 transactions fired together one at a time, in order, and each succeeds", async () => {
    await open();
    let holding = 0;
    let most = 0;

    const done = await Promise.all(
      Array.from({ length: 15 }, (_, each) =>
        database.transaction(async (tx) => {
          holding += 1;
          most = Math.max(most, holding);
          const before = await tx.select().from(probe);
          // A wait between the read and the write, as a real write's checks make.
          await sleep(5);
          await tx.insert(probe).values({ id: before.length, label: `write ${each}` });
          holding -= 1;
          return each;
        }),
      ),
    );

    expect(done).toEqual(Array.from({ length: 15 }, (_, each) => each));
    expect(most).toBe(1);
    expect(await labels()).toEqual(Array.from({ length: 15 }, (_, each) => `write ${each}`));
  });

  it("runs plain writes, with and without returning, fired together behind a held transaction", async () => {
    await open();
    await database.insert(probe).values({ id: 1, label: "first" });
    const held = gate();
    const transaction = database.transaction(async (tx) => {
      await tx.insert(probe).values({ id: 2, label: "in a transaction" });
      await held.wait;
    });

    const writes = Promise.all([
      database.update(probe).set({ label: "changed" }).where(eq(probe.id, 1)).returning(),
      database.insert(probe).values({ id: 3, label: "third" }).returning(),
      database.insert(probe).values({ id: 4, label: "fourth" }),
      database.delete(probe).where(eq(probe.id, 4)).returning(),
    ]);
    // Longer than SQLite's busy timeout: a write that went around the queue would fail by now.
    await sleep(BUSY_TIMEOUT_MS * 2);
    held.open();

    await transaction;
    expect(await writes).toMatchObject([
      [{ id: 1, label: "changed" }],
      [{ id: 3, label: "third" }],
      { rowsAffected: 1 },
      [{ id: 4, label: "fourth" }],
    ]);
    expect(await labels()).toEqual(["changed", "in a transaction", "third"]);
  });

  it("answers a read at once while a write transaction holds the queue", async () => {
    await open();
    await database.insert(probe).values({ id: 1, label: "committed" });
    const held = gate();
    const written = gate();
    let holding = true;
    const transaction = database.transaction(async (tx) => {
      await tx.insert(probe).values({ id: 2, label: "not yet committed" });
      written.open();
      await held.wait;
      holding = false;
    });
    await written.wait;

    const read = await labels();

    expect(holding).toBe(true);
    expect(read).toEqual(["committed"]);
    held.open();
    await transaction;
    expect(await labels()).toEqual(["committed", "not yet committed"]);
  });

  it("fails at once a write on the database inside its own transaction, and the transaction goes on", async () => {
    await open();

    await database.transaction(async (tx) => {
      await tx.insert(probe).values({ id: 1, label: "through the transaction" });
      await expect(
        database.insert(probe).values({ id: 2, label: "around it" }),
      ).rejects.toMatchObject({ cause: { message: OWN_TRANSACTION } });
      await expect(database.transaction(async () => {})).rejects.toThrow(OWN_TRANSACTION);
      // A read needs no turn.
      expect(await database.select().from(probe)).toEqual([]);
      await tx.insert(probe).values({ id: 3, label: "after it" });
    });

    expect(await labels()).toEqual(["through the transaction", "after it"]);
    await database.insert(probe).values({ id: 4, label: "later" });
    expect(await labels()).toEqual(["through the transaction", "after it", "later"]);
  });

  it("rolls back a transaction that never settles at the time limit, logs one line, and the writes behind it succeed", async () => {
    await open();
    const warn = vi.spyOn(log, "warn");
    const started = gate();
    void database.transaction(async (tx) => {
      await tx.insert(probe).values({ id: 1, label: "stuck" });
      started.open();
      await NEVER;
    });
    await started.wait;

    const writes = await Promise.all([
      database.insert(probe).values({ id: 2, label: "behind it" }).returning(),
      database.transaction((tx) => tx.insert(probe).values({ id: 3, label: "a transaction" })),
    ]);

    expect(writes[0]).toEqual([{ id: 2, label: "behind it" }]);
    expect(await labels()).toEqual(["behind it", "a transaction"]);
    expect(warn.mock.calls).toEqual([[LIMIT_LINE, { limitMs: WRITE_LIMIT_MS }]]);
  });

  it("fails each later statement of a transaction past its time limit, and keeps none of its writes", async () => {
    await open();
    const warn = vi.spyOn(log, "warn");
    const late = gate();
    const transaction = database.transaction(async (tx) => {
      await tx.insert(probe).values({ id: 1, label: "before the limit" });
      await late.wait;
      await tx.insert(probe).values({ id: 2, label: "after the limit" });
    });
    const outcome = transaction.then(
      () => "committed",
      (error: Error) => (error.cause as Error).message,
    );

    await sleep(WRITE_LIMIT_MS * 2);
    late.open();

    expect(await outcome).toBe("The write ran past its time limit on app.db and was rolled back.");
    await database.insert(probe).values({ id: 3, label: "next" });
    expect(await labels()).toEqual(["next"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual([LIMIT_LINE, { limitMs: WRITE_LIMIT_MS }]);
  });

  it("ends the turn when the rollback at the time limit throws, and the writes behind it succeed", async () => {
    await open();
    const warn = vi.spyOn(log, "warn");
    // The driver's transaction class, from a transaction on a plain client.
    other = createClient({ url: `file:${test.path}` });
    const plain = await other.transaction("read");
    const driverTransaction = Object.getPrototypeOf(plain) as { close(): void };
    plain.close();
    const close = driverTransaction.close;
    const started = gate();
    void database.transaction(async (tx) => {
      await tx.insert(probe).values({ id: 1, label: "stuck" });
      // As the driver does when its rollback fails: it gives the connection back, then throws.
      vi.spyOn(driverTransaction, "close").mockImplementationOnce(function (this: unknown) {
        close.call(this);
        throw new Error("The rollback failed.");
      });
      started.open();
      await NEVER;
    });
    await started.wait;

    expect(await database.insert(probe).values({ id: 2, label: "behind it" }).returning()).toEqual([
      { id: 2, label: "behind it" },
    ]);
    await database.transaction((tx) => tx.insert(probe).values({ id: 3, label: "a transaction" }));

    expect(await labels()).toEqual(["behind it", "a transaction"]);
    expect(warn.mock.calls).toEqual([[LIMIT_LINE, { limitMs: WRITE_LIMIT_MS }]]);
  });

  it("replaces the write connection after another process holds app.db past the busy timeout, so the next write works", async () => {
    await open();
    await database.insert(probe).values({ id: 1, label: "first" });
    const warn = vi.spyOn(log, "warn");
    // Another process, such as an `fft` command, holds the write lock.
    other = createClient({ url: `file:${test.path}` });
    const otherWrite = await other.transaction("write");
    await otherWrite.execute("INSERT INTO probe (id, label) VALUES (2, 'other process')");

    await expect(
      database.update(probe).set({ label: "locked out" }).where(eq(probe.id, 1)).returning(),
    ).rejects.toMatchObject({ cause: { code: "SQLITE_BUSY" } });
    await otherWrite.commit();

    expect(
      await database.update(probe).set({ label: "changed" }).where(eq(probe.id, 1)).returning(),
    ).toEqual([{ id: 1, label: "changed" }]);
    await database.transaction((tx) => tx.insert(probe).values({ id: 3, label: "third" }));
    expect(await labels()).toEqual(["changed", "other process", "third"]);
    expect(warn.mock.calls).toEqual([
      ["Another process held app.db, so the write connection is replaced"],
    ]);
  });
});
