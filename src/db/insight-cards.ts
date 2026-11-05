import { and, asc, eq, gte, inArray, isNull } from "drizzle-orm";
import type { Database } from "./client.ts";
import { insightCards, transactions } from "./schema.ts";

// SQLite takes at most 32,766 values in one statement.
const IDS_PER_QUERY = 500;

// Whether any of these Transactions is newly posted and shown: a sync first stored it as posted at
// `since` or later, and it is not pending and not hidden. A Member's edit or a change to a posted
// Transaction does not make it new. One short query per 500 IDs, which stops at the first it finds.
export async function holdsNewPostedTransaction(
  database: Database,
  ids: readonly string[],
  since: Date,
): Promise<boolean> {
  for (let start = 0; start < ids.length; start += IDS_PER_QUERY) {
    const [found] = await database
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          inArray(transactions.id, ids.slice(start, start + IDS_PER_QUERY)),
          gte(transactions.postedSeenAt, since),
          eq(transactions.pending, false),
          isNull(transactions.hiddenReason),
        ),
      )
      .limit(1);
    if (found !== undefined) return true;
  }
  return false;
}

// The current Insight cards in app.db (spec 08, Insight cards), and each card's Done mark. The
// insights module decides; these functions store and read.

export type InsightCardRow = typeof insightCards.$inferSelect;

// A card as a run writes it: no Done mark yet.
export type NewInsightCard = Omit<InsightCardRow, "doneAt" | "doneBy">;

// The current cards, in the AI's order.
export function listInsightCards(database: Database): Promise<InsightCardRow[]> {
  return database.select().from(insightCards).orderBy(asc(insightCards.position));
}

// Replaces the whole set with a run's cards, in one transaction: the old cards and their Done
// marks go.
export async function replaceInsightCards(
  database: Database,
  cards: readonly NewInsightCard[],
): Promise<void> {
  await database.transaction(async (tx) => {
    await tx.delete(insightCards);
    if (cards.length > 0) await tx.insert(insightCards).values([...cards]);
  });
}

// Marks one current card Done for every Member, or clears the mark. Marking a done card again
// keeps the first mark. Returns false, and changes nothing, when no current card has the ID.
export async function storeInsightCardDone(
  database: Database,
  mark: { cardId: string; memberId: string; at: Date; done: boolean },
): Promise<boolean> {
  const { cardId, memberId, at, done } = mark;
  return database.transaction(async (tx) => {
    const [card] = await tx
      .select({ doneAt: insightCards.doneAt })
      .from(insightCards)
      .where(eq(insightCards.id, cardId));
    if (card === undefined) return false;
    if (done && card.doneAt !== null) return true;
    await tx
      .update(insightCards)
      .set(done ? { doneAt: at, doneBy: memberId } : { doneAt: null, doneBy: null })
      .where(eq(insightCards.id, cardId));
    return true;
  });
}
