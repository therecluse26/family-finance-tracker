import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { makeFilesOwnerOnly } from "../db/index.ts";
import { log } from "../log.ts";
import { listBackups } from "./files.ts";

// Where backups go (spec 11, Where backups go): /backups when it is a mount of its own, as the
// Compose file gives it, else /data/backups, as on a platform service with one volume. The app
// uploads nothing.

export type BackupFolders = {
  // /backups in the image.
  mounted: string;
  // /data/backups in the image.
  fallback: string;
};

export const BACKUP_FOLDERS: BackupFolders = { mounted: "/backups", fallback: "/data/backups" };

// A folder is a mount of its own when it sits on another file system than the folder above it.
async function isMountPoint(path: string): Promise<boolean> {
  try {
    const [own, above] = await Promise.all([stat(path), stat(dirname(path))]);
    return own.isDirectory() && own.dev !== above.dev;
  } catch {
    return false;
  }
}

// Only the group's and others' rights go, and the owner's stay as they are. A missing folder stays
// missing, and a folder the app cannot change still works.
async function makeFolderOwnerOnly(folder: string): Promise<void> {
  const mode = await stat(folder).then(
    (found) => found.mode,
    () => undefined,
  );
  if (mode === undefined || (mode & 0o077) === 0) return;
  await chmod(folder, mode & 0o700).catch(() =>
    log.warn("Could not make the backup folder readable by the app's user alone", { folder }),
  );
}

// The backup folder in use. The fallback folder is made when it is missing. It is the app's user's
// alone, whatever the umask, and so is one an older version made 0755, even while /backups is in
// use (spec 11, What a backup holds). So is each backup in either folder that an older version made
// 0644; a file with another name, or a link, is left as it is. The entrypoint makes /backups
// owner-only.
export async function chooseBackupFolder(folders: BackupFolders): Promise<string> {
  const mounted = await isMountPoint(folders.mounted);
  if (!mounted) await mkdir(folders.fallback, { recursive: true, mode: 0o700 });
  await makeFolderOwnerOnly(folders.fallback);
  const folder = mounted ? folders.mounted : folders.fallback;
  for (const each of new Set([folder, folders.fallback])) {
    const backups = await listBackups(each).catch(() => []);
    await makeFilesOwnerOnly(backups.map((backup) => join(each, backup.name)));
  }
  return folder;
}
