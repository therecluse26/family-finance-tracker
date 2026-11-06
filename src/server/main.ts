import { fileURLToPath } from "node:url";
import { BACKUP_FOLDERS } from "../backups/index.ts";
import { APP_DB_URL } from "../db/index.ts";
import { JOBS_DB_FILE } from "../jobs/index.ts";
import { scheduledTasks } from "../jobs/list.ts";
import { log } from "../log.ts";
import { loadMasterKey } from "../secrets/index.ts";
import { readPort } from "./port.ts";
import { RUNNING_LOCK_FILE } from "./running-lock.ts";
import { loadSecurity } from "./security-mode.ts";
import { type RunningApp, startApp } from "./start.ts";
import { exitOnSignal } from "./stop.ts";
import { logUnhandledRejections } from "./unhandled.ts";

// Before anything opens a file: app.db, its -wal and -shm files, jobs.db, and each backup are the
// app's user's alone (spec 11, What a backup holds), also when the image's entrypoint is skipped.
process.umask(0o077);

// Sidequest imports each job class from the job list. The server build is this one file, so it
// re-exports the list and names itself as the job list.
export * from "../jobs/list.ts";

// A Compose service gets a new IP address when its container is made again.
const PROXY_NAME_REFRESH_MS = 10_000;

async function startUp(): Promise<RunningApp> {
  const webRoot = fileURLToPath(new URL("web", import.meta.url));
  const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
  const port = readPort(process.env.PORT);
  const security = await loadSecurity(process.env);
  const masterKey = await loadMasterKey(process.env);
  setInterval(() => void security.proxies.refresh(), PROXY_NAME_REFRESH_MS).unref();
  const server = await startApp({
    masterKey,
    databaseUrl: APP_DB_URL,
    migrationsFolder,
    jobs: { jobsDb: JOBS_DB_FILE, jobList: import.meta.url, tasks: scheduledTasks },
    port,
    webRoot,
    security,
    backupFolders: BACKUP_FOLDERS,
    runningLock: RUNNING_LOCK_FILE,
  });
  log.info("Listening", { port: server.port });
  return server;
}

async function main(): Promise<void> {
  logUnhandledRejections();
  // From the very start, so a stop during the start still releases the running lock.
  const starting = startUp();
  exitOnSignal(starting);
  await starting;
}

main().catch((error: unknown) => {
  log.error("The app could not start", { error });
  process.exit(1);
});
