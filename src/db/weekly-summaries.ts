import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import {
  alertChannels,
  members,
  spendingLinks,
  transactions,
  weeklySummarySends,
} from "./schema.ts";

// The weekly summary email in app.db (spec 06, Weekly summary email): each Member's own switch, and
// one row for each Member and week the app sends a summary for. The weekly-summary module decides;
// these functions store and read.

// A Member's own switch. Off for a Member who never turned it on.
export async function readWeeklySummarySwitch(
  database: Database,
  memberId: string,
): Promise<boolean> {
  const [row] = await database
    .select({ on: alertChannels.weeklySummary })
    .from(alertChannels)
    .where(eq(alertChannels.memberId, memberId));
  return row?.on ?? false;
}

// Turns a Member's own summary on or off. A Member with no channels row gets one with both
// channels, as every new Member has them, so the switch changes nothing else.
export async function storeWeeklySummarySwitch(
  database: Database,
  memberId: string,
  on: boolean,
): Promise<void> {
  await database
    .insert(alertChannels)
    .values({ memberId, push: true, email: true, weeklySummary: on })
    .onConflictDoUpdate({ target: alertChannels.memberId, set: { weeklySummary: on } });
}

// Each Member who turned the summary on, with their login email, in the order Members joined.
export async function listWeeklySummaryMembers(
  database: Database,
): Promise<{ id: string; email: string }[]> {
  return database
    .select({ id: members.id, email: members.email })
    .from(members)
    .innerJoin(alertChannels, eq(alertChannels.memberId, members.id))
    .where(eq(alertChannels.weeklySummary, true))
    .orderBy(asc(members.createdAt), asc(members.id));
}

// The Members whose week's summary is taken already: sending, sent, or given up. A run that finds
// every Member who wants it taken skips the build. The take still decides.
export async function listTakenWeeklySummaries(
  database: Database,
  weekStart: string,
): Promise<string[]> {
  const rows = await database
    .select({ memberId: weeklySummarySends.memberId })
    .from(weeklySummarySends)
    .where(
      and(eq(weeklySummarySends.weekStart, weekStart), ne(weeklySummarySends.state, "failed")),
    );
  return rows.map((row) => row.memberId);
}

// Takes the week's summary for each of these Members whose switch is still on, in one statement:
// a Member with no row for the week gets one, and a Member whose last try failed takes it again.
// A Member who turned the switch off since the list was read is not taken, nor is a Member whose
// summary is sending, sent, or given up. The checks and the take are one write, so two runs at
// once never take one Member's week twice. Returns the IDs taken.
export async function takeWeeklySummaries(
  database: Database,
  memberIds: readonly string[],
  weekStart: string,
  at: Date,
): Promise<string[]> {
  if (memberIds.length === 0) return [];
  // Every column, in the table's order, as an INSERT ... SELECT writes them. Members in the order
  // they joined, as listWeeklySummaryMembers lists them.
  const wanting = database
    .select({
      memberId: alertChannels.memberId,
      weekStart: sql`${sql.param(weekStart, weeklySummarySends.weekStart)}`.as("week_start"),
      state: sql`'sending'`.as("state"),
      tries: sql`0`.as("tries"),
      updatedAt: sql`${sql.param(at, weeklySummarySends.updatedAt)}`.as("updated_at"),
    })
    .from(alertChannels)
    .innerJoin(members, eq(members.id, alertChannels.memberId))
    .where(
      and(inArray(alertChannels.memberId, [...memberIds]), eq(alertChannels.weeklySummary, true)),
    )
    .orderBy(asc(members.createdAt), asc(members.id));
  const rows = await database
    .insert(weeklySummarySends)
    .select(wanting)
    .onConflictDoUpdate({
      target: [weeklySummarySends.memberId, weeklySummarySends.weekStart],
      set: { state: "sending", updatedAt: at },
      setWhere: eq(weeklySummarySends.state, "failed"),
    })
    .returning({ memberId: weeklySummarySends.memberId });
  return rows.map((row) => row.memberId);
}

// A taken summary went out.
export async function finishWeeklySummary(
  database: Database,
  memberId: string,
  weekStart: string,
  at: Date,
): Promise<void> {
  await database
    .update(weeklySummarySends)
    .set({ state: "sent", updatedAt: at })
    .where(
      and(
        eq(weeklySummarySends.memberId, memberId),
        eq(weeklySummarySends.weekStart, weekStart),
        eq(weeklySummarySends.state, "sending"),
      ),
    );
}

// Counts a failed try for each of these Members' taken summaries, in one statement. A summary at
// `cap` tries is given up; one with tries left is "failed", so the next run takes it again.
// Returns each Member's tries and new state.
export async function countWeeklySummaryFailures(
  database: Database,
  memberIds: readonly string[],
  weekStart: string,
  cap: number,
  at: Date,
): Promise<{ memberId: string; tries: number; state: "failed" | "gave up" }[]> {
  if (memberIds.length === 0) return [];
  const rows = await database
    .update(weeklySummarySends)
    .set({
      tries: sql`${weeklySummarySends.tries} + 1`,
      state: sql`CASE WHEN ${weeklySummarySends.tries} + 1 >= ${cap} THEN 'gave up' ELSE 'failed' END`,
      updatedAt: at,
    })
    .where(
      and(
        inArray(weeklySummarySends.memberId, [...memberIds]),
        eq(weeklySummarySends.weekStart, weekStart),
        eq(weeklySummarySends.state, "sending"),
      ),
    )
    .returning({
      memberId: weeklySummarySends.memberId,
      tries: weeklySummarySends.tries,
      state: weeklySummarySends.state,
    });
  return rows.map((row) => ({
    memberId: row.memberId,
    tries: row.tries,
    state: row.state === "gave up" ? "gave up" : "failed",
  }));
}

// A Member's latest week's summary, in any state. Undefined before the first. `at` is its last
// change.
export async function readLatestWeeklySummary(
  database: Database,
  memberId: string,
): Promise<
  | { weekStart: string; state: "sending" | "failed" | "sent" | "gave up"; tries: number; at: Date }
  | undefined
> {
  const [row] = await database
    .select({
      weekStart: weeklySummarySends.weekStart,
      state: weeklySummarySends.state,
      tries: weeklySummarySends.tries,
      at: weeklySummarySends.updatedAt,
    })
    .from(weeklySummarySends)
    .where(eq(weeklySummarySends.memberId, memberId))
    .orderBy(desc(weeklySummarySends.weekStart))
    .limit(1);
  return row;
}

// The posted date of each linked Refund or Reimbursement, by its ID. listPostedParts gives a linked
// part its Spending's dates; the weekly summary counts it on its own.
export async function listLinkedMoneyPostedDates(database: Database): Promise<Map<string, string>> {
  const rows = await database
    .select({ id: transactions.id, postedDate: transactions.postedDate })
    .from(spendingLinks)
    .innerJoin(transactions, eq(transactions.id, spendingLinks.transactionId));
  return new Map(rows.map((row) => [row.id, row.postedDate]));
}
