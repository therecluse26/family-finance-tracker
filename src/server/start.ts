import { aiCost, aiSettings, FOLLOW_UP_AI_USES, householdAi, startAiRetries } from "../ai/index.ts";
import {
  startAlertSending,
  startAnomalyChecks,
  startOverspendingChecks,
} from "../anomalies/index.ts";
import { createAuth } from "../auth/index.ts";
import {
  type BackupFolders,
  chooseBackupFolder,
  deleteLeftoverBackupFiles,
  runDailyBackup,
  startBackups,
  takeMigrationCopy,
} from "../backups/index.ts";
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
import { chat } from "../chat/index.ts";
import { applyMigrations, closeDatabase, type Database, openDatabase } from "../db/index.ts";
import { askForFollowUp, requestFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import { goalWriting } from "../goals/index.ts";
import { householdTimeZone } from "../household/index.ts";
import { requestInsightCardCheck, startInsightCards } from "../insights/index.ts";
import { type JobsOptions, startJobs } from "../jobs/index.ts";
import { log } from "../log.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import { startMonthlyReview } from "../monthly-review/index.ts";
import {
  askForDelivery,
  pushSettings,
  requestDelivery,
  requestDeliveryAt,
  smtpSettings,
  startNotify,
} from "../notify/index.ts";
import { startRecurringCharges } from "../recurring/index.ts";
import { requestRedo, startRedo } from "../redo/index.ts";
import { checkDataKey, type MasterKey, type Secrets, unlockSecrets } from "../secrets/index.ts";
import { householdSummary } from "../summary/index.ts";
import {
  requestGoalTailoring,
  requestTailoringJob,
  startBudgetTailoring,
  startRedrafts,
  tailorFirstDraft,
} from "../tailoring/index.ts";
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
  // /backups and /data/backups. Tests give temporary folders.
  backupFolders: BackupFolders;
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
  let backups: { stop(): void } | undefined;
  try {
    log.info("Opened the database", { url: options.databaseUrl });
    // Before migrations, so a Master key that cannot decrypt the stored data key changes nothing.
    await checkDataKey(database, options.masterKey);
    // The Household time zone, from the Household facts. Until the wizard's step 4 is done, both
    // the bank module and the scheduler use UTC.
    const timeZone = () => householdTimeZone(database);
    // Before migrations, so the safety copy can run.
    const backupFolder = await chooseBackupFolder(options.backupFolders);
    backups = startBackups({ database, folder: backupFolder, timeZone });
    log.info("Chose the backup folder", { folder: backupFolder });
    // Before any backup can run.
    await deleteLeftoverBackupFiles();
    const applied = await applyMigrations(database, options.migrationsFolder, {
      // Step 4: the safety copy, after the refusals, so a refused app.db never rotates good copies
      // out. app.db with no migration applied holds nothing yet, as on a fresh install.
      beforeMigrating: async (check) => {
        if (check.applied > 0) await takeMigrationCopy();
      },
    });
    log.info("Applied migrations", { count: applied });
    const secrets = await unlockSecrets(database, options.masterKey);
    const address = (path: string) => options.security.appUrl.address(path);
    const https = options.security.appUrl.mode === "https";
    const notify = startNotify({
      database,
      delivery: {
        secrets,
        address,
        startJob: requestDelivery,
        // Web push only over HTTPS (spec 09, Security mode).
        ...(https
          ? { push: { subject: options.security.appUrl.origin, startJobAt: requestDeliveryAt } }
          : {}),
      },
    });
    const adapters = options.bankAdapters ?? [plaidAdapter({ database, secrets })];
    const bank = startBank({ database, secrets, adapters, timeZone });
    const followUp = startFollowUpPipeline({ database, startJob: requestFollowUp });
    // A background AI use in the follow-up job retries in a new follow-up job.
    const aiRetries = startAiRetries({
      database,
      runners: {
        ...Object.fromEntries(FOLLOW_UP_AI_USES.map((use) => [use, askForFollowUp])),
        // Budget tailoring retries in its own job, which runs each waiting run.
        "budget tailoring": requestTailoringJob,
        // The Insight cards retry in the Insight card check job, as a run the 6 AM check started
        // has no Transaction left for a follow-up step.
        "insight cards": requestInsightCardCheck,
        // The Monthly review's check each minute finds its own retry due, so its retry starts
        // nothing more.
        "monthly review": async () => undefined,
      },
    });
    // The Matching and Categorization steps, and the Alerts step for its advice, ask the Quick tier
    // through the one AI call path.
    const cost = aiCost({ database, timeZone });
    const ai = householdAi({ database, secrets, cost, aiBack: requestRedo });
    const moneyMovement = startMoneyMovement({ database, ai });
    const categorization = startCategorization({ database, ai });
    const recurring = startRecurringCharges({ database });
    const anomalies = startAnomalyChecks({ database });
    // Budget tailoring: the AI's part in the first draft, and its Tailoring and Goal runs.
    const tailoring = startBudgetTailoring({ database, ai });
    const budgets = startBudgets({ database, tailorDraft: tailorFirstDraft });
    // The redraft triggers: Income, Benchmark, New bank and Facts redrafts.
    const redrafts = startRedrafts({ database, ai });
    const overspending = startOverspendingChecks({ database });
    const alertSending = startAlertSending({ database, ai });
    // The day's Insight card run, on the Writer tier: the follow-up job's last step, and the daily
    // Insight card check job.
    const insights = startInsightCards({ database, ai });
    const monthlyReview = startMonthlyReview({ database, ai });
    // The first AI run, and the redo of no-AI work each time AI comes back.
    const redo = startRedo({ database, ai });
    const cpiFetch = startCpiFetch({ database, timeZone });
    const updateCheck = startUpdateCheck({ database });
    const stopModules = () => {
      backups?.stop();
      monthlyReview.stop();
      updateCheck.stop();
      cpiFetch.stop();
      redo.stop();
      insights.stop();
      alertSending.stop();
      overspending.stop();
      budgets.stop();
      redrafts.stop();
      tailoring.stop();
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
      // A release with a newer CE data year asks for its Benchmark redraft as it first runs.
      await redrafts.atStart();
      await jobs.tick();
      const auth = createAuth({ database, secrets, appOrigin: options.security.appUrl.origin });
      // A passkey works at one web address only: those made under another APP_URL host are
      // deleted, with a System notice for each Member who lost one (spec 09, Changing APP_URL).
      if ((await auth.removeOtherHostPasskeys(new Date())) > 0) {
        await askForDelivery();
      }
      const server = await startServer({
        port: options.port,
        webRoot: options.webRoot,
        security: options.security,
        auth,
        database,
        secrets,
        plaid: plaidSettings({ database, secrets }),
        ai: aiSettings({
          database,
          secrets,
          cost,
          afterChange: async () => {
            await redo.afterAiChange();
            await tailoring.afterAiChange();
          },
        }),
        smtp: smtpSettings({ database, secrets, address }),
        push: pushSettings({ database, secrets, available: https }),
        chat: chat({ database, ai, summary: householdSummary({ database, ai }) }),
        // Each Goal's reading asks for its Budget tailoring Goal run at once.
        goalWriting: goalWriting({ database, ai, requestGoalRun: requestGoalTailoring }),
      });
      // The startup check, once the app listens, so a slow or hung backup folder never holds up
      // the start: a daily backup runs when none is from the most recent 3:00 AM, Household time.
      // A failed one starts its retry.
      const startupBackup = runDailyBackup().catch((error: unknown) => {
        log.error("The startup backup check failed", {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      });
      return {
        port: server.port,
        database,
        secrets,
        // Stops taking requests and starting jobs at once, then waits for open requests, the
        // running job, and the startup check. The database closes last, since they may use it.
        close: async () => {
          try {
            await settleAll([server.close(), jobs.stop(), startupBackup]);
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
    backups?.stop();
    closeDatabase(database);
    throw error;
  }
}
