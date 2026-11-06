import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../auth/index.ts";
import { addMember } from "../auth/testing.ts";
import { SafetyCopyError } from "../backups/index.ts";
import {
  applyMigrations,
  checkMigrations,
  closeDatabase,
  loginTables,
  markSetupStep,
  NewerDatabaseError,
  openDatabase,
  readDataKeys,
  SkippedMigrationError,
  scheduledTasks,
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
import { saveHouseholdFacts } from "../household/index.ts";
import { type ScheduledTask, startJob } from "../jobs/index.ts";
import {
  finishSlowJob,
  jobRuns,
  SampleJob,
  SlowJob,
  sampleTask,
  TEST_JOB_LIST,
  waitFor,
} from "../jobs/testing.ts";
import { createLogger } from "../log.ts";
import { type MasterKey, WrongMasterKeyError } from "../secrets/index.ts";
import { newMasterKey } from "../secrets/testing.ts";
import { LockHeldError, lockText } from "./running-lock.ts";
import { loadSecurity, type Security } from "./security-mode.ts";
import { type RunningApp, startApp } from "./start.ts";
import { fetchWithHost } from "./testing.ts";

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
    jobRuns.length = 0;
  });

  afterEach(async () => {
    finishSlowJob();
    vi.restoreAllMocks();
    await Promise.all(running.map((app) => app.close()));
    rmSync(dir, { recursive: true, force: true });
  });

  const folder = (name: string, migrations: FixtureMigration[]) =>
    writeMigrationsFolder(join(dir, name), [...appMigrations(), ...migrations]);
  const v1 = () => folder("v1", [FIRST_MIGRATION]);
  const v2 = () => folder("v2", [FIRST_MIGRATION, SECOND_MIGRATION]);
  const shipped = fileURLToPath(new URL("../../drizzle", import.meta.url));

  async function start(
    migrationsFolder: string,
    port = 0,
    key = masterKey,
    tasks: ScheduledTask[] = [],
    mode: Security = security,
  ): Promise<RunningApp> {
    const app = await startApp({
      masterKey: key,
      databaseUrl: url,
      migrationsFolder,
      jobs: { jobsDb: join(dir, "jobs.db"), jobList: TEST_JOB_LIST, tasks },
      port,
      webRoot,
      security: mode,
      backupFolders: { mounted: join(dir, "backups-mount"), fallback: join(dir, "backups") },
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

  // The backup folder the start uses, with no /backups mount, and the migration copies in it.
  const backupFolder = () => join(dir, "backups");
  const migrationCopies = () =>
    existsSync(backupFolder())
      ? readdirSync(backupFolder()).filter((name) => name.endsWith("-migration.db.gz"))
      : [];

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

  it("backs up app.db at the first start, into /data/backups with no /backups mount, and not again the same day", async () => {
    await stop(await start(v1()));
    const backups = join(dir, "backups");
    const [first, ...others] = readdirSync(backups);
    expect(others).toEqual([]);
    expect(first).toMatch(/^app-\d{8}T\d{6}Z-daily\.db\.gz$/);
    // A backup that stopped part way leaves its temporary files.
    const leftover = (first ?? "").replace(/\.gz$/, ".tmp");
    writeFileSync(join(backups, leftover), "partial copy");

    // The startup check runs once the app listens, and the stop waits for it.
    await stop(await start(v1()));

    expect(readdirSync(backups)).toEqual([first]);
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
    // One shipped migration is pending, and app.db holds one this version does not have.
    [
      "a database from a newer version, with a migration pending",
      () => folder("other", [FIRST_MIGRATION, MIDDLE_MIGRATION]),
      v2,
      NewerDatabaseError,
    ],
  ])(
    "refuses to start on %s, takes no safety copy, and never listens",
    async (_kind, written, shipped, error) => {
      await migrateFile(written());
      const port = await freePort();

      await expect(start(shipped(), port)).rejects.toThrow(error);
      await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
      expect(migrationCopies()).toEqual([]);
      const database = await openDatabase(url);
      expect((await checkMigrations(database, written())).applied).toBe(APP + 2);
      closeDatabase(database);
    },
  );

  describe("the migration safety copy", () => {
    // The migrations a migration copy holds, read from the gunzipped copy.
    async function migrationsIn(name: string) {
      const plain = join(dir, `${name}.plain`);
      writeFileSync(plain, gunzipSync(readFileSync(join(backupFolder(), name))));
      const copy = await openDatabase(`file:${plain}`);
      try {
        return await checkMigrations(copy, v2());
      } finally {
        closeDatabase(copy);
      }
    }

    it("takes one copy before it migrates when an update brings a pending migration", async () => {
      await stop(await start(v1()));

      const app = await start(v2());

      const [copy, ...others] = migrationCopies();
      expect(others).toEqual([]);
      expect(copy).toMatch(/^app-\d{8}T\d{6}Z-migration\.db\.gz$/);
      expect(await migrationsIn(copy ?? "")).toMatchObject({ applied: APP + 1, pending: 1 });
      expect((await checkMigrations(app.database, v2())).pending).toBe(0);
    });

    it("keeps one copy, and every older safety copy, while a migration that always fails restarts the app", async () => {
      await stop(await start(v1()));
      const before = await readFileState();
      const older = ["app-20200101T000000Z-migration.db.gz", "app-20200102T000000Z-restore.db.gz"];
      for (const name of older) writeFileSync(join(backupFolder(), name), "an older copy");
      // Its second migration makes the first one's table again, so it fails at every start.
      const failing = folder("failing", [
        FIRST_MIGRATION,
        { ...SECOND_MIGRATION, sql: FIRST_MIGRATION.sql },
      ]);

      for (let restart = 0; restart < 5; restart += 1) {
        await expect(start(failing)).rejects.toThrow();
      }

      const copies = migrationCopies().filter((name) => !older.includes(name));
      expect(copies).toHaveLength(1);
      expect(readdirSync(backupFolder())).toEqual(expect.arrayContaining(older));
      expect(await migrationsIn(copies[0] ?? "")).toMatchObject({ applied: APP + 1 });
      expect(await readFileState()).toEqual(before);
    });

    it("takes no copy when no migration is pending", async () => {
      await stop(await start(v2()));

      await stop(await start(v2()));

      expect(migrationCopies()).toEqual([]);
    });

    it("takes no copy on a fresh install with no app.db", async () => {
      expect(existsSync(path)).toBe(false);

      await stop(await start(v2()));

      expect(migrationCopies()).toEqual([]);
      expect(readdirSync(backupFolder())).toEqual([expect.stringMatching(/-daily\.db\.gz$/)]);
    });

    // A process that runs as root writes through a read-only folder.
    it.skipIf(process.getuid?.() === 0)(
      "stops before it migrates when the copy fails, with app.db unchanged, and the same at every restart until the folder works",
      async () => {
        await stop(await start(v1()));
        const before = readFileSync(path);
        const files = readdirSync(backupFolder());
        chmodSync(backupFolder(), 0o500);
        const lines: string[] = [];
        vi.spyOn(process.stdout, "write").mockImplementation(
          (chunk) => lines.push(String(chunk)) > 0,
        );
        const port = await freePort();
        const thrown: unknown[] = [];

        try {
          // Each restart fails the same way and leaves no file, so a restart loop never fills the
          // disk.
          for (let restart = 0; restart < 3; restart += 1) {
            thrown.push(await start(v2(), port).catch((error: unknown) => error));
            expect(thrown.at(-1)).toBeInstanceOf(SafetyCopyError);
            await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
            expect(readFileSync(path).equals(before)).toBe(true);
            expect(readdirSync(backupFolder())).toEqual(files);
          }
        } finally {
          chmodSync(backupFolder(), 0o700);
        }
        vi.restoreAllMocks();

        const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(logged.filter((line) => line.msg === "A backup failed")).toEqual(
          Array.from({ length: 3 }, () =>
            expect.objectContaining({ level: "error", kind: "migration", failure: "copy failed" }),
          ),
        );
        // The error lines, and the error the app logs as it exits, name no path but the backup
        // folder's.
        const errors = JSON.stringify([
          ...logged.filter((line) => line.level === "error"),
          ...thrown.map((error) => (error as Error).message),
        ]);
        expect(errors.replaceAll(backupFolder(), "")).not.toContain(dir);
        expect((thrown[0] as Error).message).toContain("stopped before it changed app.db");
        expect((await readFileState()).migrations).toMatchObject({ applied: APP + 1, pending: 1 });

        const app = await start(v2());

        expect(migrationCopies()).toHaveLength(1);
        expect((await checkMigrations(app.database, v2())).pending).toBe(0);
      },
    );
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
    // These are actions, not settings, so no query can read them.
    const unreadable = ["incremental_vacuum", "shrink_memory", "wal_checkpoint"];

    const expected = await readPlainSettings(`file:${join(dir, "plain.db")}`);
    expect(expected.unreadable).toEqual(unreadable);
    expect(Object.keys(expected.values).length).toBeGreaterThan(30);
    // Read with a statement, or by their effect, as no table-valued function reads them.
    expect(expected.values).toMatchObject({
      case_sensitive_like: 0,
      mmap_size: expect.anything(),
      wal_autocheckpoint: 1000,
    });
    expect(expected.values).toHaveProperty("temp_store_directory");

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

  it("runs the first scheduler tick before it listens", async () => {
    await migrateFile(shipped);
    const database = await openDatabase(url);
    await database.insert(scheduledTasks).values({
      name: sampleTask.name,
      lastRunAt: null,
      nextRunAt: new Date(Date.now() - 60_000),
      timeZone: "UTC",
    });
    closeDatabase(database);

    const app = await start(shipped, 0, masterKey, [sampleTask]);

    const [task] = await app.database.select().from(scheduledTasks);
    expect(task?.lastRunAt).not.toBeNull();
    await waitFor(() => jobRuns.length > 0);
    expect(jobRuns).toEqual(["SampleJob"]);
  });

  it("moves the next run times when a Member's edit changes the Household time zone", async () => {
    const first = await start(shipped, 0, masterKey, [sampleTask]);
    const [before] = await first.database.select().from(scheduledTasks);
    expect(before?.timeZone).toBe("UTC");
    expect(before?.nextRunAt.getUTCHours()).toBe(3);

    const at = new Date();
    await first.database.insert(loginTables.user).values({
      id: "member-a",
      name: "Alice",
      email: "alice@example.com",
      createdAt: at,
      updatedAt: at,
    });
    await saveHouseholdFacts(
      first.database,
      { zipCode: "96813", ages: [40], rentOrOwn: "own" },
      "member-a",
    );
    await stop(first);

    // The next start's first tick reads the Household time zone, as every tick does.
    const second = await start(shipped, 0, masterKey, [sampleTask]);
    const [after] = await second.database.select().from(scheduledTasks);

    // 03:00 in Honolulu is 13:00 UTC, with no daylight time.
    expect(after?.timeZone).toBe("Pacific/Honolulu");
    expect(after?.nextRunAt.getUTCHours()).toBe(13);
    expect(after?.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("never listens when the first scheduler tick fails", async () => {
    const port = await freePort();
    const failing: ScheduledTask = {
      name: "failing",
      schedule: {
        next() {
          throw new Error("A schedule that fails");
        },
      },
      job: SampleJob,
    };

    await expect(start(shipped, port, masterKey, [failing])).rejects.toThrow(
      "A schedule that fails",
    );
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });

  it("on close, stops taking requests and starting jobs, and waits for the running job", async () => {
    const app = await start(shipped);
    await startJob(SlowJob, []);
    await startJob(SampleJob, ["queued"]);
    await waitFor(() => jobRuns.length > 0);

    running.splice(running.indexOf(app), 1);
    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });

    await expect(fetch(`http://127.0.0.1:${app.port}/healthz`)).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(closed).toBe(false);

    finishSlowJob();
    await closing;
    expect(jobRuns).toEqual(["SlowJob"]);
  });

  it("deletes at start each passkey made under another APP_URL host, with a System notice for each Member who lost one", async () => {
    const first = await start(shipped);
    const auth = createAuth({
      database: first.database,
      secrets: first.secrets,
      appOrigin: "https://money.example.com",
    });
    const alice = await addMember(auth, { name: "Alice", email: "alice@example.test" });
    const bob = await addMember(auth, { name: "Bob", email: "bob@example.test" });
    const passkey = (id: string, memberId: string, host: string) =>
      first.database.$client.execute({
        sql: `INSERT INTO passkeys (id, public_key, member_id, credential_id, counter, device_type,
          backed_up, created_at, app_host) VALUES (?, 'key', ?, ?, 0, 'singleDevice', 0, ?, ?)`,
        args: [id, memberId, `credential-${id}`, new Date().toISOString(), host],
      });
    await passkey("alice-old", alice.id, "nas.example.net");
    await passkey("alice-now", alice.id, "money.example.com");
    await passkey("bob-now", bob.id, "money.example.com");
    await stop(first);

    const second = await start(shipped);

    const rows = async (sql: string) => (await second.database.$client.execute(sql)).rows;
    expect((await rows("SELECT id FROM passkeys ORDER BY id")).map((row) => row.id)).toEqual([
      "alice-now",
      "bob-now",
    ]);
    const notices = await rows("SELECT kind, text FROM system_notices");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "event" });
    expect(String(notices[0]?.text)).toContain("Alice's passkeys");
    await stop(second);

    // A start under the same host finds nothing more to delete.
    const third = await start(shipped);
    expect(await third.database.$client.execute("SELECT id FROM system_notices")).toMatchObject({
      rows: [expect.anything()],
    });
  });

  it("makes the VAPID keys at start over HTTPS when none are stored, as after a restore without the Master key", async () => {
    const first = await start(shipped);
    await markSetupStep(first.database, "master key", "done");
    await first.database.$client.execute("DELETE FROM vapid_keys");
    await stop(first);

    const second = await start(shipped);

    const rows = await second.database.$client.execute("SELECT id FROM vapid_keys");
    expect(rows.rows).toHaveLength(1);
  });

  describe("the running lock in /data", () => {
    const lockFile = () => join(dir, "app.lock");
    const startLocked = () =>
      startApp({
        masterKey,
        databaseUrl: url,
        migrationsFolder: shipped,
        jobs: { jobsDb: join(dir, "jobs.db"), jobList: TEST_JOB_LIST, tasks: [] },
        port: 0,
        webRoot,
        security,
        backupFolders: { mounted: join(dir, "backups-mount"), fallback: join(dir, "backups") },
        runningLock: lockFile(),
      });

    it("holds the lock while the app runs, and deletes it on close", async () => {
      const app = await startLocked();
      expect(JSON.parse(readFileSync(lockFile(), "utf8"))).toMatchObject({
        holder: "app",
        pid: process.pid,
      });
      await app.close();
      expect(existsSync(lockFile())).toBe(false);
    });

    it("refuses to start while fft restore holds it, before app.db opens", async () => {
      const restore = lockText({ holder: "restore", id: "restore-1", host: "fft-run", pid: 7 });
      writeFileSync(lockFile(), restore);

      await expect(startLocked()).rejects.toThrow(LockHeldError);

      expect(existsSync(path)).toBe(false);
      expect(readFileSync(lockFile(), "utf8")).toBe(restore);
    });
  });

  describe("web push in each security mode", () => {
    // The built page names the manifest, as vite-plugin-pwa writes it.
    const PAGE = '<!doctype html><link rel="manifest" href="/manifest.webmanifest">';

    // Signs a new Member in through the running app, then reads Settings → Alerts' push view and
    // the page. Over HTTPS the test stands where the trusted proxy would, on loopback.
    async function visit(app: RunningApp, origin: string, https: boolean) {
      await markSetupStep(app.database, "master key", "done");
      const auth = createAuth({ database: app.database, secrets: app.secrets, appOrigin: origin });
      const member = await addMember(auth, { name: "Alice", email: "alice@example.test" });
      const proxy: Record<string, string> = https ? { "x-forwarded-proto": "https" } : {};
      let cookie = "";
      const send = async (path: string, body?: unknown) => {
        const res = await fetchWithHost(new URL(origin).host)(
          `http://127.0.0.1:${app.port}${path}`,
          {
            method: body === undefined ? "GET" : "POST",
            headers: {
              ...proxy,
              origin,
              cookie,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          },
        );
        const set = res.headers.getSetCookie().map((line) => line.split(";")[0]);
        if (set.length > 0) cookie = set.join("; ");
        return res;
      };
      await send("/api/auth/sign-in/email", { email: member.email, password: member.password });
      const signedIn = await send("/api/auth/two-factor/verify-totp", {
        code: await member.totpCode(),
      });
      expect(signedIn.status).toBe(200);
      const view = await send("/api/push");
      expect(view.status).toBe(200);
      return {
        push: ((await view.json()) as { push: unknown }).push,
        page: await (await send("/")).text(),
      };
    }

    it("offers push over HTTPS, and the page names the manifest", async () => {
      writeFileSync(join(webRoot, "index.html"), PAGE);
      const app = await start(shipped);

      const { push, page } = await visit(app, "https://money.example.com", true);

      expect(push).toEqual({ available: true, publicKey: expect.stringMatching(/^[\w-]{87}$/) });
      expect(page).toBe(PAGE);
    });

    it("hides push in plain-HTTP mode, and the page names no manifest", async () => {
      writeFileSync(join(webRoot, "index.html"), PAGE);
      const port = await freePort();
      const origin = `http://127.0.0.1:${port}`;
      const plain = await loadSecurity(
        { APP_URL: origin },
        { logger: createLogger(() => {}, { throwOnSecretField: true }) },
      );
      const app = await start(shipped, port, masterKey, [], plain);

      const { push, page } = await visit(app, origin, false);

      expect(push).toEqual({ available: false, why: "plain HTTP" });
      expect(page).toBe("<!doctype html>");
      expect(await app.database.$client.execute("SELECT * FROM vapid_keys")).toMatchObject({
        rows: [],
      });
    });
  });
});
