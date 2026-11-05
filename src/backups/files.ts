import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

// The backup folder's files (spec 11, How the app makes a backup; How many are kept). The app reads
// and deletes only files with its own names, so a file a self-hoster puts in the folder stays.

export const BACKUP_KINDS = ["daily", "manual", "migration", "restore"] as const;
export type BackupKind = (typeof BACKUP_KINDS)[number];

// Regular backups, and safety copies, each with their own count kept.
const REGULAR: readonly BackupKind[] = ["daily", "manual"];
export const REGULAR_KEPT = 7;
export const SAFETY_KEPT = 3;

const KIND = BACKUP_KINDS.join("|");
// A backup: app-20261102T080000Z-daily.db.gz. The time is UTC.
const BACKUP_NAME = new RegExp(`^app-(\\d{8}T\\d{6}Z)-(${KIND})\\.db\\.gz$`);
// A temporary file a backup writes on its way: the copy, app-...-daily.db.tmp, with any file
// SQLite keeps beside it, and the gzipped file before its rename, app-...-daily.db.gz.tmp.
const TEMPORARY_NAME = new RegExp(
  `^app-\\d{8}T\\d{6}Z-(?:${KIND})\\.db(?:\\.tmp(?:-wal|-shm|-journal)?|\\.gz\\.tmp)$`,
);

// 2026-11-02T08:00:00.000Z as 20261102T080000Z.
function stampOf(at: Date): string {
  return at
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
}

// The time a stamp names, or undefined for a stamp that names no real time, such as
// 99999999T999999Z or 20261131T030000Z. Only a stamp the app could have written comes back.
function timeOf(stamp: string): Date | undefined {
  const [, y, mo, d, h, mi, s] = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp) ?? [];
  const at = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`);
  return Number.isNaN(at.getTime()) || stampOf(at) !== stamp ? undefined : at;
}

// The names of one backup's files: its final name and its two temporary files.
export function backupNames(kind: BackupKind, at: Date) {
  const name = `app-${stampOf(at)}-${kind}.db.gz`;
  return { name, copy: name.replace(/\.gz$/, ".tmp"), packed: `${name}.tmp` };
}

export type BackupFile = { name: string; kind: BackupKind; at: Date; bytes: number };

// The backups in the folder, newest first. A link, a folder, or any other file is left out, even
// one with a backup's name, and so is a name whose time is not a real one: the app never lists,
// counts, or deletes it.
export async function listBackups(folder: string): Promise<BackupFile[]> {
  const files: BackupFile[] = [];
  for (const name of await readdir(folder)) {
    const match = BACKUP_NAME.exec(name);
    if (match === null) continue;
    const at = timeOf(match[1] ?? "");
    if (at === undefined) continue;
    const stat = await lstat(join(folder, name)).catch(() => undefined);
    if (stat === undefined || !stat.isFile()) continue;
    files.push({ name, kind: match[2] as BackupKind, at, bytes: stat.size });
  }
  return files.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.name < b.name ? 1 : -1));
}

export function isRegular(kind: BackupKind): boolean {
  return REGULAR.includes(kind);
}

// Keeps the newest 7 regular backups and the newest 3 safety copies, and deletes the older ones.
// Each count is its own, so a safety copy never deletes a regular backup, and the other way round.
// A backup that names a later time than now, such as one copied from a server whose clock ran
// ahead, is neither counted nor deleted, so it never pushes out a new backup. Returns the names it
// deleted.
export async function deleteOldBackups(folder: string, now: Date): Promise<string[]> {
  const backups = (await listBackups(folder)).filter((file) => file.at <= now);
  const old = [
    ...backups.filter((file) => isRegular(file.kind)).slice(REGULAR_KEPT),
    ...backups.filter((file) => !isRegular(file.kind)).slice(SAFETY_KEPT),
  ];
  for (const file of old) await unlink(join(folder, file.name));
  return old.map((file) => file.name);
}

// Deletes the temporary files a stopped backup left behind, and returns how many. A link or a
// folder with such a name stays.
export async function deleteLeftoverFiles(folder: string): Promise<number> {
  let deleted = 0;
  for (const name of await readdir(folder)) {
    if (!TEMPORARY_NAME.test(name)) continue;
    const stat = await lstat(join(folder, name)).catch(() => undefined);
    if (stat === undefined || !stat.isFile()) continue;
    await unlink(join(folder, name));
    deleted += 1;
  }
  return deleted;
}
