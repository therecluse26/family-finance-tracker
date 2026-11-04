import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Database, Queries } from "./client.ts";
import { reviewItems } from "./schema.ts";

// Review list items in app.db (spec 07, Review list page). The review module decides; these
// functions store and read.

export type StoredReviewItem = typeof reviewItems.$inferSelect;

export type NewReviewItem = Pick<
  StoredReviewItem,
  "kind" | "subjectType" | "subjectIds" | "decided" | "bestAnswer"
>;

export async function addReviewItem(
  database: Database,
  item: NewReviewItem,
  at: Date,
): Promise<string> {
  const id = crypto.randomUUID();
  await database.insert(reviewItems).values({ id, ...item, createdAt: at });
  return id;
}

// Adds several items in one statement for each 500, and returns their IDs in order.
export async function addReviewItems(
  database: Queries,
  items: readonly NewReviewItem[],
  at: Date,
): Promise<string[]> {
  const rows = items.map((item) => ({ id: crypto.randomUUID(), ...item, createdAt: at }));
  for (let start = 0; start < rows.length; start += 500) {
    await database.insert(reviewItems).values(rows.slice(start, start + 500));
  }
  return rows.map((row) => row.id);
}

export async function readReviewItem(
  database: Database,
  id: string,
): Promise<StoredReviewItem | undefined> {
  const [row] = await database.select().from(reviewItems).where(eq(reviewItems.id, id));
  return row;
}

// The subjects of every item of a kind, open or closed, with when each opened.
export async function listReviewItemSubjects(
  database: Database,
  kind: string,
): Promise<{ subjectIds: string[]; createdAt: Date }[]> {
  return database
    .select({ subjectIds: reviewItems.subjectIds, createdAt: reviewItems.createdAt })
    .from(reviewItems)
    .where(eq(reviewItems.kind, kind));
}

// Every open item, newest first.
export async function listOpenReviewItems(database: Database): Promise<StoredReviewItem[]> {
  return database
    .select()
    .from(reviewItems)
    .where(isNull(reviewItems.closedAt))
    .orderBy(desc(reviewItems.createdAt), desc(reviewItems.id));
}

// Every open item of one kind, newest first.
export async function listOpenReviewItemsOfKind(
  database: Database,
  kind: string,
): Promise<StoredReviewItem[]> {
  return database
    .select()
    .from(reviewItems)
    .where(and(isNull(reviewItems.closedAt), eq(reviewItems.kind, kind)))
    .orderBy(desc(reviewItems.createdAt), desc(reviewItems.id));
}

export async function countOpenReviewItems(database: Database): Promise<number> {
  const [row] = await database
    .select({ open: count() })
    .from(reviewItems)
    .where(isNull(reviewItems.closedAt));
  return row?.open ?? 0;
}

type Choice = { value: string; label: string };

// A Member's answer, in one write transaction: `apply` gets the open item and applies the answer
// through `tx`, then the item closes as answered. When `apply` throws or returns undefined, nothing
// changes. An event that settles the item first leaves it not open; one that comes during the
// transaction waits for it, then finds the item closed.
export async function answerOpenReviewItem(
  database: Database,
  id: string,
  apply: (tx: Queries, item: StoredReviewItem) => Promise<Choice | undefined>,
  answeredBy: string,
  at: Date,
): Promise<"answered" | "not open" | "refused"> {
  return database.transaction(async (tx) => {
    const [item] = await tx.select().from(reviewItems).where(eq(reviewItems.id, id));
    if (item === undefined || item.closedAt !== null) return "not open";
    const answer = await apply(tx, item);
    if (answer === undefined) return "refused";
    await tx
      .update(reviewItems)
      .set({ closedAt: at, closedReason: "answered", answer, answeredBy })
      .where(and(eq(reviewItems.id, id), isNull(reviewItems.closedAt)));
    return "answered";
  });
}

// Closes the open items among `ids` with no answer, in one write transaction. Returns how many
// closed: an item already closed stays as it was.
export async function closeReviewItems(
  database: Database,
  ids: readonly string[],
  closing: { reason: string; at: Date },
): Promise<number> {
  if (ids.length === 0) return 0;
  return database.transaction(async (tx) => {
    let closed = 0;
    // SQLite limits the parameters in one statement.
    for (let start = 0; start < ids.length; start += 500) {
      const rows = await tx
        .update(reviewItems)
        .set({ closedAt: closing.at, closedReason: closing.reason, answer: null, answeredBy: null })
        .where(
          and(inArray(reviewItems.id, ids.slice(start, start + 500)), isNull(reviewItems.closedAt)),
        )
        .returning({ id: reviewItems.id });
      closed += rows.length;
    }
    return closed;
  });
}

// Closes an open item. False when it was already closed.
export async function closeReviewItem(
  database: Database,
  id: string,
  closing: {
    reason: string;
    at: Date;
    answer?: { value: string; label: string };
    answeredBy?: string;
  },
): Promise<boolean> {
  const closed = await database
    .update(reviewItems)
    .set({
      closedAt: closing.at,
      closedReason: closing.reason,
      answer: closing.answer ?? null,
      answeredBy: closing.answeredBy ?? null,
    })
    .where(and(eq(reviewItems.id, id), isNull(reviewItems.closedAt)))
    .returning({ id: reviewItems.id });
  return closed.length > 0;
}
