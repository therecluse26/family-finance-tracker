import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { alertChannels, members, weeklySummarySends } from "./schema.ts";

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

// Takes the week's summary for each of these Members, in one statement: a Member with no row for
// the week gets one, and a Member whose last try failed takes it again. A Member whose summary is
// sending, sent, or given up is not taken. The check and the take are one write, so two runs at
// once never take one Member's week twice. Returns the IDs taken.
export async function takeWeeklySummaries(
  database: Database,
  memberIds: readonly string[],
  weekStart: string,
  at: Date,
): Promise<string[]> {
  if (memberIds.length === 0) return [];
  const rows = await database
    .insert(weeklySummarySends)
    .values(
      memberIds.map((memberId) => ({
        memberId,
        weekStart,
        state: "sending" as const,
        updatedAt: at,
      })),
    )
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

// A Member's latest summary that ended: sent, or given up. Undefined before the first.
export async function readLastWeeklySummary(
  database: Database,
  memberId: string,
): Promise<{ weekStart: string; state: "sent" | "gave up"; at: Date } | undefined> {
  const [row] = await database
    .select({
      weekStart: weeklySummarySends.weekStart,
      state: weeklySummarySends.state,
      at: weeklySummarySends.updatedAt,
    })
    .from(weeklySummarySends)
    .where(
      and(
        eq(weeklySummarySends.memberId, memberId),
        inArray(weeklySummarySends.state, ["sent", "gave up"]),
      ),
    )
    .orderBy(desc(weeklySummarySends.weekStart))
    .limit(1);
  if (row === undefined) return undefined;
  return { weekStart: row.weekStart, state: row.state === "sent" ? "sent" : "gave up", at: row.at };
}
