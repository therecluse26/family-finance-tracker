import {
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
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuth } from "../auth/index.ts";
import { addMember } from "../auth/testing.ts";
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
    jobRuns.length = 0;
  });

  afterEach(async () => {
    finishSlowJob();
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
        const res = await fetch(`http://127.0.0.1:${app.port}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            ...proxy,
            origin,
            cookie,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
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
