import type { HouseholdAi } from "../ai/index.ts";
import { registerFirstRunStep } from "../bank/index.ts";
import {
  claimAiBack,
  claimFirstAiRunDone,
  clearAiAway,
  countAiRedoFailure,
  type Database,
  endAiRedo,
  markAiAway,
  readAiRedo,
  readHistoryWait,
} from "../db/index.ts";
import { writeInsightCards } from "../insights/index.ts";
import { Job, startJobUnlessWaiting } from "../jobs/index.ts";
import { log } from "../log.ts";
import { endCondition, raiseNotice } from "../notify/index.ts";

// The first AI run and the redo of no-AI work (spec 08, Runs that reuse these uses; Redo of no-AI
// work; spec 03, AI decisions and the no-AI path).
// - Each item a no-AI path decided keeps a mark: a best guess from cascade step 6, a Merchant name
//   left rule-cleaned, an Unclear Transfer pair sent to the Review list, and money from a person
//   booked as Income. Each owner module registers a step that sends its marked items through the
//   AI once, in the Quick tier's batches, and clears each mark the AI answers. A Member's answer or
//   hand-set Category takes an item out, so the AI never redoes it.
// - AI is away while a background AI use takes its no-AI path (src/ai/household-ai.ts). It comes
//   back once: after an outage, when an AI call works; after a pause, when the pause ends, such as
//   when the AI cost cap resets on the 1st, a Member raises the cap or fixes a rejected key, or an
//   AI provider is set up. The AI back job checks a pause once a day, shortly after midnight, and
//   each change of the AI settings checks at once. Each return starts one Redo no-AI work job, never one for each sync.
// - The first AI run is the same work on all history, about 18 months, as the First run's "ai first
//   run" step. It ends with one Insight card run, at any hour. Without AI then, AI counts as away,
//   and the redo that AI's return starts finishes it.
// - The redo's calls count against the AI cost cap, through the one AI call path. It runs no Alert
//   step and writes no Monthly review, so sent Alerts and written Monthly reviews stay as they
//   were, and no Alert gets advice later.

// The steps of a redo, in this order: clean names first, since the Categories read them; Money
// movement next, since a new decision clears a Transaction's Categories.
export const REDO_STEPS = ["Merchant names", "Money movement", "Categories"] as const;

export type RedoStepName = (typeof REDO_STEPS)[number];

// One step of a redo. `decided` are the Transactions the steps before it decided again. With `ai`
// false, AI went away during an earlier step: the step makes no AI call, and only puts right what
// the earlier steps left, such as the Categories of `decided`. Returns the Transactions it decided
// again. A step must be safe to run twice, as every job is.
export type RedoStep = (run: {
  decided: readonly string[];
  ai: boolean;
}) => Promise<readonly string[]>;

const steps = new Map<RedoStepName, RedoStep>();

// Registers the step's work. Returns a function that removes it again.
export function registerRedoStep(name: RedoStepName, step: RedoStep): () => void {
  if (steps.has(name)) throw new Error(`The redo step "${name}" is already registered.`);
  steps.set(name, step);
  return () => {
    if (steps.get(name) === step) steps.delete(name);
  };
}

type Services = {
  database: Database;
  ai: HouseholdAi;
  now: () => Date;
  startJob: () => Promise<unknown>;
};

let services: Services | undefined;

function running(): Services {
  if (services === undefined) throw new Error("The redo of no-AI work is not running.");
  return services;
}

// What one redo did.
// - "not due": AI has not come back since the last redo, and the first AI run is done or waits for
//   the history.
// - "busy": a redo was already running in this process.
// - "AI away": AI was away at the start, or went away during the redo. The marked items it did not
//   reach wait for AI's next return.
// - "done": every marked item went through the AI once.
export type RedoOutcome = "not due" | "busy" | "AI away" | "done";

// Set before the first await, so a redo started beside a running one does nothing (K18).
let busy = false;

// Runs the redo once, when AI has come back or the first AI run is due. Any error throws.
export async function runRedo(): Promise<RedoOutcome> {
  if (busy) return "busy";
  busy = true;
  try {
    return await redo(running());
  } finally {
    busy = false;
  }
}

async function redo({ database, ai, now }: Services): Promise<RedoOutcome> {
  const state = await readAiRedo(database);
  const firstRun =
    state.firstRunDoneAt === null && (await readHistoryWait(database)).endedAt !== null;
  if (state.dueAt === null && !firstRun) return "not due";
  // The Quick tier's uses all share one gate.
  const pause = await ai.pauseFor("category fix");
  if (pause !== undefined) {
    await markAiAway(database, "pause", now());
    await endAiRedo(database, state.dueAt);
    log.info("The redo of no-AI work waits for AI", { pause, firstRun });
    return "AI away";
  }
  await clearAiAway(database);
  const decided = new Set<string>();
  let aiOn = true;
  for (const name of REDO_STEPS) {
    const step = steps.get(name);
    if (step === undefined) continue;
    for (const id of await step({ decided: [...decided], ai: aiOn })) decided.add(id);
    // A call of this step found AI away: the later steps make no call.
    if (aiOn && (await readAiRedo(database)).awayAt !== null) aiOn = false;
  }
  await endAiRedo(database, state.dueAt);
  if (!aiOn) {
    log.info("AI went away during the redo of no-AI work", { firstRun });
    return "AI away";
  }
  if (firstRun) {
    // A Writer call that found AI away leaves the first AI run to AI's return, which runs it again.
    const cards = await writeInsightCards({ database, ai, now });
    if (cards !== "written" && (await readAiRedo(database)).awayAt !== null) {
      log.info("The first AI run's Insight card run waits for AI");
      return "AI away";
    }
    if (await claimFirstAiRunDone(database, now())) log.info("The first AI run finished");
  }
  log.info("The redo of no-AI work finished", { firstRun, decidedAgain: decided.size });
  return "done";
}

// A Redo no-AI work job gets this many attempts. The last one that fails ends the redo, with one
// System notice: its marked items wait for AI's next return (K4).
export const REDO_ATTEMPTS = 3;

export const REDO_STOPPED = "ai redo stopped";
export const REDO_STOPPED_TEXT =
  "Some work the app did without AI could not go through the AI. It tries again the next time AI comes back after a pause or an outage.";

// The Redo no-AI work job's work. A redo that fails throws, and Sidequest runs it again, until it
// has failed REDO_ATTEMPTS times in a row.
export async function runRedoJob(): Promise<void> {
  const { database } = running();
  let outcome: RedoOutcome;
  try {
    outcome = await runRedo();
  } catch (error) {
    const failures = await countAiRedoFailure(database);
    if (failures < REDO_ATTEMPTS) throw error;
    log.error("The redo of no-AI work stopped after its last attempt", {
      failures,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    await endAiRedo(database, (await readAiRedo(database)).dueAt);
    await raiseNotice({ kind: "condition", condition: REDO_STOPPED, text: REDO_STOPPED_TEXT });
    return;
  }
  if (outcome === "done") await endCondition(REDO_STOPPED);
}

// The Redo no-AI work job (spec 10, Job list). Only AI's return starts it.
export class RedoNoAiWorkJob extends Job {
  override async run(): Promise<void> {
    await runRedoJob();
  }
}

// Starts a Redo no-AI work job, unless one already waits.
export function requestRedo(): Promise<boolean> {
  return startJobUnlessWaiting(RedoNoAiWorkJob, [], { maxAttempts: REDO_ATTEMPTS });
}

// AI comes back from a pause once the pause ends, such as when the AI cost cap resets on the 1st:
// starts the redo then. An outage comes back only with a call that works (src/ai/household-ai.ts).
// True when AI came back now. The claim reads the away reason, in its one write.
export async function checkAiBack(): Promise<boolean> {
  const { database, ai, now, startJob } = running();
  if ((await ai.pauseFor("category fix")) !== undefined) return false;
  if (!(await claimAiBack(database, now(), "pause"))) return false;
  log.info("AI came back after a pause");
  await startJob();
  return true;
}

// The AI back job. A scheduled task starts it once a day, shortly after midnight, Household time. It
// makes no AI call, and writes only when a pause has ended.
export class AiBackJob extends Job {
  override async run(): Promise<void> {
    await checkAiBack();
  }
}

// Gives the redo app.db and the Household AI, and registers the first AI run as the First run's
// "ai first run" step. The start calls it before jobs run. afterAiChange runs after each change of
// the AI settings that may let AI run again; it never throws.
export function startRedo(options: {
  database: Database;
  ai: HouseholdAi;
  now?: () => Date;
  startJob?: () => Promise<unknown>;
}): { afterAiChange(): Promise<void>; stop(): void } {
  if (services !== undefined) throw new Error("The redo of no-AI work is already running.");
  const started: Services = {
    database: options.database,
    ai: options.ai,
    now: options.now ?? (() => new Date()),
    startJob: options.startJob ?? requestRedo,
  };
  services = started;
  const stopStep = registerFirstRunStep("ai first run", async () => {
    await runRedo();
  });
  return {
    async afterAiChange() {
      try {
        await checkAiBack();
      } catch (error) {
        log.warn("The check for AI's return after an AI settings change failed", {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
    },
    stop() {
      stopStep();
      if (services === started) services = undefined;
    },
  };
}
