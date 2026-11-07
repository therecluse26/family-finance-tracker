import type * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import type * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listOpenNotices } from "../db/index.ts";
import { newTestDatabase, type TestDatabase } from "../db/testing.ts";
import { startNotify } from "../notify/index.ts";
import {
  BACKUP_FAILED,
  backUp,
  backupStatus,
  deleteLeftoverBackupFiles,
  runDailyBackup,
  startBackups,
} from "./index.ts";

// Backups on a backup folder that stops answering, as a stale network mount does (spec 11, When a
// backup fails). Each call named in `hung.calls` waits when its path is in the folder, as a call
// on a hung mount does, until `answer()` runs it, as the mount does when it comes back.

const hung = vi.hoisted(() => ({
  calls: new Set<string>(),
  folder: "/nowhere",
  // How many calls the app started on the folder.
  started: 0,
  // The calls that wait for the folder to answer.
  waiting: [] as (() => Promise<unknown>)[],
}));

const inFolder = (path: unknown) => String(path).startsWith(hung.folder);

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fsPromises>();
  // The call, which waits for `answer()` when the folder is hung for it.
  const hangable = <F>(call: string, real: F): F =>
    ((...args: unknown[]) => {
      const run = () => (real as (...args: unknown[]) => Promise<unknown>)(...args);
      if (!inFolder(args[0])) return run();
      hung.started += 1;
      if (!hung.calls.has(call)) return run();
      return new Promise((resolve, reject) => {
        hung.waiting.push(() => run().then(resolve, reject));
      });
    }) as F;
  return {
    ...actual,
    readdir: hangable("readdir", actual.readdir),
    lstat: hangable("lstat", actual.lstat),
    writeFile: hangable("writeFile", actual.writeFile),
    rename: hangable("rename", actual.rename),
  };
});

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    // A write stream whose writes are never done.
    createWriteStream: ((path, options) => {
      if (inFolder(path)) hung.started += 1;
      return inFolder(path) && hung.calls.has("createWriteStream")
        ? new Writable({ write() {} })
        : actual.createWriteStream(path, options);
    }) as typeof actual.createWriteStream,
  };
});

// The folder answers again: every waiting call runs and settles.
async function answer(): Promise<void> {
  hung.calls.clear();
  await Promise.allSettled(hung.waiting.splice(0).map((run) => run()));
  await new Promise((resolve) => setImmediate(resolve));
}

const NOW = new Date("2026-11-02T08:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const LIMIT_MS = 100;
// Far past the limit, and far under any wait for good.
const SETTLES_WITHIN_MS = 3000;

// The promise's value, or "still waiting" when it does not settle in time.
async function within<T>(promise: Promise<T>): Promise<T | "still waiting"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"still waiting">((resolve) => {
    timer = setTimeout(() => resolve("still waiting"), SETTLES_WITHIN_MS);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

describe("backups on a hung backup folder", () => {
  let test: TestDatabase;
  let dir: string;
  let folder: string;
  let clock: Date;
  let retries: Date[];
  let stops: (() => void)[];

  beforeEach(async () => {
    test = await newTestDatabase();
    dir = mkdtempSync(join(tmpdir(), "fft-hung-backups-"));
    folder = join(dir, "backups");
    mkdirSync(folder);
    hung.folder = folder;
    hung.calls.clear();
    hung.started = 0;
    clock = NOW;
    retries = [];
    stops = [
      startNotify({ database: test.database }).stop,
      startBackups({
        database: test.database,
        folder,
        timeZone: async () => undefined,
        now: () => clock,
        startRetry: async (at) => {
          retries.push(at);
        },
        checkCopy: async () => true,
        wait: async (ms) => {
          clock = new Date(clock.getTime() + ms);
        },
        folderLimitMs: LIMIT_MS,
      }).stop,
    ];
  });

  afterEach(async () => {
    await answer();
    for (const stop of stops) stop();
    test.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const openNotices = async () =>
    (await listOpenNotices(test.database)).filter((notice) => notice.condition === BACKUP_FAILED);
  const backups = () => readdirSync(folder).filter((name) => name.endsWith(".db.gz"));

  it.each([
    ["the due check's folder list", "readdir"],
    ["the check for a free name", "lstat"],
    ["the copy's first write", "writeFile"],
    ["the gzip's write", "createWriteStream"],
    ["the rename to the final name", "rename"],
  ])(
    "fails the daily backup within the limit when %s never answers, raises one notice, and the next backup runs",
    async (_what, call) => {
      hung.calls.add(call);

      // The startup check, which the stop waits on, ends, and starts the retry.
      expect(await within(runDailyBackup())).toBe("retrying");
      expect(retries).toEqual([new Date(NOW.getTime() + HOUR_MS)]);
      expect(await openNotices()).toEqual([]);

      clock = new Date(NOW.getTime() + HOUR_MS);
      expect(await within(runDailyBackup(true))).toBe("failed");
      expect(await openNotices()).toHaveLength(1);
      expect(await within(runDailyBackup(true))).toBe("failed");
      expect(await openNotices()).toHaveLength(1);
      expect(retries).toHaveLength(1);
      expect(backups()).toEqual([]);

      // The folder answers again: the next backup does not wait behind the hung call. (A rename
      // that waited finishes the first try's backup as it answers.)
      await answer();
      clock = new Date(NOW.getTime() + 2 * HOUR_MS);
      expect(await within(backUp("manual"))).toEqual(expect.objectContaining({ ok: true }));
      expect(backups()).toContain("app-20261102T100000Z-manual.db.gz");
      expect(await openNotices()).toEqual([]);
    },
  );

  it("ends Back up now and the start's clean-up within the limit, and the next backup runs", async () => {
    hung.calls.add("readdir");
    hung.calls.add("lstat");

    expect(await within(deleteLeftoverBackupFiles())).toBeUndefined();
    expect(await within(backUp("manual"))).toEqual({ ok: false, failure: "copy failed" });

    await answer();
    expect(await within(backUp("manual"))).toEqual(expect.objectContaining({ ok: true }));
    expect(backups()).toEqual(["app-20261102T080000Z-manual.db.gz"]);
  });

  it("starts no new call on the folder while a call that ran out of time waits, until it answers", async () => {
    hung.calls.add("readdir");
    expect(await within(runDailyBackup())).toBe("retrying");
    const started = hung.started;
    expect(hung.waiting).toHaveLength(1);

    // Its retry, two Back up nows and two Settings status reads each fail at once.
    expect(await within(runDailyBackup(true))).toBe("failed");
    expect(await within(backUp("manual"))).toEqual({ ok: false, failure: "copy failed" });
    expect(await within(backUp("manual"))).toEqual({ ok: false, failure: "copy failed" });
    expect(await within(backupStatus())).toEqual(expect.objectContaining({ readable: false }));
    expect(await within(backupStatus())).toEqual(expect.objectContaining({ readable: false }));

    expect(hung.started).toBe(started);
    expect(hung.waiting).toHaveLength(1);
    expect(await openNotices()).toHaveLength(1);

    await answer();
    expect(await within(backUp("manual"))).toEqual(expect.objectContaining({ ok: true }));
    expect(await openNotices()).toEqual([]);
  });
});
