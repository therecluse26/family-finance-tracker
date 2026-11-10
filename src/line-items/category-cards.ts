import {
  type CategorizedLineItem,
  type Database,
  listUnsureLineItems,
  productKeyOf,
} from "../db/index.ts";
import { log } from "../log.ts";
import {
  GROUPED_ON_CARD,
  openReviewItemsOfKind,
  type ReviewChoice,
  type ReviewItem,
  type ReviewSubject,
  regroupReviewItems,
} from "../review/index.ts";

// The Line item Category cards on the Review list (spec 14, Review list items): one card per
// product, which holds every Line item of that product the AI chose with confidence "low". Each
// update works the cards out again from the stored Categories, so a card keeps the open item that
// holds the most of its Line items, and an item whose Line items all moved on closes.

export const LINE_ITEM_CATEGORY_KIND = "Line item Category";

// Why a card closes when none of its Line items is unsure any more, such as after an Item rule.
export const LINE_ITEM_CHOSEN_AGAIN = "its Category was chosen again";

const lineItemIdsOf = (item: ReviewItem) =>
  item.subject.type === "line items" ? item.subject.lineItemIds : [];

// Newest order first, then by ID.
const newestFirst = (a: CategorizedLineItem, b: CategorizedLineItem) =>
  b.orderDate.localeCompare(a.orderDate) || a.id.localeCompare(b.id);

// The card's words and best answer: the Category the AI chose most, the newest first on a tie.
function faceOf(card: readonly CategorizedLineItem[]) {
  const counts = new Map<string, number>();
  for (const item of card) {
    if (item.category !== null) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  }
  let best: string | undefined;
  for (const [category, count] of counts) {
    if (best === undefined || count > (counts.get(best) ?? 0)) best = category;
  }
  const category = best ?? "Miscellaneous";
  const of = counts.get(category) ?? 0;
  const share = of === card.length ? "" : ` for ${of} of ${card.length}`;
  return {
    decided: `The AI chose ${category}${share}, but it was unsure.`,
    bestAnswer: { value: category, label: `Yes, ${category}` },
  };
}

// One update at a time, so two never open a card for the same product side by side.
let queue: Promise<unknown> = Promise.resolve();

// Keeps the Line item Category cards in step with the stored Categories. Reads the open cards and
// the unsure Line items once each, and writes in one transaction.
export function updateLineItemCards(database: Database): Promise<void> {
  const run = queue.then(async () => {
    const open = await openReviewItemsOfKind(database, LINE_ITEM_CATEGORY_KIND);
    const byProduct = new Map<string, CategorizedLineItem[]>();
    for (const item of await listUnsureLineItems(database)) {
      const key = productKeyOf(item);
      const card = byProduct.get(key);
      if (card === undefined) byProduct.set(key, [item]);
      else card.push(item);
    }
    // Each Line item's open item. One on two items, which only a race leaves, belongs to the newest.
    const itemOf = new Map<string, ReviewItem>();
    for (const item of open) {
      for (const id of lineItemIdsOf(item)) if (!itemOf.has(id)) itemOf.set(id, item);
    }
    type Face = { subject: ReviewSubject; decided: string; bestAnswer: ReviewChoice };
    const regroup = {
      close: [] as { id: string; reason: string }[],
      revise: [] as (Face & { id: string })[],
      open: [] as (Face & { kind: string })[],
    };
    const kept = new Set<string>();
    const onCard = new Set<string>();
    for (const card of byProduct.values()) {
      card.sort(newestFirst);
      const lineItemIds = card.map((item) => item.id);
      for (const id of lineItemIds) onCard.add(id);
      const face = faceOf(card);
      const holds = new Map<ReviewItem, number>();
      for (const id of lineItemIds) {
        const item = itemOf.get(id);
        if (item !== undefined && !kept.has(item.id)) holds.set(item, (holds.get(item) ?? 0) + 1);
      }
      let keeper: ReviewItem | undefined;
      for (const [item, count] of holds) {
        if (keeper === undefined || count > (holds.get(keeper) ?? 0)) keeper = item;
      }
      const subject = { type: "line items" as const, lineItemIds };
      if (keeper === undefined) {
        regroup.open.push({ kind: LINE_ITEM_CATEGORY_KIND, subject, ...face });
        continue;
      }
      kept.add(keeper.id);
      if (
        lineItemIdsOf(keeper).join() !== lineItemIds.join() ||
        keeper.decided !== face.decided ||
        keeper.bestAnswer.value !== face.bestAnswer.value ||
        keeper.bestAnswer.label !== face.bestAnswer.label
      ) {
        regroup.revise.push({ id: keeper.id, subject, ...face });
      }
    }
    for (const item of open) {
      if (kept.has(item.id)) continue;
      const grouped = lineItemIdsOf(item).some((id) => onCard.has(id));
      regroup.close.push({
        id: item.id,
        reason: grouped ? GROUPED_ON_CARD : LINE_ITEM_CHOSEN_AGAIN,
      });
    }
    if (regroup.close.length + regroup.revise.length + regroup.open.length === 0) return;
    await regroupReviewItems(database, regroup);
    if (regroup.open.length > 0) {
      log.info("Line item Categories the AI was unsure of went on the Review list", {
        opened: regroup.open.length,
      });
    }
  });
  queue = run.catch(() => {});
  return run;
}
