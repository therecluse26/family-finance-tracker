import { constants, createWriteStream, existsSync } from "node:fs";
import { type FileHandle, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import {
  type BackupResult,
  backUp,
  backupNameOf,
  chooseBackupFolder,
  startBackups,
} from "../backups/index.ts";
import {
  applyMigrations,
  checkDatabaseCopy,
  checkMigrations,
  closeDatabase,
  type Database,
  forgetUnreadableSecrets,
  openDatabase,
  openDatabaseCopy,
  type RestoreLosses,
  readRestoreLosses,
} from "../db/index.ts";
import {
  decryptsDataKey,
  findMasterKey,
  type MasterKey,
  masterKeyFile,
  sealNewDataKey,
} from "../secrets/index.ts";
import { type LockRefusal, takeRunningLock } from "../server/running-lock.ts";
import type { FftIo } from "./io.ts";
import { writeMasterKey } from "./setup.ts";

// `fft restore <file>` (spec 11, Restore; spec 12, `fft restore <file>`). The self-hoster stops the
// app and runs it on the server. No web page or API route restores: every Member has equal powers,
// so a web restore would let any Member overwrite all data. Its steps, in the spec's order:
// 1. It refuses to run while the app, or another restore, holds the running lock in /data.
// 2. It finds the file: a bare file name means a file in the backup folder, and a path must name a
//    file in that folder. Only a backup's own name is taken, and a link is refused.
// 3. With no Master key, it makes one and prints it once, to this terminal only, never to a log.
// 4. It unpacks the backup next to app.db and runs SQLite's integrity check on it.
// 5. It refuses a backup with a migration this version does not have. An older one is fine: the
//    migrations run at the next start, or before step 6 lists the losses when the key differs.
// 6. When the Master key cannot decrypt the backup's data key, it lists the secrets that will be
//    lost and asks for `yes`. Any other answer stops it.
// 7. It saves the current app.db, if there is one, as a `restore` safety copy.
// 8. It puts the backup in place and empties jobs.db.
// 9. Without the matching Master key, it deletes the secrets it cannot read and every web push
//    device, and stores a new data key encrypted with the current Master key.
// Each refusal comes before anything changes, apart from a new Master key. Step 9 runs on the
// unpacked copy just before step 8 renames it into place, so app.db is always either the old
// database or the whole restored one.

const USAGE = "Usage: fft restore <file>\n";

// The files SQLite may keep beside a database.
const BESIDE = ["-wal", "-shm", "-journal"];

// What every Member reads after a restore without the Master key (spec 11, Without the Master key).
export const RESTORED_WITHOUT_MASTER_KEY =
  "The app was restored from a backup without its Master key, so its saved secrets are gone. Set these up again: the Plaid secret, the AI key, the SMTP password, and the Price source keys in Settings; each bank, with Link again; and Alerts on each device.";

const NOTHING_CHANGED = "Nothing changed.";

function lockRefusal(refusal: LockRefusal, file: string): string {
  if (refusal.holder === "app") {
    return (
      "The app is running, so fft restore changed nothing. Stop it first with " +
      "`docker compose stop app`, then run fft restore again. Right after a crash, wait 30 " +
      "seconds and try again.\n"
    );
  }
  if (refusal.holder === "restore") {
    return "Another fft restore is running, so this one changed nothing.\n";
  }
  return `${file} is not a lock file the app wrote, so fft restore changed nothing. Delete it, then run fft restore again.\n`;
}

// The backup's path: a bare file name in the backup folder, or a path whose folder is the backup
// folder. The name must be a backup's own name, such as app-20261102T080000Z-daily.db.gz, with a
// real time no later than `now`. It is checked and used exactly as given: nothing is decoded or
// trimmed. Undefined for any other name, or any path that leaves the folder, as with "..".
export function backupPath(folder: string, given: string, now: Date): string | undefined {
  const inFolder = resolve(folder);
  const name = given.includes("/") ? basename(resolve(given)) : given;
  if (backupNameOf(name, now) === undefined) return undefined;
  const path = join(inFolder, name);
  if (given.includes("/") && resolve(given) !== path) return undefined;
  return dirname(path) === inFolder && basename(path) === name ? path : undefined;
}

// Opens the backup without following a link, and only when it is a plain file.
async function openBackup(path: string): Promise<FileHandle | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  if ((await handle.stat()).isFile()) return handle;
  await handle.close();
  return undefined;
}

// Deletes a file, or a link, at `path`. Nothing there is fine.
async function deleteFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function deleteWithBeside(path: string): Promise<void> {
  for (const file of [path, ...BESIDE.map((end) => `${path}${end}`)]) await deleteFile(file);
}

// Gunzips the backup into a new file. False when it is not gzip.
async function unpack(backup: FileHandle, into: string): Promise<boolean> {
  try {
    await pipeline(
      backup.createReadStream({ start: 0, autoClose: false }),
      createGunzip(),
      createWriteStream(into, { flags: "wx", mode: 0o600, flush: true }),
    );
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.startsWith("Z_")) return false;
    throw error;
  }
}

// Whether a nonempty file sits beside a closed database, which closing it should have written in.
async function leftBeside(path: string): Promise<boolean> {
  for (const end of ["-wal", "-journal"]) {
    const found = await lstat(`${path}${end}`).catch(() => undefined);
    if (found !== undefined && (!found.isFile() || found.size > 0)) return true;
  }
  return false;
}

function lossLines(losses: RestoreLosses): string[] {
  const lines: string[] = [];
  if (losses.plaidSecret) lines.push("  - the Plaid secret");
  if (losses.aiKey) lines.push("  - the AI key");
  if (losses.smtpPassword) lines.push("  - the SMTP password, with the rest of the SMTP settings");
  if (losses.priceSourceKeys)
    lines.push("  - the Price source keys: the Apify token and the Kroger keys");
  if (losses.banks.length > 0) {
    lines.push(
      `  - the access to each bank: ${losses.banks.join(", ")}. Each Connection becomes Broken, and a Member links each bank again with Link again.`,
    );
  }
  if (losses.pushDevices > 0) {
    const devices = losses.pushDevices === 1 ? "1 device" : `${losses.pushDevices} devices`;
    lines.push(
      `  - Alerts on ${devices}. The app makes new push keys, and each Member turns Alerts on again on each device.`,
    );
  }
  lines.push(
    "  - every session and TOTP code. Once the app runs, run fft reset-login for one Member, who then resets the others in the app.",
  );
  return lines;
}

// The `restore` safety copy of the current app.db (spec 11, When backups run).
async function takeSafetyCopy(databaseFile: string, folder: string): Promise<BackupResult> {
  let current: Database;
  try {
    current = await openDatabase(`file:${databaseFile}`);
  } catch {
    return { ok: false, failure: "copy failed" };
  }
  const backups = startBackups({ database: current, folder, timeZone: async () => undefined });
  try {
    return await backUp("restore");
  } finally {
    backups.stop();
    closeDatabase(current);
  }
}

export async function restore(args: string[], io: FftIo): Promise<number> {
  const [given, ...rest] = args;
  if (given === undefined || given === "" || rest.length > 0) {
    io.err(USAGE);
    return 2;
  }
  await mkdir(dirname(io.runningLock), { recursive: true });
  const taken = await takeRunningLock(io.runningLock, "restore");
  if (!taken.taken) {
    io.err(lockRefusal(taken.refusal, io.runningLock));
    return 1;
  }
  try {
    return await restoreHoldingLock(given, io);
  } finally {
    await taken.lock.release();
  }
}

async function restoreHoldingLock(given: string, io: FftIo): Promise<number> {
  const folder = await chooseBackupFolder(io.backupFolders);
  const path = backupPath(folder, given, new Date());
  const backup = path === undefined ? undefined : await openBackup(path);
  if (path === undefined || backup === undefined) {
    io.err(
      `No backup file "${given}" is in the backup folder, ${folder}. Give a file name from that ` +
        `folder, such as app-20261102T080000Z-daily.db.gz. ${NOTHING_CHANGED}\n`,
    );
    return 1;
  }
  try {
    const masterKey = await masterKeyOrNew(io);
    return await restoreFrom(backup, basename(path), folder, masterKey, io);
  } finally {
    await backup.close();
  }
}

// The Master key, or a new one. A new one is printed once, to this terminal.
async function masterKeyOrNew(io: FftIo): Promise<MasterKey> {
  const found = await findMasterKey(io.env);
  if (found !== undefined) return found.masterKey;
  const file = masterKeyFile(io.env);
  const made = await writeMasterKey(file);
  io.out(
    [
      `There was no Master key, so fft restore made a new one in ${file}:`,
      `  ${made.hex}`,
      "",
      "Save it in a password manager now, off this server. It is shown only this once.",
      "Keep the Master key file readable only by the app's user (mode 0600).",
      "",
    ].join("\n"),
  );
  return made.masterKey;
}

async function restoreFrom(
  backup: FileHandle,
  name: string,
  folder: string,
  masterKey: MasterKey,
  io: FftIo,
): Promise<number> {
  const refuse = (reason: string) => {
    io.err(`${reason} ${NOTHING_CHANGED}\n`);
    return 1;
  };
  // Next to app.db, on the same file system, so the rename that puts it in place is one step.
  await mkdir(dirname(io.databaseFile), { recursive: true });
  const unpacked = `${io.databaseFile}.restoring`;
  await deleteWithBeside(unpacked);
  // Whether the Master key decrypts the backup's data key.
  let matches = false;
  try {
    if (!(await unpack(backup, unpacked))) return refuse(`${name} is not a gzipped backup.`);
    if (!(await checkDatabaseCopy(unpacked))) {
      return refuse(`${name} failed SQLite's integrity check, so it is damaged.`);
    }

    const copy = openDatabaseCopy(unpacked);
    try {
      const check = await checkMigrations(copy, io.migrationsFolder);
      if (check.applied === 0) return refuse(`${name} is not a backup of this app.`);
      if (check.newer > 0) {
        return refuse(
          `${name} holds a migration this version of the app does not have, so a newer version ` +
            "made it. Run that version, or restore a backup from this one.",
        );
      }
      if (check.skipped > 0) {
        return refuse(`${name} lacks a migration that this version ships before its newest one.`);
      }

      matches = await decryptsDataKey(copy, masterKey);
      if (!matches) {
        // The losses and step 9 read and write this version's tables, so an older backup gets this
        // version's migrations first. Only the copy changes, and a refusal deletes it. With the
        // matching key, the migrations run at the next start, as after any update.
        await applyMigrations(copy, io.migrationsFolder);
        const losses = await readRestoreLosses(copy);
        io.out(
          [
            "The Master key cannot decrypt this backup's data key, so its secrets cannot be read.",
            "All history comes back. These are lost:",
            ...lossLines(losses),
            "",
          ].join("\n"),
        );
        const answer = await io.ask(
          "Type yes to restore without these secrets. Any other answer stops the restore: ",
        );
        if (answer !== "yes") return refuse("The restore stopped.");
      }

      if (existsSync(io.databaseFile)) {
        const safety = await takeSafetyCopy(io.databaseFile, folder);
        if (!safety.ok) {
          return refuse(
            `The safety copy of the current app.db failed (${safety.failure}). Check that the ` +
              `backup folder, ${folder}, has free space and that fft can write to it. If app.db ` +
              "is damaged, move it out of the data folder, then run fft restore again.",
          );
        }
        io.out(`Saved the current app.db as ${safety.name} in ${folder}.\n`);
      }

      if (!matches) {
        await forgetUnreadableSecrets(copy, {
          at: new Date(),
          dataKey: sealNewDataKey(masterKey),
          noticeText: RESTORED_WITHOUT_MASTER_KEY,
        });
      }
    } finally {
      closeDatabase(copy);
    }
    if (await leftBeside(unpacked)) {
      throw new Error("The restored copy did not close cleanly, so app.db was left as it was.");
    }

    // jobs.db goes first: its jobs belong to the current app.db. If fft stops here, the old app.db
    // runs with an empty jobs.db, and the app schedules missed work again at start.
    await deleteWithBeside(io.jobsDbFile);
    // The current app.db's own write-ahead log would apply to the restored file, so it goes too.
    // The safety copy holds what it held.
    for (const end of BESIDE) await deleteFile(`${io.databaseFile}${end}`);
    await rename(unpacked, io.databaseFile);
  } finally {
    await deleteWithBeside(unpacked);
  }

  io.out(
    [
      `Restored ${name}. jobs.db is empty: the app schedules missed work again at start.`,
      ...(matches
        ? ["The Master key matched, so every secret was kept."]
        : [
            "The secrets the Master key could not read were deleted. Every Connection is Broken,",
            "and every Member sees a System notice that lists what to set up again.",
            "Once the app runs, run fft reset-login <email> for one Member.",
          ]),
      "Start the app: docker compose up -d",
      "",
    ].join("\n"),
  );
  return 0;
}
