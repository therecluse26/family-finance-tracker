import { and, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "./client.ts";
import { noticeDeliveries, systemNotices } from "./schema.ts";

// System notices and their delivery records in app.db (spec 06, System notices). The notify module
// decides; these functions store and read.

export type StoredNotice = typeof systemNotices.$inferSelect;

export type NewNotice =
  | { kind: "event"; text: string }
  | { kind: "condition"; text: string; condition: string };

// Stores a new notice and its delivery record, in one transaction. A condition that already has an
// open notice keeps that one, and gets no second delivery. Returns the open notice's ID.
export async function addNotice(database: Database, notice: NewNotice, at: Date): Promise<string> {
  return database.transaction(async (tx) => {
    const condition = notice.kind === "condition" ? notice.condition : null;
    if (condition !== null) {
      const [open] = await tx
        .select({ id: systemNotices.id })
        .from(systemNotices)
        .where(and(eq(systemNotices.condition, condition), isNull(systemNotices.closedAt)));
      if (open !== undefined) return open.id;
    }
    const id = crypto.randomUUID();
    await tx
      .insert(systemNotices)
      .values({ id, kind: notice.kind, text: notice.text, condition, raisedAt: at });
    await tx.insert(noticeDeliveries).values({ noticeId: id, createdAt: at });
    return id;
  });
}

// Closes the open notice of a condition. True when one was open.
export async function endNoticeCondition(
  database: Database,
  condition: string,
  at: Date,
): Promise<boolean> {
  const closed = await database
    .update(systemNotices)
    .set({ closedAt: at })
    .where(and(eq(systemNotices.condition, condition), isNull(systemNotices.closedAt)))
    .returning({ id: systemNotices.id });
  return closed.length > 0;
}

// A Member closes an open event notice, for every Member. A condition notice stays open until its
// condition ends.
export async function closeEventNotice(
  database: Database,
  id: string,
  memberId: string,
  at: Date,
): Promise<"closed" | "not open" | "condition"> {
  const [notice] = await database
    .select({ kind: systemNotices.kind, closedAt: systemNotices.closedAt })
    .from(systemNotices)
    .where(eq(systemNotices.id, id));
  if (notice === undefined || notice.closedAt !== null) return "not open";
  if (notice.kind === "condition") return "condition";
  await database
    .update(systemNotices)
    .set({ closedAt: at, closedBy: memberId })
    .where(and(eq(systemNotices.id, id), isNull(systemNotices.closedAt)));
  return "closed";
}

// Every open notice, newest first.
export async function listOpenNotices(database: Database): Promise<StoredNotice[]> {
  return database
    .select()
    .from(systemNotices)
    .where(isNull(systemNotices.closedAt))
    .orderBy(desc(systemNotices.raisedAt), desc(systemNotices.id));
}
