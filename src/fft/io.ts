import type { BackupFolders } from "../backups/index.ts";

// What an fft command reads and writes, so tests can run it in place of a terminal.
export type FftIo = {
  // The environment. Reading the Master key deletes FFT_MASTER_KEY from it, as the app does.
  env: Record<string, string | undefined>;
  // app.db, as a file path.
  databaseFile: string;
  // The migrations this version ships, to check that app.db matches them.
  migrationsFolder: string;
  // /backups and /data/backups, as the app chooses between them.
  backupFolders: BackupFolders;
  // Sidequest's jobs.db, which a restore empties.
  jobsDbFile: string;
  // The running lock file, /data/app.lock, which the running app holds.
  runningLock: string;
  out(text: string): void;
  err(text: string): void;
  // Prints the question and reads one line the self-hoster types in the terminal. Empty at the end
  // of input.
  ask(question: string): Promise<string>;
};
