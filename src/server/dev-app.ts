import { mkdirSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { offerDemoBanks } from "../bank/demo.ts";
import { FakeBankAdapter } from "../bank/fake.ts";
import { CpiFetchJob } from "../benchmarks/index.ts";
import {
  applyMigrations,
  closeDatabase,
  type Database,
  hasMember,
  openDatabase,
} from "../db/index.ts";
import { scheduledTasks } from "../jobs/list.ts";
import {
  checkDataKey,
  loadMasterKey,
  type MasterKey,
  MasterKeyError,
  makeMasterKey,
  setupCodeOf,
  WrongMasterKeyError,
} from "../secrets/index.ts";
import { UpdateCheckJob } from "../updates/index.ts";
import { createApp } from "./app.ts";
import { devRoutes } from "./dev-routes.ts";
import { loadSecurity } from "./security-mode.ts";
import { launchServices } from "./start.ts";

// `pnpm dev` only: the Hono app on its own app.db in .dev/, which Vite hands /api and /healthz.
// With no Master key set, it uses .dev/master.key, and makes it when it is missing.
export const DEV_FOLDER = fileURLToPath(new URL("../../.dev", import.meta.url));
const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));
// Sidequest imports each job class from the job list. Vite runs Sidequest's files too, so that
// import reaches the modules this app runs.
const JOB_LIST = new URL("../jobs/list.ts", import.meta.url).href;

// The Master key settings that loadMasterKey reads.
type MasterKeyEnv = Parameters<typeof loadMasterKey>[0];

export type DevEnv = {
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
  const database = await openDatabase(devDatabaseUrl(folder));
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

const devDatabaseUrl = (folder: string) => `file:${join(folder, "app.db")}`;

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

// `pnpm start`'s scheduled tasks, less the two that call outside services on their own: the update
// check (GitHub) and the CPI fetch (BLS). `pnpm dev` makes no scheduled outside call.
export const devScheduledTasks = scheduledTasks.filter(
  (task) => task.job !== UpdateCheckJob && task.job !== CpiFetchJob,
);

// The services `pnpm start` runs, with the same start-up steps: the bank module, the job runner and
// its schedule, the follow-up work, and email. Dev adds the fake adapter beside Plaid's, with each
// demo bank scripted, and its fake bank route. close() stops them, as Vite closes or before a
// restart. Tests pass their own folder, and no scheduled tasks.
export async function createDevApp(
  webRoot: string,
  env: DevEnv,
  { folder = DEV_FOLDER, tasks = devScheduledTasks } = {},
) {
  const security = await loadSecurity(env);
  const opened = await openDevDatabase(env, folder);
  try {
    await showSetupLink(opened.database, security.appUrl.address("/setup"), opened.masterKey);
  } finally {
    closeDatabase(opened.database);
  }
  const fake = new FakeBankAdapter();
  offerDemoBanks(fake);
  // "Back up now" and the daily backup write to .dev/backups.
  const backups = join(folder, "backups");
  const services = await launchServices({
    masterKey: opened.masterKey,
    databaseUrl: devDatabaseUrl(folder),
    migrationsFolder: MIGRATIONS,
    jobs: { jobsDb: join(folder, "jobs.db"), jobList: JOB_LIST, tasks },
    security,
    extraBankAdapters: [fake],
    backupFolders: { mounted: backups, fallback: backups },
  });
  // A throw here, such as from a route that an edit broke, must not leave the services running:
  // the next restart could not start them again.
  try {
    const app = createApp(webRoot, security, services.auth, services.database, services.secrets, {
      ...services.routes,
      devRoutes: devRoutes(services.database),
    });
    return { app, close: () => services.close() };
  } catch (error) {
    await services.close();
    throw error;
  }
}
