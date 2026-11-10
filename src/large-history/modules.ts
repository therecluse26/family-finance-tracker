import {
  type AiModelMaker,
  aiCost,
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
import { startBackups } from "../backups/index.ts";
import { type BankDataAdapter, startBank } from "../bank/index.ts";
import { startCpiFetch } from "../benchmarks/index.ts";
import { startBudgets } from "../budgets/index.ts";
import { startCategorization } from "../categorization/index.ts";
import type { Database } from "../db/index.ts";
import {
  askForFollowUp,
  type FollowUpStepName,
  startFollowUpPipeline,
} from "../follow-up/index.ts";
import { startGoals } from "../goals/index.ts";
import { householdTimeZone } from "../household/index.ts";
import { startInsightCards } from "../insights/index.ts";
import { startLineItemCategories, startLineItemLinks } from "../line-items/index.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import { startMonthlyReview } from "../monthly-review/index.ts";
import { startNotify } from "../notify/index.ts";
import { StubSmtp } from "../notify/testing.ts";
import { startRecurringCharges } from "../recurring/index.ts";
import { startRedo } from "../redo/index.ts";
import type { Secrets } from "../secrets/index.ts";
import { startBudgetTailoring, startRedrafts, tailorFirstDraft } from "../tailoring/index.ts";
import { startUpdateCheck } from "../updates/index.ts";
import { startWeeklySummary } from "../weekly-summary/index.ts";
import { HISTORY_NOW } from "./history.ts";

// The app's modules, as src/server/start.ts starts them, in its order. The build and each case
// start them from this list. large-history.test.ts fails when the app starts a module, or a module
// registers a follow-up step, that this list does not hold. The bench leaves out only the job
// queue and the HTTP server: a case runs each job itself and sends each request in process.

export type ModuleServices = {
  database: Database;
  secrets: Secrets;
  adapters: readonly BankDataAdapter[];
  // How the follow-up pipeline starts a follow-up job. No job queue runs in the bench.
  startJob: () => Promise<unknown>;
  // The AI's models: AI SDK test models. Without them, any AI call fails, so the bench never
  // reaches an AI provider.
  makeModels?: AiModelMaker;
};

export type AppModule = {
  // The start function src/server/start.ts calls.
  name: string;
  start: (services: ModuleServices) => { stop(): void };
  // The follow-up step the module registers, with the build's row for it on the full history and
  // that row's limit: about twice its time when the step was added here.
  step?: { name: FollowUpStepName; path: string; buildLimitMs: number };
};

export const APP_MODULES: readonly AppModule[] = [
  {
    name: "startNotify",
    start: ({ database, secrets }) =>
      startNotify({
        database,
        delivery: {
          secrets,
          address: (path) => `http://nas.local:8080${path}`,
          // A case runs the Delivery job itself, through a stubbed SMTP server.
          startJob: async () => {},
          makeTransport: new StubSmtp().makeTransport,
        },
      }),
  },
  {
    name: "startBank",
    start: ({ database, secrets, adapters }) =>
      startBank({
        database,
        secrets,
        adapters,
        timeZone: () => householdTimeZone(database),
        // No sync job runs by itself: a case syncs in place.
        startSync: async () => {},
      }),
  },
  {
    name: "startFollowUpPipeline",
    start: ({ database, startJob }) => startFollowUpPipeline({ database, startJob }),
  },
  {
    name: "startAiRetries",
    start: ({ database }) =>
      startAiRetries({
        database,
        runners: Object.fromEntries(FOLLOW_UP_AI_USES.map((use) => [use, askForFollowUp])),
      }),
  },
  {
    name: "startAiRequestLogCleanup",
    // Its job runs once a day, never in a follow-up step. The AI request log is off, so no case
    // keeps text.
    start: ({ database }) => ({ stop: startAiRequestLogCleanup({ database }) }),
  },
  {
    name: "startMoneyMovement",
    start: ({ database, secrets, makeModels = noAiProvider }) =>
      startMoneyMovement({
        database,
        ai: householdAi({
          database,
          secrets,
          makeModels,
          cost: aiCost({ database, timeZone: () => householdTimeZone(database) }),
        }),
      }),
    step: {
      name: "matching",
      path: "Matching follow-up on the full history",
      buildLimitMs: 40_000,
    },
  },
  {
    name: "startLineItemLinks",
    // A fixed time, so a shipment's 60 days of waiting do not end as the calendar moves on.
    start: ({ database }) => startLineItemLinks({ database, now: HISTORY_NOW }),
    step: {
      name: "Amazon linking",
      path: "Amazon linking follow-up on the full history",
      buildLimitMs: 20_000,
    },
  },
  {
    name: "startCategorization",
    start: ({ database, secrets, makeModels = noAiProvider }) =>
      startCategorization({
        database,
        ai: householdAi({
          database,
          secrets,
          makeModels,
          cost: aiCost({ database, timeZone: () => householdTimeZone(database) }),
        }),
      }),
    step: {
      name: "categorization",
      path: "Categorization follow-up on the full history",
      buildLimitMs: 60_000,
    },
  },
  {
    name: "startLineItemCategories",
    start: ({ database, secrets, makeModels = noAiProvider }) =>
      startLineItemCategories({
        database,
        ai: householdAi({
          database,
          secrets,
          makeModels,
          cost: aiCost({ database, timeZone: () => householdTimeZone(database) }),
        }),
      }),
  },
  {
    name: "startRecurringCharges",
    // A fixed time, so a Recurring charge's status does not change as the calendar moves on.
    start: ({ database }) => startRecurringCharges({ database, now: HISTORY_NOW }),
    step: {
      name: "recurring charge checks",
      path: "Recurring charge checks on the full history",
      buildLimitMs: 20_000,
    },
  },
  {
    name: "startAnomalyChecks",
    start: ({ database }) => startAnomalyChecks({ database, now: HISTORY_NOW }),
    step: {
      name: "anomaly checks",
      path: "Anomaly checks on the full history",
      buildLimitMs: 6_000,
    },
  },
  {
    name: "startBudgetTailoring",
    // A case runs the Budget tailoring job itself.
    start: ({ database, secrets, makeModels = noAiProvider }) =>
      startBudgetTailoring({
        database,
        ai: householdAi({
          database,
          secrets,
          makeModels,
          cost: aiCost({ database, timeZone: () => householdTimeZone(database) }),
        }),
        now: HISTORY_NOW,
        startJob: async () => {},
      }),
  },
  {
    name: "startBudgets",
    start: ({ database }) =>
      startBudgets({ database, now: HISTORY_NOW, tailorDraft: tailorFirstDraft }),
    // Before the first draft, the step finds no Budget to set: the Budget draft case times it.
    step: {
      name: "Bills Budgets",
      path: "Bills Budgets follow-up on the full history",
      buildLimitMs: 10_000,
    },
  },
  {
    name: "startGoals",
    start: ({ database }) => startGoals({ database, now: HISTORY_NOW }),
    // The history has no Goal, so the step reads none: the Goal Done check case times it with 50.
    step: {
      name: "Goal done check",
      path: "Goal Done check follow-up on the full history",
      buildLimitMs: 5_000,
    },
  },
  {
    name: "startRedrafts",
    start: ({ database, secrets, makeModels = noAiProvider }) => {
      const redrafts = startRedrafts({
        database,
        ai: householdAi({
          database,
          secrets,
          makeModels,
          cost: aiCost({ database, timeZone: () => householdTimeZone(database) }),
        }),
        now: HISTORY_NOW,
      });
      return { stop: redrafts.stop };
    },
    // Before the first draft, the step has no inputs to compare: the redraft case times it.
    step: {
      name: "redraft check",
      path: "Redraft check follow-up on the full history",
      buildLimitMs: 5_000,
    },
  },
  {
    name: "startOverspendingChecks",
    start: ({ database }) => startOverspendingChecks({ database, now: HISTORY_NOW }),
    // Before the first draft, the step checks nothing: the Overspending case times it after one.
    step: {
      name: "overspending checks",
      path: "Overspending checks on the full history",
      buildLimitMs: 10_000,
    },
  },
  {
    name: "startAlertSending",
    start: ({ database }) => startAlertSending({ database }),
    // The history load's Alerts are found in history, so the step has none to decide: the Alerts
    // step case times it on new ones.
    step: {
      name: "alerts",
      path: "Alerts step on the full history",
      buildLimitMs: 5_000,
    },
  },
  {
    name: "startInsightCards",
    start: ({ database, secrets, makeModels = noAiProvider }) =>
      startInsightCards({
        database,
        ai: householdAi({
          database,
          secrets,
          makeModels,
          cost: aiCost({ database, timeZone: () => householdTimeZone(database) }),
        }),
        now: HISTORY_NOW,
      }),
    // With no AI provider the run takes the no-AI path after it builds the Household summary.
    step: {
      name: "insight card check",
      path: "Insight card check on the full history",
      buildLimitMs: 10_000,
    },
  },
  {
    name: "startMonthlyReview",
    // Its jobs run on the 1st and each minute, never in a follow-up step.
    start: ({ database, secrets, makeModels = noAiProvider }) =>
      startMonthlyReview({
        database,
        ai: householdAi({
          database,
          secrets,
          makeModels,
          cost: aiCost({ database, timeZone: () => householdTimeZone(database) }),
        }),
        now: HISTORY_NOW,
      }),
  },
  {
    name: "startRedo",
    // A case runs the redo itself, and a Member's run with runRedoJob: no job queue runs in the
    // bench.
    start: ({ database, secrets, makeModels = noAiProvider }) =>
      startRedo({
        database,
        ai: householdAi({
          database,
          secrets,
          makeModels,
          cost: aiCost({ database, timeZone: () => householdTimeZone(database) }),
        }),
        now: HISTORY_NOW,
        startJob: async () => {},
        // A Member's press waits for its case to run runRedoJob.
        startWork: async () => {},
      }),
  },
  {
    name: "startCpiFetch",
    start: ({ database }) =>
      startCpiFetch({ database, timeZone: () => householdTimeZone(database), fetch: noNetwork }),
  },
  {
    name: "startUpdateCheck",
    start: ({ database }) => startUpdateCheck({ database, fetch: noNetwork }),
  },
  {
    name: "startWeeklySummary",
    // Its job runs on Sunday mornings, never in a follow-up step: the weekly summary case runs it.
    start: ({ database }) => startWeeklySummary({ database, now: HISTORY_NOW }),
  },
  {
    name: "startBackups",
    // No case makes a backup, so the bench names a folder that is never made.
    start: ({ database }) =>
      startBackups({
        database,
        folder: "/nonexistent/fft-bench-backups",
        timeZone: () => householdTimeZone(database),
      }),
  },
];

// The bench never reaches an outside service. The CPI fetch and the Update check fetch only from
// their own jobs, which no case runs; this refuses any call all the same.
const noNetwork = async (): Promise<Response> => {
  throw new Error("The large-history check makes no network request.");
};

// The same for the AI: a case that sets up an AI provider gives test models.
const noAiProvider: AiModelMaker = () => {
  throw new Error("The large-history check calls no AI provider.");
};

// Starts each module in order. Returns a function that stops them in the reverse order.
export function startModules(modules: readonly AppModule[], services: ModuleServices): () => void {
  const stops: (() => void)[] = [];
  const stopAll = () => {
    for (const stop of stops.splice(0).reverse()) stop();
  };
  try {
    for (const appModule of modules) stops.push(appModule.start(services).stop);
  } catch (error) {
    stopAll();
    throw error;
  }
  return stopAll;
}
