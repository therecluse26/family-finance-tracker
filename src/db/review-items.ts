import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database, Queries } from "./client.ts";
import { reviewItems, transactions } from "./schema.ts";

// Review list items in app.db (spec 07, Review list page). The review module decides; these
// functions store and read.

export type StoredReviewItem = typeof reviewItems.$inferSelect;

export type NewReviewItem = Pick<
  StoredReviewItem,
  "kind" | "subjectType" | "subjectIds" | "decided" | "bestAnswer"
> &
  Partial<Pick<StoredReviewItem, "needsAi">>;

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

// The newest date an item's shown Transactions show: the purchase date, else the posted date. Null
// for a loan item, or when none of its Transactions shows. Each item reads its own few Transactions
// by ID.
const subjectDate = sql<string | null>`(
  SELECT max(coalesce(${transactions.authorizedDate}, ${transactions.postedDate}))
  FROM json_each(${reviewItems.subjectIds}) AS subject
  JOIN ${transactions} ON ${transactions.id} = subject.value
  WHERE ${reviewItems.subjectType} = 'transactions' AND ${transactions.hiddenReason} IS NULL
)`;

// Every open item in the Review list page's order: newest first, and items made at the same moment
// by their Transaction's date, newest first, then by ID (spec 07, Review list page). A loan item
// comes after them.
export async function listReviewListItems(database: Database): Promise<StoredReviewItem[]> {
  return database
    .select()
    .from(reviewItems)
    .where(isNull(reviewItems.closedAt))
    .orderBy(
      desc(reviewItems.createdAt),
      sql`${subjectDate} DESC NULLS LAST`,
      desc(reviewItems.id),
    );
}

// Every open item, newest made first, for callers that settle or revise items and need no page
// order, so they skip each item's Transaction dates.
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

// The Accounts an item's two shown Transactions are in, sorted, as one text, or null when it does
// not have exactly two that show. Each item reads its own two Transactions by ID.
const accountsOfPair = sql<string | null>`(
  SELECT CASE WHEN count(*) = 2
    THEN min(${transactions.accountId}) || ' ' || max(${transactions.accountId}) END
  FROM json_each(${reviewItems.subjectIds}) AS subject
  JOIN ${transactions} ON ${transactions.id} = subject.value
  WHERE ${reviewItems.subjectType} = 'transactions' AND ${transactions.hiddenReason} IS NULL
)`;

// How many open items the Review list shows. Items of a kind in `groupedByAccounts` between the
// same two Accounts show as one group, so they count once (spec 07, Review list page).
export async function countOpenReviewItems(
  database: Database,
  groupedByAccounts: readonly string[] = [],
): Promise<number> {
  const shown =
    groupedByAccounts.length === 0
      ? count()
      : sql<number>`count(DISTINCT CASE WHEN ${inArray(reviewItems.kind, [...groupedByAccounts])}
          THEN coalesce('accounts ' || ${reviewItems.kind} || ' ' || ${accountsOfPair}, 'item ' || ${reviewItems.id})
          ELSE 'item ' || ${reviewItems.id} END)`.mapWith(Number);
  const [row] = await database
    .select({ open: shown })
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

// Gives each open item among these its new best answer and no-AI mark, in one write transaction,
// such as when the AI decides an item a no-AI path decided. An item already closed stays as it was.
export async function reviseOpenReviewItems(
  database: Database,
  revisions: readonly { id: string; bestAnswer: Choice; needsAi: boolean }[],
): Promise<void> {
  if (revisions.length === 0) return;
  await database.transaction(async (tx) => {
    for (const { id, bestAnswer, needsAi } of revisions) {
      await tx
        .update(reviewItems)
        .set({ bestAnswer, needsAi })
        .where(and(eq(reviewItems.id, id), isNull(reviewItems.closedAt)));
    }
  });
}

export type ReviewItemRegroup = {
  // Open items to close with no answer, each with the event that settled it.
  close: readonly { id: string; reason: string }[];
  // Open items that keep their ID and take these Transactions, words and best answer.
  revise: readonly {
    id: string;
    subjectIds: string[];
    decided: string;
    bestAnswer: Choice;
    // Kept as it is when absent.
    needsAi?: boolean;
  }[];
  open: readonly NewReviewItem[];
};

// Closes, revises and opens items in one write transaction, such as when Categorization groups a
// Merchant's items into one card. An item already closed stays as it was. Returns the new items'
// IDs in order.
export async function regroupOpenReviewItems(
  database: Database,
  regroup: ReviewItemRegroup,
  at: Date,
): Promise<string[]> {
  const { close, revise, open } = regroup;
  if (close.length === 0 && revise.length === 0 && open.length === 0) return [];
  return database.transaction(async (tx) => {
    const reasons = new Map<string, string[]>();
    for (const { id, reason } of close) reasons.set(reason, [...(reasons.get(reason) ?? []), id]);
    for (const [reason, ids] of reasons) {
      for (let start = 0; start < ids.length; start += 500) {
        await tx
          .update(reviewItems)
          .set({ closedAt: at, closedReason: reason, answer: null, answeredBy: null })
          .where(
            and(
              inArray(reviewItems.id, ids.slice(start, start + 500)),
              isNull(reviewItems.closedAt),
            ),
          );
      }
    }
    for (const { id, subjectIds, decided, bestAnswer, needsAi } of revise) {
      await tx
        .update(reviewItems)
        .set({ subjectIds, decided, bestAnswer, ...(needsAi === undefined ? {} : { needsAi }) })
        .where(and(eq(reviewItems.id, id), isNull(reviewItems.closedAt)));
    }
    return addReviewItems(tx, open, at);
  });
}
