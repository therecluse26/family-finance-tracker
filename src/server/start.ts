import { aiCost, aiSettings, FOLLOW_UP_AI_USES, householdAi, startAiRetries } from "../ai/index.ts";
import {
  startAlertSending,
  startAnomalyChecks,
  startOverspendingChecks,
} from "../anomalies/index.ts";
import { createAuth } from "../auth/index.ts";
import {
  type BankDataAdapter,
  catchUpSyncs,
  plaidAdapter,
  plaidSettings,
  startBank,
} from "../bank/index.ts";
import { startCpiFetch } from "../benchmarks/index.ts";
import { startBudgets } from "../budgets/index.ts";
import { startCategorization } from "../categorization/index.ts";
import { applyMigrations, closeDatabase, type Database, openDatabase } from "../db/index.ts";
import { askForFollowUp, requestFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import { householdTimeZone } from "../household/index.ts";
import { type JobsOptions, startJobs } from "../jobs/index.ts";
import { log } from "../log.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import { requestDelivery, smtpSettings, startNotify } from "../notify/index.ts";
import { startRecurringCharges } from "../recurring/index.ts";
import { checkDataKey, type MasterKey, type Secrets, unlockSecrets } from "../secrets/index.ts";
import { startUpdateCheck } from "../updates/index.ts";
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
  // The Bank-data adapters: the Plaid adapter unless given. Tests give the fake adapter.
  bankAdapters?: readonly BankDataAdapter[];
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
    // The Household time zone, from the Household facts. Until the wizard's step 4 is done, both
    // the bank module and the scheduler use UTC.
    const timeZone = () => householdTimeZone(database);
    const address = (path: string) => options.security.appUrl.address(path);
    const notify = startNotify({
      database,
      delivery: { secrets, address, startJob: requestDelivery },
    });
    const adapters = options.bankAdapters ?? [plaidAdapter({ database, secrets })];
    const bank = startBank({ database, secrets, adapters, timeZone });
    const followUp = startFollowUpPipeline({ database, startJob: requestFollowUp });
    // A background AI use in the follow-up job retries in a new follow-up job.
    const aiRetries = startAiRetries({
      database,
      runners: Object.fromEntries(FOLLOW_UP_AI_USES.map((use) => [use, askForFollowUp])),
    });
    // The Matching and Categorization steps ask the Quick tier through the one AI call path.
    const cost = aiCost({ database, timeZone });
    const ai = householdAi({ database, secrets, cost });
    const moneyMovement = startMoneyMovement({ database, ai });
    const categorization = startCategorization({ database, ai });
    const recurring = startRecurringCharges({ database });
    const anomalies = startAnomalyChecks({ database });
    const budgets = startBudgets({ database });
    const overspending = startOverspendingChecks({ database });
    const alertSending = startAlertSending({ database });
    const cpiFetch = startCpiFetch({ database, timeZone });
    const updateCheck = startUpdateCheck({ database });
    const stopModules = () => {
      updateCheck.stop();
      cpiFetch.stop();
      alertSending.stop();
      overspending.stop();
      budgets.stop();
      anomalies.stop();
      recurring.stop();
      categorization.stop();
      moneyMovement.stop();
      aiRetries.stop();
      followUp.stop();
      bank.stop();
      notify.stop();
    };
    let jobs: Awaited<ReturnType<typeof startJobs>>;
    try {
      jobs = await startJobs({ ...options.jobs, database, timeZone });
    } catch (error) {
      stopModules();
      throw error;
    }
    try {
      // Each Connection whose last sync attempt is more than 6 hours old syncs at once.
      await catchUpSyncs();
      await jobs.tick();
      const server = await startServer({
        port: options.port,
        webRoot: options.webRoot,
        security: options.security,
        auth: createAuth({ database, secrets, appOrigin: options.security.appUrl.origin }),
        database,
        secrets,
        plaid: plaidSettings({ database, secrets }),
        ai: aiSettings({ database, secrets, cost }),
        smtp: smtpSettings({ database, secrets, address }),
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
            stopModules();
            closeDatabase(database);
          }
        },
      };
    } catch (error) {
      await jobs.stop();
      stopModules();
      throw error;
    }
  } catch (error) {
    closeDatabase(database);
    throw error;
  }
}
