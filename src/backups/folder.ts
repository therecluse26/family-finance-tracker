import { mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";

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

// The backup folder in use. The fallback folder is made when it is missing.
export async function chooseBackupFolder(folders: BackupFolders): Promise<string> {
  if (await isMountPoint(folders.mounted)) return folders.mounted;
  await mkdir(folders.fallback, { recursive: true });
  return folders.fallback;
}
