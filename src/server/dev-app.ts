import { mkdirSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { aiCost, aiSettings, householdAi } from "../ai/index.ts";
import { createAuth } from "../auth/index.ts";
import { startBackups } from "../backups/index.ts";
import { plaidSettings } from "../bank/index.ts";
import { chat } from "../chat/index.ts";
import { applyMigrations, hasMember, openDatabase } from "../db/index.ts";
import { householdTimeZone } from "../household/index.ts";
import { pushSettings, startNotify } from "../notify/index.ts";
import {
  checkDataKey,
  loadMasterKey,
  makeMasterKey,
  setupCodeOf,
  unlockSecrets,
} from "../secrets/index.ts";
import { householdSummary } from "../summary/index.ts";
import { createApp } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";

// `pnpm dev` only: the Hono app on its own app.db in .dev/, which Vite hands /api and /healthz.
// It needs the Master key, as `pnpm start` does.
export const DEV_FOLDER = fileURLToPath(new URL("../../.dev", import.meta.url));

type DevEnv = {
  APP_URL: string;
  TRUSTED_PROXIES?: string;
  FFT_MASTER_KEY_FILE?: string;
  FFT_MASTER_KEY?: string;
};

// With no Master key set, `pnpm dev` uses .dev/master.key and makes it, with mode 0600, when it is
// missing, so local dev needs no setup step. A key set in FFT_MASTER_KEY_FILE or FFT_MASTER_KEY
// is used as it is. Only dev does this: a missing key on a server means a lost key.
export async function withDevMasterKey(env: DevEnv, folder: string): Promise<DevEnv> {
  if (env.FFT_MASTER_KEY_FILE || (env.FFT_MASTER_KEY ?? "").trim() !== "") return env;
  const file = join(folder, "master.key");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, `${makeMasterKey().hex}\n`, { mode: 0o600, flag: "wx" });
    await chmod(file, 0o600);
    process.stdout.write(`Made a dev Master key in ${file}.\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return { ...env, FFT_MASTER_KEY_FILE: file };
}

export async function createDevApp(webRoot: string, env: DevEnv) {
  const security = await loadSecurity(env);
  const masterKey = await loadMasterKey(await withDevMasterKey(env, DEV_FOLDER));
  mkdirSync(DEV_FOLDER, { recursive: true });
  const database = await openDatabase(`file:${DEV_FOLDER}/app.db`);
  await checkDataKey(database, masterKey);
  await applyMigrations(database, fileURLToPath(new URL("../../drizzle", import.meta.url)));
  // The setup link goes to the terminal only, never to the app's log (spec 12, The `fft` command).
  if (!(await hasMember(database))) {
    const link = `${security.appUrl.address("/setup")}#code=${setupCodeOf(masterKey)}`;
    process.stdout.write(`\nOpen this setup link to make the first Member:\n  ${link}\n\n`);
  }
  const secrets = await unlockSecrets(database, masterKey);
  // System notices, such as the AI cost cap's, go to the dev app.db. Vite starts the app once.
  startNotify({ database });
  // "Back up now" writes to .dev/backups.
  const backupFolder = join(DEV_FOLDER, "backups");
  mkdirSync(backupFolder, { recursive: true });
  startBackups({ database, folder: backupFolder, timeZone: () => householdTimeZone(database) });
  const auth = createAuth({ database, secrets, appOrigin: security.appUrl.origin });
  const cost = aiCost({ database, timeZone: () => householdTimeZone(database) });
  const ai = householdAi({ database, secrets, cost });
  return createApp(webRoot, security, auth, database, secrets, {
    plaid: plaidSettings({ database, secrets }),
    push: pushSettings({ database, secrets, available: security.appUrl.mode === "https" }),
    ai: aiSettings({ database, secrets, cost }),
    chat: chat({ database, ai, summary: householdSummary({ database, ai }) }),
  });
}
