// What an fft command reads and writes, so tests can run it in place of a terminal.
export type FftIo = {
  // The environment. Reading the Master key deletes FFT_MASTER_KEY from it, as the app does.
  env: Record<string, string | undefined>;
  // app.db, as a file path.
  databaseFile: string;
  // The migrations this version ships, to check that app.db matches them.
  migrationsFolder: string;
  out(text: string): void;
  err(text: string): void;
};
