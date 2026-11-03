import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createAuth } from "../auth/index.ts";
import { applyMigrations, openDatabase } from "../db/index.ts";
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
  const auth = createAuth({ database, secrets, appOrigin: security.appUrl.origin });
  return createApp(webRoot, security, auth, database);
}
