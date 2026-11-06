// The entry point of the `fft` command in the image: dist/fft.js, which /usr/local/bin/fft runs.
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { BACKUP_FOLDERS } from "../backups/index.ts";
import { APP_DB_URL } from "../db/index.ts";
import { JOBS_DB_FILE } from "../jobs/index.ts";
import { RUNNING_LOCK_FILE } from "../server/running-lock.ts";
import { runFft } from "./fft.ts";

// One line from the terminal, or "" when input ends first.
function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    terminal.on("close", () => {
      if (!answered) resolve("");
    });
    terminal.question(question, (answer) => {
      answered = true;
      terminal.close();
      resolve(answer);
    });
  });
}

// Before anything opens a file: app.db, its -wal and -shm files, a restore's files, and the Master
// key are the app's user's alone (spec 11, What a backup holds).
process.umask(0o077);

const code = await runFft(process.argv.slice(2), {
  env: process.env,
  databaseFile: APP_DB_URL.replace(/^file:/, ""),
  // As the app's own start finds them, next to dist.
  migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  backupFolders: BACKUP_FOLDERS,
  jobsDbFile: JOBS_DB_FILE,
  runningLock: RUNNING_LOCK_FILE,
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
  ask,
});
process.exitCode = code;
