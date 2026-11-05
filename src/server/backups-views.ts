// What the Settings, Backups and data routes answer. This file imports nothing, so the web app's
// type check can follow it through api.ts.

export type BackupsView = {
  // The backup folder in use: /backups, or /data/backups.
  folder: string;
  // False when the app cannot read the folder.
  readable: boolean;
  // The last successful backup, or null.
  lastBackupAt: string | null;
  // The backups and safety copies in the folder, and their total size in bytes.
  files: number;
  bytes: number;
};

// The result of "Back up now": the new file's name and time, or why it failed.
export type BackUpNowResult =
  | { ok: true; file: string; at: string }
  | { ok: false; failure: "copy failed" | "check failed" | "write failed" };

export type BackupRoutes = {
  status(): Promise<BackupsView>;
  backUpNow(): Promise<BackUpNowResult>;
};
