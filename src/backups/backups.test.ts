import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, listOpenNotices, openDatabase } from "../db/index.ts";
import { newTestDatabase, type TestDatabase } from "../db/testing.ts";
import { startNotify } from "../notify/index.ts";
import { sameAsGzipped } from "./backup.ts";
import {
  BACKUP_FAILED,
  backUp,
  backupStatus,
  chooseBackupFolder,
  deleteLeftoverBackupFiles,
  latestBackupTime,
  runDailyBackup,
  SafetyCopyError,
  startBackups,
  takeMigrationCopy,
} from "./index.ts";

// Backups of app.db (spec 11, How the app makes a backup; When backups run; How many are kept;
// Where backups go; When a backup fails), in temporary folders, with a fake clock. The Household
// time zone is UTC unless a test sets one.

const NOW = new Date("2026-11-02T08:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

describe("backups", () => {
  let test: TestDatabase;
  let dir: string;
  let folder: string;
  let clock: Date;
  let timeZone: string | undefined;
  let checkPasses: boolean;
  let retries: Date[];
  let retryStarts: boolean;
  let waits: number[];
  let clockMoves: boolean;
  let stops: (() => void)[];

  beforeEach(async () => {
    test = await newTestDatabase();
    dir = mkdtempSync(join(tmpdir(), "fft-backups-"));
    folder = join(dir, "backups");
    mkdirSync(folder);
    clock = NOW;
    timeZone = undefined;
    checkPasses = true;
    retries = [];
    retryStarts = true;
    waits = [];
    clockMoves = true;
    await test.database.$client.execute("CREATE TABLE probe (id integer PRIMARY KEY, label text)");
    await test.database.$client.execute("INSERT INTO probe (label) VALUES ('kept')");
    stops = [
      startNotify({ database: test.database }).stop,
      startBackups({
        database: test.database,
        folder,
        timeZone: async () => timeZone,
        now: () => clock,
        startRetry: async (at) => {
          if (!retryStarts) throw new Error("The jobs module is not running.");
          retries.push(at);
        },
        checkCopy: async () => checkPasses,
        wait: async (ms) => {
          waits.push(ms);
          if (clockMoves) clock = new Date(clock.getTime() + ms);
        },
      }).stop,
    ];
  });

  afterEach(() => {
    for (const stop of stops) stop();
    test.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const files = () => readdirSync(folder).sort();
  const openNotices = async () =>
    (await listOpenNotices(test.database)).filter((notice) => notice.condition === BACKUP_FAILED);

  // Writes a file with a backup's name, and the given size in bytes.
  const plant = (name: string, bytes = 10) => writeFileSync(join(folder, name), "x".repeat(bytes));

  // The rows of the probe table in a backup, after gunzip.
  async function labelsIn(name: string): Promise<string[]> {
    const plain = join(dir, `${name}.plain`);
    writeFileSync(plain, gunzipSync(readFileSync(join(folder, name))));
    const copy = await openDatabase(`file:${plain}`);
    try {
      const result = await copy.$client.execute("SELECT label FROM probe ORDER BY id");
      return result.rows.map((row) => String(row[0]));
    } finally {
      closeDatabase(copy);
    }
  }

  describe("making a backup", () => {
    it("writes app.db, gzipped and not encrypted, under a name with its kind and time, and leaves no temporary file", async () => {
      const result = await backUp("manual");

      expect(result).toEqual({ ok: true, name: "app-20261102T080000Z-manual.db.gz", at: NOW });
      expect(files()).toEqual(["app-20261102T080000Z-manual.db.gz"]);
      const plain = gunzipSync(readFileSync(join(folder, "app-20261102T080000Z-manual.db.gz")));
      expect(plain.subarray(0, 16).toString("latin1")).toBe("SQLite format 3\0");
      expect(await labelsIn("app-20261102T080000Z-manual.db.gz")).toEqual(["kept"]);
    });

    it("holds only app.db: no Sidequest table, and no file but the backup", async () => {
      await backUp("manual");
      const plain = join(dir, "plain.db");
      writeFileSync(
        plain,
        gunzipSync(readFileSync(join(folder, "app-20261102T080000Z-manual.db.gz"))),
      );
      const copy = await openDatabase(`file:${plain}`);
      try {
        const tables = await copy.$client.execute("SELECT name FROM sqlite_schema");
        const names = tables.rows.map((row) => String(row[0]));

        expect(names).toContain("probe");
        expect(names.filter((name) => name.startsWith("sidequest"))).toEqual([]);
      } finally {
        closeDatabase(copy);
      }
      expect(files()).toEqual(["app-20261102T080000Z-manual.db.gz"]);
    });

    it("keeps every committed row while another connection holds an open write", async () => {
      const other = await openDatabase(`file:${test.path}`);
      try {
        await other.$client.execute("INSERT INTO probe (label) VALUES ('committed elsewhere')");
        const open = await other.$client.transaction("write");
        try {
          await open.execute("INSERT INTO probe (label) VALUES ('not committed')");

          expect((await backUp("manual")).ok).toBe(true);
        } finally {
          await open.rollback();
          open.close();
        }
      } finally {
        closeDatabase(other);
      }

      expect(await labelsIn("app-20261102T080000Z-manual.db.gz")).toEqual([
        "kept",
        "committed elsewhere",
      ]);
    });

    it("counts a failed integrity check as a failed backup, and leaves no file", async () => {
      checkPasses = false;

      expect(await backUp("manual")).toEqual({ ok: false, failure: "check failed" });
      expect(files()).toEqual([]);
    });

    it("fails, and leaves no file, when VACUUM INTO cannot write", async () => {
      rmSync(folder, { recursive: true });

      expect(await backUp("manual")).toEqual({ ok: false, failure: "copy failed" });
      expect(existsSync(folder)).toBe(false);
    });

    it("writes the backup so only the app's user can read it", async () => {
      await backUp("manual");

      expect(statSync(join(folder, "app-20261102T080000Z-manual.db.gz")).mode & 0o777).toBe(0o600);
    });

    it("never replaces a backup: a second one in the same second waits for the next second", async () => {
      expect((await backUp("manual")).ok).toBe(true);
      const first = readFileSync(join(folder, "app-20261102T080000Z-manual.db.gz"));
      await test.database.$client.execute("INSERT INTO probe (label) VALUES ('later')");

      expect(await backUp("manual")).toEqual({
        ok: true,
        name: "app-20261102T080001Z-manual.db.gz",
        at: new Date("2026-11-02T08:00:01.000Z"),
      });
      expect(waits).toEqual([1000]);
      expect(readFileSync(join(folder, "app-20261102T080000Z-manual.db.gz"))).toEqual(first);
      expect(await labelsIn("app-20261102T080001Z-manual.db.gz")).toEqual(["kept", "later"]);
    });

    it("fails, and keeps the other backup, when its name stays taken", async () => {
      clockMoves = false;
      expect((await backUp("manual")).ok).toBe(true);
      const first = readFileSync(join(folder, "app-20261102T080000Z-manual.db.gz"));

      expect(await backUp("manual")).toEqual({ ok: false, failure: "write failed" });
      expect(waits).toHaveLength(3);
      expect(files()).toEqual(["app-20261102T080000Z-manual.db.gz"]);
      expect(readFileSync(join(folder, "app-20261102T080000Z-manual.db.gz"))).toEqual(first);
    });

    it.each([
      "app-20261102T080000Z-manual.db.tmp",
      "app-20261102T080000Z-manual.db.tmp-wal",
      "app-20261102T080000Z-manual.db.gz.tmp",
    ])(
      "never writes through, or deletes, a link planted at the temporary name %s",
      async (name) => {
        // A link to a file outside, and a link to nothing, which a write would make.
        const outside = join(dir, "outside.txt");
        writeFileSync(outside, "mine");
        const nothing = join(dir, "made-through-a-link");
        for (const target of [outside, nothing]) {
          symlinkSync(target, join(folder, name));

          expect(await backUp("manual")).toEqual({ ok: false, failure: "copy failed" });
          expect(files()).toEqual([name]);
          expect(readFileSync(outside, "utf8")).toBe("mine");
          expect(existsSync(nothing)).toBe(false);
          rmSync(join(folder, name));
        }
      },
    );
  });

  describe("a file with a backup's name but no real time, or a later time than now", () => {
    const IMPOSSIBLE = "app-99999999T999999Z-daily.db.gz";
    const FUTURE = "app-20301231T000000Z-daily.db.gz";

    it.each([IMPOSSIBLE, FUTURE])("never stops the daily backup: %s", async (name) => {
      plant("app-20261101T030000Z-daily.db.gz", 100);
      plant(name, 50);

      expect(await runDailyBackup()).toBe("done");
      expect(files()).toEqual(
        ["app-20261101T030000Z-daily.db.gz", "app-20261102T080000Z-daily.db.gz", name].sort(),
      );
      expect((await backupStatus()).lastBackupAt).toEqual(NOW);
    });

    it("is left out of the status when its time is not a real one, or later than now", async () => {
      plant(IMPOSSIBLE, 50);
      plant("app-20261131T030000Z-daily.db.gz", 50);
      plant(FUTURE, 50);
      plant("app-20261102T080001Z-migration.db.gz", 50);

      expect(await backupStatus()).toEqual({
        folder,
        readable: true,
        lastBackupAt: null,
        files: 0,
        bytes: 0,
      });
    });

    it("is never deleted when its time is not a real one", async () => {
      for (let day = 20; day < 30; day += 1) plant(`app-202610${day}T030000Z-daily.db.gz`);
      plant("app-00000000T000000Z-daily.db.gz");

      expect((await backUp("manual")).ok).toBe(true);
      expect(files()).toContain("app-00000000T000000Z-daily.db.gz");
    });
  });

  it("deletes the temporary files a stopped backup left, and nothing else", async () => {
    const leftovers = [
      "app-20261101T030000Z-daily.db.tmp",
      "app-20261101T030000Z-daily.db.tmp-wal",
      "app-20261101T030000Z-daily.db.tmp-shm",
      "app-20261101T030000Z-manual.db.gz.tmp",
      "app-20261101T030000Z-migration.db.tmp-journal",
    ];
    for (const name of leftovers) plant(name);
    const kept = [
      "app-20261101T030000Z-daily.db.gz",
      "notes.txt",
      "app-20261101T030000Z-daily.db.tmp.bak",
      "other-20261101T030000Z-daily.db.tmp",
    ];
    for (const name of kept) plant(name);
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "mine");
    symlinkSync(outside, join(folder, "app-20261101T040000Z-daily.db.tmp"));
    mkdirSync(join(folder, "app-20261101T050000Z-daily.db.tmp"));

    await deleteLeftoverBackupFiles();

    expect(files()).toEqual(
      [...kept, "app-20261101T040000Z-daily.db.tmp", "app-20261101T050000Z-daily.db.tmp"].sort(),
    );
    expect(readFileSync(outside, "utf8")).toBe("mine");
  });

  it("keeps the newest 7 regular backups and the newest 3 safety copies, and touches no other file", async () => {
    const daily = Array.from(
      { length: 9 },
      (_, i) => `app-202610${String(20 + i).padStart(2, "0")}T030000Z-daily.db.gz`,
    );
    const safety = [
      "app-20261001T120000Z-migration.db.gz",
      "app-20261005T120000Z-restore.db.gz",
      "app-20261010T120000Z-migration.db.gz",
      "app-20261015T120000Z-restore.db.gz",
    ];
    for (const name of [...daily, ...safety]) plant(name);
    const foreign = [
      "notes.txt",
      "app-20261001T030000Z-weekly.db.gz",
      "app-old.db.gz",
      "my-app-20261001T030000Z-daily.db.gz",
      "app-20261001T030000Z-daily.db.gz.bak",
    ];
    for (const name of foreign) plant(name);
    const outside = join(dir, "outside.db.gz");
    writeFileSync(outside, "mine");
    symlinkSync(outside, join(folder, "app-20260901T030000Z-daily.db.gz"));

    expect((await backUp("manual")).ok).toBe(true);

    expect(files()).toEqual(
      [
        "app-20261102T080000Z-manual.db.gz",
        ...daily.slice(3),
        ...safety.slice(1),
        ...foreign,
        "app-20260901T030000Z-daily.db.gz",
      ].sort(),
    );
    expect(readFileSync(outside, "utf8")).toBe("mine");
  });

  describe("the migration safety copy", () => {
    it("is a backup of kind migration, made through the same steps", async () => {
      const name = await takeMigrationCopy();

      expect(name).toBe("app-20261102T080000Z-migration.db.gz");
      expect(files()).toEqual([name]);
      expect(await labelsIn(name)).toEqual(["kept"]);
      expect(statSync(join(folder, name)).mode & 0o777).toBe(0o600);
    });

    it("keeps the last migration copy, and writes no file, while app.db has not changed since it", async () => {
      const first = await takeMigrationCopy();

      for (let start = 0; start < 3; start += 1) {
        clock = new Date(clock.getTime() + HOUR_MS);
        expect(await takeMigrationCopy()).toBe(first);
        expect(files()).toEqual([first]);
      }

      await test.database.$client.execute("INSERT INTO probe (label) VALUES ('new')");
      const second = await takeMigrationCopy();

      expect(second).toBe("app-20261102T110000Z-migration.db.gz");
      expect(files()).toEqual([first, second]);
      expect(await labelsIn(second)).toEqual(["kept", "new"]);
    });

    it.each([
      ["a restore copy of the same app.db", "restore", (same: Buffer) => gzipSync(same)],
      ["a migration copy it cannot read", "migration", () => Buffer.from("not gzip")],
      [
        "a migration copy one byte shorter",
        "migration",
        (same: Buffer) => gzipSync(same.subarray(0, -1)),
      ],
      [
        "a migration copy one byte longer",
        "migration",
        (same: Buffer) => gzipSync(Buffer.concat([same, Buffer.from([0])])),
      ],
      [
        "a migration copy with one byte changed",
        "migration",
        (same: Buffer) => {
          const changed = Buffer.from(same);
          changed[changed.length - 1] = (changed.at(-1) ?? 0) ^ 1;
          return gzipSync(changed);
        },
      ],
    ])("takes a new copy when the newest safety copy is %s", async (_case, kind, content) => {
      const first = await takeMigrationCopy();
      const newest = `app-20261102T083000Z-${kind}.db.gz`;
      writeFileSync(join(folder, newest), content(gunzipSync(readFileSync(join(folder, first)))));
      // Later than now, so neither counted nor compared.
      plant("app-20301231T000000Z-migration.db.gz");
      clock = new Date(clock.getTime() + HOUR_MS);

      const second = await takeMigrationCopy();

      expect(second).toBe("app-20261102T090000Z-migration.db.gz");
      expect(files()).toEqual(
        [first, newest, second, "app-20301231T000000Z-migration.db.gz"].sort(),
      );
    });

    it.each([
      ["VACUUM INTO cannot write", () => rmSync(folder, { recursive: true }), "copy failed"],
      ["the integrity check fails", () => (checkPasses = false), "check failed"],
    ])("throws, and leaves no file, when %s", async (_case, breakStep, failure) => {
      breakStep();

      const copy = takeMigrationCopy();

      await expect(copy).rejects.toThrow(SafetyCopyError);
      await expect(copy).rejects.toThrow(`(${failure})`);
      expect(existsSync(folder) ? files() : []).toEqual([]);
    });

    it("counts with the safety copies only: it deletes the oldest one, and never a regular backup", async () => {
      const regular = [
        ...Array.from({ length: 5 }, (_, i) => `app-2026102${i}T030000Z-daily.db.gz`),
        "app-20261025T090000Z-manual.db.gz",
        "app-20261026T090000Z-manual.db.gz",
      ];
      const safety = [
        "app-20261001T120000Z-migration.db.gz",
        "app-20261005T120000Z-restore.db.gz",
        "app-20261010T120000Z-migration.db.gz",
      ];
      // Later than now, as from a server whose clock ran ahead: never counted, so never deleted,
      // and never a reason to delete the new copy.
      const later = [
        "app-20261201T120000Z-migration.db.gz",
        "app-20261202T120000Z-migration.db.gz",
        "app-20261203T120000Z-restore.db.gz",
      ];
      // Names the app never wrote, and a time that is not a real one.
      const foreign = [
        "app-20261131T120000Z-migration.db.gz",
        "app-20261002T120000Z-migration.db.gz;",
        "app-20261002T120000Z-migration.db.gz{",
        "app-20261002T120000Z-migration%2edb.gz",
        "app-20261002T120000Z-migration．db.gz",
        "app-20261002T120000Z-migration.db.gz\t",
        " app-20261002T120000Z-migration.db.gz",
      ];
      for (const name of [...regular, ...safety, ...later, ...foreign]) plant(name);

      const name = await takeMigrationCopy();

      expect(files()).toEqual([name, ...regular, ...safety.slice(1), ...later, ...foreign].sort());
    });
  });

  it("deletes nothing after a failed backup", async () => {
    const daily = Array.from(
      { length: 9 },
      (_, i) => `app-202610${String(20 + i).padStart(2, "0")}T030000Z-daily.db.gz`,
    );
    for (const name of daily) plant(name);
    checkPasses = false;

    expect((await backUp("manual")).ok).toBe(false);
    expect(files()).toEqual(daily);
  });

  it("shows the folder, the last backup, the number of files, and their total size", async () => {
    expect(await backupStatus()).toEqual({
      folder,
      readable: true,
      lastBackupAt: null,
      files: 0,
      bytes: 0,
    });

    plant("app-20261101T030000Z-daily.db.gz", 100);
    plant("app-20261101T120000Z-migration.db.gz", 50);
    plant("notes.txt", 1000);

    expect(await backupStatus()).toEqual({
      folder,
      readable: true,
      lastBackupAt: new Date("2026-11-01T12:00:00.000Z"),
      files: 2,
      bytes: 150,
    });
  });

  describe("the daily backup", () => {
    it("runs when the newest regular backup is older than the most recent 3:00 AM", async () => {
      plant("app-20261101T030000Z-daily.db.gz");
      // A newer safety copy is not a regular backup.
      plant("app-20261102T040000Z-migration.db.gz");

      expect(await runDailyBackup()).toBe("done");
      expect(files()).toContain("app-20261102T080000Z-daily.db.gz");
    });

    it("runs at start with no backup yet", async () => {
      expect(await runDailyBackup()).toBe("done");
      expect(files()).toEqual(["app-20261102T080000Z-daily.db.gz"]);
    });

    it("does not run when a regular backup is newer than the most recent 3:00 AM", async () => {
      plant("app-20261102T030000Z-daily.db.gz");
      expect(await runDailyBackup()).toBe("not due");

      plant("app-20261102T050000Z-manual.db.gz");
      expect(await runDailyBackup()).toBe("not due");
      expect(files()).toEqual([
        "app-20261102T030000Z-daily.db.gz",
        "app-20261102T050000Z-manual.db.gz",
      ]);
    });

    it("uses 3:00 AM Household time once the Household facts set a time zone", async () => {
      timeZone = "America/New_York";
      // 3:00 AM in New York on Nov 2, 2026 is 08:00 UTC, after the clocks went back on Nov 1.
      plant("app-20261102T050000Z-daily.db.gz");
      clock = new Date("2026-11-02T07:59:59.000Z");
      expect(await runDailyBackup()).toBe("not due");

      clock = new Date("2026-11-02T08:00:00.000Z");
      expect(await runDailyBackup()).toBe("done");
    });

    it("tries once more an hour later, then raises one System notice, which stays until a backup works", async () => {
      checkPasses = false;

      expect(await runDailyBackup()).toBe("retrying");
      expect(retries).toEqual([new Date(NOW.getTime() + HOUR_MS)]);
      expect(await openNotices()).toEqual([]);

      clock = new Date(NOW.getTime() + HOUR_MS);
      expect(await runDailyBackup(true)).toBe("failed");
      expect(retries).toHaveLength(1);
      const [notice] = await openNotices();
      expect(notice).toMatchObject({ kind: "condition", condition: BACKUP_FAILED });
      expect(notice?.text).toContain("The daily backup failed twice.");

      // A backup that always fails stops: a failed retry starts no other, and keeps one notice.
      expect(await runDailyBackup(true)).toBe("failed");
      expect(retries).toHaveLength(1);
      expect(await openNotices()).toHaveLength(1);
      expect(files()).toEqual([]);

      checkPasses = true;
      expect((await backUp("manual")).ok).toBe(true);
      expect(await openNotices()).toEqual([]);
    });

    it("raises the notice at once when its retry cannot start", async () => {
      checkPasses = false;
      retryStarts = false;

      expect(await runDailyBackup()).toBe("failed");
      expect(await openNotices()).toHaveLength(1);
    });

    it("skips its retry when a backup worked in the meantime", async () => {
      checkPasses = false;
      expect(await runDailyBackup()).toBe("retrying");

      checkPasses = true;
      clock = new Date(NOW.getTime() + HOUR_MS / 2);
      expect((await backUp("manual")).ok).toBe(true);
      clock = new Date(NOW.getTime() + HOUR_MS);

      expect(await runDailyBackup(true)).toBe("not due");
      expect(await openNotices()).toEqual([]);
    });
  });
});

describe("the most recent 3:00 AM", () => {
  it.each([
    ["UTC", "2026-11-02T08:00:00.000Z", "2026-11-02T03:00:00.000Z"],
    ["UTC", "2026-11-02T02:59:59.000Z", "2026-11-01T03:00:00.000Z"],
    ["UTC", "2026-11-02T03:00:00.000Z", "2026-11-02T03:00:00.000Z"],
    ["America/New_York", "2026-11-02T07:00:00.000Z", "2026-11-01T08:00:00.000Z"],
    ["America/New_York", "2026-11-02T09:00:00.000Z", "2026-11-02T08:00:00.000Z"],
    // The clocks go back on Nov 1, 2026: 3:00 AM that day is EST.
    ["America/New_York", "2026-11-01T07:30:00.000Z", "2026-10-31T07:00:00.000Z"],
    ["America/New_York", "2026-11-01T08:00:00.000Z", "2026-11-01T08:00:00.000Z"],
    // The clocks go forward on Mar 8, 2026: 3:00 AM that day is EDT.
    ["America/New_York", "2026-03-08T07:30:00.000Z", "2026-03-08T07:00:00.000Z"],
    ["America/New_York", "2026-03-08T06:59:00.000Z", "2026-03-07T08:00:00.000Z"],
  ])("in %s at %s is %s", (zone, now, latest) => {
    expect(latestBackupTime(new Date(now), zone).toISOString()).toBe(latest);
  });
});

describe("the backup folder", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fft-backup-folder-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to /data/backups, and makes it, when /backups is a plain folder", async () => {
    const mounted = join(dir, "backups");
    mkdirSync(mounted);
    const fallback = join(dir, "data", "backups");

    expect(await chooseBackupFolder({ mounted, fallback })).toBe(fallback);
    expect(statSync(fallback).isDirectory()).toBe(true);
  });

  it("falls back to /data/backups when /backups is missing", async () => {
    const fallback = join(dir, "data", "backups");

    expect(await chooseBackupFolder({ mounted: join(dir, "backups"), fallback })).toBe(fallback);
  });

  // /proc is a mount of its own on every Linux system. The check only reads its file system ID.
  it.runIf(process.platform === "linux")(
    "uses /backups when it is a mount of its own, and makes no fallback folder",
    async () => {
      const fallback = join(dir, "data", "backups");

      expect(await chooseBackupFolder({ mounted: "/proc", fallback })).toBe("/proc");
      expect(existsSync(fallback)).toBe(false);
    },
  );
});

// The compare of a new safety copy with the last one (spec 10, Startup, step 4). A copy it cannot
// read counts as changed, so the start takes a new copy. Each case reads the last copy from a real
// file, and most give the new copy's bytes only after a wait, so the gunzip reaches its error or
// its end before the compare reads from it. Every stream ends destroyed, so no file stays open, and
// an error after the compare has stopped has a handler: vitest fails the run on an unhandled one.
describe("the compare with the last safety copy", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fft-backup-compare-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // A safety copy on disk with these bytes.
  const lastCopy = (bytes: Buffer) => {
    const path = join(dir, "app-20261102T080000Z-migration.db.gz");
    writeFileSync(path, bytes);
    return createReadStream(path);
  };

  // The new copy, which gives its bytes only after the wait.
  const newCopy = (bytes: Buffer, waitMs = 100) =>
    Readable.from(
      (async function* () {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        yield bytes;
      })(),
    );

  // A new copy whose read fails at once.
  const unreadableCopy = () =>
    new Readable({
      read() {
        this.destroy(Object.assign(new Error("read failed"), { code: "EIO" }));
      },
    });

  // About 1 MB of bytes that gzip cannot shrink, so the last copy is more than a file stream reads
  // in one chunk.
  const database = Buffer.alloc(1024 * 1024);
  let seed = 0x9e3779b9;
  for (let i = 0; i < database.length; i += 1) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    database[i] = seed & 0xff;
  }

  it("is the same for the same bytes", async () => {
    const plain = newCopy(database);
    const gzipped = lastCopy(gzipSync(database));

    expect(await sameAsGzipped(plain, gzipped)).toBe(true);
    expect([plain.destroyed, gzipped.destroyed]).toEqual([true, true]);
  });

  it("stops at the first difference, and closes the last copy's file", async () => {
    const changed = Buffer.from(database);
    changed[0] = (changed[0] ?? 0) ^ 1;
    const plain = newCopy(changed, 0);
    const gzipped = lastCopy(gzipSync(database));

    expect(await sameAsGzipped(plain, gzipped)).toBe(false);
    expect([plain.destroyed, gzipped.destroyed]).toEqual([true, true]);
  });

  it.each([
    ["is not gzip", Buffer.from("not gzip"), "Z_DATA_ERROR"],
    ["is a gzip cut short", gzipSync(database).subarray(0, 4096), "Z_BUF_ERROR"],
  ])("fails, with no unhandled error, when the last copy %s", async (_case, bytes, code) => {
    const plain = newCopy(database);
    const gzipped = lastCopy(bytes);

    await expect(sameAsGzipped(plain, gzipped)).rejects.toMatchObject({ code });
    expect([plain.destroyed, gzipped.destroyed]).toEqual([true, true]);
  });

  it("fails when the last copy's file cannot be read", async () => {
    const plain = newCopy(database);
    const gzipped = createReadStream(join(dir, "app-20261102T080000Z-migration.db.gz"));

    await expect(sameAsGzipped(plain, gzipped)).rejects.toMatchObject({ code: "ENOENT" });
    expect([plain.destroyed, gzipped.destroyed]).toEqual([true, true]);
  });

  it("fails, with no unhandled error, when the new copy cannot be read and the last is not gzip", async () => {
    const plain = unreadableCopy();
    const gzipped = lastCopy(Buffer.from("not gzip"));

    await expect(sameAsGzipped(plain, gzipped)).rejects.toMatchObject({ code: "EIO" });
    expect([plain.destroyed, gzipped.destroyed]).toEqual([true, true]);
    // The gunzip's own error, after the compare has stopped, comes by now if it comes at all.
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});
