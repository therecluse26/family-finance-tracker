import { mkdirSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { aiCost, aiSettings, householdAi } from "../ai/index.ts";
import { createAuth } from "../auth/index.ts";
import { startBackups } from "../backups/index.ts";
import { plaidSettings } from "../bank/index.ts";
import { chat } from "../chat/index.ts";
import {
  applyMigrations,
  closeDatabase,
  type Database,
  hasMember,
  openDatabase,
} from "../db/index.ts";
import { householdTimeZone } from "../household/index.ts";
import { pushSettings, startNotify } from "../notify/index.ts";
import {
  checkDataKey,
  loadMasterKey,
  type MasterKey,
  MasterKeyError,
  makeMasterKey,
  setupCodeOf,
  unlockSecrets,
  WrongMasterKeyError,
} from "../secrets/index.ts";
import { householdSummary } from "../summary/index.ts";
import { createApp } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";

// `pnpm dev` only: the Hono app on its own app.db in .dev/, which Vite hands /api and /healthz.
// With no Master key set, it uses .dev/master.key, and makes it when it is missing.
export const DEV_FOLDER = fileURLToPath(new URL("../../.dev", import.meta.url));
const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));

// The Master key settings that loadMasterKey reads.
type MasterKeyEnv = Parameters<typeof loadMasterKey>[0];

type DevEnv = {
  APP_URL: string;
  TRUSTED_PROXIES?: string;
  FFT_MASTER_KEY_FILE?: string;
  FFT_MASTER_KEY?: string;
};

// With no Master key set, `pnpm dev` uses .dev/master.key and makes it, with mode 0600, when it is
// missing, so local dev needs no setup step. A key set in FFT_MASTER_KEY_FILE or FFT_MASTER_KEY
// is used as it is. Only dev does this: a missing key on a server means a lost key.
export async function withDevMasterKey<Env extends object>(
  env: Env & MasterKeyEnv,
  folder: string,
): Promise<Env & MasterKeyEnv> {
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

// A dev start that cannot go on. Its message says what to do in dev, and holds no key and no
// file content.
export class DevStartError extends Error {
  override name = "DevStartError";
}

// The Master key and the dev app.db, for `pnpm dev` and `pnpm seed:demo`. Dev has no `fft setup`
// key and no data worth a restore, so a bad .dev/master.key, or an app.db set up with another key,
// gets a dev message: delete it and start again. A key set in FFT_MASTER_KEY_FILE or
// FFT_MASTER_KEY keeps the production messages.
export async function openDevDatabase(
  env: MasterKeyEnv,
  folder: string,
): Promise<{ masterKey: MasterKey; database: Database }> {
  const chosen = await withDevMasterKey(env, folder);
  let masterKey: MasterKey;
  try {
    masterKey = await loadMasterKey(chosen);
  } catch (error) {
    // withDevMasterKey hands back `env` itself when a Master key is set.
    if (chosen === env || !(error instanceof MasterKeyError)) throw error;
    throw new DevStartError(
      `${chosen.FFT_MASTER_KEY_FILE} is not a usable dev Master key. Delete it and run \`pnpm dev\` again to make a new one.`,
    );
  }
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "app.db");
  const database = await openDatabase(`file:${file}`);
  try {
    await checkDataKey(database, masterKey);
    await applyMigrations(database, MIGRATIONS);
  } catch (error) {
    closeDatabase(database);
    if (!(error instanceof WrongMasterKeyError)) throw error;
    throw new DevStartError(
      `${file} was made with another Master key. It holds dev data only: delete ${folder} to start over, and run \`pnpm dev\` again.`,
    );
  }
  return { masterKey, database };
}

// The setup link goes to the terminal only, never to the app's log (spec 12, The `fft` command).
// It shows until the first Member is made.
export async function showSetupLink(
  database: Database,
  setupAddress: string,
  masterKey: MasterKey,
): Promise<void> {
  if (await hasMember(database)) return;
  const link = `${setupAddress}#code=${setupCodeOf(masterKey)}`;
  process.stdout.write(`\nOpen this setup link to make the first Member:\n  ${link}\n\n`);
}

export async function createDevApp(webRoot: string, env: DevEnv) {
  const security = await loadSecurity(env);
  const { masterKey, database } = await openDevDatabase(env, DEV_FOLDER);
  await showSetupLink(database, security.appUrl.address("/setup"), masterKey);
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
