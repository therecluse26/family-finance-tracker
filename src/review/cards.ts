import type { ReviewChoice, ReviewItem, ReviewSubject } from "./review-list.ts";

// Review list cards (spec 03 and 04, Review list items): one open item of a kind per key, which
// holds every Transaction of that key that asks. A Transaction with no key is a card of its own.
// A kind works out the cards it wants from what its Transactions ask now, and regroupCards works out
// how the open items get there: a card keeps the open item that holds the most of its Transactions,
// so a Member's open answer still reaches it, and every other open item closes. Items from before
// cards, one per Transaction, group the first time, with no marker: once grouped, a second update
// finds nothing to change.

// Why an item closes when its Transactions moved to another card.
export const GROUPED = "grouped";

// A Transaction that asks, with the key of its card, or null for a card of its own.
export type CardMember = { id: string; postedDate: string; key: string | null };

// The words and best answer a card shows, from its Transactions, newest first, and its no-AI mark,
// for a kind that keeps one.
export type CardFace = { decided: string; bestAnswer: ReviewChoice; needsAi?: boolean };

export type CardRegroup = {
  close: { id: string; reason: string }[];
  revise: (CardFace & { id: string; subject: ReviewSubject })[];
  open: (CardFace & { kind: string; subject: ReviewSubject })[];
  // How many open items closed as grouped.
  grouped: number;
};

const transactionIdsOf = (item: ReviewItem) =>
  item.subject.type === "transactions" ? item.subject.transactionIds : [];

// Newest first, by posted date, then by ID, as the Review list shows a card's Transactions.
const newestFirst = (a: CardMember, b: CardMember) =>
  b.postedDate.localeCompare(a.postedDate) || a.id.localeCompare(b.id);

// The members by key, each card newest first, the largest card first. A member with no key is a
// card of its own.
export function cardsByKey(members: readonly CardMember[]): CardMember[][] {
  const cards: CardMember[][] = [];
  const byKey = new Map<string, CardMember[]>();
  for (const member of members) {
    if (member.key === null) {
      cards.push([member]);
      continue;
    }
    const card = byKey.get(member.key);
    if (card === undefined) byKey.set(member.key, [member]);
    else card.push(member);
  }
  cards.push(...byKey.values());
  for (const card of cards) card.sort(newestFirst);
  return cards.sort((a, b) => b.length - a.length);
}

// What the open items of `kind` need so that each card in `cards` has one: the closings, the
// revised items, and the new ones. Reads nothing, and does no work for each pair of a Transaction
// and an item (K3). `closedWhy` says why an open item none of whose Transactions is on a card
// closes, such as "decided again".
export function regroupCards(
  kind: string,
  open: readonly ReviewItem[],
  cards: readonly (readonly CardMember[])[],
  faceOf: (card: readonly CardMember[]) => CardFace,
  closedWhy: string,
): CardRegroup {
  // Each Transaction's open item. A Transaction on two items, which only a race leaves, belongs to
  // the newest; the other lets it go.
  const itemOf = new Map<string, ReviewItem>();
  for (const item of open) {
    for (const id of transactionIdsOf(item)) if (!itemOf.has(id)) itemOf.set(id, item);
  }
  const kept = new Set<string>();
  const onCard = new Set<string>();
  const regroup: CardRegroup = { close: [], revise: [], open: [], grouped: 0 };
  for (const card of cards) {
    const transactionIds = card.map((member) => member.id);
    for (const id of transactionIds) onCard.add(id);
    const face = faceOf(card);
    const holds = new Map<ReviewItem, number>();
    for (const id of transactionIds) {
      const item = itemOf.get(id);
      if (item !== undefined && !kept.has(item.id)) holds.set(item, (holds.get(item) ?? 0) + 1);
    }
    let keeper: ReviewItem | undefined;
    for (const [item, count] of holds) {
      if (keeper === undefined || count > (holds.get(keeper) ?? 0)) keeper = item;
    }
    const subject = { type: "transactions" as const, transactionIds };
    if (keeper === undefined) {
      regroup.open.push({ kind, subject, ...face });
      continue;
    }
    kept.add(keeper.id);
    if (
      transactionIdsOf(keeper).join() !== transactionIds.join() ||
      keeper.decided !== face.decided ||
      keeper.bestAnswer.value !== face.bestAnswer.value ||
      keeper.bestAnswer.label !== face.bestAnswer.label ||
      (face.needsAi !== undefined && keeper.needsAi !== face.needsAi)
    ) {
      regroup.revise.push({ id: keeper.id, subject, ...face });
    }
  }
  for (const item of open) {
    if (kept.has(item.id)) continue;
    const grouped = transactionIdsOf(item).some((id) => onCard.has(id));
    if (grouped) regroup.grouped += 1;
    regroup.close.push({ id: item.id, reason: grouped ? GROUPED : closedWhy });
  }
  return regroup;
}
