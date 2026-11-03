import { applyMigrations, closeDatabase, type Database, openDatabase } from "../db/index.ts";
import { log } from "../log.ts";
import { checkDataKey, type MasterKey, type Secrets, unlockSecrets } from "../secrets/index.ts";
import type { Security } from "./security-mode.ts";
import { type RunningServer, startServer } from "./server.ts";

export type StartOptions = {
  // Step 1: main loads the Master key before startApp opens app.db.
  masterKey: MasterKey;
  databaseUrl: string;
  migrationsFolder: string;
  port: number;
  webRoot: string;
  security: Security;
};

// The open database stays open until close().
export type RunningApp = RunningServer & { database: Database; secrets: Secrets };

// The startup steps, in the spec's order. Nothing listens until migrations are done.
export async function startApp(options: StartOptions): Promise<RunningApp> {
  const database = await openDatabase(options.databaseUrl);
  try {
    log.info("Opened the database", { url: options.databaseUrl });
    // Before migrations, so a Master key that cannot decrypt the stored data key changes nothing.
    await checkDataKey(database, options.masterKey);
    const applied = await applyMigrations(database, options.migrationsFolder);
    log.info("Applied migrations", { count: applied });
    const secrets = await unlockSecrets(database, options.masterKey);
    const server = await startServer({
      port: options.port,
      webRoot: options.webRoot,
      security: options.security,
    });
    return {
      port: server.port,
      database,
      secrets,
      close: async () => {
        try {
          await server.close();
        } finally {
          closeDatabase(database);
        }
      },
    };
  } catch (error) {
    closeDatabase(database);
    throw error;
  }
}
