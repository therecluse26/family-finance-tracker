import {
  type AiSettings,
  aiCost,
  aiSettings,
  FOLLOW_UP_AI_USES,
  householdAi,
  startAiRequestLogCleanup,
  startAiRetries,
} from "../ai/index.ts";
import {
  startAlertSending,
  startAnomalyChecks,
  startOverspendingChecks,
} from "../anomalies/index.ts";
import { type Auth, createAuth } from "../auth/index.ts";
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
  type PlaidSettings,
  plaidAdapter,
  plaidSettings,
  startBank,
} from "../bank/index.ts";
import { startCpiFetch } from "../benchmarks/index.ts";
import { startBudgets } from "../budgets/index.ts";
import { startCategorization } from "../categorization/index.ts";
import { type Chat, chat } from "../chat/index.ts";
import { applyMigrations, closeDatabase, type Database, openDatabase } from "../db/index.ts";
import {
  type PlanRuns,
  type PriceSourceAdapter,
  priceSourceReaders,
  startPlanRuns,
  startPriceHistoryPrune,
} from "../deal-finder/index.ts";
import { askForFollowUp, requestFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import { type GoalWriting, goalWriting, startGoals } from "../goals/index.ts";
import { householdTimeZone } from "../household/index.ts";
import { requestInsightCardCheck, startInsightCards } from "../insights/index.ts";
import { type JobsOptions, startJobs } from "../jobs/index.ts";
import {
  retryLineItemCategories,
  startLineItemCategories,
  startLineItemLinks,
} from "../line-items/index.ts";
import { log } from "../log.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import { startMonthlyReview } from "../monthly-review/index.ts";
import type { SmtpSettings } from "../notify/email-view.ts";
import {
  askForDelivery,
  pushSettings,
  requestDelivery,
  requestDeliveryAt,
  smtpSettings,
  startNotify,
  vapidKeysOf,
} from "../notify/index.ts";
import type { PushSettings } from "../notify/push-view.ts";
import { startRecurringCharges } from "../recurring/index.ts";
import {
  type AiWork,
  aiWork,
  REDO_AI_USES,
  requestRedo,
  retryRedo,
  startRedo,
} from "../redo/index.ts";
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
import { startWeeklySummary } from "../weekly-summary/index.ts";
import { takeAppLock } from "./running-lock.ts";
import type { Security } from "./security-mode.ts";
import { type RunningServer, startServer } from "./server.ts";

// What the app's services need: everything that `pnpm start` and `pnpm dev` both run.
export type ServiceOptions = {
  // Step 1: main loads the Master key before startApp opens app.db.
  masterKey: MasterKey;
  databaseUrl: string;
  migrationsFolder: string;
  jobs: Pick<JobsOptions, "jobsDb" | "jobList" | "tasks">;
  security: Security;
  // Bank-data adapters beside the Plaid adapter. `pnpm dev` adds the fake adapter; the built app
  // adds none.
  extraBankAdapters?: readonly BankDataAdapter[];
  // The deal finder's Price source adapter. `pnpm dev` gives the fake one; the built app leaves it
  // out and gets the real readers, which read only with the Household's saved keys.
  priceSources?: PriceSourceAdapter;
  // /backups and /data/backups. Tests give temporary folders.
  backupFolders: BackupFolders;
};

export type StartOptions = ServiceOptions & {
  port: number;
  webRoot: string;
  // The running lock file, /data/app.lock, so `fft restore` refuses to run while the app does.
  // Tests that do not check it leave it out.
  runningLock?: string;
};

// The services the web app hands its routes, beside app.db, the secrets, and the login.
export type RouteServices = {
  plaid: PlaidSettings;
  ai: AiSettings;
  smtp: SmtpSettings;
  push: PushSettings;
  chat: Chat;
  goalWriting: GoalWriting;
  aiWork: AiWork;
  // The deal finder's Price source adapter: the Kroger API and Apify readers, or the one the
  // ServiceOptions gave.
  priceSources: PriceSourceAdapter;
  // "Find the best prices" and its progress, with a Price source adapter.
  planRuns?: PlanRuns;
};

// The app's running services, with nothing listening yet. The open database stays open until
// close().
export type AppServices = {
  database: Database;
  secrets: Secrets;
  auth: Auth;
  routes: RouteServices;
  // Stops starting jobs at once, then waits for the running job and for `waitFor`, such as open
  // requests. The modules stop and the database closes last, since they may use it.
  close(waitFor?: Promise<unknown>[]): Promise<void>;
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

// Takes the running lock before app.db opens, and holds it until close() ends (spec 11, Restore).
export async function startApp(options: StartOptions): Promise<RunningApp> {
  const lock =
    options.runningLock === undefined
      ? undefined
      : await takeAppLock(options.runningLock, {
          warn: (message) => log.warn(message),
          info: (message) => log.info(message),
        });
  try {
    const app = await launchUnderLock(options);
    return {
      ...app,
      close: async () => {
        try {
          await app.close();
        } finally {
          await lock?.release();
        }
      },
    };
  } catch (error) {
    await lock?.release();
    throw error;
  }
}

// The services, then the server. Nothing listens until the services have started.
async function launchUnderLock(options: StartOptions): Promise<RunningApp> {
  const services = await launchServices(options);
  const { database, secrets } = services;
  let server: RunningServer;
  try {
    server = await startServer({
      port: options.port,
      webRoot: options.webRoot,
      security: options.security,
      auth: services.auth,
      database,
      secrets,
      ...services.routes,
    });
  } catch (error) {
    await services.close();
    throw error;
  }
  // The startup check, once the app listens, so a slow or hung backup folder never holds up the
  // start: a daily backup runs when none is from the most recent 3:00 AM, Household time. A failed
  // one starts its retry.
  const startupBackup = runDailyBackup().catch((error: unknown) => {
    log.error("The startup backup check failed", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  });
  return {
    port: server.port,
    database,
    secrets,
    // Stops taking requests and starting jobs at once, then waits for open requests, the running
    // job, and the startup check. The database closes last, since they may use it.
    close: () => services.close([server.close(), startupBackup]),
  };
}

// The startup steps, in the spec's order, up to the point where the app may listen: migrations are
// done and the first scheduler tick has run. `pnpm start` then listens; `pnpm dev` hands the same
// services to Vite.
export async function launchServices(options: ServiceOptions): Promise<AppServices> {
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
    // Web push needs VAPID keys: the app makes them when none are stored, as after a restore
    // without the Master key deleted them (spec 09, Encryption at rest).
    if (https) await vapidKeysOf(database, secrets);
    const adapters = [plaidAdapter({ database, secrets }), ...(options.extraBankAdapters ?? [])];
    const bank = startBank({ database, secrets, adapters, timeZone });
    const followUp = startFollowUpPipeline({ database, startJob: requestFollowUp });
    // A background AI use in the follow-up job retries in a new follow-up job.
    const aiRetries = startAiRetries({
      database,
      runners: {
        ...Object.fromEntries(FOLLOW_UP_AI_USES.map((use) => [use, askForFollowUp])),
        // A use the redo calls also starts the redo again, when AI went away during it.
        ...Object.fromEntries(
          REDO_AI_USES.map((use) => [
            use,
            async () => {
              await askForFollowUp();
              await retryRedo();
            },
          ]),
        ),
        // Line items with no Transaction try again here; the follow-up job handles the linked ones.
        "line item category": async () => {
          await askForFollowUp();
          await retryRedo();
          await retryLineItemCategories();
        },
        // A Product match tries again at the next plan run, which a Member starts.
        "product match": async () => undefined,
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
    // Amazon linking: its follow-up step after Matching, its run after each import, and its Review
    // list kind.
    const lineItemLinks = startLineItemLinks({ database });
    const categorization = startCategorization({ database, ai });
    const lineItemCategories = startLineItemCategories({ database, ai });
    const recurring = startRecurringCharges({ database });
    const anomalies = startAnomalyChecks({ database });
    // Budget tailoring: the AI's part in the first draft, and its Tailoring and Goal runs.
    const tailoring = startBudgetTailoring({ database, ai });
    const budgets = startBudgets({ database, tailorDraft: tailorFirstDraft });
    // The Goal Done check, in each follow-up job and in the Month start job.
    const goals = startGoals({ database });
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
    const weeklySummary = startWeeklySummary({ database });
    const stopRequestLogCleanup = startAiRequestLogCleanup({ database });
    // The deal finder: its plan runs, with a Price source adapter, and its daily price history
    // prune.
    const priceSources = options.priceSources ?? priceSourceReaders();
    const plans = startPlanRuns({ database, secrets, adapter: priceSources, ai });
    const priceHistory = startPriceHistoryPrune({ database });
    const stopModules = () => {
      plans.stop();
      priceHistory.stop();
      backups?.stop();
      stopRequestLogCleanup();
      weeklySummary.stop();
      monthlyReview.stop();
      updateCheck.stop();
      cpiFetch.stop();
      redo.stop();
      insights.stop();
      alertSending.stop();
      overspending.stop();
      goals.stop();
      budgets.stop();
      redrafts.stop();
      tailoring.stop();
      anomalies.stop();
      recurring.stop();
      lineItemCategories.stop();
      categorization.stop();
      lineItemLinks.stop();
      moneyMovement.stop();
      aiRetries.stop();
      followUp.stop();
      bank.stop();
      notify.stop();
    };
    // The Review list cards follow the code that groups them: the open items regroup once, before
    // any job runs, so a release that changes the grouping applies with no sync. A failure leaves
    // the items as they are until the next run and never stops the start.
    try {
      await categorization.atStart();
      await moneyMovement.atStart();
    } catch (error) {
      log.error("The Review list cards could not regroup at start-up", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
    // Line items an import left with no Category take theirs in the background, as AI calls can be
    // slow.
    lineItemCategories.atStart().catch((error: unknown) => {
      log.error("Line item Categories could not run at start-up", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    });
    // Each price history from before Recurring charges kept their Transactions in their own table
    // moves there once, before any job runs. A failure tries again at the next start.
    try {
      await recurring.atStart();
    } catch (error) {
      log.error("The Recurring charges' price histories could not move at start-up", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
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
      return {
        database,
        secrets,
        auth,
        routes: {
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
          // "Finish AI work now", "Run AI on all history", and the status line of the AI's work.
          aiWork,
          priceSources,
          planRuns: plans.planRuns,
        },
        close: async (waitFor = []) => {
          try {
            await settleAll([...waitFor, jobs.stop()]);
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
