import * as z from "zod";
import { budgetSpending, budgetsForMonth } from "../budgets/index.ts";
import {
  type Database,
  listAccounts,
  listMonthlyReviews,
  listPlanTicks,
  listReviewLinks,
  readMonthlyReview,
  storeMonthlyReview,
  storePlanTick,
  storeReviewLinkDone,
} from "../db/index.ts";
import { calendarDateIn } from "../format.ts";
import { readGoalsWithProgress } from "../goals/index.ts";
import { householdTimeZone } from "../household/index.ts";
import { listManualLoanViews } from "../money-movement/index.ts";
import { drawPicture, pictureChoice } from "../pictures/index.ts";
import { EFFORTS, IDEA_KINDS, type StoredReview } from "./review-view.ts";

// The Monthly review (spec 08, Monthly review; spec 07, Reviews page). A run on the 1st hands the
// AI's words here; the app adds every number and picture from app.db and stores the whole review
// once. It never changes after that: the plan's ticks and the AI box link's Done mark are stored
// apart from it. Reading a review makes no AI call and writes nothing.

// The review link leaves the AI box 7 days after the review is written (spec 07, 1. AI box).
export const REVIEW_LINK_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;
// The largest saving or cost a month, in dollars.
const MAX_DOLLARS = 1_000_000;

const text = (max: number) => z.string().trim().min(1).max(max);
const dollars = z.number().min(0).max(MAX_DOLLARS);

// The AI's part of a review (spec 08, Review fields), in dollars as the AI writes them. Each
// picture choice is parsed on its own when the review is stored, so one bad choice draws no
// picture and never refuses the review. `budgetChanges` become Proposals through the proposals
// module, with the source "Monthly review" and the review's month as the run ID; this part takes
// them and leaves them out of the review. A field the review fields do not name refuses the reply.
export const reviewReply = z
  .object({
    headline: text(200),
    budgetChanges: z.unknown().optional(),
    habits: z
      .array(
        z
          .object({ name: text(100), line: text(200), costMonth: dollars, picture: z.unknown() })
          .strict(),
      )
      .min(2)
      .max(4),
    ideas: z
      .array(
        z
          .object({
            idea: text(100),
            savesMonth: dollars,
            effort: z.enum(EFFORTS),
            kind: z.enum(IDEA_KINDS),
            habit: z.number().int().min(0).nullable(),
            why: text(400),
            catch: text(300).nullable(),
          })
          .strict(),
      )
      .min(5)
      .max(8),
    plan: z.array(z.object({ idea: z.number().int().min(0), when: text(60) }).strict()).length(3),
    goals: z.array(z.object({ goalId: text(100), line: text(200) }).strict()).max(100),
  })
  .strict()
  .refine(
    ({ habits, ideas, plan }) =>
      ideas.every((idea) => idea.habit === null || idea.habit < habits.length) &&
      plan.every((item) => item.idea < ideas.length) &&
      new Set(plan.map((item) => item.idea)).size === plan.length,
    { message: "Each index points at a Habit or idea in the review, and the plan's ideas differ." },
  );
export type ReviewReply = z.input<typeof reviewReply>;

const cents = (amount: number) => Math.round(amount * 100);

// What every credit card and every loan owes now, Manual loans included, as the Debt tile counts
// it (spec 07, 4. Number tiles): Excluded and Closed Accounts count in no balance.
async function debtNow(database: Database): Promise<number> {
  const manualLoans = new Map(
    (await listManualLoanViews(database)).map((loan) => [loan.id, loan.currentBalance]),
  );
  let owed = 0;
  for (const account of await listAccounts(database)) {
    if (account.closedAt !== null || account.excluded) continue;
    if (account.kind !== "credit" && account.kind !== "loan") continue;
    // A Manual loan's balance is the app's estimate of what it owes; a synced one owes its
    // negative balance.
    const manual = manualLoans.get(account.id);
    owed += manual === undefined ? 0 - (account.currentBalance ?? 0) : manual;
  }
  return owed;
}

// The header's Spending and Budget in `month`, in the Categories Left to spend counts (spec 07,
// 2. Left to spend): each monthly Budget, and each Category with no Budget. Travel, and Gifts and
// donations, stay out.
async function headerSpending(
  database: Database,
  month: string,
  now: Date,
): Promise<Pick<StoredReview["header"], "spending" | "budget">> {
  const { budgets, groups } = await budgetsForMonth(database, month);
  const found = await budgetSpending(database, month, budgets, now);
  let spending = 0;
  for (const group of found.groups.values()) spending += group?.spending ?? 0;
  const monthly = budgets.some((budget) => budget.period === "monthly");
  return {
    spending,
    budget: monthly ? groups.reduce((sum, group) => sum + group.monthly, 0) : null,
  };
}

export type SaveResult = "saved" | "already written" | { refused: string };

// Stores the review of `month`, written YYYY-MM, from the AI's words: the header, each Habit's
// picture, and each active Goal's meter are drawn from app.db at `writtenAt`. A month that has a
// review keeps it. A reply that does not fit the review fields stores nothing.
export async function saveMonthlyReview(
  database: Database,
  input: { month: string; reply: unknown; writtenAt?: Date },
): Promise<SaveResult> {
  const { month, writtenAt = new Date() } = input;
  if (!MONTH.test(month)) return { refused: "Write the month as YYYY-MM." };
  const parsed = reviewReply.safeParse(input.reply);
  if (!parsed.success) return { refused: "The reply does not fit the review fields." };
  const reply = parsed.data;
  if ((await readMonthlyReview(database, month)) !== undefined) return "already written";

  const habits: StoredReview["habits"] = [];
  for (const habit of reply.habits) {
    const choice = pictureChoice.safeParse(habit.picture);
    habits.push({
      name: habit.name,
      line: habit.line,
      costMonth: cents(habit.costMonth),
      picture: choice.success ? await drawPicture(database, choice.data, month, writtenAt) : null,
    });
  }
  const lines = new Map<string, string>();
  for (const goal of reply.goals) if (!lines.has(goal.goalId)) lines.set(goal.goalId, goal.line);
  const goals: StoredReview["goals"] = (await readGoalsWithProgress(database, writtenAt))
    .filter((goal) => goal.list === "active")
    .map((goal) => ({
      goalId: goal.id,
      words: goal.words,
      percentage: goal.progress?.percentage ?? null,
      state: goal.progress?.state ?? null,
      detail: goal.progress?.detail ?? "",
      line: lines.get(goal.id) ?? null,
    }));

  const review: StoredReview = {
    writtenOn: calendarDateIn(writtenAt, (await householdTimeZone(database)) ?? "UTC"),
    headline: reply.headline,
    header: {
      ...(await headerSpending(database, month, writtenAt)),
      debt: await debtNow(database),
    },
    habits,
    ideas: reply.ideas.map((idea) => ({ ...idea, savesMonth: cents(idea.savesMonth) })),
    plan: reply.plan,
    goals,
  };
  const stored = await storeMonthlyReview(database, { month, writtenAt, review });
  return stored ? "saved" : "already written";
}

// Each review's month, and the Household's date it was written, newest month first.
export async function listReviews(
  database: Database,
): Promise<{ month: string; writtenOn: string }[]> {
  return (await listMonthlyReviews(database)).map((row) => ({
    month: row.month,
    writtenOn: (row.review as StoredReview).writtenOn,
  }));
}

export type MonthlyReview = {
  month: string;
  writtenAt: Date;
  review: StoredReview;
  // The ticked plan items, shared across the Household: each one's place in the plan, who ticked
  // it, and when. A removed Member's tick stays, with no Member.
  ticks: { item: number; memberId: string | null; tickedAt: Date }[];
};

// A month's review as it was written, with the plan's ticks, or undefined with none.
export async function readReview(
  database: Database,
  month: string,
): Promise<MonthlyReview | undefined> {
  const row = await readMonthlyReview(database, month);
  if (row === undefined) return undefined;
  return {
    month: row.month,
    writtenAt: row.writtenAt,
    review: row.review as StoredReview,
    ticks: await listPlanTicks(database, month),
  };
}

// Ticks a plan item (0, 1, or 2) for every Member, or clears it. False, and nothing changes, when
// the month has no review.
export function tickPlanItem(
  database: Database,
  tick: { month: string; item: number; memberId: string; done: boolean },
  now = new Date(),
): Promise<boolean> {
  return storePlanTick(database, { ...tick, at: now });
}

// The AI box's review links (spec 07, 1. AI box): "Your <Month> review is ready", from when the
// review is written until a Member marks it Done or 7 days pass. Newest first.
export async function reviewLinks(
  database: Database,
  now = new Date(),
): Promise<{ month: string; writtenAt: Date }[]> {
  const since = new Date(now.getTime() - REVIEW_LINK_DAYS * DAY_MS);
  return (await listReviewLinks(database, since))
    .filter((link) => !link.done && link.writtenAt <= now)
    .map(({ month, writtenAt }) => ({ month, writtenAt }));
}

// Done on a review link, for every Member: the link leaves the box. {done: false} clears the mark
// within the 7 days. False, and nothing changes, when the box has no link for the month.
export function markReviewLink(
  database: Database,
  mark: { month: string; memberId: string; done: boolean },
  now = new Date(),
): Promise<boolean> {
  const since = new Date(now.getTime() - REVIEW_LINK_DAYS * DAY_MS);
  return storeReviewLinkDone(database, { ...mark, at: now, since });
}
