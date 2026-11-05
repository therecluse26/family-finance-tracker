import { and, asc, desc, eq, gt } from "drizzle-orm";
import type { Database } from "./client.ts";
import { monthlyReviews, reviewLinksDone, reviewPlanTicks } from "./schema.ts";

// The Monthly reviews in app.db (spec 08, Monthly review; spec 07, Reviews page), the plan's ticks,
// and each review link's Done mark in the AI box. The monthly-review module decides; these
// functions store and read. A review row is written once and never updated.

export type StoredMonthlyReview = typeof monthlyReviews.$inferSelect;

// Stores a month's review. A month that has one keeps it: the review never changes once written.
// Returns false, and changes nothing, when the month already has a review.
export async function storeMonthlyReview(
  database: Database,
  row: StoredMonthlyReview,
): Promise<boolean> {
  const stored = await database
    .insert(monthlyReviews)
    .values(row)
    .onConflictDoNothing()
    .returning({ month: monthlyReviews.month });
  return stored.length > 0;
}

// Every review, newest month first.
export async function listMonthlyReviews(database: Database): Promise<StoredMonthlyReview[]> {
  return database.select().from(monthlyReviews).orderBy(desc(monthlyReviews.month));
}

export async function readMonthlyReview(
  database: Database,
  month: string,
): Promise<StoredMonthlyReview | undefined> {
  const [row] = await database.select().from(monthlyReviews).where(eq(monthlyReviews.month, month));
  return row;
}

// The ticked plan items of a month's review, in plan order.
export async function listPlanTicks(
  database: Database,
  month: string,
): Promise<{ item: number; memberId: string | null; tickedAt: Date }[]> {
  return database
    .select({
      item: reviewPlanTicks.item,
      memberId: reviewPlanTicks.memberId,
      tickedAt: reviewPlanTicks.tickedAt,
    })
    .from(reviewPlanTicks)
    .where(eq(reviewPlanTicks.month, month))
    .orderBy(asc(reviewPlanTicks.item));
}

// Ticks a plan item for every Member, or clears the tick, in one transaction. Ticking a ticked
// item again keeps the first tick. Returns false, and changes nothing, when the month has no
// review.
export async function storePlanTick(
  database: Database,
  tick: { month: string; item: number; memberId: string; at: Date; done: boolean },
): Promise<boolean> {
  const { month, item, memberId, at, done } = tick;
  return database.transaction(async (tx) => {
    const [review] = await tx
      .select({ month: monthlyReviews.month })
      .from(monthlyReviews)
      .where(eq(monthlyReviews.month, month));
    if (review === undefined) return false;
    if (done) {
      await tx
        .insert(reviewPlanTicks)
        .values({ month, item, memberId, tickedAt: at })
        .onConflictDoNothing();
    } else {
      await tx
        .delete(reviewPlanTicks)
        .where(and(eq(reviewPlanTicks.month, month), eq(reviewPlanTicks.item, item)));
    }
    return true;
  });
}

// The reviews written after `since`, newest first, each with its link's Done mark.
export async function listReviewLinks(
  database: Database,
  since: Date,
): Promise<{ month: string; writtenAt: Date; done: boolean }[]> {
  const rows = await database
    .select({
      month: monthlyReviews.month,
      writtenAt: monthlyReviews.writtenAt,
      doneMonth: reviewLinksDone.month,
    })
    .from(monthlyReviews)
    .leftJoin(reviewLinksDone, eq(reviewLinksDone.month, monthlyReviews.month))
    .where(gt(monthlyReviews.writtenAt, since))
    .orderBy(desc(monthlyReviews.writtenAt));
  return rows.map(({ doneMonth, ...row }) => ({ ...row, done: doneMonth !== null }));
}

// Marks a review link Done for every Member, or clears the mark, in one transaction. The link is a
// review written after `since`. Marking a done link again keeps the first mark. Returns false, and
// changes nothing, when no such review has the month.
export async function storeReviewLinkDone(
  database: Database,
  mark: { month: string; memberId: string; at: Date; since: Date; done: boolean },
): Promise<boolean> {
  const { month, memberId, at, since, done } = mark;
  return database.transaction(async (tx) => {
    const [review] = await tx
      .select({ month: monthlyReviews.month })
      .from(monthlyReviews)
      .where(and(eq(monthlyReviews.month, month), gt(monthlyReviews.writtenAt, since)));
    if (review === undefined) return false;
    if (done) {
      await tx
        .insert(reviewLinksDone)
        .values({ month, memberId, doneAt: at })
        .onConflictDoNothing();
    } else {
      await tx.delete(reviewLinksDone).where(eq(reviewLinksDone.month, month));
    }
    return true;
  });
}
