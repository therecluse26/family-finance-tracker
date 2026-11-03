import { applyMigrations, closeDatabase, type Database, openDatabase } from "../db/index.ts";
import { type JobsOptions, startJobs } from "../jobs/index.ts";
import { log } from "../log.ts";
import { checkDataKey, type MasterKey, type Secrets, unlockSecrets } from "../secrets/index.ts";
import type { Security } from "./security-mode.ts";
import { type RunningServer, startServer } from "./server.ts";

export type StartOptions = {
  // Step 1: main loads the Master key before startApp opens app.db.
  masterKey: MasterKey;
  databaseUrl: string;
  migrationsFolder: string;
  jobs: Pick<JobsOptions, "jobsDb" | "jobList" | "tasks">;
  port: number;
  webRoot: string;
  security: Security;
};

// The open database stays open until close().
export type RunningApp = RunningServer & { database: Database; secrets: Secrets };

// Waits for every promise, then throws the first failure.
async function settleAll(promises: Promise<unknown>[]): Promise<void> {
  const failed = (await Promise.allSettled(promises)).find(
    (result) => result.status === "rejected",
  );
  if (failed !== undefined) throw failed.reason;
}

// The startup steps, in the spec's order. Nothing listens until migrations are done and the first
// scheduler tick has run.
export async function startApp(options: StartOptions): Promise<RunningApp> {
  const database = await openDatabase(options.databaseUrl);
  try {
    log.info("Opened the database", { url: options.databaseUrl });
    // Before migrations, so a Master key that cannot decrypt the stored data key changes nothing.
    await checkDataKey(database, options.masterKey);
    const applied = await applyMigrations(database, options.migrationsFolder);
    log.info("Applied migrations", { count: applied });
    const secrets = await unlockSecrets(database, options.masterKey);
    const jobs = await startJobs({ ...options.jobs, database });
    try {
      await jobs.tick();
      const server = await startServer({
        port: options.port,
        webRoot: options.webRoot,
        security: options.security,
      });
      return {
        port: server.port,
        database,
        secrets,
        // Stops taking requests and starting jobs at once, then waits for open requests and the
        // running job. The database closes last, since the running job may use it.
        close: async () => {
          try {
            await settleAll([server.close(), jobs.stop()]);
          } finally {
            closeDatabase(database);
          }
        },
      };
    } catch (error) {
      await jobs.stop();
      throw error;
    }
  } catch (error) {
    closeDatabase(database);
    throw error;
  }
}
