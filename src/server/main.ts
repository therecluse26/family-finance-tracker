import { fileURLToPath } from "node:url";
import { APP_DB_URL } from "../db/index.ts";
import { JOBS_DB_FILE } from "../jobs/index.ts";
import { scheduledTasks } from "../jobs/list.ts";
import { log } from "../log.ts";
import { loadMasterKey } from "../secrets/index.ts";
import { readPort } from "./port.ts";
import { loadSecurity } from "./security-mode.ts";
import { startApp } from "./start.ts";
import { exitOnSignal } from "./stop.ts";

// Sidequest imports each job class from the job list. The server build is this one file, so it
// re-exports the list and names itself as the job list.
export * from "../jobs/list.ts";

// A Compose service gets a new IP address when its container is made again.
const PROXY_NAME_REFRESH_MS = 10_000;

async function main(): Promise<void> {
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
  });
  log.info("Listening", { port: server.port });
  exitOnSignal(server);
}

main().catch((error: unknown) => {
  log.error("The app could not start", { error });
  process.exit(1);
});
