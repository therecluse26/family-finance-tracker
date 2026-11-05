import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeBankAdapter } from "../bank/fake.ts";
import { syncConnection } from "../bank/index.ts";
import { addConnection, applyMigrations, closeDatabase, openDatabase } from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { createLogger } from "../log.ts";
import { unlockSecrets } from "../secrets/index.ts";
import { newMasterKey } from "../secrets/testing.ts";
import {
  GENERATOR_VERSION,
  type GeneratedHistory,
  generateHistory,
  HISTORY_NOW,
} from "./history.ts";
import { APP_MODULES, type ModuleServices, startModules } from "./modules.ts";

// The built history: app.db after a first sync of the whole history and its follow-up job, cached
// in the OS temp folder. Never in the repo.
//
// The cache key is the generator version, plus a hash of the app code and migrations that build
// it. A change to sync, Matching or Categorization changes what the build stores and how long it
// takes, so such a change builds it again. A change to a case file does not.

// One timed path, with its limit. `ms` is the CPU time this process spent on the work, which a
// busy host does not stretch, and the limit counts it. `wallMs` is the wall clock time, for the
// table only. The build's rows say when they were timed, as an ISO date and time, so the table can
// mark a cached build's rows.
export type TimingRow = {
  path: string;
  ms: number;
  wallMs?: number;
  limitMs: number;
  timedAt?: string;
};

// Runs the work, and measures its CPU time and its wall clock time in whole milliseconds. Each
// timed case runs in its own process, so the CPU time is this work's, on every thread.
export async function timeWork<T>(
  work: () => Promise<T>,
): Promise<{ result: T; ms: number; wallMs: number }> {
  const wallStarted = performance.now();
  const started = process.cpuUsage();
  const result = await work();
  const used = process.cpuUsage(started);
  const ms = Math.round((used.user + used.system) / 1_000);
  return { result, ms, wallMs: Math.round(performance.now() - wallStarted) };
}

export type BuildReport = {
  generatorVersion: number;
  transactions: number;
  // The build's own timed jobs: the first sync, then each follow-up step.
  times: TimingRow[];
  // True when this process built it; false when it came from the cache.
  builtNow: boolean;
};

// The first sync's limit: about twice its time when this check was added. Each follow-up step's
// limit is in modules.ts. A build that goes over still caches, and every run reports it.
const SYNC_LIMIT_MS = 40_000;

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const CACHE_FOLDER = join(tmpdir(), "fft-large-history");
// Cached builds kept for other branches and worktrees. Older ones are deleted.
const KEPT_BUILDS = 4;

const quiet = createLogger(() => {}, { throwOnSecretField: true });

// The files whose change changes the build: the app code outside the web app and tests, the
// migrations, the lockfile, and this folder's generator, module list, and build. Not the cases or
// the timing code.
const BUILD_FILES = new Set([
  "src/large-history/history.ts",
  "src/large-history/modules.ts",
  "src/large-history/build.ts",
]);
function buildInputs(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() ? [relative(ROOT, full).split(sep).join("/")] : [];
    });
  const code = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "drizzle"))].filter(
    (path) =>
      !path.startsWith("src/web/") &&
      !/\.test\.tsx?$/.test(path) &&
      (!path.startsWith("src/large-history/") || BUILD_FILES.has(path)),
  );
  return [...code, "pnpm-lock.yaml"].sort();
}

export async function cacheKey(): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      Buffer.concat(
        buildInputs().flatMap((path) => [
          Buffer.from(`${path}\0`),
          readFileSync(join(ROOT, path)),
          Buffer.from("\0"),
        ]),
      ),
    ),
  );
  const hex = Array.from(hash.slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `v${GENERATOR_VERSION}-${hex}`;
}

const timed = async (path: string, limitMs: number, run: () => Promise<unknown>) => {
  const { ms, wallMs } = await timeWork(run);
  return { path, ms, wallMs, limitMs, timedAt: new Date().toISOString() };
};

// Builds app.db at `path` from the generated history, through the real sync path on the fake
// adapter, with the modules the app starts (modules.ts). The data key is deleted after, so the file
// holds no key and each run unlocks it with a new Master key.
async function build(path: string, history: GeneratedHistory): Promise<BuildReport> {
  const database = await openDatabase(`file:${path}`);
  const stops: (() => void)[] = [];
  try {
    await applyMigrations(database, join(ROOT, "drizzle"));
    const secrets = await unlockSecrets(database, newMasterKey().masterKey, { logger: quiet });
    const fake = new FakeBankAdapter();
    // No job queue runs: the build runs each follow-up itself.
    const services: ModuleServices = {
      database,
      secrets,
      adapters: [fake],
      startJob: async () => {},
    };
    // The modules with no follow-up step first, then each step's module before its own follow-up
    // run, so each run times one step.
    stops.push(
      startModules(
        APP_MODULES.filter((appModule) => appModule.step === undefined),
        services,
      ),
    );
    const connectionIds: string[] = [];
    for (const bank of history.banks) {
      fake.addPages(bank.bankId, ...bank.pages);
      connectionIds.push(
        await addConnection(database, {
          provider: "fake",
          bankId: bank.bankId,
          bankName: bank.bankName,
          origin: "linked",
          syncMinute: 17,
        }),
      );
    }
    const pages = history.banks.reduce((sum, bank) => sum + bank.pages.length, 0);
    const records = history.banks.reduce(
      (sum, bank) => sum + bank.pages.reduce((n, page) => n + (page.added?.length ?? 0), 0),
      0,
    );
    const times: TimingRow[] = [];
    times.push(
      await timed(
        `Sync of the full history: ${records.toLocaleString("en-US")} Transactions, ` +
          `${history.banks.length} Connections, ${pages} pages`,
        SYNC_LIMIT_MS,
        async () => {
          for (const id of connectionIds) await syncConnection(id, HISTORY_NOW);
        },
      ),
    );
    for (const appModule of APP_MODULES) {
      if (appModule.step === undefined) continue;
      stops.push(startModules([appModule], services));
      times.push(
        await timed(appModule.step.path, appModule.step.buildLimitMs, () =>
          runFollowUp(HISTORY_NOW),
        ),
      );
    }

    await database.$client.execute("DELETE FROM data_keys");
    const sealed = await database.$client.execute(
      "SELECT count(*) AS n FROM connections WHERE credential IS NOT NULL",
    );
    if (Number(sealed.rows[0]?.n) !== 0) throw new Error("The built history holds a credential.");
    return { generatorVersion: GENERATOR_VERSION, transactions: records, times, builtNow: true };
  } finally {
    for (const stop of stops.reverse()) stop();
    closeDatabase(database);
  }
}

// Deletes all but the most recently used builds, and builds left half done an hour ago.
function pruneCache(keep: string): void {
  const hourAgo = Date.now() - 3_600_000;
  const entries = readdirSync(CACHE_FOLDER, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== keep)
    .map((entry) => ({ path: join(CACHE_FOLDER, entry.name), name: entry.name }))
    .map((entry) => ({ ...entry, used: statSync(entry.path).mtimeMs }));
  const building = entries.filter((entry) => entry.name.includes(".building-"));
  const built = entries
    .filter((entry) => !entry.name.includes(".building-"))
    .sort((a, b) => b.used - a.used);
  for (const entry of [
    ...building.filter((entry) => entry.used < hourAgo),
    ...built.slice(KEPT_BUILDS - 1),
  ]) {
    rmSync(entry.path, { recursive: true, force: true });
  }
}

export type BuiltHistory = { path: string; report: BuildReport };

// The cached build for the code as it is now, built first if there is none. Two processes may
// build at once; each builds in its own folder, and the first to finish wins.
export async function builtHistory(history = generateHistory()): Promise<BuiltHistory> {
  const key = await cacheKey();
  const folder = join(CACHE_FOLDER, key);
  const path = join(folder, "app.db");
  const reportPath = join(folder, "build.json");
  if (existsSync(reportPath)) {
    const now = new Date();
    utimesSync(folder, now, now);
    const report: BuildReport = JSON.parse(readFileSync(reportPath, "utf8"));
    return { path, report: { ...report, builtNow: false } };
  }
  mkdirSync(CACHE_FOLDER, { recursive: true });
  const building = join(CACHE_FOLDER, `${key}.building-${process.pid}-${Date.now()}`);
  mkdirSync(building);
  try {
    const report = await build(join(building, "app.db"), history);
    writeFileSync(join(building, "build.json"), JSON.stringify(report, null, 2));
    try {
      renameSync(building, folder);
    } catch (error) {
      // Another process finished the same build first.
      if (!existsSync(reportPath)) throw error;
    }
    pruneCache(key);
    return { path, report };
  } finally {
    rmSync(building, { recursive: true, force: true });
  }
}
