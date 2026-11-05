import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { aiCost, aiSettings } from "../ai/index.ts";
import { createAuth } from "../auth/index.ts";
import { startBackups } from "../backups/index.ts";
import { plaidSettings } from "../bank/index.ts";
import { applyMigrations, openDatabase } from "../db/index.ts";
import { householdTimeZone } from "../household/index.ts";
import { pushSettings, startNotify } from "../notify/index.ts";
import { checkDataKey, loadMasterKey, unlockSecrets } from "../secrets/index.ts";
import { createApp } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";

// `pnpm dev` only: the Hono app on its own app.db in .dev/, which Vite hands /api and /healthz.
// It needs the Master key, as `pnpm start` does.
export const DEV_FOLDER = fileURLToPath(new URL("../../.dev", import.meta.url));

export async function createDevApp(
  webRoot: string,
  env: {
    APP_URL: string;
    TRUSTED_PROXIES?: string;
    FFT_MASTER_KEY_FILE?: string;
    FFT_MASTER_KEY?: string;
  },
) {
  const security = await loadSecurity(env);
  const masterKey = await loadMasterKey(env);
  mkdirSync(DEV_FOLDER, { recursive: true });
  const database = await openDatabase(`file:${DEV_FOLDER}/app.db`);
  await checkDataKey(database, masterKey);
  await applyMigrations(database, fileURLToPath(new URL("../../drizzle", import.meta.url)));
  const secrets = await unlockSecrets(database, masterKey);
  // System notices, such as the AI cost cap's, go to the dev app.db. Vite starts the app once.
  startNotify({ database });
  // "Back up now" writes to .dev/backups.
  const backupFolder = join(DEV_FOLDER, "backups");
  mkdirSync(backupFolder, { recursive: true });
  startBackups({ database, folder: backupFolder, timeZone: () => householdTimeZone(database) });
  const auth = createAuth({ database, secrets, appOrigin: security.appUrl.origin });
  return createApp(webRoot, security, auth, database, secrets, {
    plaid: plaidSettings({ database, secrets }),
    push: pushSettings({ database, secrets, available: security.appUrl.mode === "https" }),
    ai: aiSettings({
      database,
      secrets,
      cost: aiCost({ database, timeZone: () => householdTimeZone(database) }),
    }),
  });
}
