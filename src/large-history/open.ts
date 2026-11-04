import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth } from "../auth/auth.ts";
import { addMember } from "../auth/testing.ts";
import { FakeBankAdapter } from "../bank/fake.ts";
import {
  closeDatabase,
  type Database,
  listConnections,
  markSetupStep,
  openDatabase,
} from "../db/index.ts";
import { createLogger } from "../log.ts";
import { type Secrets, unlockSecrets } from "../secrets/index.ts";
import { newMasterKey } from "../secrets/testing.ts";
import { createApp } from "../server/app.ts";
import { loadSecurity } from "../server/security-mode.ts";
import { TestBrowser } from "../server/testing.ts";
import { type BuildReport, builtHistory } from "./build.ts";
import { type GeneratedHistory, generateHistory } from "./history.ts";
import { APP_MODULES, startModules } from "./modules.ts";

export type LargeHistory = {
  // A copy of the built app.db, for this caller alone.
  database: Database;
  secrets: Secrets;
  // The fake adapter, with each bank's pages, so a later sync carries on from the first one.
  fake: FakeBankAdapter;
  generated: GeneratedHistory;
  // Each Connection's ID, by its fake bank ID.
  connectionIds: Map<string, string>;
  build: BuildReport;
  // A signed-in Member's browser on the app's HTTP interface.
  browser: TestBrowser;
  memberId: string;
  // How many times the app asked for a follow-up job. No job runs: a caller runs runFollowUp.
  followUpsAsked(): number;
  close(): void;
};

const APP_URL = "http://nas.local:8080";

let generated: GeneratedHistory | undefined;

// Opens a new copy of the built history, building it first if the cache has none, with the modules
// the app starts (modules.ts) and a signed-in Member. Opens one at a time per process, as the app's modules run
// once per process.
export async function openLargeHistory(): Promise<LargeHistory> {
  generated ??= generateHistory();
  const history = generated;
  const built = await builtHistory(history);
  const dir = mkdtempSync(join(tmpdir(), "fft-large-history-run-"));
  const path = join(dir, "app.db");
  copyFileSync(built.path, path);
  // Closing app.db moves its WAL file's pages into it, but a copy takes the WAL file too, if any.
  if (existsSync(`${built.path}-wal`)) copyFileSync(`${built.path}-wal`, `${path}-wal`);
  writeFileSync(join(dir, "index.html"), "<!doctype html>");
  const database = await openDatabase(`file:${path}`);
  const stops: (() => void)[] = [];
  const close = () => {
    for (const stop of stops.reverse()) stop();
    closeDatabase(database);
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const quiet = createLogger(() => {}, { throwOnSecretField: true });
    // The build left no data key, so a new Master key, made now, unlocks the copy.
    const secrets = await unlockSecrets(database, newMasterKey().masterKey, { logger: quiet });
    const fake = new FakeBankAdapter();
    for (const bank of history.banks) fake.addPages(bank.bankId, ...bank.pages);
    let asked = 0;
    stops.push(
      startModules(APP_MODULES, {
        database,
        secrets,
        adapters: [fake],
        startJob: async () => {
          asked += 1;
        },
      }),
    );
    const connections = await listConnections(database);
    const auth = createAuth({ database, secrets, appOrigin: APP_URL, logger: quiet });
    const app = createApp(
      dir,
      await loadSecurity({ APP_URL }, { logger: quiet }),
      auth,
      database,
      secrets,
    );
    const member = await addMember(auth, { name: "Riley Park", email: "riley@example.com" });
    await markSetupStep(database, "master key", "done");
    const browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);
    return {
      database,
      secrets,
      fake,
      generated: history,
      connectionIds: new Map(connections.map((connection) => [connection.bankId, connection.id])),
      build: built.report,
      browser,
      memberId: member.id,
      followUpsAsked: () => asked,
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
