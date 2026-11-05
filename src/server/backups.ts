import { backUp, backupStatus } from "../backups/index.ts";
import type { BackupRoutes } from "./backups-views.ts";

// The Settings, Backups and data routes (spec 11, When backups run; Where backups go; When a backup
// fails): the folder in use, the last successful backup, the number of files and their total size,
// and "Back up now" for any Member.

export function backupRoutes(): BackupRoutes {
  return {
    async status() {
      const status = await backupStatus();
      return { ...status, lastBackupAt: status.lastBackupAt?.toISOString() ?? null };
    },

    async backUpNow() {
      const result = await backUp("manual");
      return result.ok ? { ok: true, file: result.name, at: result.at.toISOString() } : result;
    },
  };
}
