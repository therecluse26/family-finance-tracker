import * as z from "zod";
import { type AiReply, type HouseholdAi, type SummaryPart, typedCount } from "../ai/index.ts";
import {
  clearAiRetry,
  type Database,
  endMonthlyReviewRun,
  listHealthyConnectionSyncs,
  listMonthlyReviewProposalReasons,
  listOpenMonthlyReviewRuns,
  markMonthlyReviewDue,
  markMonthlyReviewProposed,
  type StoredMonthlyReviewRun,
  storeMonthlyReviewReply,
  storeMonthlyReviewRetry,
} from "../db/index.ts";
import { calendarDateIn, monthLabel } from "../format.ts";
import { type Goal, readGoalsWithProgress } from "../goals/index.ts";
import { householdTimeZone } from "../household/index.ts";
import { daily, Job, type Schedule } from "../jobs/index.ts";
import { type Logger, log } from "../log.ts";
import { endCondition, raiseNotice } from "../notify/index.ts";
import { PICTURE_TYPES } from "../pictures/index.ts";
import { MAX_PROPOSALS_PER_RUN, propose } from "../proposals/index.ts";
import { addMonths } from "../recurring/index.ts";
import { householdSummary, plainLine } from "../summary/index.ts";
import { type ReviewReply, reviewReply, saveMonthlyReview } from "./review.ts";
import { EFFORTS, IDEA_KINDS } from "./review-view.ts";

// Writing the Monthly review (spec 08, Monthly review; Every AI use; Failures; The AI cost cap).
// - At midnight on the 1st, Household time, the review of the month just ended comes due. A 1st
//   the app missed while it was down comes due at the next start (spec 10, Scheduled tasks). A new
//   install waits for its first 1st.
// - The check each minute writes a due review once every Healthy Connection has synced that day,
//   or at noon, whichever comes first. After the 1st, a due review is written at once.
// - It rebuilds the Household summary for the month just ended, then makes one Writer call. The
//   reply is stored the moment it comes back, so no failure after the call pays for a second one:
//   a stored reply or a stored review makes no call.
// - An AI error tries again after 1, 5, and 30 minutes, then every 6 hours (src/ai/retries.ts).
//   At the AI cost cap, or while AI waits for history, a fixed key, or a price, it looks again
//   each hour, so it runs after the reset. With no AI provider, the month has no review.
// - Its cap is its month: when the next month begins, a run with no review ends, makes no more
//   calls, and raises one System notice.

// How long a run waits after a pause, or after a failure that is not an AI error, before it looks
// again. A look rebuilds the Household summary, so it is not every minute.
export const REVIEW_WAIT_MS = 60 * 60 * 1000;

// The hour of the 1st, Household time, at which the review is written whether or not every
// Healthy Connection has synced.
export const REVIEW_HOUR = 12;

// The condition of the System notice for a month whose review could not be written. The next
// review that is written ends it.
export const REVIEW_STOPPED = "monthly review stopped";

// The task, as the AI reads it after the Household summary. Its counts stay far apart, so no two of
// them read as a Household's ages to the privacy filter. The reply's schema holds every count too.
export const MONTHLY_REVIEW_TASK = [
  "Task: the Monthly review of the month just ended, which the Household summary covers. On the 1st the dashboard moves to the new month, so the review holds the old month's story. Do not restate the dashboard.",
  "",
  "headline: how the month went, under 15 words.",
  "",
  'habits: at least 2 Habits, and at most 4. A Habit is a repeated behavior, named the way a perceptive friend would say it, such as "Takeout fills the busy nights" or "The cards never quite get paid off". It names what the Household does, not what it spent.',
  "- name: no numbers, and fewer than 8 words.",
  "- line: one line that says what gives the Habit away, under 16 words, with at most one number.",
  "- Never judgmental. A one-off is not a Habit.",
  "- costMonth: what the Habit costs a month, in dollars.",
  '- picture: one picture from the menu. "days" names a Category or a list of Merchants: a calendar of the days it happened. "trend" names a Category: its Spending against its Budget over recent months. "cards" names nothing: each credit card\'s balance and APR. "recurring" names a Category: its monthly Recurring charges. Set a field the picture does not name to null.',
  "",
  "ideas: at least 5 ideas to save, and at most 8. Every idea comes from this Household's data: what the data shows, the change, and the saving a month.",
  "- Look widely: meal prep, grocery trips, overlapping streaming services, price increases, carried card debt, deferred-interest deadlines, loan rates, insurance, and fees.",
  "- Debt ideas compare real options with the math: paying the statement in full, a 0% balance transfer card, a debt consolidation loan, or paying down with savings above the emergency fund.",
  "- Name a kind of product, never a company, lender, or card.",
  "- idea: an imperative, under 8 words. savesMonth: the saving a month, in dollars.",
  "- effort: Easy, Some effort, or Big step. kind: Habit, Recurring charge, Debt, or Bill.",
  "- habit: the Habit the idea answers, by its place in habits counting from 0, or null.",
  "- why: one sentence with the evidence and the math. catch: one sentence, or null.",
  "",
  "plan: exactly 3 different ideas, each by its place in ideas counting from 0, with when: a date or how often, under 6 words.",
  "",
  "goals: one line for each active Goal listed below, by its number: which idea moves it, and how much, under 14 words.",
  "",
  "budgetChanges: Budget changes to consider, at most 2, or none. Each names a Category exactly as the summary does, the new amount in dollars for the Budget's period, from half the current Budget to one and a half times it, and a one-sentence reason. Never a Bills Category. Each one becomes a Proposal that a Member may accept.",
].join("\n");

// A picture choice as the AI writes it: every field present, and null where the picture names
// nothing. Drawing checks it against the data (src/pictures), so a bad choice draws no picture.
const pictureAnswer = z
  .object({
    type: z.enum(PICTURE_TYPES),
    category: z.string().nullable(),
    merchants: z.array(z.string()).nullable(),
  })
  .strict();

const answerShape = (goals: number) =>
  z
    .object({
      headline: z.string(),
      habits: z
        .array(
          z
            .object({
              name: z.string(),
              line: z.string(),
              costMonth: z.number(),
              picture: pictureAnswer,
            })
            .strict(),
        )
        .min(2)
        .max(4),
      ideas: z
        .array(
          z
            .object({
              idea: z.string(),
              savesMonth: z.number(),
              effort: z.enum(EFFORTS),
              kind: z.enum(IDEA_KINDS),
              habit: z.number().int().nullable(),
              why: z.string(),
              catch: z.string().nullable(),
            })
            .strict(),
        )
        .min(5)
        .max(8),
      plan: z.array(z.object({ idea: z.number().int(), when: z.string() }).strict()).length(3),
      goals: z.array(z.object({ goal: z.number().int(), line: z.string() }).strict()).length(goals),
      // Guardrail 3: at most 2 Proposals in one review.
      budgetChanges: z
        .array(
          z.object({ category: z.string(), newAmount: z.number(), reason: z.string() }).strict(),
        )
        .max(MAX_PROPOSALS_PER_RUN),
    })
    .strict();

export type ReviewAnswer = z.infer<ReturnType<typeof answerShape>>;

type BudgetChange = { category: string; amount: number; reason: string };

// The AI's answer as the monthly-review module stores it, with each Goal by its ID, in the order
// the call listed them, and each Budget change in whole cents.
function asReviewReply(
  answer: ReviewAnswer,
  goalIds: readonly string[],
): { review: ReviewReply; budgetChanges: BudgetChange[] } {
  return {
    review: {
      headline: answer.headline,
      habits: answer.habits.map(({ picture, ...habit }) => ({
        ...habit,
        picture: {
          type: picture.type,
          ...(picture.category === null ? {} : { category: picture.category }),
          ...(picture.merchants === null ? {} : { merchants: picture.merchants }),
        },
      })),
      ideas: answer.ideas,
      plan: answer.plan,
      goals: answer.goals.map((goal) => ({
        goalId: goalIds[goal.goal - 1] ?? "",
        line: goal.line,
      })),
    },
    budgetChanges: answer.budgetChanges.map((change) => ({
      category: change.category,
      amount: Math.round(change.newAmount * 100),
      reason: change.reason,
    })),
  };
}

// The reply schema of a review call that lists `goals` active Goals (spec 08, Review fields). A
// reply passes only when the review it makes fits the review fields: the counts, each text's
// length, each Habit and idea index, and one line for each Goal number, each once. A reply that
// fails is an AI error, which retries, so a paid reply is never refused after it is stored.
export function reviewAnswer(goals: number) {
  const placeholders = Array.from({ length: goals }, (_, index) => `goal-${index + 1}`);
  return answerShape(goals).refine(
    (answer) =>
      answer.goals.every((goal) => goal.goal >= 1 && goal.goal <= goals) &&
      new Set(answer.goals.map((goal) => goal.goal)).size === goals &&
      answer.budgetChanges.every((change) => Number.isFinite(change.newAmount)) &&
      reviewReply.safeParse(asReviewReply(answer, placeholders).review).success,
    { message: "The reply fits the review fields." },
  );
}

// What a run keeps of the reply, the moment it comes back: the answer, and the IDs of the Goals
// the call listed, by number.
const storedReply = z.object({ answer: z.unknown(), goalIds: z.array(z.string()) });

// The call's facts after the task: the active Goals by number, each number a typed count, and each
// Goal's words as one plain line, so the privacy filter reads the characters the AI reads and the
// words cannot start a line of their own. The reply names each Goal by its number, never by its ID.
function goalParts(goals: readonly Goal[]): SummaryPart[] {
  if (goals.length === 0) return ["Active Goals: none, so goals is empty."];
  return [
    "Active Goals, by number:",
    ...goals.flatMap((goal, index) => [
      "\n",
      typedCount(index + 1),
      `. "${plainLine(goal.words)}"`,
    ]),
  ];
}

const nextMonth = (month: string) => addMonths(`${month}-01`, 1).slice(0, 7);

// The hour on the Household's clock, 0 to 23.
function hourIn(moment: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" })
    .formatToParts(moment)
    .find((part) => part.type === "hour")?.value;
  return Number(hour);
}

// Midnight on the 1st of each month, Household time.
export const ON_THE_FIRST: Schedule = {
  next(after, timeZone) {
    const midnight = daily("00:00");
    let at = after;
    for (let day = 0; day < 32; day += 1) {
      at = midnight.next(at, timeZone);
      if (calendarDateIn(at, timeZone).endsWith("-01")) return at;
    }
    throw new RangeError("No 1st of the month within 32 days.");
  },
};

// The review of the month just ended, Household time, comes due. A month whose review is due
// keeps its run.
export async function markReviewDue(database: Database, now = new Date()): Promise<string> {
  const timeZone = (await householdTimeZone(database)) ?? "UTC";
  const month = addMonths(`${calendarDateIn(now, timeZone).slice(0, 7)}-01`, -1).slice(0, 7);
  await markMonthlyReviewDue(database, month, now);
  return month;
}

// What one check did: nothing was due, another check was running, the run waits for its time, a
// retry, or AI, or it ended with a review, with none for want of an AI provider, or at its cap.
export type ReviewCheck =
  | "nothing due"
  | "running"
  | "waits"
  | "written"
  | "no AI provider"
  | "stopped";

type Services = { database: Database; ai: HouseholdAi; now: () => Date; logger: Logger };

let services: Services | undefined;
// True while a check runs. It is set before the check's first await, so two checks that start
// together never make two calls.
let checking = false;

// Gives the Monthly review's jobs app.db and the one AI call path. The start calls it before jobs
// run.
export function startMonthlyReview(options: {
  database: Database;
  ai: HouseholdAi;
  now?: () => Date;
  logger?: Logger;
}): { stop(): void } {
  if (services !== undefined) throw new Error("The Monthly review is already running.");
  const started: Services = {
    database: options.database,
    ai: options.ai,
    now: options.now ?? (() => new Date()),
    logger: options.logger ?? log,
  };
  services = started;
  return {
    stop() {
      if (services === started) services = undefined;
    },
  };
}

// Looks at each run that has not ended: ends one whose month has passed, and moves the open one on
// a step, up to the review written. Safe to run at any time: a second check while one runs does
// nothing.
export async function checkMonthlyReview(at?: Date): Promise<ReviewCheck> {
  if (services === undefined) throw new Error("The Monthly review is not running.");
  if (checking) return "running";
  checking = true;
  try {
    const running = services;
    const now = at ?? running.now();
    const runs = await listOpenMonthlyReviewRuns(running.database);
    if (runs.length === 0) return "nothing due";
    const timeZone = (await householdTimeZone(running.database)) ?? "UTC";
    const today = calendarDateIn(now, timeZone);
    const thisMonth = today.slice(0, 7);
    let result: ReviewCheck = "nothing due";
    for (const run of runs) {
      // A run whose month has not ended, as when the clock or the time zone moves back across
      // midnight on the 1st, waits.
      const due = nextMonth(run.month);
      if (due < thisMonth) result = await stop(running, run.month, now);
      else if (due === thisMonth) result = await advance(running, run, { now, today, timeZone });
      else result = "waits";
    }
    return result;
  } finally {
    checking = false;
  }
}

// True once the 1st's review may be written: at noon, or once every Healthy Connection has synced
// that day.
async function timeToWrite(
  database: Database,
  clock: { now: Date; today: string; timeZone: string },
): Promise<boolean> {
  if (!clock.today.endsWith("-01")) return true;
  if (hourIn(clock.now, clock.timeZone) >= REVIEW_HOUR) return true;
  return (await listHealthyConnectionSyncs(database)).every(
    (connection) =>
      connection.lastSyncedAt !== null &&
      calendarDateIn(connection.lastSyncedAt, clock.timeZone) === clock.today,
  );
}

async function advance(
  running: Services,
  run: StoredMonthlyReviewRun,
  clock: { now: Date; today: string; timeZone: string },
): Promise<ReviewCheck> {
  const { database, logger } = running;
  const { now } = clock;
  if (run.retryAt !== null && run.retryAt > now) return "waits";
  let reply = run.reply;
  if (reply === null) {
    if (!(await timeToWrite(database, clock))) return "waits";
    const asked = await ask(running, run.month, now);
    if (typeof asked === "string") return asked;
    reply = asked;
  }
  try {
    return await finish(running, { ...run, reply }, now);
  } catch (error) {
    // The reply stays stored: the next look stores the review from it, with no call.
    logger.error("The Monthly review could not be stored", {
      month: run.month,
      error: error instanceof Error ? error.name : "unknown",
    });
    await storeMonthlyReviewRetry(database, run.month, new Date(now.getTime() + REVIEW_WAIT_MS));
    return "waits";
  }
}

// The one Writer call, after the Household summary for the month just ended is rebuilt. Returns
// the stored reply, or what the run does instead.
async function ask(
  running: Services,
  month: string,
  now: Date,
): Promise<Record<string, unknown> | ReviewCheck> {
  const { database, ai, logger } = running;
  const later = new Date(now.getTime() + REVIEW_WAIT_MS);
  let goals: Goal[];
  let reply: AiReply<ReviewAnswer>;
  try {
    goals = (await readGoalsWithProgress(database, now)).filter((goal) => goal.list === "active");
    const summary = await householdSummary({
      database,
      ai,
      now: () => now,
      logger,
    }).monthJustEnded();
    reply = await ai.generate({
      use: "monthly review",
      summary: summary.parts,
      task: MONTHLY_REVIEW_TASK,
      facts: goalParts(goals),
      output: reviewAnswer(goals.length),
    });
  } catch (error) {
    // Such as the privacy filter refusing the call, which then did not go out. Only the error's
    // name: never the prompt, the reply, or a message that may quote them.
    logger.warn("The Monthly review call could not be made", {
      month,
      error: error instanceof Error ? error.name : "unknown",
    });
    await storeMonthlyReviewRetry(database, month, later);
    return "waits";
  }
  if (!reply.ready) {
    if ("pause" in reply && reply.pause === "no AI provider") {
      await endMonthlyReviewRun(database, month, "no AI provider", now);
      await clearAiRetry(database, "monthly review");
      logger.info("No Monthly review this month: no AI provider", { month });
      return "no AI provider";
    }
    // An AI error's retry time, or an hour after a pause such as the AI cost cap.
    await storeMonthlyReviewRetry(database, month, "retryAt" in reply ? reply.retryAt : later);
    logger.info("The Monthly review waits", {
      month,
      reason: "pause" in reply ? reply.pause : "failed" in reply ? reply.failed : "AI retry",
    });
    return "waits";
  }
  const stored = { answer: reply.output, goalIds: goals.map((goal) => goal.id) };
  await storeMonthlyReviewReply(database, month, stored);
  return stored;
}

// The review's text for the screen, in the one plain voice, with each Member's name in place of
// their label.
async function forScreen(ai: HouseholdAi, review: ReviewReply): Promise<ReviewReply> {
  const screen = (text: string) => ai.forScreen(text);
  const maybe = async (text: string | null) => (text === null ? null : screen(text));
  return {
    headline: await screen(review.headline),
    habits: await Promise.all(
      review.habits.map(async (habit) => ({
        ...habit,
        name: await screen(habit.name),
        line: await screen(habit.line),
      })),
    ),
    ideas: await Promise.all(
      review.ideas.map(async (idea) => ({
        ...idea,
        idea: await screen(idea.idea),
        why: await screen(idea.why),
        catch: await maybe(idea.catch),
      })),
    ),
    plan: await Promise.all(
      review.plan.map(async (item) => ({ ...item, when: await screen(item.when) })),
    ),
    goals: await Promise.all(
      review.goals.map(async (goal) => ({ ...goal, line: await screen(goal.line) })),
    ),
  };
}

// From the stored reply: each Budget change becomes a Proposal, once, then the review is stored.
async function finish(
  running: Services,
  run: StoredMonthlyReviewRun & { reply: Record<string, unknown> },
  now: Date,
): Promise<ReviewCheck> {
  const { database, ai, logger } = running;
  const kept = storedReply.parse(run.reply);
  const { review, budgetChanges } = asReviewReply(
    reviewAnswer(kept.goalIds.length).parse(kept.answer),
    kept.goalIds,
  );
  if (run.proposedAt === null) {
    // A look that failed between two Proposals made the first: each change goes once, matched by
    // its reason as stored.
    const made = await listMonthlyReviewProposalReasons(database, run.month);
    for (const change of budgetChanges) {
      const reason = await ai.forScreen(change.reason);
      const already = made.indexOf(reason.trim());
      if (already !== -1) {
        made.splice(already, 1);
        continue;
      }
      const result = await propose(
        database,
        {
          kind: "Budget change",
          source: "Monthly review",
          runId: run.month,
          reason,
          budgets: [{ category: change.category, amount: change.amount }],
        },
        now,
      );
      if (result.outcome === "refused") {
        logger.info("A Budget change from the Monthly review was refused", {
          month: run.month,
          guardrail: result.guardrail,
        });
      }
    }
    await markMonthlyReviewProposed(database, run.month, now);
  }
  // A Member's name can make a text longer than its field allows: the review then keeps the
  // labels, as the AI wrote them.
  const screened = await forScreen(ai, review);
  const reply = reviewReply.safeParse(screened).success ? screened : review;
  const saved = await saveMonthlyReview(database, { month: run.month, reply, writtenAt: now });
  if (typeof saved === "object") {
    logger.error("The Monthly review was refused", { month: run.month, reason: saved.refused });
    return stop(running, run.month, now);
  }
  await endMonthlyReviewRun(database, run.month, "written", now);
  logger.info("Wrote the Monthly review", {
    month: run.month,
    budgetChanges: budgetChanges.length,
  });
  try {
    await endCondition(REVIEW_STOPPED);
  } catch (error) {
    logger.warn("The Monthly review System notice could not be ended", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
  return "written";
}

// The run's month has passed with no review: it ends, its AI retry ends with it, and one System
// notice says so.
async function stop(running: Services, month: string, now: Date): Promise<ReviewCheck> {
  const { database, logger } = running;
  if (!(await endMonthlyReviewRun(database, month, "stopped", now))) return "stopped";
  await clearAiRetry(database, "monthly review");
  logger.warn("The Monthly review stopped with no review", { month });
  try {
    await raiseNotice({
      kind: "condition",
      condition: REVIEW_STOPPED,
      text: `The app could not write the ${monthLabel(`${month}-01`)} Monthly review. Next month's review is written on the 1st as usual.`,
    });
  } catch (error) {
    logger.warn("The Monthly review System notice could not be raised", {
      error: error instanceof Error ? error.name : "unknown",
    });
  }
  return "stopped";
}

// The task on the 1st: the review of the month just ended comes due.
export class MonthlyReviewDueJob extends Job {
  override async run(): Promise<void> {
    if (services === undefined) throw new Error("The Monthly review is not running.");
    const month = await markReviewDue(services.database, services.now());
    services.logger.info("The Monthly review is due", { month });
  }
}

// The check each minute. Most minutes it finds nothing due and does nothing.
export class MonthlyReviewJob extends Job {
  override async run(): Promise<void> {
    await checkMonthlyReview();
  }
}
