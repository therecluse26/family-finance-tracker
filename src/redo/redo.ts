import { aiActivity, type HouseholdAi, showRunActivity } from "../ai/index.ts";
import { registerFirstRunStep } from "../bank/index.ts";
import {
  claimAiBack,
  claimFirstAiRunDone,
  clearAiAway,
  clearAiRetry,
  countAiRedoFailure,
  countMarkedItems,
  type Database,
  endAiRedo,
  markAiAway,
  markCategoriesForAi,
  readAiRedo,
  readAiRetry,
  readHistoryWait,
  recordAiRedoRun,
} from "../db/index.ts";
import { calendarDateIn } from "../format.ts";
import { householdTimeZone } from "../household/index.ts";
import { writeInsightCards } from "../insights/index.ts";
import { Job, type JobArgument, startJob, startJobUnlessWaiting } from "../jobs/index.ts";
import { log } from "../log.ts";
import { endCondition, raiseNotice } from "../notify/index.ts";
import {
  AI_WORK_KINDS,
  type AiWork,
  type AiWorkKind,
  type AiWorkPress,
  type AiWorkRefusal,
  type AiWorkRun,
  type AiWorkStep,
  type AiWorkView,
  type AiWorkWait,
  ALL_HISTORY_MONTHS,
  workProgress,
} from "./work-view.ts";

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
// - A Member starts it at once from Settings, AI (spec 08, AI work on your Transactions): "Finish
//   AI work now" runs it even when AI has not come back. "Run AI on all history" first marks, at
//   the press, each Category of the last 18 months that no hand edit, Category rule, or Money
//   movement set; the run then asks the AI about each at step 5, past the provider's category and
//   Merchant history. The press marks once, so a job's later attempt never asks again about a
//   Category the AI answered. Each press is one Redo no-AI work job, with the job's attempts and
//   System notice. One run goes at a time: a press while one waits or runs is refused, and a redo
//   that AI's return starts gives way to a Member's run.

// The steps of a redo, in this order: clean names first, since the Categories read them; Money
// movement next, since a new decision clears a Transaction's Categories. Line item Categories go
// last: each one the AI answers sends its Transaction to the follow-up job, which splits it again.
export const REDO_STEPS = [
  "Merchant names",
  "Money movement",
  "Categories",
  "Line item Categories",
] as const;

export type RedoStepName = (typeof REDO_STEPS)[number];

// One step of a redo. `decided` are the Transactions the steps before it decided again. With `ai`
// false, AI went away during an earlier step: the step makes no AI call, and only puts right what
// the earlier steps left, such as the Categories of `decided`. `allHistory` is true in a run of
// "Run AI on all history". The Categories step counts the Transactions whose Category the AI
// answered with countAiCategories. Returns the Transactions it decided again. A step must be safe
// to run twice, as every job is.
export type RedoStep = (run: {
  decided: readonly string[];
  ai: boolean;
  allHistory: boolean;
  countAiCategories(count: number): void;
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
  // Starts the job of a Member's run.
  startWork: (kind: AiWorkKind) => Promise<unknown>;
  // How often a working redo counts its decided items for its progress.
  progressMs: number;
};

// A working redo counts its decided items this often, so the live AI status sends its progress at
// most once a second (spec 08, AI work on your Transactions, Progress bar).
export const PROGRESS_MS = 1_000;

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
// The step the running redo is on, for the status line.
let step: AiWorkStep | undefined;
// A Member's run, from the press until its job ends. Set before the press's first await, so
// presses sent together start one run (K18).
let pressed: AiWorkKind | undefined;
// True once the running redo has found that it is due and that AI may run.
let working = false;
// The working redo's count for its progress: the marked items when it started working, the items
// it has decided since, when it started, and its steps in order.
let tally:
  | { before: number; done: number; startedAt: Date; steps: readonly AiWorkStep[] }
  | undefined;
// The timer that counts the working redo's decided items.
let ticker: ReturnType<typeof setInterval> | undefined;

// The run as the status line and the live AI status show it, with its progress once it counts.
// `left` is the marked items now, when the caller has read them.
function runNow(left?: number): AiWorkRun | null {
  if (pressed === undefined && !busy) return null;
  const run: AiWorkRun = { kind: pressed ?? null, step: step ?? "starting" };
  if (tally === undefined) return run;
  const place = tally.steps.indexOf(run.step);
  run.progress = workProgress({
    before: tally.before,
    done: left === undefined ? tally.done : tally.before - left,
    place: place === -1 ? null : place + 1,
    steps: tally.steps.length,
    startedAt: tally.startedAt,
    now: services?.now() ?? new Date(),
  });
  return run;
}

// The live AI status's run (spec 08, Live AI status): a Member's press from the press on, and a
// redo the app starts once it is due with AI on. Each change of `busy`, `step`, `pressed`, and
// `working` calls it.
function showRun(): void {
  showRunActivity(pressed !== undefined || (busy && working) ? runNow() : null);
}

// Counts the working redo's decided items, one count at a time, and shows its progress. A count
// that ends after its redo has ended shows nothing.
let counting = false;
async function countProgress(database: Database): Promise<void> {
  const counted = tally;
  if (counting || counted === undefined) return;
  counting = true;
  try {
    const left = await countMarkedItems(database);
    if (tally !== counted) return;
    counted.done = Math.max(0, counted.before - left);
    showRun();
  } catch (error) {
    log.warn("The redo of no-AI work could not count its progress", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  } finally {
    counting = false;
  }
}

function stopCounting(): void {
  if (ticker !== undefined) clearInterval(ticker);
  ticker = undefined;
  tally = undefined;
}

function pressedNow(kind: AiWorkKind | undefined): void {
  pressed = kind;
  showRun();
}

// Runs the redo once, when AI has come back or the first AI run is due. With `kind`, it is a
// Member's run, which runs at once. A redo that AI's return starts gives way to a Member's run
// that waits for its job. Any error throws.
export async function runRedo(kind?: AiWorkKind): Promise<RedoOutcome> {
  if (busy || (kind === undefined && pressed !== undefined)) return "busy";
  busy = true;
  step = "starting";
  showRun();
  try {
    return await redo(running(), kind);
  } finally {
    busy = false;
    step = undefined;
    working = false;
    stopCounting();
    showRun();
  }
}

// The calendar date `months` months before `date`, both YYYY-MM-DD. A day past the month's end
// becomes its last day.
export function monthsBefore(date: string, months: number): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  const index = year * 12 + (month - 1) - months;
  const shown = { year: Math.floor(index / 12), month: (index % 12) + 1 };
  const last = new Date(Date.UTC(shown.year, shown.month, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shown.year}-${pad(shown.month)}-${pad(Math.min(day, last))}`;
}

async function redo(
  { database, ai, now, progressMs }: Services,
  kind: AiWorkKind | undefined,
): Promise<RedoOutcome> {
  const state = await readAiRedo(database);
  const firstRun =
    state.firstRunDoneAt === null && (await readHistoryWait(database)).endedAt !== null;
  if (kind === undefined && state.dueAt === null && !firstRun) return "not due";
  // The Quick tier's uses all share one gate.
  const pause = await ai.pauseFor("category fix");
  if (pause !== undefined) {
    await markAiAway(database, "pause", now());
    await endAiRedo(database, state.dueAt);
    log.info("The redo of no-AI work waits for AI", { pause, firstRun });
    return "AI away";
  }
  await clearAiAway(database);
  working = true;
  showRun();
  // Each item whose mark goes away during the run is one the run decided: by the AI, or by an
  // earlier cascade step such as Merchant history.
  const before = await countMarkedItems(database);
  const runSteps: AiWorkStep[] = REDO_STEPS.filter((name) => steps.has(name));
  if (firstRun) runSteps.push("Insight cards");
  tally = { before, done: 0, startedAt: now(), steps: runSteps };
  ticker = setInterval(() => void countProgress(database), progressMs);
  ticker.unref?.();
  showRun();
  const decidedItems = async () => Math.max(0, before - (await countMarkedItems(database)));
  let aiCategories = 0;
  const record = async (outcome: "finished" | "stopped") =>
    recordAiRedoRun(database, { at: now(), items: await decidedItems(), aiCategories, outcome });
  try {
    const decided = new Set<string>();
    let aiOn = true;
    for (const name of REDO_STEPS) {
      const work = steps.get(name);
      if (work === undefined) continue;
      step = name;
      showRun();
      const run = {
        decided: [...decided],
        ai: aiOn,
        allHistory: kind === "all history",
        countAiCategories: (count: number) => {
          aiCategories += count;
        },
      };
      for (const id of await work(run)) decided.add(id);
      // A call of this step found AI away: the later steps make no call.
      if (aiOn && (await readAiRedo(database)).awayAt !== null) aiOn = false;
    }
    // The redo ends, and its failures count from 0, only once nothing more can fail: a step that
    // fails after the end on each attempt would never reach the last attempt (K4).
    const end = async (outcome: "finished" | "stopped") => {
      await record(outcome);
      await endAiRedo(database, state.dueAt);
    };
    if (!aiOn) {
      log.info("AI went away during the redo of no-AI work", { firstRun, kind });
      await end("stopped");
      return "AI away";
    }
    if (firstRun) {
      step = "Insight cards";
      showRun();
      // A Writer call that found AI away leaves the first AI run to AI's return, which runs it
      // again.
      const cards = await writeInsightCards({ database, ai, now });
      if (cards !== "written" && (await readAiRedo(database)).awayAt !== null) {
        log.info("The first AI run's Insight card run waits for AI");
        await end("stopped");
        return "AI away";
      }
      if (await claimFirstAiRunDone(database, now())) log.info("The first AI run finished");
    }
    log.info("The redo of no-AI work finished", {
      firstRun,
      kind,
      decidedAgain: decided.size,
      aiCategories,
    });
    await end("finished");
    return "done";
  } catch (error) {
    await record("stopped");
    throw error;
  }
}

// A Redo no-AI work job gets this many attempts. The last one that fails ends the redo, with one
// System notice: its marked items wait for AI's next return (K4).
export const REDO_ATTEMPTS = 3;

export const REDO_STOPPED = "ai redo stopped";
export const REDO_STOPPED_TEXT =
  "Some work the app did without AI could not go through the AI. It tries again the next time AI comes back after a pause or an outage.";

// The Redo no-AI work job's work. A redo that fails throws, and Sidequest runs it again, until it
// has failed REDO_ATTEMPTS times in a row. With `kind`, it is a Member's run, which ends its press
// at its end: when it finishes, waits for AI, or stops after its last attempt.
export async function runRedoJob(kind?: AiWorkKind): Promise<void> {
  const { database } = running();
  let outcome: RedoOutcome;
  try {
    outcome = await runRedo(kind);
  } catch (error) {
    const failures = await countAiRedoFailure(database);
    if (failures < REDO_ATTEMPTS) throw error;
    log.error("The redo of no-AI work stopped after its last attempt", {
      failures,
      kind,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    if (kind !== undefined) pressedNow(undefined);
    await endAiRedo(database, (await readAiRedo(database)).dueAt);
    await raiseNotice({ kind: "condition", condition: REDO_STOPPED, text: REDO_STOPPED_TEXT });
    return;
  }
  if (kind !== undefined) pressedNow(undefined);
  if (outcome === "done") await endCondition(REDO_STOPPED);
}

const kindOf = (value: JobArgument | undefined): AiWorkKind | undefined =>
  AI_WORK_KINDS.find((kind) => kind === value);

// The Redo no-AI work job (spec 10, Job list). AI's return starts it with no argument, and a
// Member's press with the run's kind.
export class RedoNoAiWorkJob extends Job {
  override async run(kind?: JobArgument): Promise<void> {
    await runRedoJob(kindOf(kind));
  }
}

// The Quick-tier uses a redo calls: Merchant names, Money movement, and Categories, with their
// Merchant lookups, and Line item Categories.
export const REDO_AI_USES = [
  "merchant cleanup",
  "unclear transfer",
  "reimbursement linking",
  "category fix",
  "merchant lookup",
  "line item category",
] as const;

// The latest time a use the redo calls tries again after a failed call, while it is still to come.
// Until then that use makes no call, so a run would stop at once with nothing decided.
async function retryWaitUntil(database: Database, now: Date): Promise<Date | undefined> {
  let latest: Date | undefined;
  for (const use of REDO_AI_USES) {
    const retry = await readAiRetry(database, use);
    if (retry === undefined || retry.retryAt <= now) continue;
    if (latest === undefined || retry.retryAt > latest) latest = retry.retryAt;
  }
  return latest;
}

type Wait = { wait: AiWorkWait; retryAt?: Date };

// Why AI work waits now, or undefined when it may run: the Quick tier's pause first, then a retry
// wait. It makes no call. A press never skips a retry wait: that wait is the backoff after a
// failure, and the use's own retry runs the work at that time.
async function waitsFor({ database, ai, now }: Services): Promise<Wait | undefined> {
  const pause = await ai.pauseFor("category fix");
  // A Quick-tier use never asks "send anyway?": that pause is Chat's and reading a Goal's.
  if (pause !== undefined) return { wait: pause === "send anyway?" ? "cost cap" : pause };
  const retryAt = await retryWaitUntil(database, now());
  return retryAt === undefined ? undefined : { wait: "retry wait", retryAt };
}

// The status line of the AI's work (spec 08, AI work on your Transactions). It makes no AI call.
export async function aiWorkView(): Promise<AiWorkView> {
  const services = running();
  const { database } = services;
  const waits = await waitsFor(services);
  const waiting = await countMarkedItems(database);
  const state = await readAiRedo(database);
  return {
    running: runNow(waiting),
    waits: waits?.wait ?? null,
    retryAt: waits?.retryAt?.toISOString() ?? null,
    waiting,
    lastRun:
      state.lastRun === null ? null : { ...state.lastRun, at: state.lastRun.at.toISOString() },
  };
}

// A press of "Finish AI work now" or "Run AI on all history": starts the run's job, or says why
// not. A refused press makes no AI call and gives its place back. "Run AI on all history" marks
// the last 18 months' Categories here, once, before its job starts: they then wait for the AI like
// any marked item, even if the job never runs.
export async function pressAiWork(kind: AiWorkKind): Promise<AiWorkPress> {
  const services = running();
  const { database } = services;
  // The place is taken here, before the first await (K18).
  if (busy || pressed !== undefined) return { started: false, refusal: "running" };
  pressedNow(kind);
  let refusal: AiWorkRefusal | undefined;
  let retryAt: Date | undefined;
  try {
    const waits = await waitsFor(services);
    // A Member's press skips the retry wait (spec 08): it ends the retry times of the uses the run
    // calls, so the run's calls go now. A pause, such as the AI cost cap, still refuses.
    if (waits?.wait === "retry wait") {
      for (const use of REDO_AI_USES) await clearAiRetry(database, use);
    } else {
      refusal = waits?.wait;
      retryAt = waits?.retryAt;
    }
    if (refusal === undefined && kind === "all history") {
      const today = calendarDateIn(services.now(), (await householdTimeZone(database)) ?? "UTC");
      const marked = await markCategoriesForAi(database, monthsBefore(today, ALL_HISTORY_MONTHS));
      log.info("Run AI on all history marked the Categories it sends to the AI", { marked });
    }
    if (refusal === undefined) {
      const { firstRunDoneAt } = await readAiRedo(database);
      const firstRun =
        firstRunDoneAt === null && (await readHistoryWait(database)).endedAt !== null;
      if (!firstRun && (await countMarkedItems(database)) === 0) refusal = "nothing waits";
    }
    if (refusal === undefined) await services.startWork(kind);
  } catch (error) {
    pressedNow(undefined);
    throw error;
  }
  if (refusal !== undefined) {
    pressedNow(undefined);
    if (refusal === "retry wait") {
      return { started: false, refusal, retryAt: (retryAt ?? services.now()).toISOString() };
    }
    return { started: false, refusal };
  }
  log.info("A Member started AI work", { kind });
  return { started: true, work: await aiWorkView() };
}

// Settings, AI's routes for the AI's work, and the live AI status's feed.
export const aiWork: AiWork = { view: aiWorkView, press: pressAiWork, activity: aiActivity };

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

// The AI retry of a use the redo calls came due (spec 08, Failures): a redo that stopped because
// AI went away starts again now, so the retry time the status line shows is true. A follow-up job
// handles only a sync's Transactions, so its call alone may never bring AI back. Only the retry
// starts it, never a sync, and the retries' own cap ends it: after the last retry, the use has no
// retry time, and the redo waits for AI's return (K4). True when it started the redo.
export async function retryRedo(): Promise<boolean> {
  const { database, now, startJob } = running();
  if ((await readAiRedo(database)).lastRun?.outcome !== "stopped") return false;
  if (!(await claimAiBack(database, now(), "outage"))) return false;
  log.info("The redo of no-AI work starts again at its AI retry");
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
  startWork?: (kind: AiWorkKind) => Promise<unknown>;
  progressMs?: number;
}): { afterAiChange(): Promise<void>; stop(): void } {
  if (services !== undefined) throw new Error("The redo of no-AI work is already running.");
  const started: Services = {
    database: options.database,
    ai: options.ai,
    now: options.now ?? (() => new Date()),
    startJob: options.startJob ?? requestRedo,
    startWork:
      options.startWork ??
      ((kind) => startJob(RedoNoAiWorkJob, [kind], { maxAttempts: REDO_ATTEMPTS })),
    progressMs: options.progressMs ?? PROGRESS_MS,
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
      if (services === started) {
        services = undefined;
        pressedNow(undefined);
      }
      // No open live AI status stream outlives the app (spec 10, HTTP routes).
      aiActivity.stop();
    },
  };
}
