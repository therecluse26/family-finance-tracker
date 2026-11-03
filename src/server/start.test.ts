import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  checkMigrations,
  closeDatabase,
  NewerDatabaseError,
  openDatabase,
  readDataKeys,
  SkippedMigrationError,
} from "../db/index.ts";
import {
  appMigrations,
  changedSettings,
  FIRST_MIGRATION,
  type FixtureMigration,
  MIDDLE_MIGRATION,
  readEverySetting,
  readPlainSettings,
  readSettings,
  SECOND_MIGRATION,
  writeMigrationsFolder,
} from "../db/testing.ts";
import { createLogger } from "../log.ts";
import { type MasterKey, WrongMasterKeyError } from "../secrets/index.ts";
import { newMasterKey } from "../secrets/testing.ts";
import { loadSecurity, type Security } from "./security-mode.ts";
import { type RunningApp, startApp } from "./start.ts";

// The app's own migrations, which come before the fixtures in every test folder.
const APP = appMigrations().length;

describe("starting the app", () => {
  let dir: string;
  let path: string;
  let url: string;
  let webRoot: string;
  let running: RunningApp[];
  let security: Security;
  let masterKey: MasterKey;

  beforeAll(async () => {
    security = await loadSecurity(
      { APP_URL: "https://money.example.com", TRUSTED_PROXIES: "127.0.0.1" },
      { logger: createLogger(() => {}, { throwOnSecretField: true }) },
    );
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fft-start-"));
    path = join(dir, "app.db");
    url = `file:${path}`;
    webRoot = join(dir, "web");
    mkdirSync(webRoot);
    writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
    running = [];
    masterKey = newMasterKey().masterKey;
  });

  afterEach(async () => {
    await Promise.all(running.map((app) => app.close()));
    rmSync(dir, { recursive: true, force: true });
  });

  const folder = (name: string, migrations: FixtureMigration[]) =>
    writeMigrationsFolder(join(dir, name), [...appMigrations(), ...migrations]);
  const v1 = () => folder("v1", [FIRST_MIGRATION]);
  const v2 = () => folder("v2", [FIRST_MIGRATION, SECOND_MIGRATION]);

  async function start(migrationsFolder: string, port = 0, key = masterKey): Promise<RunningApp> {
    const app = await startApp({
      masterKey: key,
      databaseUrl: url,
      migrationsFolder,
      port,
      webRoot,
      security,
    });
    running.push(app);
    return app;
  }

  async function stop(app: RunningApp): Promise<void> {
    running.splice(running.indexOf(app), 1);
    await app.close();
  }

  async function migrateFile(migrationsFolder: string): Promise<void> {
    const database = await openDatabase(url);
    try {
      await applyMigrations(database, migrationsFolder);
    } finally {
      closeDatabase(database);
    }
  }

  function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const address = probe.address();
        probe.close(() =>
          typeof address === "object" && address ? resolve(address.port) : reject(address),
        );
      });
    });
  }

  // What a start could change in app.db: its data keys and its migrations.
  async function readFileState() {
    const database = await openDatabase(url);
    try {
      return {
        dataKeys: await readDataKeys(database),
        migrations: await checkMigrations(database, v2()),
      };
    } finally {
      closeDatabase(database);
    }
  }

  it("creates app.db on a fresh start and applies the migrations, then answers /healthz", async () => {
    expect(existsSync(path)).toBe(false);

    const app = await start(v2());

    expect(existsSync(path)).toBe(true);
    expect(await checkMigrations(app.database, v2())).toEqual({
      applied: APP + 2,
      pending: 0,
      newer: 0,
      skipped: 0,
    });
    const res = await fetch(`http://127.0.0.1:${app.port}/healthz`);
    expect(res.status).toBe(200);
  });

  it("applies no migration on a second start", async () => {
    await stop(await start(v2()));

    const app = await start(v2());

    expect((await checkMigrations(app.database, v2())).applied).toBe(APP + 2);
  });

  it("applies only the new migrations after an update", async () => {
    await stop(await start(v1()));

    const app = await start(v2());

    expect(await checkMigrations(app.database, v2())).toMatchObject({
      applied: APP + 2,
      pending: 0,
    });
    expect((await checkMigrations(app.database, v1())).newer).toBe(1);
  });

  it.each([
    ["a database from a newer version", v2, v1, NewerDatabaseError],
    [
      "a database that would skip a migration",
      v2,
      () => folder("next", [FIRST_MIGRATION, MIDDLE_MIGRATION, SECOND_MIGRATION]),
      SkippedMigrationError,
    ],
  ])("refuses to start on %s, and never listens", async (_kind, written, shipped, error) => {
    await migrateFile(written());
    const port = await freePort();

    await expect(start(shipped(), port)).rejects.toThrow(error);
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
    const database = await openDatabase(url);
    expect((await checkMigrations(database, written())).applied).toBe(APP + 2);
    closeDatabase(database);
  });

  it("makes one data key at the first start, and decrypts with it after a restart", async () => {
    const first = await start(v1());
    const stored = await readDataKeys(first.database);
    const place = { rowId: 1, column: "settings.smtp_password" };
    const ciphertext = first.secrets.encrypt("household-smtp-value", place);
    await stop(first);

    const again = await start(v1());

    expect(stored).toHaveLength(1);
    expect(await readDataKeys(again.database)).toEqual(stored);
    expect(again.secrets.decrypt(ciphertext, place)).toBe("household-smtp-value");
  });

  it("refuses to start with a Master key that cannot decrypt the data key, changes nothing, and never listens", async () => {
    await stop(await start(v1()));
    const before = await readFileState();
    const port = await freePort();

    await expect(start(v2(), port, newMasterKey().masterKey)).rejects.toThrow(WrongMasterKeyError);

    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
    expect(await readFileState()).toEqual(before);
    expect(before.migrations.pending).toBe(1);
  });

  it("opens app.db with the spec's settings on every connection", async () => {
    const app = await start(v1());
    // WAL mode and the busy timeout come from the spec's startup steps. Foreign keys stay on, which
    // the spec's rule on migrations relies on. The spec sets no synchronous level, so it stays at
    // SQLite's default, 2 (FULL).
    const spec = { journal_mode: "wal", foreign_keys: 1, synchronous: 2, busy_timeout: 5000 };

    expect(await readSettings(app.database)).toEqual(spec);
    // A transaction holds one connection, so the driver opens another for this read.
    await app.database.transaction(async () => {
      expect(await readSettings(app.database)).toEqual(spec);
    });
  });

  it("changes no other setting from a plain libSQL connection's, on every connection", async () => {
    const app = await start(v1());
    // The only settings the app changes, each with its value.
    const changes = { journal_mode: "wal", busy_timeout: 5000 };
    // SQLite gives these settings no table-valued function, so no query can read them.
    const unreadable = [
      "case_sensitive_like",
      "incremental_vacuum",
      "mmap_size",
      "shrink_memory",
      "temp_store_directory",
      "wal_autocheckpoint",
      "wal_checkpoint",
    ];

    const expected = await readPlainSettings(`file:${join(dir, "plain.db")}`);
    expect(expected.unreadable).toEqual(unreadable);
    expect(Object.keys(expected.values).length).toBeGreaterThan(30);

    const compare = async () => {
      const actual = await readEverySetting(app.database.$client);
      expect(changedSettings(expected.values, actual.values)).toEqual(changes);
      expect(actual.unreadable).toEqual(unreadable);
    };
    await compare();
    // A transaction holds one connection, so the driver opens another for this read.
    await app.database.transaction(compare);
  });

  it("turns on WAL mode in app.db", async () => {
    await start(v1());

    // Bytes 18 and 19 of an SQLite file are 2 in WAL mode and 1 in rollback-journal mode.
    expect([...readFileSync(path).subarray(18, 20)]).toEqual([2, 2]);
    expect(existsSync(`${path}-wal`)).toBe(true);
  });
});
