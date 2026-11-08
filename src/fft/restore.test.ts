import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuth } from "../auth/auth.ts";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import { backUp, startBackups } from "../backups/index.ts";
import {
  AI_SETTINGS_ROW,
  addConnection,
  applyMigrations,
  closeDatabase,
  copyDatabaseInto,
  type Database,
  listOpenNotices,
  markSetupStep,
  openDatabase,
  openDatabaseCopy,
  readAiSettings,
  readDataKeys,
  SMTP_SETTINGS_ROW,
  storeAiSettings,
  storePlaidKeys,
  storePushDevice,
  storeSmtpSettings,
  VAPID_KEYS_ROW,
} from "../db/index.ts";
import { readEveryTable } from "../db/testing.ts";
import { TEST_JOB_LIST } from "../jobs/testing.ts";
import { createLogger } from "../log.ts";
import { vapidKeysOf } from "../notify/index.ts";
import { findMasterKey, type MasterKey, type Secrets, unlockSecrets } from "../secrets/index.ts";
import { newMasterKey, newMasterKeyHex } from "../secrets/testing.ts";
import { createApp } from "../server/app.ts";
import { lockText, STALE_AFTER_MS, takeRunningLock } from "../server/running-lock.ts";
import { loadSecurity } from "../server/security-mode.ts";
import { startApp } from "../server/start.ts";
import { type App, TestBrowser } from "../server/testing.ts";
import { runFft } from "./fft.ts";
import { backupPath, RESTORED_WITHOUT_MASTER_KEY } from "./restore.ts";
import { restoreParts } from "./testing.ts";

// `fft restore <file>` (spec 11, Restore; spec 12). Each test has a server's folders in a new
// temporary folder: /data with app.db, jobs.db and the lock, and /data/backups. The backup comes
// from a Household made in another app.db, with made-up secrets and a Master key made at test time.

const APP_URL = "https://money.example.com";
const SHIPPED_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const TOTP_STEP_MS = 30_000;
const quiet = createLogger(() => {}, { throwOnSecretField: true });

// The places each secret is bound to, as the modules that seal them name them.
const PLAID_SECRET_PLACE = { rowId: 1, column: "plaid_settings.secret" };
const AI_KEY_PLACE = { rowId: AI_SETTINGS_ROW, column: "ai_settings.api_key" };
const SMTP_PASSWORD_PLACE = { rowId: SMTP_SETTINGS_ROW, column: "smtp_settings.password" };
const CREDENTIAL = (id: string) => ({ rowId: id, column: "connections.credential" });

// The tables a restore without the Master key changes. Every other table comes back as it was.
const CHANGED_WITHOUT_KEY = [
  "data_keys",
  "connections",
  "plaid_settings",
  "ai_settings",
  "smtp_settings",
  "push_devices",
  "push_sends",
  "vapid_keys",
  "sessions",
  "two_factors",
  "verifications",
  "master_key_checks",
  "system_notices",
  "notice_deliveries",
];

type Household = {
  test: TestAuth;
  alice: TestMember;
  bob: TestMember;
  // Bob's browser, signed in before the backup.
  bobTab: TestBrowser;
  // The made-up secrets, to check that none of them reaches the command's output.
  secrets: string[];
  linked: string;
  imported: string;
  removed: string;
};

// Each test runs several restores, each with a gzip and an integrity check, so under the full
// suite's load one takes longer than the default 5 s.
describe("fft restore", { timeout: 30_000 }, () => {
  let dir: string;
  let dataDir: string;
  let databaseFile: string;
  let backupFolder: string;
  let jobsDb: string;
  let lockFile: string;
  let household: Household;
  // The backup of the Household, in the backup folder, and every table it holds.
  let backupName: string;
  let backedUp: Record<string, unknown[]>;
  let out: string;
  let err: string;
  let questions: string[];
  let webRoot: string;
  let open: Database[];
  let clients = 0;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T15:00:00.000Z"));
    dir = mkdtempSync(join(tmpdir(), "fft-restore-"));
    dataDir = join(dir, "data");
    databaseFile = join(dataDir, "app.db");
    backupFolder = join(dataDir, "backups");
    jobsDb = join(dataDir, "jobs.db");
    lockFile = join(dataDir, "app.lock");
    webRoot = join(dir, "web");
    mkdirSync(webRoot);
    writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
    mkdirSync(backupFolder, { recursive: true });
    open = [];
    out = "";
    err = "";
    questions = [];

    household = await makeHousehold();
    backupName = await backUpInto(household.test.database);
    backedUp = await readEveryTable(household.test.database);
    // The current app.db differs from the backup: Carol joined after it was made.
    await addMember(household.test.auth, { name: "Carol", email: "carol@example.com" });
    await copyDatabaseInto(household.test.database, databaseFile);
    // jobs.db, with a job waiting.
    writeFileSync(jobsDb, "a scheduled job");
    writeFileSync(`${jobsDb}-wal`, "a job's log");
  });

  afterEach(() => {
    for (const database of open) closeDatabase(database);
    household.test.close();
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function appOn(database: Database, secrets: Secrets): Promise<App> {
    return loadSecurity({ APP_URL, TRUSTED_PROXIES: "127.0.0.1" }, { logger: quiet }).then(
      (security) =>
        createApp(
          webRoot,
          security,
          createAuth({ database, secrets, appOrigin: APP_URL, logger: quiet }),
          database,
          secrets,
        ),
    );
  }

  function browser(app: App, cookies?: Map<string, string>): TestBrowser {
    clients += 1;
    const tab = new TestBrowser(app, APP_URL, `192.168.1.${100 + clients}`, {
      source: "127.0.0.1",
      headers: { "x-forwarded-proto": "https" },
    });
    for (const [name, value] of cookies ?? []) tab.cookies.set(name, value);
    return tab;
  }

  // A Household with every kind of secret: a Plaid secret, an AI key, SMTP settings, VAPID keys and
  // a push device, two Connections with credentials and one removed, and a signed-in Member.
  async function makeHousehold(): Promise<Household> {
    const test = await newTestAuth(APP_URL, quiet);
    const { database, secrets } = test;
    const alice = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    const bob = await addMember(test.auth, { name: "Bob", email: "bob@example.com" });
    await markSetupStep(database, "master key", "done");
    const made = Array.from({ length: 6 }, () => `made-up-${crypto.randomUUID()}`);
    const [plaidSecret = "", aiKey = "", smtpPassword = "", token1 = "", token2 = "", token3 = ""] =
      made;
    await storePlaidKeys(database, {
      clientId: "client-id",
      secret: secrets.encrypt(plaidSecret, PLAID_SECRET_PLACE),
    });
    await storeAiSettings(
      database,
      {
        provider: "anthropic",
        apiKey: secrets.encrypt(aiKey, AI_KEY_PLACE),
        baseUrl: null,
        gatewayToken: null,
        quickModel: "quick-model",
        writerModel: "writer-model",
        chatModel: "chat-model",
        keyRejectedAt: null,
      },
      0,
    );
    // Saved before Chat had its own tier: no Chat model of its own.
    await database.$client.execute("UPDATE ai_settings SET chat_model = NULL");
    await storeSmtpSettings(database, {
      host: "smtp.example.com",
      port: 587,
      username: "fft",
      password: secrets.encrypt(smtpPassword, SMTP_PASSWORD_PLACE),
      sender: "fft@example.com",
    });
    await vapidKeysOf(database, secrets, quiet);
    await storePushDevice(
      database,
      alice.id,
      { endpoint: "https://fcm.googleapis.com/fcm/send/device-1", p256dh: "p256dh", auth: "auth" },
      new Date(),
    );
    const connection = (bankName: string, token: string, origin: "linked" | "imported") =>
      addConnection(database, {
        provider: "plaid",
        bankId: `ins_${bankName.length}`,
        bankName,
        origin,
        sealCredential: (id) => secrets.encrypt(token, CREDENTIAL(id)),
      });
    const linked = await connection("Bluebird Credit Union", token1, "linked");
    const imported = await connection("Acme Bank", token2, "imported");
    const removed = await connection("Old Savings Bank", token3, "linked");
    await database.$client.execute({
      sql: "UPDATE connections SET removed_at = ?, health = 'healthy' WHERE id = ?",
      args: [new Date().toISOString(), removed],
    });
    // A passkey made under the APP_URL host the backup was made under.
    await database.$client.execute({
      sql: `INSERT INTO passkeys (id, public_key, member_id, credential_id, counter, device_type,
        backed_up, created_at, app_host) VALUES ('bob-old', 'key', ?, 'credential-bob-old', 0,
        'singleDevice', 0, ?, 'nas.example.net')`,
      args: [bob.id, new Date().toISOString()],
    });
    vi.setSystemTime(Date.now() + TOTP_STEP_MS);
    const bobTab = browser(await appOn(database, secrets));
    await bobTab.signIn(bob);
    return {
      test,
      alice,
      bob,
      bobTab,
      secrets: made,
      linked,
      imported,
      removed,
    };
  }

  // A backup made as the app makes one, into the backup folder.
  async function backUpInto(database: Database): Promise<string> {
    const backups = startBackups({
      database,
      folder: backupFolder,
      timeZone: async () => undefined,
    });
    try {
      const result = await backUp("manual");
      if (!result.ok) throw new Error(`The backup failed: ${result.failure}`);
      return result.name;
    } finally {
      backups.stop();
    }
  }

  // A backup file with these bytes, gzipped, under a backup's name in the backup folder.
  function writeBackup(name: string, plain: Uint8Array): string {
    writeFileSync(join(backupFolder, name), gzipSync(plain));
    return name;
  }

  // A copy of the Household's backup, changed by `change` before it is gzipped.
  async function changedBackup(
    name: string,
    change: (copy: Database) => Promise<unknown>,
  ): Promise<string> {
    const plain = join(dir, `${name}.plain`);
    writeFileSync(plain, gunzipSync(readFileSync(join(backupFolder, backupName))));
    const copy = openDatabaseCopy(plain);
    try {
      await change(copy);
    } finally {
      closeDatabase(copy);
    }
    return writeBackup(name, readFileSync(plain));
  }

  function fft(args: string[], options: { masterKey?: string; answers?: string[] } = {}) {
    const parts = restoreParts(dir, options.answers);
    questions = parts.questions;
    return runFft(args, {
      env: {
        APP_URL,
        FFT_MASTER_KEY_FILE: join(dir, "secrets", "master.key"),
        ...(options.masterKey === undefined ? {} : { FFT_MASTER_KEY: options.masterKey }),
      },
      databaseFile,
      migrationsFolder: SHIPPED_FOLDER,
      ...parts,
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    });
  }

  const sameKey = () => household.test.secrets.showMasterKey();

  // A lock another container wrote.
  const otherLock = (holder: "app" | "restore") =>
    lockText({ holder, id: `${holder}-other`, host: "other-container", pid: 1 });

  // Everything a refused restore must leave as it was.
  function serverState() {
    return {
      appDb: readFileSync(databaseFile),
      data: readdirSync(dataDir).sort(),
      backups: readdirSync(backupFolder).sort(),
      jobsDb: readFileSync(jobsDb, "utf8"),
    };
  }

  async function restored(masterKey: MasterKey): Promise<{ database: Database; secrets: Secrets }> {
    const database = await openDatabase(`file:${databaseFile}`);
    open.push(database);
    return { database, secrets: await unlockSecrets(database, masterKey, { logger: quiet }) };
  }

  describe("refuses before anything changes", () => {
    it("while the app runs, in this container or in another that shares /data", async () => {
      const before = serverState();
      const app = await takeRunningLock(lockFile, "app");
      if (!app.taken) throw new Error("The app's lock was not taken");
      // As the app's last refresh set it, on the test's clock.
      utimesSync(lockFile, new Date(), new Date());

      expect(await fft(["restore", backupName], { masterKey: sameKey() })).toBe(1);
      expect(err).toContain("The app is running");
      expect(err).toContain("docker compose stop app");
      expect(err).toContain("Right after a crash, wait 30 seconds and try again.");
      await app.lock.release();

      // The app's container refreshed its lock 20 seconds ago.
      writeFileSync(lockFile, otherLock("app"));
      const at = new Date(Date.now() - 20_000);
      utimesSync(lockFile, at, at);
      expect(await fft(["restore", backupName], { masterKey: sameKey() })).toBe(1);

      // Another restore holds it.
      writeFileSync(lockFile, otherLock("restore"));
      utimesSync(lockFile, new Date(), new Date());
      expect(await fft(["restore", backupName], { masterKey: sameKey() })).toBe(1);
      expect(err).toContain("Another fft restore is running");

      expect(out).toBe("");
      rmSync(lockFile);
      expect(serverState()).toEqual(before);
    });

    it("runs over a stale lock, which an app that crashed left", async () => {
      writeFileSync(lockFile, otherLock("app"));
      const at = new Date(Date.now() - STALE_AFTER_MS - 1_000);
      utimesSync(lockFile, at, at);

      expect(await fft(["restore", backupName], { masterKey: sameKey() })).toBe(0);
      expect(existsSync(lockFile)).toBe(false);
    });

    it("for a file that is not in the backup folder, or is a link, in any spelling", async () => {
      const outside = join(dir, backupName);
      const bytes = readFileSync(join(backupFolder, backupName));
      writeFileSync(outside, bytes);
      symlinkSync(outside, join(backupFolder, "app-20261101T030000Z-daily.db.gz"));
      const [stem = "", rest = ""] = backupName.split(".db");
      // Each of these is a real file in the backup folder, so only its name refuses it: a backup's
      // own name, exactly as given, with a real time that is not in the future.
      const misnamed = [
        `${backupName};`,
        `{${backupName}}`,
        `%2e%2e%2f${backupName}`,
        `${stem}．db${rest}`,
        `\t${backupName}`,
        ` ${backupName}`,
        `${backupName} `,
        `${backupName.toUpperCase()}`,
        "app-20261131T030000Z-daily.db.gz",
        "app-20261340T030000Z-daily.db.gz",
        "app-20261105T150100Z-daily.db.gz",
        "app-20271101T030000Z-daily.db.gz",
        "app-20261101T030000Z-weekly.db.gz",
        "app.db.gz",
      ];
      for (const name of misnamed) writeFileSync(join(backupFolder, name), bytes);
      const before = serverState();
      const refused = [
        ...misnamed,
        outside,
        `../${backupName}`,
        `${backupFolder}/../../${backupName}`,
        "app-20261101T030000Z-daily.db.gz",
        ".",
        "..",
        `${backupName}\0`,
      ];
      for (const name of refused) {
        err = "";
        expect([name, await fft(["restore", name], { masterKey: sameKey() })]).toEqual([name, 1]);
        expect(err).toContain("No backup file");
      }

      expect(out).toBe("");
      expect(serverState()).toEqual(before);
      for (const name of misnamed) rmSync(join(backupFolder, name));
      rmSync(join(backupFolder, "app-20261101T030000Z-daily.db.gz"));
    });

    it("for a file that is not a gzipped database, or fails the integrity check", async () => {
      const unchanged = () => ({ ...serverState(), backups: undefined });
      const state = unchanged();
      const plain = gunzipSync(readFileSync(join(backupFolder, backupName)));
      writeFileSync(join(backupFolder, "app-20261101T030000Z-manual.db.gz"), plain);
      const damaged = Buffer.from(plain);
      damaged.fill(0xab, 3 * 4096, 5 * 4096);
      writeBackup("app-20261102T030000Z-manual.db.gz", damaged);
      writeBackup("app-20261103T030000Z-manual.db.gz", Buffer.from("not a database"));

      expect(await fft(["restore", "app-20261101T030000Z-manual.db.gz"])).toBe(1);
      expect(err).toContain("is not a gzipped backup");
      for (const name of [
        "app-20261102T030000Z-manual.db.gz",
        "app-20261103T030000Z-manual.db.gz",
      ]) {
        err = "";
        expect(await fft(["restore", name], { masterKey: sameKey() })).toBe(1);
        expect(err).toContain("failed SQLite's integrity check");
        expect(err).toContain("Nothing changed.");
      }

      expect(out).not.toContain("Restored");
      expect(unchanged()).toEqual(state);
    });

    it("for a backup a newer version made, and one that lacks a migration", async () => {
      const state = serverState();
      const newer = await changedBackup("app-20261101T030000Z-manual.db.gz", (copy) =>
        copy.$client.execute(
          `INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('${"f".repeat(64)}', 99999999999999)`,
        ),
      );
      const skipped = await changedBackup("app-20261102T030000Z-manual.db.gz", (copy) =>
        copy.$client.execute(
          "DELETE FROM __drizzle_migrations WHERE created_at = (SELECT created_at FROM __drizzle_migrations ORDER BY created_at LIMIT 1 OFFSET 1)",
        ),
      );
      const empty = await changedBackup("app-20261103T030000Z-manual.db.gz", (copy) =>
        copy.$client.execute("DELETE FROM __drizzle_migrations"),
      );

      expect(await fft(["restore", newer], { masterKey: sameKey() })).toBe(1);
      expect(err).toContain("holds a migration this version of the app does not have");
      expect(await fft(["restore", skipped], { masterKey: sameKey() })).toBe(1);
      expect(err).toContain("lacks a migration");
      expect(await fft(["restore", empty], { masterKey: sameKey() })).toBe(1);
      expect(err).toContain("is not a backup of this app");

      expect({ ...serverState(), backups: state.backups }).toEqual(state);
    });

    it("for any answer but yes, when the Master key does not match", async () => {
      const state = serverState();
      for (const answer of ["no", "", "YES", "yes please", " yes", "y"]) {
        err = "";
        expect(
          await fft(["restore", backupName], { masterKey: newMasterKeyHex(), answers: [answer] }),
        ).toBe(1);
        expect(questions).toHaveLength(1);
        expect(err).toContain("The restore stopped. Nothing changed.");
      }

      expect(serverState()).toEqual(state);
      expect(out).toContain("These are lost:");
    });

    it("for a missing or extra argument, with its usage", async () => {
      expect(await fft(["restore"])).toBe(2);
      expect(await fft(["restore", backupName, "extra"])).toBe(2);
      expect(err).toContain("Usage: fft restore <file>");
    });
  });

  it("with the matching Master key, puts the backup in place with every secret, and empties jobs.db", async () => {
    expect(await fft(["restore", backupName], { masterKey: sameKey() })).toBe(0);

    expect(questions).toEqual([]);
    expect(err).toBe("");
    expect(out).toContain(`Restored ${backupName}.`);
    expect(out).toContain("every secret was kept");
    const { database, secrets } = await restored(household.test.masterKey);
    expect(await readEveryTable(database)).toEqual(backedUp);
    const [plaidSecret, aiKey, smtpPassword] = household.secrets;
    const tables = await readEveryTable(database);
    const row = (table: string) => tables[table]?.[0] as Record<string, string>;
    expect(secrets.decrypt(row("plaid_settings").secret ?? "", PLAID_SECRET_PLACE)).toBe(
      plaidSecret,
    );
    expect(secrets.decrypt(row("ai_settings").api_key ?? "", AI_KEY_PLACE)).toBe(aiKey);
    expect(secrets.decrypt(row("smtp_settings").password ?? "", SMTP_PASSWORD_PLACE)).toBe(
      smtpPassword,
    );
    expect(existsSync(jobsDb)).toBe(false);
    expect(existsSync(`${jobsDb}-wal`)).toBe(false);
    expect(existsSync(lockFile)).toBe(false);
    expect(readdirSync(dataDir).filter((name) => name.includes("restoring"))).toEqual([]);

    // Bob's session and TOTP still work.
    const app = await appOn(database, secrets);
    expect(await browser(app, household.bobTab.cookies).isSignedIn()).toBe(true);
    vi.setSystemTime(Date.now() + TOTP_STEP_MS);
    await browser(app).signIn(household.bob);
  });

  it("saves the current app.db as a restore safety copy first", async () => {
    expect(await fft(["restore", backupName], { masterKey: sameKey() })).toBe(0);

    const safety = readdirSync(backupFolder).filter((name) => name.endsWith("-restore.db.gz"));
    expect(safety).toEqual([expect.stringMatching(/^app-\d{8}T\d{6}Z-restore\.db\.gz$/)]);
    expect(out).toContain(`Saved the current app.db as ${safety[0]}`);
    const plain = join(dir, "safety.db");
    writeFileSync(plain, gunzipSync(readFileSync(join(backupFolder, safety[0] ?? ""))));
    const copy = openDatabaseCopy(plain);
    open.push(copy);
    const emails = (await copy.$client.execute("SELECT email FROM members ORDER BY email")).rows;
    expect(emails.map((row) => row.email)).toEqual([
      "alice@example.com",
      "bob@example.com",
      "carol@example.com",
    ]);
    // The restored app.db has no Carol.
    const { database } = await restored(household.test.masterKey);
    expect((await database.$client.execute("SELECT email FROM members")).rows).toHaveLength(2);
  });

  it("takes no safety copy when there is no app.db, as on a new server", async () => {
    rmSync(databaseFile);

    expect(await fft(["restore", join(backupFolder, backupName)], { masterKey: sameKey() })).toBe(
      0,
    );

    expect(readdirSync(backupFolder)).toEqual([backupName]);
    const { database } = await restored(household.test.masterKey);
    expect(await readEveryTable(database)).toEqual(backedUp);
  });

  describe("without the matching Master key, after yes", () => {
    let masterKey: { hex: string; masterKey: MasterKey };
    let oldDataKey: string;

    beforeEach(async () => {
      masterKey = newMasterKey();
      const [key] = await readDataKeys(household.test.database);
      oldDataKey = key?.id ?? "";
      expect(
        await fft(["restore", backupName], { masterKey: masterKey.hex, answers: ["yes"] }),
      ).toBe(0);
    });

    it("lists what will be lost before it asks", () => {
      expect(questions).toEqual([
        "Type yes to restore without these secrets. Any other answer stops the restore: ",
      ]);
      const lost = out.slice(0, out.indexOf("Saved the current app.db"));
      expect(lost).toContain("the Plaid secret");
      expect(lost).toContain("the AI key");
      expect(lost).toContain("the SMTP password");
      expect(lost).toContain("Acme Bank, Bluebird Credit Union.");
      expect(lost).not.toContain("Old Savings Bank");
      expect(lost).toContain("Alerts on 1 device");
      expect(lost).toContain("fft reset-login");
      for (const made of household.secrets) expect(out + err).not.toContain(made);
    });

    it("keeps all history, and stores a new data key that the current Master key decrypts", async () => {
      const { database, secrets } = await restored(masterKey.masterKey);
      const tables = await readEveryTable(database);
      for (const [name, rows] of Object.entries(backedUp)) {
        if (!CHANGED_WITHOUT_KEY.includes(name)) expect([name, tables[name]]).toEqual([name, rows]);
      }
      const keys = await readDataKeys(database);
      expect(keys).toHaveLength(1);
      expect(keys[0]?.id).not.toBe(oldDataKey);
      const sealed = secrets.encrypt("a value", { rowId: 1, column: "test" });
      expect(secrets.decrypt(sealed, { rowId: 1, column: "test" })).toBe("a value");
      // No value the old data key encrypted is left in any table.
      const text = JSON.stringify(tables);
      expect(text).not.toContain(`"${oldDataKey}.`);
      expect(text).not.toContain(oldDataKey);
    });

    it("deletes every secret it cannot read, and every push device", async () => {
      const { database } = await restored(masterKey.masterKey);
      const tables = await readEveryTable(database);
      expect(tables.plaid_settings).toMatchObject([{ client_id: "client-id", secret: null }]);
      expect(tables.ai_settings).toMatchObject([
        {
          provider: "anthropic",
          api_key: null,
          gateway_token: null,
          quick_model: "quick-model",
          chat_model: null,
        },
      ]);
      expect(await readAiSettings(database)).toMatchObject({ chatModel: "writer-model" });
      for (const table of [
        "smtp_settings",
        "push_devices",
        "push_sends",
        "vapid_keys",
        "sessions",
        "two_factors",
        "verifications",
        "master_key_checks",
      ]) {
        expect([table, tables[table]]).toEqual([table, []]);
      }
      for (const connection of tables.connections as { credential: unknown }[]) {
        expect(connection.credential).toBeNull();
      }
    });

    it("marks every Connection that is not removed Broken, so Repair offers only Link again", async () => {
      const { database } = await restored(masterKey.masterKey);
      const rows = (
        await database.$client.execute(
          "SELECT id, health, next_sync_at, removed_at FROM connections ORDER BY bank_name",
        )
      ).rows;
      const { linked, imported, removed } = household;
      expect(rows.map((row) => [row.id, row.health, row.next_sync_at])).toEqual([
        [imported, "broken", null],
        [linked, "broken", null],
        [
          removed,
          "healthy",
          (backedUp.connections as { id: string; next_sync_at: unknown }[]).find(
            (row) => row.id === removed,
          )?.next_sync_at,
        ],
      ]);
      // Their first history load never finishes, so they stop holding back AI, as any Broken
      // Connection does. The removed one is left as it was.
      const released = await database.$client.execute(
        "SELECT id, history_loaded, history_wait_released_at FROM connections ORDER BY bank_name",
      );
      expect(
        released.rows.map((row) => [row.id, row.history_loaded, row.history_wait_released_at]),
      ).toEqual([
        [imported, 0, expect.stringMatching(/^2026-11-05T15:00:\d{2}\.\d{3}Z$/)],
        [linked, 0, expect.stringMatching(/^2026-11-05T15:00:\d{2}\.\d{3}Z$/)],
        [removed, 0, null],
      ]);
    });

    it("gives every Member one System notice that lists what to set up again", async () => {
      const { database } = await restored(masterKey.masterKey);
      const notices = await listOpenNotices(database);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ kind: "event", text: RESTORED_WITHOUT_MASTER_KEY });
      for (const item of [
        "Plaid secret",
        "AI key",
        "SMTP password",
        "each bank",
        "Alerts on each device",
      ]) {
        expect(RESTORED_WITHOUT_MASTER_KEY).toContain(item);
      }
      const deliveries = (await database.$client.execute("SELECT notice_id FROM notice_deliveries"))
        .rows;
      expect(deliveries.map((row) => row.notice_id)).toEqual([notices[0]?.id]);
    });

    it("ends every session, and no TOTP code works", async () => {
      const { database, secrets } = await restored(masterKey.masterKey);
      const app = await appOn(database, secrets);
      expect(await browser(app, household.bobTab.cookies).isSignedIn()).toBe(false);
      vi.setSystemTime(Date.now() + TOTP_STEP_MS);
      await expect(browser(app).signIn(household.bob)).rejects.toThrow("The code step answered");
    });

    it("lets the app make new VAPID keys", async () => {
      const { database, secrets } = await restored(masterKey.masterKey);
      expect(await vapidKeysOf(database, secrets, quiet)).toMatchObject({
        publicKey: expect.any(String),
      });
      expect((await readEveryTable(database)).vapid_keys).toMatchObject([{ id: VAPID_KEYS_ROW }]);
      expect(await listOpenNotices(database)).toHaveLength(1);
    });

    it("leaves the passkey check to the start under the new APP_URL host", async () => {
      const { database, secrets } = await restored(masterKey.masterKey);
      const auth = createAuth({ database, secrets, appOrigin: APP_URL, logger: quiet });
      expect(await auth.removeOtherHostPasskeys(new Date())).toBe(1);
    });
  });

  it("without the matching Master key, restores a backup an older version made, and the app starts on it", async () => {
    // A backup made by the version whose last migration was 0047, with its own Master key.
    const oldFolder = join(dir, "old-drizzle");
    cpSync(SHIPPED_FOLDER, oldFolder, { recursive: true });
    const journalFile = join(oldFolder, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalFile, "utf8")) as { entries: { idx: number }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 47);
    writeFileSync(journalFile, JSON.stringify(journal));
    const old = await openDatabase(`file:${join(dir, "old.db")}`);
    open.push(old);
    await applyMigrations(old, oldFolder);
    const oldSecrets = await unlockSecrets(old, newMasterKey().masterKey, { logger: quiet });
    await storePlaidKeys(old, {
      clientId: "client-id",
      secret: oldSecrets.encrypt(`made-up-${crypto.randomUUID()}`, PLAID_SECRET_PLACE),
    });
    await storeSmtpSettings(old, {
      host: "smtp.example.com",
      port: 587,
      username: "fft",
      password: oldSecrets.encrypt(`made-up-${crypto.randomUUID()}`, SMTP_PASSWORD_PLACE),
      sender: "fft@example.com",
    });
    const bank = await addConnection(old, {
      provider: "plaid",
      bankId: "ins_1",
      bankName: "Bluebird Credit Union",
      origin: "linked",
      sealCredential: (id) => oldSecrets.encrypt(`made-up-${crypto.randomUUID()}`, CREDENTIAL(id)),
    });
    const name = "app-20261101T030000Z-daily.db.gz";
    await copyDatabaseInto(old, join(dir, "old-copy.db"));
    writeBackup(name, readFileSync(join(dir, "old-copy.db")));
    const masterKey = newMasterKey();

    expect(await fft(["restore", name], { masterKey: masterKey.hex, answers: ["yes"] })).toBe(0);

    expect(err).toBe("");
    expect(out).toContain("the Plaid secret");
    expect(out).toContain("the SMTP password");
    expect(out).toContain("the access to each bank: Bluebird Credit Union.");
    const app = await startApp({
      masterKey: masterKey.masterKey,
      databaseUrl: `file:${databaseFile}`,
      migrationsFolder: SHIPPED_FOLDER,
      jobs: { jobsDb: jobsDb, jobList: TEST_JOB_LIST, tasks: [] },
      port: 0,
      webRoot,
      security: await loadSecurity({ APP_URL, TRUSTED_PROXIES: "127.0.0.1" }, { logger: quiet }),
      backupFolders: { mounted: join(dir, "backups-mount"), fallback: backupFolder },
      runningLock: lockFile,
    });
    try {
      const tables = await readEveryTable(app.database);
      expect(tables.plaid_settings).toMatchObject([{ secret: null }]);
      expect(tables.smtp_settings).toEqual([]);
      expect(tables.connections).toMatchObject([{ id: bank, credential: null, health: "broken" }]);
      const notices = await listOpenNotices(app.database);
      expect(notices.map((notice) => notice.text)).toContain(RESTORED_WITHOUT_MASTER_KEY);
    } finally {
      await app.close();
    }
  });

  it("with no Master key at all, makes one, prints it once, and restores without the backup's", async () => {
    expect(await fft(["restore", backupName], { answers: ["yes"] })).toBe(0);

    const keyFile = join(dir, "secrets", "master.key");
    const hex = readFileSync(keyFile, "utf8").trim();
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(out.split(hex)).toHaveLength(2);
    expect(out).toContain("Save it in a password manager");
    expect(err).not.toContain(hex);
    const found = await findMasterKey({ FFT_MASTER_KEY_FILE: keyFile });
    if (found === undefined) throw new Error("No Master key was found");
    const { database } = await restored(found.masterKey);
    expect((await readEveryTable(database)).smtp_settings).toEqual([]);
  });
});

describe("the backup's path", () => {
  const NOW = new Date("2026-11-05T15:00:00.000Z");
  const NAME = "app-20261102T080000Z-daily.db.gz";

  it("is a backup's name in the backup folder, as a bare name or a path whose folder is that folder", () => {
    const path = `/data/backups/${NAME}`;
    expect(backupPath("/data/backups", NAME, NOW)).toBe(path);
    expect(backupPath("/data/backups", path, NOW)).toBe(path);
    expect(backupPath("/data/backups/", `/data/backups//${NAME}`, NOW)).toBe(path);
    for (const kind of ["daily", "manual", "migration", "restore"]) {
      const name = `app-20261105T150000Z-${kind}.db.gz`;
      expect(backupPath("/data/backups", name, NOW)).toBe(`/data/backups/${name}`);
    }
    for (const given of [
      `../${NAME}`,
      `/data/${NAME}`,
      `/data/backups/../${NAME}`,
      `/data/backups/sub/${NAME}`,
      `sub/${NAME}`,
      "app.db.gz",
      "app-20261105T150001Z-daily.db.gz",
      "app-20260229T080000Z-daily.db.gz",
      "app-20261102T080000Z-daily.db",
      `${NAME}.tmp`,
      "..",
      ".",
      "",
      `${NAME}\0`,
    ]) {
      expect([given, backupPath("/data/backups", given, NOW)]).toEqual([given, undefined]);
    }
  });
});
