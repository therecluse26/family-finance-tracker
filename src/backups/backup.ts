import { createReadStream, createWriteStream } from "node:fs";
import { lstat, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import {
  checkDatabaseCopy,
  copyDatabaseInto,
  type Database,
  listOpenNotices,
} from "../db/index.ts";
import { daily, Job, type JobArgument, startJob } from "../jobs/index.ts";
import { log } from "../log.ts";
import { endCondition, raiseNotice } from "../notify/index.ts";
import {
  type BackupFile,
  type BackupKind,
  backupNames,
  deleteLeftoverFiles,
  deleteOldBackups,
  isRegular,
  listBackups,
} from "./files.ts";
import {
  FOLDER_CALL_LIMIT_MS,
  type FolderCall,
  FolderHungError,
  folderCalls,
  missingUnlessHung,
} from "./folder-calls.ts";

// Backups of app.db (spec 11, How the app makes a backup; When backups run; When a backup fails).
// A backup holds only app.db: never jobs.db, the Master key, the Compose file, or .env. It is a
// gzipped plain SQLite file, which the app does not encrypt. The steps: VACUUM INTO a temporary
// file in the backup folder while the app keeps running, the integrity check on the copy, gzip,
// and a rename to the final name. After each successful backup, the app deletes the backups past
// the ones it keeps. Backups run one at a time.
//
// The `migration` safety copy runs at start, when migrations are pending, through the same steps.
// It runs before the migrations, so a failed one stops the start with app.db unchanged. When
// app.db has not changed since the last migration copy, it keeps that one and writes no file.

// The daily backup's time, Household time.
export const BACKUP_SCHEDULE = daily("03:00");

// A failed daily backup tries once more, an hour later.
export const RETRY_AFTER_MS = 60 * 60 * 1000;

// The condition of the System notice for a daily backup that failed its retry. It ends when any
// backup succeeds.
export const BACKUP_FAILED = "backup failed";

const BACKUP_FAILED_TEXT =
  "The daily backup failed twice. Check that the backup folder has free space and that the app can write to it, then choose Back up now in Settings, Backups and data. This notice stays until a backup works.";

// The argument of the daily backup's retry job.
const RETRY = "retry";

// Why a backup failed: VACUUM INTO, the integrity check, or the gzip and rename.
export type BackupFailure = "copy failed" | "check failed" | "write failed";

export type BackupResult =
  | { ok: true; name: string; at: Date }
  | { ok: false; failure: BackupFailure };

type BackupServices = {
  database: Database;
  folder: string;
  timeZone: () => Promise<string | undefined>;
  now: () => Date;
  startRetry: (at: Date) => Promise<unknown>;
  checkCopy: (path: string) => Promise<boolean>;
  wait: (ms: number) => Promise<void>;
  folderLimitMs: number;
};

export type BackupOptions = {
  database: Database;
  // The backup folder in use, from chooseBackupFolder.
  folder: string;
  // The Household time zone, or undefined until the Household facts set it; then UTC.
  timeZone: () => Promise<string | undefined>;
  now?: () => Date;
  // Starts the daily backup's retry job, not before `at`. Tests record it.
  startRetry?: (at: Date) => Promise<unknown>;
  // The integrity check on the copy. Tests give one that fails.
  checkCopy?: (path: string) => Promise<boolean>;
  // Waits for the next second's name. Tests move their fake clock instead.
  wait?: (ms: number) => Promise<void>;
  // How long one call on the backup folder may go without an answer. Tests give a short one.
  folderLimitMs?: number;
};

let services: BackupServices | undefined;

function running(): BackupServices {
  if (services === undefined) throw new Error("Backups are not running.");
  return services;
}

// Gives backups app.db and the backup folder. The start calls it before jobs run.
export function startBackups(options: BackupOptions): { stop(): void } {
  if (services !== undefined) throw new Error("Backups are already running.");
  const started: BackupServices = {
    database: options.database,
    folder: options.folder,
    timeZone: options.timeZone,
    now: options.now ?? (() => new Date()),
    startRetry: options.startRetry ?? ((at) => startJob(BackupJob, [RETRY], { at })),
    checkCopy: options.checkCopy ?? checkDatabaseCopy,
    wait: options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    folderLimitMs: options.folderLimitMs ?? FOLDER_CALL_LIMIT_MS,
  };
  services = started;
  return {
    stop() {
      if (services === started) services = undefined;
    },
  };
}

// The app is one Node process (ADR 0002), so this queue keeps every backup, and the start's
// clean-up, one at a time.
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work);
  queue = run.catch(() => {});
  return run;
}

// What a log line may say about an error: its name and its code, such as ENOSPC or SQLITE_FULL.
function errorFields(error: unknown): { errorName: string; code?: string } {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    ...(typeof code === "string" ? { code } : {}),
  };
}

// Whether anything is at `path`: a file, a folder, or a link, even one to nothing. It throws when
// the folder is hung.
async function taken(path: string, call: FolderCall): Promise<boolean> {
  return (await call(() => lstat(path)).catch(missingUnlessHung)) !== undefined;
}

// Deletes a backup's temporary files, the files SQLite may keep beside the copy included. A link or
// a folder with such a name stays. A hung folder stops it; the next start deletes them.
async function deleteTemporaryFiles(paths: string[], call: FolderCall): Promise<void> {
  for (const path of paths) {
    try {
      if ((await call(() => lstat(path)).catch(missingUnlessHung))?.isFile()) {
        await call(() => unlink(path));
      }
    } catch (error) {
      log.error("Could not delete a backup's temporary file", errorFields(error));
      if (error instanceof FolderHungError) return;
    }
  }
}

// The time and names of a new backup. A backup never replaces another: when one of this kind
// already has this second's name, it waits for the next second, a few times at most. It throws when
// the folder is hung.
async function freeNames(
  services: BackupServices,
  kind: BackupKind,
  call: FolderCall,
): Promise<{ at: Date; names: ReturnType<typeof backupNames> } | undefined> {
  for (let tries = 0; tries < NAME_TRIES; tries += 1) {
    const at = services.now();
    const names = backupNames(kind, at);
    if (!(await taken(join(services.folder, names.name), call))) return { at, names };
    await services.wait(1000 - (at.getTime() % 1000));
  }
  return undefined;
}

const NAME_TRIES = 3;

// Whether two streams give the same bytes. It reads both a chunk at a time and stops at the first
// difference.
async function sameBytes(a: AsyncIterable<Buffer>, b: AsyncIterable<Buffer>): Promise<boolean> {
  const left = a[Symbol.asyncIterator]();
  const right = b[Symbol.asyncIterator]();
  let x: Buffer = Buffer.alloc(0);
  let y: Buffer = Buffer.alloc(0);
  let leftDone = false;
  let rightDone = false;
  try {
    for (;;) {
      if (x.length === 0 && !leftDone) {
        const next = await left.next();
        if (next.done) leftDone = true;
        else x = next.value;
      } else if (y.length === 0 && !rightDone) {
        const next = await right.next();
        if (next.done) rightDone = true;
        else y = next.value;
      } else if (x.length === 0 || y.length === 0) {
        // One stream has ended: the same only when both have, with nothing left.
        return x.length === 0 && y.length === 0;
      } else {
        const length = Math.min(x.length, y.length);
        if (!x.subarray(0, length).equals(y.subarray(0, length))) return false;
        x = x.subarray(length);
        y = y.subarray(length);
      }
    }
  } finally {
    await left.return?.();
    await right.return?.();
  }
}

// Whether `plain` gives the bytes that `gzipped` holds after gunzip. It throws when either cannot be
// read. The compare can stop early, at a difference or an error, so every stream is destroyed on
// every path, and no file stays open. The pipeline passes a read error of the file to the gunzip,
// where the compare ends with it; its own result only says how the pipe ended, so nothing waits on
// it. The compare's handler on the gunzip comes only with its first read there, after the new
// copy's first chunk, and the pipeline drops its own once the last byte is in, before the gunzip
// checks the end. So the gunzip keeps a handler of its own until it is destroyed; the error stays on
// it, and the compare ends with it.
export async function sameAsGzipped(plain: Readable, gzipped: Readable): Promise<boolean> {
  const unpacked = createGunzip().on("error", () => {});
  pipeline(gzipped, unpacked).catch(() => {});
  try {
    return await sameBytes(plain, unpacked);
  } finally {
    plain.destroy();
    unpacked.destroy();
    gzipped.destroy();
  }
}

// The newest safety copy, when it is a migration copy of the same database as the new copy at
// `path`, compared without gzip, whose bytes may differ. A start whose migration fails stops with
// app.db unchanged, and the restart takes its copy again; this keeps one copy of that app.db, so a
// restart loop never pushes out an older safety copy. A copy it cannot read counts as changed.
async function unchangedMigrationCopy(
  services: BackupServices,
  path: string,
  call: FolderCall,
): Promise<BackupFile | undefined> {
  try {
    const now = services.now();
    const newest = (await listBackups(services.folder, call)).find(
      (file) => !isRegular(file.kind) && file.at <= now,
    );
    if (newest?.kind !== "migration") return undefined;
    const same = await call((progress, signal) =>
      sameAsGzipped(
        createReadStream(path, { signal }),
        createReadStream(join(services.folder, newest.name), { signal }).on("data", progress),
      ),
    );
    return same ? newest : undefined;
  } catch (error) {
    log.warn("Could not compare the safety copy with the last one", errorFields(error));
    return undefined;
  }
}

// Backups hold readable history, so only the app's user may read them, as with the Master key file.
const BACKUP_MODE = 0o600;

// Every call on the backup folder goes through `call`, within its time limit. A hung folder fails
// the backup at the step it was on.
async function makeBackup(
  services: BackupServices,
  kind: BackupKind,
  call: FolderCall,
): Promise<BackupResult> {
  const free = await freeNames(services, kind, call).catch((error: unknown) =>
    error instanceof FolderHungError ? error : undefined,
  );
  if (free instanceof FolderHungError) {
    log.error("A backup failed", { kind, failure: "copy failed", ...errorFields(free) });
    return { ok: false, failure: "copy failed" };
  }
  if (free === undefined) {
    log.error("A backup failed: its name was taken", { kind });
    return { ok: false, failure: "write failed" };
  }
  const { at, names } = free;
  const copy = join(services.folder, names.copy);
  const packed = join(services.folder, names.packed);
  const final = join(services.folder, names.name);
  // A file or link already at a temporary name is not the app's to write through or delete.
  const temporary = [copy, `${copy}-wal`, `${copy}-shm`, `${copy}-journal`, packed];
  try {
    for (const path of temporary) {
      if (await taken(path, call)) {
        log.error("A backup failed: a temporary name was taken", { kind });
        return { ok: false, failure: "copy failed" };
      }
    }
  } catch (error) {
    log.error("A backup failed", { kind, failure: "copy failed", ...errorFields(error) });
    return { ok: false, failure: "copy failed" };
  }
  let step: BackupFailure = "copy failed";
  try {
    await call(() => copyDatabaseInto(services.database, copy));
    step = "check failed";
    if (!(await call(() => services.checkCopy(copy)))) {
      log.error("A backup's copy failed its integrity check", { kind });
      return { ok: false, failure: step };
    }
    if (kind === "migration") {
      const kept = await unchangedMigrationCopy(services, copy, call);
      if (kept !== undefined) {
        log.info("Kept the safety copy: app.db has not changed since it", { file: kept.name });
        return { ok: true, name: kept.name, at: kept.at };
      }
    }
    step = "write failed";
    // "wx" refuses a path that exists, so the gzip never writes through a link. Each chunk read
    // starts the time limit again, so only a stalled read or write runs out.
    await call((progress, signal) =>
      pipeline(
        createReadStream(copy).on("data", progress),
        createGzip(),
        createWriteStream(packed, { flags: "wx", mode: BACKUP_MODE, flush: true }),
        { signal },
      ),
    );
    if (await taken(final, call)) throw new Error("The backup's name was taken.");
    await call(() => rename(packed, final));
  } catch (error) {
    log.error("A backup failed", { kind, failure: step, ...errorFields(error) });
    return { ok: false, failure: step };
  } finally {
    await deleteTemporaryFiles(temporary, call);
  }
  log.info("Made a backup", { kind, file: names.name });
  try {
    const deleted = await deleteOldBackups(services.folder, services.now(), call);
    if (deleted.length > 0) log.info("Deleted old backups", { count: deleted.length });
  } catch (error) {
    log.error("Could not delete old backups", errorFields(error));
  }
  // A migration copy runs before the migrations and before the notify module starts, so the next
  // regular backup ends the notice.
  if (kind !== "migration") await endBackupFailed(services.database);
  return { ok: true, name: names.name, at };
}

// A backup worked, so the failed-backup notice ends. It writes only when that notice is open, so a
// backup while another connection holds a long write never waits on it. A failure here leaves the
// backup made.
async function endBackupFailed(database: Database): Promise<void> {
  try {
    const open = await listOpenNotices(database);
    if (open.some((notice) => notice.condition === BACKUP_FAILED))
      await endCondition(BACKUP_FAILED);
  } catch (error) {
    log.error("Could not end the failed-backup notice", errorFields(error));
  }
}

// Makes a backup of this kind now. It never throws for a failed backup.
export function backUp(kind: BackupKind): Promise<BackupResult> {
  const started = running();
  return oneAtATime(() => makeBackup(started, kind, folderCalls(started.folderLimitMs)));
}

export class SafetyCopyError extends Error {
  override name = "SafetyCopyError";
}

// The `migration` safety copy (spec 10, Startup, step 4), at start, after the refusals and before
// the migrations. It returns the copy's name, or the last migration copy's name when app.db has not
// changed since that one. It throws when the copy fails, so the start stops before it migrates.
// The failed backup's line says which step failed.
export async function takeMigrationCopy(): Promise<string> {
  const result = await backUp("migration");
  if (result.ok) return result.name;
  throw new SafetyCopyError(
    `The safety copy before migrations failed (${result.failure}), so the app stopped before it ` +
      "changed app.db. Check that the backup folder has free space and that the app can write " +
      "to it, then start the app again.",
  );
}

// At start, before any backup runs: deletes the temporary files a stopped backup left behind.
export function deleteLeftoverBackupFiles(): Promise<void> {
  const { folder, folderLimitMs } = running();
  return oneAtATime(async () => {
    try {
      const deleted = await deleteLeftoverFiles(folder, folderCalls(folderLimitMs));
      if (deleted > 0) log.info("Deleted a stopped backup's temporary files", { count: deleted });
    } catch (error) {
      log.error("Could not delete a stopped backup's temporary files", errorFields(error));
    }
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

// The most recent 3:00 AM, Household time, at or before `now`. Days are 23 to 25 hours long, so
// one falls within the 27 hours before now.
export function latestBackupTime(now: Date, timeZone: string): Date {
  let latest = BACKUP_SCHEDULE.next(
    new Date(now.getTime() - DAY_MS - 3 * 60 * 60 * 1000),
    timeZone,
  );
  for (
    let next = BACKUP_SCHEDULE.next(latest, timeZone);
    next <= now;
    next = BACKUP_SCHEDULE.next(latest, timeZone)
  ) {
    latest = next;
  }
  return latest;
}

// A daily backup is due when no regular backup is from the most recent 3:00 AM up to now. A backup
// that names a later time than now, such as one copied from a server whose clock ran ahead, never
// marks the day done. A folder the app cannot read, or that does not answer in time, counts as due,
// so the backup fails and is retried.
async function dailyBackupDue(services: BackupServices, call: FolderCall): Promise<boolean> {
  const timeZone = (await services.timeZone()) ?? "UTC";
  const now = services.now();
  const latest = latestBackupTime(now, timeZone);
  try {
    const backups = await listBackups(services.folder, call);
    return !backups.some((file) => isRegular(file.kind) && file.at >= latest && file.at <= now);
  } catch {
    return true;
  }
}

export type DailyBackupResult = "not due" | "done" | "retrying" | "failed";

// The daily backup, when it is due. It runs at 3:00 AM, Household time, from the startup check,
// and as its own retry. A failed first try starts one retry an hour later. A failed retry, or a
// retry that cannot start, raises one System notice to every Member, which stays until a backup
// works. It never throws for a failed backup. A hung backup folder fails it within one time limit,
// so the stop never waits on it for good.
export function runDailyBackup(retry = false): Promise<DailyBackupResult> {
  const started = running();
  return oneAtATime(async () => {
    const call = folderCalls(started.folderLimitMs);
    if (!(await dailyBackupDue(started, call))) return "not due";
    const result = await makeBackup(started, "daily", call);
    if (result.ok) return "done";
    if (!retry) {
      const at = new Date(started.now().getTime() + RETRY_AFTER_MS);
      try {
        await started.startRetry(at);
        log.warn("The daily backup failed; it tries again in an hour", { at: at.toISOString() });
        return "retrying";
      } catch (error) {
        log.error("The daily backup's retry did not start", errorFields(error));
      }
    }
    await raiseNotice({ kind: "condition", condition: BACKUP_FAILED, text: BACKUP_FAILED_TEXT });
    return "failed";
  });
}

// The daily backup's job: at 3:00 AM, Household time, with no argument, and as the retry an hour
// after a failed first try. It is safe to run twice: a second run finds the backup done.
export class BackupJob extends Job {
  override async run(...args: JobArgument[]): Promise<void> {
    await runDailyBackup(args[0] === RETRY);
  }
}

export type BackupStatus = {
  folder: string;
  // False when the app cannot read the folder.
  readable: boolean;
  // The newest backup's time, of any kind, or null. Each field counts only backups that name no
  // later time than now.
  lastBackupAt: Date | null;
  files: number;
  bytes: number;
};

// What Settings show: the folder in use, the last successful backup, the number of files, and their
// total size. A backup that names a later time than now is left out, as retention leaves it out.
export async function backupStatus(): Promise<BackupStatus> {
  const { folder, now, folderLimitMs } = running();
  try {
    const moment = now();
    const backups = (await listBackups(folder, folderCalls(folderLimitMs))).filter(
      (file) => file.at <= moment,
    );
    return {
      folder,
      readable: true,
      lastBackupAt: backups[0]?.at ?? null,
      files: backups.length,
      bytes: backups.reduce((sum, file) => sum + file.bytes, 0),
    };
  } catch (error) {
    log.error("Could not read the backup folder", errorFields(error));
    return { folder, readable: false, lastBackupAt: null, files: 0, bytes: 0 };
  }
}
