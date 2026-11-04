import { type BankDataAdapter, startBank } from "../bank/index.ts";
import { startCpiFetch } from "../benchmarks/index.ts";
import { startCategorization } from "../categorization/index.ts";
import type { Database } from "../db/index.ts";
import { type FollowUpStepName, startFollowUpPipeline } from "../follow-up/index.ts";
import { householdTimeZone } from "../household/index.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import { startNotify } from "../notify/index.ts";
import { startRecurringCharges } from "../recurring/index.ts";
import type { Secrets } from "../secrets/index.ts";
import { startUpdateCheck } from "../updates/index.ts";
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
  { name: "startNotify", start: ({ database }) => startNotify({ database }) },
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
    name: "startMoneyMovement",
    start: ({ database }) => startMoneyMovement({ database }),
    step: {
      name: "matching",
      path: "Matching follow-up on the full history",
      buildLimitMs: 40_000,
    },
  },
  {
    name: "startCategorization",
    start: ({ database }) => startCategorization({ database }),
    step: {
      name: "categorization",
      path: "Categorization follow-up on the full history",
      buildLimitMs: 60_000,
    },
  },
  {
    name: "startRecurringCharges",
    // A fixed time, so a Recurring charge's status does not change as the calendar moves on.
    start: ({ database }) => startRecurringCharges({ database, now: HISTORY_NOW }),
    step: {
      name: "recurring charge and anomaly checks",
      path: "Recurring charge checks on the full history",
      buildLimitMs: 20_000,
    },
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
];

// The bench never reaches an outside service. The CPI fetch and the Update check fetch only from
// their own jobs, which no case runs; this refuses any call all the same.
const noNetwork = async (): Promise<Response> => {
  throw new Error("The large-history check makes no network request.");
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
