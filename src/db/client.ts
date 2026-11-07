import { AsyncLocalStorage } from "node:async_hooks";
import { chmod } from "node:fs/promises";
import {
  type Client,
  createClient,
  type InArgs,
  type InStatement,
  LibsqlError,
  type ResultSet,
  type Transaction,
  type TransactionMode,
} from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { log } from "../log.ts";
import * as schema from "./schema.ts";

export const APP_DB_URL = "file:/data/app.db";

const BUSY_TIMEOUT_MS = 5000;

// The longest one write may hold app.db's write queue. On 5 years of history (`pnpm bench:history`)
// on a desktop, Delete history holds it about 1 s and the longest transaction about 4.5 s. A NAS or
// a Raspberry Pi may be ten times slower. The limit fires only when a transaction yields to the
// event loop, such as on a timer or I/O. SQLite's statements run synchronously, so the limit never
// cuts a statement, such as a backup's VACUUM INTO, or a transaction that only runs statements.
const WRITE_LIMIT_MS = 60_000;

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
// SQLite opened. False for an in-memory database, which has no file.
async function makeOwnerOnly(client: Client): Promise<boolean> {
  const result = await client.execute("SELECT file FROM pragma_database_list WHERE name = 'main'");
  const file = String(result.rows[0]?.[0] ?? "");
  if (file === "") return false;
  await makeFilesOwnerOnly(sqliteFiles(file));
  return true;
}

export type DatabaseOptions = {
  // Tests set shorter ones.
  busyTimeoutMs?: number;
  writeLimitMs?: number;
};

// The driver setup, and the only code that changes an SQLite setting: WAL mode, which is kept in the
// file itself. The driver applies the busy timeout to every connection it opens.
export async function openDatabase(url: string, options: DatabaseOptions = {}): Promise<Database> {
  const timeout = options.busyTimeoutMs ?? BUSY_TIMEOUT_MS;
  const client = createClient({ url, timeout, concurrency: 1 });
  let reader = client;
  try {
    await client.execute("PRAGMA journal_mode = WAL");
    // An in-memory database lives on its one connection, so it reads there too.
    if (await makeOwnerOnly(client)) reader = createClient({ url, timeout });
  } catch (error) {
    client.close();
    throw error;
  }
  const writes = writeQueue(client, reader, options.writeLimitMs ?? WRITE_LIMIT_MS);
  const database = drizzle(writes.client, { schema });
  // A write on `database` inside a transaction's callback would wait for that transaction, so the
  // callback runs marked as inside its turn, and such a write fails at once. That holds for a write
  // the callback starts without awaiting it, if it runs while the transaction is open; once the
  // transaction ends, it waits its turn as usual.
  const transaction = database.transaction.bind(database);
  database.transaction = ((work, config) =>
    transaction((tx) => writes.inside(() => work(tx)), config)) as typeof database.transaction;
  return database;
}

// One write at a time on app.db. SQLite takes one write transaction at a time: a second one waits
// out the busy timeout, then fails with SQLITE_BUSY. The app is one Node process (ADR 0002), so one
// queue here orders every write it makes, Better Auth's too, and no caller needs its own:
// - Each transaction, and each plain insert, update or delete, waits its turn, in order, and runs
//   on the one write connection.
// - A read runs at once on a read connection. WAL mode lets it run beside the one writer.
// - A turn that runs past the time limit is rolled back. Its later statements fail, and the next
//   write goes on.
// - SQLITE_BUSY can still come from another process, such as an `fft` command. A statement that
//   fails with it can leave its connection broken, so the write connection is replaced before the
//   next turn.
type Turn = {
  // Gives the queue to the next write. Each turn ends once.
  end(): void;
  // True once the turn ran past the time limit.
  expired: boolean;
  // True once one of its statements found app.db locked.
  busy: boolean;
  // Rolls back the turn's transaction, when it has one.
  rollBack?: () => void;
};

type WriteQueue = {
  client: Client;
  // Runs a transaction's callback marked as inside the turn that holds the queue.
  inside<T>(work: () => T): T;
};

// SQL that only reads: a SELECT, or a WITH that names no write. Anything else waits its turn. So a
// few reads count as writes: a settings statement, EXPLAIN, a comment or ( before the SELECT, and a
// WITH that calls replace(). Inside a transaction's callback each fails like a write on
// `database`: run it through the transaction, or read a setting with its table-valued function.
const READ = /^\s*(?:select\b|with\b(?![\s\S]*\b(?:insert|update|delete|replace)\b))/i;

const isBusy = (error: unknown) =>
  error instanceof LibsqlError &&
  (error.code === "SQLITE_BUSY" || error.message.includes("statements in progress"));

function writeQueue(writer: Client, reader: Client, limitMs: number): WriteQueue {
  const turns = new AsyncLocalStorage<Turn>();
  let last: Promise<void> = Promise.resolve();
  let current: Turn | undefined;

  // Closes the write connection, even one a transaction holds, and opens a new one for the next
  // turn. An in-memory database lives on its one connection, so it keeps it.
  const replaceWriter = () => {
    if (reader !== writer) writer.reconnect();
  };

  // Waits for the queue. The place in line is taken in the same step as the check.
  async function take(): Promise<Turn> {
    if (current !== undefined && turns.getStore() === current) {
      throw new Error(
        "A write on the database inside its own transaction would wait for that transaction. Write through the transaction instead.",
      );
    }
    const before = last;
    let free = () => {};
    last = new Promise((resolve) => {
      free = resolve;
    });
    await before;
    let ended = false;
    const turn: Turn = {
      expired: false,
      busy: false,
      end() {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        if (current === turn) current = undefined;
        try {
          if (turn.busy) {
            log.warn("Another process held app.db, so the write connection is replaced");
            replaceWriter();
          }
        } finally {
          free();
        }
      },
    };
    const timer = setTimeout(() => {
      turn.expired = true;
      log.warn("A write held app.db past its time limit and was rolled back", { limitMs });
      try {
        turn.rollBack?.();
      } catch {
        // The driver gives the connection back even when its rollback throws, and drops it when
        // it is broken. The turn ends either way.
      } finally {
        turn.end();
      }
    }, limitMs);
    timer.unref();
    current = turn;
    return turn;
  }

  // Runs one step of the turn, and notes a lock.
  async function run<T>(turn: Turn, work: () => Promise<T>): Promise<T> {
    if (turn.expired) {
      throw new Error("The write ran past its time limit on app.db and was rolled back.");
    }
    try {
      return await work();
    } catch (error) {
      if (isBusy(error)) turn.busy = true;
      throw error;
    }
  }

  async function write<T>(work: () => Promise<T>): Promise<T> {
    const turn = await take();
    try {
      return await run(turn, work);
    } finally {
      turn.end();
    }
  }

  // The turn ends when the transaction commits, rolls back, or closes.
  function transactionIn(turn: Turn, tx: Transaction): Transaction {
    turn.rollBack = () => tx.close();
    if (turn.expired) tx.close();
    return {
      execute: (stmt) => run(turn, () => tx.execute(stmt)),
      batch: (stmts) => run(turn, () => tx.batch(stmts)),
      executeMultiple: (sql) => run(turn, () => tx.executeMultiple(sql)),
      async commit() {
        try {
          await run(turn, () => tx.commit());
        } finally {
          turn.end();
        }
      },
      // Each does nothing more on a transaction the time limit already rolled back.
      async rollback() {
        try {
          await tx.rollback();
        } finally {
          turn.end();
        }
      },
      close() {
        try {
          tx.close();
        } finally {
          turn.end();
        }
      },
      get closed() {
        return turn.expired || tx.closed;
      },
    };
  }

  const client: Client = {
    execute: ((stmt: InStatement | string, args?: InArgs) => {
      const statement = typeof stmt === "string" ? { sql: stmt, args: args ?? [] } : stmt;
      if (READ.test(statement.sql)) return reader.execute(statement);
      return write(() => writer.execute(statement));
    }) as Client["execute"],
    batch: (stmts, mode) => write(() => writer.batch(stmts, mode)),
    migrate: (stmts) => write(() => writer.migrate(stmts)),
    executeMultiple: (sql) => write(() => writer.executeMultiple(sql)),
    async transaction(mode?: TransactionMode) {
      const turn = await take();
      try {
        return transactionIn(turn, await run(turn, () => writer.transaction(mode)));
      } catch (error) {
        turn.end();
        throw error;
      }
    },
    sync: () => writer.sync(),
    close() {
      writer.close();
      if (reader !== writer) reader.close();
    },
    reconnect() {
      writer.reconnect();
      if (reader !== writer) reader.reconnect();
    },
    get closed() {
      return writer.closed;
    },
    protocol: writer.protocol,
  };
  return { client, inside: (work) => (current === undefined ? work() : turns.run(current, work)) };
}

// A copy of app.db that no app uses, such as a backup that `fft restore` checks and changes before
// it puts it in place. It changes no setting, so the copy keeps its journal mode, as VACUUM INTO
// wrote it, and leaves no write-ahead log beside it to move with it. It needs no write queue: one
// command writes it alone. Sidequest's jobs.db has its own driver and needs none either.
export function openDatabaseCopy(path: string): Database {
  return drizzle(createClient({ url: `file:${path}`, timeout: BUSY_TIMEOUT_MS }), { schema });
}

export function closeDatabase(database: Database): void {
  database.$client.close();
}
