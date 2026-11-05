import { createReadStream, createWriteStream } from "node:fs";
import { lstat, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
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
  type BackupKind,
  backupNames,
  deleteLeftoverFiles,
  deleteOldBackups,
  isRegular,
  listBackups,
} from "./files.ts";

// Backups of app.db (spec 11, How the app makes a backup; When backups run; When a backup fails).
// A backup holds only app.db: never jobs.db, the Master key, the Compose file, or .env. It is a
// gzipped plain SQLite file, which the app does not encrypt. The steps: VACUUM INTO a temporary
// file in the backup folder while the app keeps running, the integrity check on the copy, gzip,
// and a rename to the final name. After each successful backup, the app deletes the backups past
// the ones it keeps. Backups run one at a time.

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

// Whether anything is at `path`: a file, a folder, or a link, even one to nothing.
async function taken(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => undefined)) !== undefined;
}

// Deletes a backup's temporary files, the files SQLite may keep beside the copy included. A link or
// a folder with such a name stays.
async function deleteTemporaryFiles(paths: string[]): Promise<void> {
  for (const path of paths) {
    try {
      if ((await lstat(path).catch(() => undefined))?.isFile()) await unlink(path);
    } catch (error) {
      log.error("Could not delete a backup's temporary file", errorFields(error));
    }
  }
}

// The time and names of a new backup. A backup never replaces another: when one of this kind
// already has this second's name, it waits for the next second, a few times at most.
async function freeNames(
  services: BackupServices,
  kind: BackupKind,
): Promise<{ at: Date; names: ReturnType<typeof backupNames> } | undefined> {
  for (let tries = 0; tries < NAME_TRIES; tries += 1) {
    const at = services.now();
    const names = backupNames(kind, at);
    if (!(await taken(join(services.folder, names.name)))) return { at, names };
    await services.wait(1000 - (at.getTime() % 1000));
  }
  return undefined;
}

const NAME_TRIES = 3;

// Backups hold readable history, so only the app's user may read them, as with the Master key file.
const BACKUP_MODE = 0o600;

async function makeBackup(services: BackupServices, kind: BackupKind): Promise<BackupResult> {
  const free = await freeNames(services, kind).catch(() => undefined);
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
  for (const path of temporary) {
    if (await taken(path)) {
      log.error("A backup failed: a temporary name was taken", { kind });
      return { ok: false, failure: "copy failed" };
    }
  }
  let step: BackupFailure = "copy failed";
  try {
    await copyDatabaseInto(services.database, copy);
    step = "check failed";
    if (!(await services.checkCopy(copy))) {
      log.error("A backup's copy failed its integrity check", { kind });
      return { ok: false, failure: step };
    }
    step = "write failed";
    // "wx" refuses a path that exists, so the gzip never writes through a link.
    await pipeline(
      createReadStream(copy),
      createGzip(),
      createWriteStream(packed, { flags: "wx", mode: BACKUP_MODE, flush: true }),
    );
    if (await taken(final)) throw new Error("The backup's name was taken.");
    await rename(packed, final);
  } catch (error) {
    log.error("A backup failed", { kind, failure: step, ...errorFields(error) });
    return { ok: false, failure: step };
  } finally {
    await deleteTemporaryFiles(temporary);
  }
  log.info("Made a backup", { kind, file: names.name });
  try {
    const deleted = await deleteOldBackups(services.folder);
    if (deleted.length > 0) log.info("Deleted old backups", { count: deleted.length });
  } catch (error) {
    log.error("Could not delete old backups", errorFields(error));
  }
  await endBackupFailed(services.database);
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
  return oneAtATime(() => makeBackup(started, kind));
}

// At start, before any backup runs: deletes the temporary files a stopped backup left behind.
export function deleteLeftoverBackupFiles(): Promise<void> {
  const { folder } = running();
  return oneAtATime(async () => {
    try {
      const deleted = await deleteLeftoverFiles(folder);
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
// marks the day done. A folder the app cannot read counts as due, so the backup fails and is
// retried.
async function dailyBackupDue(services: BackupServices): Promise<boolean> {
  const timeZone = (await services.timeZone()) ?? "UTC";
  const now = services.now();
  const latest = latestBackupTime(now, timeZone);
  try {
    const backups = await listBackups(services.folder);
    return !backups.some((file) => isRegular(file.kind) && file.at >= latest && file.at <= now);
  } catch {
    return true;
  }
}

export type DailyBackupResult = "not due" | "done" | "retrying" | "failed";

// The daily backup, when it is due. It runs at 3:00 AM, Household time, from the startup check,
// and as its own retry. A failed first try starts one retry an hour later. A failed retry, or a
// retry that cannot start, raises one System notice to every Member, which stays until a backup
// works. It never throws for a failed backup.
export function runDailyBackup(retry = false): Promise<DailyBackupResult> {
  const started = running();
  return oneAtATime(async () => {
    if (!(await dailyBackupDue(started))) return "not due";
    const result = await makeBackup(started, "daily");
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
  // The newest backup's time, of any kind, that is not later than now, or null.
  lastBackupAt: Date | null;
  files: number;
  bytes: number;
};

// What Settings show: the folder in use, the last successful backup, the number of files, and their
// total size.
export async function backupStatus(): Promise<BackupStatus> {
  const { folder, now } = running();
  try {
    const backups = await listBackups(folder);
    const moment = now();
    return {
      folder,
      readable: true,
      lastBackupAt: backups.find((file) => file.at <= moment)?.at ?? null,
      files: backups.length,
      bytes: backups.reduce((sum, file) => sum + file.bytes, 0),
    };
  } catch (error) {
    log.error("Could not read the backup folder", errorFields(error));
    return { folder, readable: false, lastBackupAt: null, files: 0, bytes: 0 };
  }
}
