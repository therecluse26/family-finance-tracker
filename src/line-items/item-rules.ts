import {
  type Category,
  isCategory,
  LINE_ITEM_CATEGORIES,
  NOT_FOR_LINE_ITEMS,
} from "../categories/index.ts";
import { categoryChoiceValue, readCategoryChoice } from "../categorization/index.ts";
import {
  type ChangedLineItems,
  type Database,
  listItemRules,
  type Queries,
  readCategorizedLineItems,
  removeItemRule,
  type StoredItemRule,
  setLineItemCategoriesByHand,
  storeItemRule,
} from "../db/index.ts";
import { askForFollowUp, followUpAgain } from "../follow-up/index.ts";
import { log } from "../log.ts";
import {
  NotAChoice,
  type ReviewChoice,
  type ReviewItem,
  type ReviewKind,
} from "../review/index.ts";
import { updateLineItemCards } from "./category-cards.ts";

// Item rules (spec 14, Item rules). A Member's change of a Line item's Category makes it hand-set,
// and makes or replaces the Item rule for its product, unless the Member picks "only this item".
// The rule changes every Line item of the product that no Member set by hand, in one statement,
// and every Transaction it changed goes down the follow-up steps again, in the same transaction,
// so its parts are made again.

// Whether a Line item may take the Category: one from the fixed list, and never Superstores, Cash
// or Payments to people.
export function takesLineItemCategory(category: string): category is Category {
  return isCategory(category) && !NOT_FOR_LINE_ITEMS.has(category);
}

// The Categories a Line item may take, in list order.
export function lineItemCategoryChoices(onlyThisItem: boolean): ReviewChoice[] {
  return LINE_ITEM_CATEGORIES.map((name) => ({
    value: categoryChoiceValue(name, onlyThisItem),
    label: onlyThisItem ? `${name}, only this item` : name,
  }));
}

// Makes these Line items hand-set with the Category and, unless `onlyThisItem`, makes the Item rule
// for the product of `maker` and gives the rule's Category to every Line item it covers. Every
// changed Transaction goes down the follow-up steps again. Writes only through `database`, so it
// runs inside the change's transaction. Returns the Transactions it sent.
async function applyChange(
  database: Queries,
  maker: {
    productId: string | null;
    cleanName: string;
    name: string;
    transactionId: string | null;
  },
  handSet: readonly string[],
  category: Category,
  options: { onlyThisItem: boolean; memberId: string; at: Date },
): Promise<string[]> {
  await setLineItemCategoriesByHand(database, handSet, category);
  let changed: ChangedLineItems = { ids: [], transactionIds: [] };
  if (!options.onlyThisItem) {
    ({ changed } = await storeItemRule(database, {
      productId: maker.productId,
      cleanName: maker.cleanName,
      name: maker.name,
      category,
      madeAt: options.at,
      madeBy: options.memberId,
    }));
  }
  const sent = new Set(changed.transactionIds);
  const handSetItems = await readCategorizedLineItems(database, handSet);
  for (const item of handSetItems) if (item.transactionId !== null) sent.add(item.transactionId);
  await followUpAgain(database, [...sent]);
  return [...sent];
}

// Serializes every Item rule write, so two changes at once never run side by side: concurrent
// libSQL transactions stall, and the later change must win (K18).
let queue: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work);
  queue = run.catch(() => {});
  return run;
}

export type LineItemChange = { category: string; onlyThisItem: boolean };

export type LineItemChangeResult = "changed" | "not found" | "not a Category";

// A Member changes a Line item's Category (spec 14, Item rules; Pages). In one transaction: the
// Line item becomes hand-set, the rule is made unless "only this item", and every changed
// Transaction goes down the follow-up steps again. Then the follow-up job starts and the Review
// list's cards update.
export function changeLineItemCategory(
  database: Database,
  id: string,
  change: LineItemChange,
  memberId: string,
  at = new Date(),
): Promise<LineItemChangeResult> {
  const { category, onlyThisItem } = change;
  if (!takesLineItemCategory(category)) return Promise.resolve("not a Category");
  return oneAtATime(async () => {
    const found = await database.transaction(async (tx) => {
      const [item] = await readCategorizedLineItems(tx, [id]);
      if (item === undefined) return false;
      await applyChange(tx, item, [item.id], category, { onlyThisItem, memberId, at });
      return true;
    });
    if (!found) return "not found";
    await afterChange(database);
    return "changed";
  });
}

// The follow-up job and the Review list's cards, after a change commits. A failure here leaves the
// change in place: the next follow-up job and update reach it.
async function afterChange(database: Database): Promise<void> {
  await askForFollowUp();
  await updateLineItemCards(database);
}

// Every Item rule, by name, for Settings.
export function itemRules(database: Database): Promise<StoredItemRule[]> {
  return listItemRules(database);
}

// Deletes an Item rule (spec 14, Item rules). Its Line items not set by hand lose their Category,
// and their Transactions go down the follow-up steps again, in the same transaction. Returns the
// Line items it cleared, or undefined when no rule has the ID. The caller sends the unlinked ones
// down the steps again.
export function deleteItemRule(
  database: Database,
  id: string,
): Promise<ChangedLineItems | undefined> {
  return oneAtATime(async () => {
    const removed = await database.transaction(async (tx) => {
      const gone = await removeItemRule(tx, id);
      if (gone === undefined) return undefined;
      await followUpAgain(tx, gone.cleared.transactionIds);
      return gone.cleared;
    });
    if (removed === undefined) return undefined;
    await afterChange(database);
    return removed;
  });
}

const lineItemIdsOf = (item: ReviewItem) =>
  item.subject.type === "line items" ? item.subject.lineItemIds : [];

// The Line item Category kind of the Review list (spec 14, Review list items). Accepting the
// guess makes an Item rule; another Category is a correction, and makes a rule unless the Member
// picks "only this item", which a card of one Line item offers. Each Line item still on the card
// becomes hand-set.
export function lineItemCategoryReview(database: Database): ReviewKind {
  return {
    async otherChoices(item) {
      const one = lineItemIdsOf(item).length === 1;
      return [...lineItemCategoryChoices(false), ...(one ? lineItemCategoryChoices(true) : [])];
    },
    async answer(item, choice, answering) {
      const answer = readCategoryChoice(choice.value);
      if (item.subject.type !== "line items" || answer === undefined) {
        throw new Error("A Line item Category item is about Line items, and its answer is one.");
      }
      if (!takesLineItemCategory(answer.category)) throw new NotAChoice();
      // Only the Line items still unsure, read inside the answer's transaction: one a Member
      // changed, or one an Item rule reached, keeps what it has.
      const onCard = (
        await readCategorizedLineItems(answering.database, lineItemIdsOf(item))
      ).filter((each) => each.categorySource === "AI" && each.categoryConfidence === "low");
      const [maker] = onCard;
      if (maker === undefined) {
        log.info("A Line item Category card's answer found none of its Line items still on it");
        return;
      }
      await applyChange(
        answering.database,
        maker,
        onCard.map((each) => each.id),
        answer.category,
        {
          onlyThisItem: answer.onlyThisTransaction,
          memberId: answering.memberId,
          at: new Date(),
        },
      );
    },
    afterAnswer: () => afterChange(database),
  };
}
