import { type HouseholdAi, PrivacyRefusal } from "../ai/index.ts";
import { benchmarkSnapshot } from "../benchmarks/index.ts";
import { type DraftTailoring, withinHalfOf } from "../budgets/index.ts";
import { type Category, categoryGroupOf } from "../categories/index.ts";
import {
  countTailoringRunFailure,
  type Database,
  dropTailoringRun,
  endRedraftRun,
  endTailoringRun,
  goalRunProposalsId,
  listBankNames,
  listWaitingTailoringRuns,
  type RedraftInputs,
  readBudgetInputs,
  readGoal,
  recordRedraftInputs,
  requestTailoringRun,
  type StoredGoal,
  type StoredTailoringRun,
} from "../db/index.ts";
import { calendarDateIn, wholeDollars } from "../format.ts";
import { goalAmountFrom, goalReadingOf, goalStartToday } from "../goals/index.ts";
import { householdTimeZone } from "../household/index.ts";
import { Job, startJobUnlessWaiting } from "../jobs/index.ts";
import { log } from "../log.ts";
import { raiseNotice } from "../notify/index.ts";
import { namedCompany, propose, US_BANKS_AND_LENDERS } from "../proposals/index.ts";
import { steadyIncome } from "../recurring/index.ts";
import {
  aiFigures,
  askTailoring,
  benchmarksOf,
  type CategoryFigure,
  centsOf,
  figuresOf,
  type GoalFacts,
  readTailoringFacts,
  screenText,
  type TailoringReply,
} from "./tailoring.ts";

// When Budget tailoring runs (spec 05, Which Proposals exist; spec 08, Runs that reuse these uses):
// - The first draft: Budget tailoring's figures take effect at once, with no Proposal.
// - The Tailoring run: when an AI provider is set up after the first draft, one Budget change
//   Proposal adjusts the current Budgets for the Goals. It runs once.
// - A Goal run: when a Goal is added or its words change (T89 asks for it), a Goal Budget change
//   Proposal for the flexible Categories the Goal touches, and a Goal amount Proposal for a spend
//   less Goal, and for a save Goal whose reading has no change. At most 2 Proposals.
// - A redraft: when one of its triggers fires (src/tailoring/redrafts.ts), the full draft for
//   flexible Categories, as one Proposal. Once handled, its inputs are the ones behind the current
//   Budgets, so the same trigger does not repeat.
// Each run makes one AI call. It waits in app.db until that call ends: an AI error retries after 1,
// 5 and 30 minutes, then the run takes its no-AI path, no Proposal. A pause, such as the AI cost
// cap, keeps it waiting until AI returns. With no AI provider, the run ends with no Proposal.

// A run that throws anything but an AI error ends after this many tries, with one System notice.
export const TAILORING_RUN_CAP = 3;

export const TAILORING_STOPPED_TEXT =
  "The app could not tailor Budgets after 3 tries. Budgets stay as they are.";

// A redraft asked for again during each of its runs, up to the cap.
export const REDRAFT_STOPPED_TEXT =
  "Household figures kept changing while the app redrafted Budgets, so it stopped after 3 runs. Budgets stay as they are.";

type Services = {
  database: Database;
  ai: HouseholdAi;
  now: () => Date;
  // Starts the Budget tailoring job. Tests give their own.
  startJob: () => Promise<unknown>;
};

let services: Services | undefined;

async function householdToday(database: Database, now: Date): Promise<string> {
  return calendarDateIn(now, (await householdTimeZone(database)) ?? "UTC");
}

const isBills = (category: Category) => categoryGroupOf(category) === "Bills";

// The first draft's part (src/budgets/first-draft.ts): one call, and the AI's figure and reason
// for each Category it gives one for. The draft stays the formula's on every other path, and
// never waits: after an AI error, or while AI is paused, a Tailoring run follows instead. The
// start gives it to the budgets module.
export const tailorFirstDraft: DraftTailoring = async ({ budgets }) => {
  try {
    if (services === undefined) throw new Error("Budget tailoring is not running.");
    const { database, ai, now } = services;
    const at = now();
    const figures = figuresOf(budgets, new Map());
    const reply = await askTailoring({
      database,
      ai,
      now,
      run: { kind: "first draft" },
      figures,
      benchmarks: await benchmarksOf(database, at),
    });
    if (reply.ready) {
      const drafted = await aiFigures(
        ai,
        reply.output,
        new Set(budgets.map((each) => each.category)),
      );
      // A reason that names a company is never stored, as in a Proposal (spec 08, rule 7): that
      // Category keeps the formula's figure.
      const companies = [...(await listBankNames(database)), ...US_BANKS_AND_LENDERS];
      for (const [category, { reason }] of drafted) {
        if (namedCompany(reason, companies) !== undefined) drafted.delete(category);
      }
      return drafted;
    }
    // After an AI error, or while AI is paused, such as at the AI cost cap, the Tailoring run waits
    // to make its Proposal once AI runs again.
    if ("retryAt" in reply || ("pause" in reply && reply.pause !== "no AI provider")) {
      await requestTailoringRun(database, { kind: "Tailoring" }, at);
    }
    log.info("The first draft took the formula's figures", {
      why: "pause" in reply ? reply.pause : "retryAt" in reply ? "AI retry" : reply.failed,
    });
    return undefined;
  } catch (error) {
    // The draft never waits on Budget tailoring: on any failure, it is the formula's figures.
    log.error("Budget tailoring failed in the first draft", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return undefined;
  }
};

// The Goal facts of a Goal run, and whether the app asks the AI for a Goal amount: always for a
// spend less Goal, and for a save Goal whose reading has no change, while it has none.
function goalFactsOf(
  start: Awaited<ReturnType<typeof goalStartToday>>,
  goal: StoredGoal,
): GoalFacts {
  const open = goal.goalAmount === null;
  if (start?.kind === "spend less") {
    return {
      kind: "spend less",
      baseline: start.baseline ?? 0,
      asksAmount: open && start.change === null,
    };
  }
  if (start?.kind === "save toward an amount") {
    return {
      kind: "save toward an amount",
      balance: start.startBalance ?? 0,
      asksAmount: open && start.change === null,
    };
  }
  return { kind: "other" };
}

// The figure for a Proposal: the AI's, within 50% of the formula's figure and within 50% of the
// current Budget, or undefined when no figure is within both.
function proposedFigure(figure: CategoryFigure, amount: number): number | undefined {
  if (figure.budget === null) return undefined;
  const base = figure.formula ?? figure.budget;
  const kept = withinHalfOf(figure.budget, withinHalfOf(base, amount));
  return withinHalfOf(base, kept) === kept ? kept : undefined;
}

// The Budget change Proposal of a Tailoring or Goal run: each flexible Category with a Budget whose
// figure changes. Bills, which hold Interest and fees, are never proposed. A Goal run for a
// Category Goal changes only that Category, the one it touches.
async function proposeBudgets(
  { database, ai, now }: Services,
  runId: string,
  reply: TailoringReply,
  figures: readonly CategoryFigure[],
  only?: Category,
): Promise<number> {
  const byCategory = new Map(figures.map((figure) => [figure.category, figure]));
  const withBudget = new Set(
    figures
      .filter((each) => each.budget !== null && (only === undefined || each.category === only))
      .map((each) => each.category),
  );
  const lines: { category: string; amount: number; reason: string }[] = [];
  for (const [category, { amount, reason }] of await aiFigures(ai, reply, withBudget)) {
    const figure = byCategory.get(category);
    if (figure === undefined || isBills(category)) continue;
    const kept = proposedFigure(figure, amount);
    if (kept === undefined || kept === figure.budget) continue;
    lines.push({ category, amount: kept, reason });
  }
  if (lines.length === 0) return 0;
  const result = await propose(
    database,
    {
      kind: "Budget change",
      source: "Budget tailoring",
      runId,
      reason: await screenText(ai, reply.reason),
      budgets: lines,
    },
    now(),
  );
  if (result.outcome === "shown") return 1;
  log.warn("A Budget tailoring Proposal was refused", { guardrail: result.guardrail });
  return 0;
}

// The Goal amount Proposal of a Goal run. A spend less Goal whose reading has a change takes the
// baseline minus the change, which the app computes. Otherwise the AI's amount counts only below
// a spend less Goal's baseline, or above a save Goal's balance.
async function proposeGoalAmount(
  { database, ai, now }: Services,
  runId: string,
  reply: TailoringReply,
  goal: StoredGoal,
  start: Awaited<ReturnType<typeof goalStartToday>>,
): Promise<number> {
  if (start === undefined || goal.goalAmount !== null) return 0;
  const asked = reply.goalAmount === null ? undefined : centsOf(reply.goalAmount);
  let amount: number | undefined;
  let reason = reply.goalReason ?? reply.reason;
  if (start.kind === "spend less") {
    const baseline = start.baseline ?? 0;
    if (start.change !== null) {
      amount = goalAmountFrom("spend less", start.change, baseline) ?? undefined;
      reason = `The 3-month average is ${wholeDollars(baseline)} a month. The Goal's change brings it to ${wholeDollars(amount ?? 0)}.`;
    } else if (asked !== undefined && asked < baseline) {
      amount = asked;
    }
  } else if (start.kind === "save toward an amount" && start.change === null) {
    if (asked !== undefined && asked > (start.startBalance ?? 0)) amount = asked;
  }
  if (amount === undefined) return 0;
  const result = await propose(
    database,
    {
      kind: "Goal amount",
      source: "Budget tailoring",
      runId,
      reason: await screenText(ai, reason),
      goalId: goal.id,
      goalAmount: amount,
    },
    now(),
  );
  if (result.outcome === "shown") return 1;
  log.warn("A Budget tailoring Proposal was refused", { guardrail: result.guardrail });
  return 0;
}

// The redraft Proposal's reason when the AI's names a company.
const REDRAFT_REASON = "The flexible Budgets, drafted again with the latest figures.";

// True when a redraft's figure differs from the current Budget by 5% or more.
const differs = (figure: number, budget: number) =>
  figure !== budget && Math.abs(figure - budget) * 20 >= budget;

// The redraft Proposal (spec 05, Which Proposals exist): the full draft for flexible Categories.
// Each Category takes the AI's figure, within 50% of the formula's, or the formula's figure, after
// the "must fit" step. A figure whose reason names a company is never used: that Category takes the
// formula's. The Proposal lists each flexible Category with a Budget whose figure differs from its
// Budget by 5% or more, kept within 50% of that Budget too (spec 08, rule 4). None differs, no
// Proposal. Returns how many Proposals it made: 1 or 0.
async function proposeRedraft(
  { database, ai, now }: Services,
  runId: string,
  reply: TailoringReply,
  figures: readonly CategoryFigure[],
  redraft: RedraftInputs,
): Promise<number> {
  const flexible = new Set(
    figures
      .filter((each) => each.budget !== null && !isBills(each.category))
      .map((each) => each.category),
  );
  const drafted = await aiFigures(ai, reply, flexible);
  const companies = [...(await listBankNames(database)), ...US_BANKS_AND_LENDERS];
  const lines: { category: string; amount: number; reason: string | null }[] = [];
  for (const figure of figures) {
    if (!flexible.has(figure.category) || figure.budget === null) continue;
    let found = drafted.get(figure.category);
    if (found !== undefined && namedCompany(found.reason, companies) !== undefined) {
      found = undefined;
    }
    const amount = found?.amount ?? figure.formula;
    if (amount === null) continue;
    const kept = proposedFigure(figure, amount);
    if (kept === undefined || !differs(kept, figure.budget)) continue;
    lines.push({ category: figure.category, amount: kept, reason: found?.reason ?? null });
  }
  if (lines.length === 0) return 0;
  const said = await screenText(ai, reply.reason);
  const reason = said === "" || namedCompany(said, companies) !== undefined ? REDRAFT_REASON : said;
  const result = await propose(
    database,
    { kind: "Budget change", source: "Budget tailoring", runId, reason, budgets: lines, redraft },
    now(),
  );
  if (result.outcome === "shown") return 1;
  log.warn("A redraft Proposal was refused", { guardrail: result.guardrail });
  return 0;
}

// The inputs a redraft drafts at: I, and the shipped CE data year.
function redraftInputsAt(income: number): RedraftInputs {
  const { ce, sample } = benchmarkSnapshot();
  return { steadyIncome: income, ceDataYear: ce.dataYear, sampleBenchmarks: sample };
}

// A redraft that ends with no Proposal is handled all the same: its inputs are recorded, so the
// same trigger does not repeat. A redraft that cannot read them logs it and ends.
async function redraftHandled(run: StoredTailoringRun, inputs?: RedraftInputs): Promise<void> {
  if (run.kind !== "Redraft" || services === undefined) return;
  try {
    const { database, now } = services;
    const at = now();
    const measured = inputs ?? redraftInputsAt((await steadyIncome(database, at)).amount);
    await recordRedraftInputs(database, measured, at);
  } catch (error) {
    log.error("A redraft could not record its inputs", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}

// A redraft's run ended. A trigger that fired during it, after the run read its stamp, keeps it
// waiting, since the run read its figures before that trigger: it runs once more, in a new job.
// Each run more counts toward the run cap, so a trigger that fires during every run still ends,
// with one System notice.
async function endRedraft(run: StoredTailoringRun): Promise<void> {
  if (services === undefined) throw new Error("Budget tailoring is not running.");
  const { database, startJob } = services;
  if (!(await endRedraftRun(database, run.id, run.requestedAt))) return;
  const tries = await countTailoringRunFailure(database, run.id);
  log.info("A redraft was asked for again during its run", { tries });
  if (tries >= TAILORING_RUN_CAP) {
    await dropTailoringRun(database, run.id);
    await raiseNotice({ kind: "event", text: REDRAFT_STOPPED_TEXT });
    return;
  }
  await startJob();
}

// One waiting run: "next" when it ended, "wait" when AI is paused or its retry is not due, so the
// runs after it wait too.
async function runOne(run: StoredTailoringRun): Promise<"next" | "wait"> {
  if (services === undefined) throw new Error("Budget tailoring is not running.");
  const { database, ai, now } = services;
  const at = now();
  // A Tailoring run asked for by the first draft's AI retry waits for the draft.
  if ((await readBudgetInputs(database)) === undefined) return "wait";
  let goal: StoredGoal | undefined;
  let start: Awaited<ReturnType<typeof goalStartToday>>;
  if (run.kind === "Goal") {
    goal = run.goalId === null ? undefined : await readGoal(database, run.goalId);
    // A Goal marked done or dropped before its run leaves the AI's context.
    if (goal === undefined || goal.status !== "active") {
      await dropTailoringRun(database, run.id);
      return "next";
    }
    start = await goalStartToday(database, goal.id, at);
  }
  const today = await householdToday(database, at);
  const { formula, income, budgets, benchmarks } = await readTailoringFacts(
    database,
    today.slice(0, 7),
    at,
    today,
  );
  const figures = figuresOf(formula, budgets);
  // A redraft drafts at the I its formula used, and the shipped CE data year.
  const redraft = run.kind === "Redraft" ? redraftInputsAt(income) : undefined;
  const reply = await askTailoring({
    database,
    ai,
    now,
    run:
      goal !== undefined
        ? { kind: "Goal", words: goal.words, goal: goalFactsOf(start, goal) }
        : redraft !== undefined
          ? { kind: "Redraft" }
          : { kind: "Tailoring" },
    figures,
    benchmarks,
  });
  if (!reply.ready) {
    if ("retryAt" in reply || ("pause" in reply && reply.pause !== "no AI provider")) {
      return "wait";
    }
    await redraftHandled(run, redraft);
    if (redraft !== undefined) await endRedraft(run);
    else await dropTailoringRun(database, run.id);
    log.info("A Budget tailoring run took its no-AI path", {
      kind: run.kind,
      why: "pause" in reply ? reply.pause : reply.failed,
    });
    return "next";
  }
  // New words saved during the AI call: the run proposes nothing and stays waiting, for the job
  // their save started, so its Proposals come from the words the Goal holds now.
  if (goal !== undefined && (await readGoal(database, goal.id))?.words !== goal.words) {
    log.info("A Goal's words changed during its Budget tailoring run");
    return "next";
  }
  const runId =
    goal === undefined ? `${run.kind} run ${run.id}` : goalRunProposalsId(run.id, goal.id);
  if (redraft !== undefined) {
    // Each run of a redraft has its own run ID, from the stamp it read, so a run after a trigger
    // during the last one has its own cap of Proposals. A retry after a failure keeps the stamp.
    const redraftRunId = `${runId} at ${run.requestedAt.toISOString()}`;
    const made = await proposeRedraft(services, redraftRunId, reply.output, figures, redraft);
    // With no Proposal, the redraft is handled now; a Proposal records them when it closes.
    if (made === 0) await redraftHandled(run, redraft);
    await endRedraft(run);
    log.info("A Budget tailoring run ended", { kind: run.kind, proposals: made });
    return "next";
  }
  // A Category Goal's limit comes from its own reading, so it holds whatever its start reads.
  const target = goal === undefined ? null : goalReadingOf(goal).target;
  const only = target?.kind === "Category" ? target.category : undefined;
  let made = await proposeBudgets(services, runId, reply.output, figures, only);
  if (goal !== undefined)
    made += await proposeGoalAmount(services, runId, reply.output, goal, start);
  await endTailoringRun(database, run.id, now());
  log.info("A Budget tailoring run ended", { kind: run.kind, proposals: made });
  return "next";
}

// Runs each waiting run, oldest first, until AI pauses. A run that throws anything but an AI error
// counts a try and waits for the next start; at the cap, it ends with one System notice. A run the
// privacy filter refuses ends at once. Returns how many runs ended.
export async function runWaitingTailoring(): Promise<number> {
  if (services === undefined) throw new Error("Budget tailoring is not running.");
  const { database } = services;
  let ended = 0;
  for (const run of await listWaitingTailoringRuns(database)) {
    try {
      if ((await runOne(run)) === "wait") break;
      ended += 1;
    } catch (error) {
      const name = error instanceof Error ? error.name : "unknown";
      if (error instanceof PrivacyRefusal) {
        await redraftHandled(run);
        await dropTailoringRun(database, run.id);
        log.error("The privacy filter refused a Budget tailoring run", { kind: run.kind });
        ended += 1;
        continue;
      }
      const tries = await countTailoringRunFailure(database, run.id);
      log.error("A Budget tailoring run failed", { kind: run.kind, tries, error: name });
      if (tries >= TAILORING_RUN_CAP) {
        await redraftHandled(run);
        await dropTailoringRun(database, run.id);
        await raiseNotice({ kind: "event", text: TAILORING_STOPPED_TEXT });
        ended += 1;
      }
    }
  }
  return ended;
}

// The Budget tailoring job: runs each waiting run. Asking for one, the AI retry of Budget
// tailoring, a change to the AI settings, and its daily task start it. With no run waiting, it
// does nothing.
export class BudgetTailoringJob extends Job {
  override async run(): Promise<void> {
    await runWaitingTailoring();
  }
}

// Starts the Budget tailoring job, unless one already waits to run.
export function requestTailoringJob(): Promise<boolean> {
  return startJobUnlessWaiting(BudgetTailoringJob, []);
}

// T89 asks for a Goal run when a Goal is added or its words change. True when this call stored
// it: a Goal whose run already waits keeps that one, which reads the Goal's words when it runs.
export async function requestGoalTailoring(goalId: string): Promise<boolean> {
  if (services === undefined) throw new Error("Budget tailoring is not running.");
  const stored = await requestTailoringRun(
    services.database,
    { kind: "Goal", goalId },
    services.now(),
  );
  await services.startJob();
  return stored;
}

// A redraft trigger fired (src/tailoring/redrafts.ts). True when this call stored the run: a
// redraft that already waits takes this trigger too, since it reads the figures when it runs. Its
// stamp moves, so a redraft whose run is under way runs once more (endRedraft).
export async function requestRedraft(trigger: string): Promise<boolean> {
  if (services === undefined) throw new Error("Budget tailoring is not running.");
  const stored = await requestTailoringRun(services.database, { kind: "Redraft" }, services.now());
  log.info(stored ? "A redraft was asked for" : "A redraft already waits", { trigger });
  if (stored) await services.startJob();
  return stored;
}

// After a change to the AI settings: once the first draft is stored, a Tailoring run, which is
// stored once ever and never after a first draft that took the AI's figures. Then the job, when
// any run waits, such as one paused at the AI cost cap.
async function afterAiChange({ database, now, startJob }: Services): Promise<void> {
  if ((await readBudgetInputs(database)) !== undefined) {
    await requestTailoringRun(database, { kind: "Tailoring" }, now());
  }
  if ((await listWaitingTailoringRuns(database)).length > 0) await startJob();
}

// Gives Budget tailoring app.db and the Household AI. The start calls it before jobs run. It gives
// back the first draft's part and the work after a change to the AI settings.
export function startBudgetTailoring(options: {
  database: Database;
  ai: HouseholdAi;
  now?: () => Date;
  startJob?: () => Promise<unknown>;
}): { afterAiChange(): Promise<void>; stop(): void } {
  if (services !== undefined) throw new Error("Budget tailoring is already running.");
  const started: Services = {
    database: options.database,
    ai: options.ai,
    now: options.now ?? (() => new Date()),
    startJob: options.startJob ?? requestTailoringJob,
  };
  services = started;
  return {
    afterAiChange: () => afterAiChange(started),
    stop() {
      if (services === started) services = undefined;
    },
  };
}
