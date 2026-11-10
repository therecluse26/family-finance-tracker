import type { HouseholdAi } from "../ai/index.ts";
import { type Category, isCategory, NOT_FOR_LINE_ITEMS } from "../categories/index.ts";
import { type CategorizedLineItem, type Database, readLinkedLineItems } from "../db/index.ts";

// Cascade step 1a (spec 04, The categorization cascade; spec 14, Splits from Line items): a
// Spending Transaction with linked Line items takes its Category from them. The line-items module
// chooses each Line item's Category and registers that work here; until it registers, a Line item
// with no Category yet follows its Transaction's own Category, as at the Line items' step 4.

// The Category a Line item takes at its step 4 from its Transaction's Category.
export function transactionStepCategory(category: Category): Category {
  return NOT_FOR_LINE_ITEMS.has(category) ? "Miscellaneous" : category;
}

// How step 1a's Line item work runs, as step 5 does: the Household's AI, "follow-up job" for no AI
// call now, or undefined for no AI.
export type LineItemAi = HouseholdAi | "follow-up job" | undefined;

// Chooses the Category of each of these Line items, which have none yet, and stores it. Returns
// each Line item as it is now. One still with no Category waits for the AI: for its retry at
// `again`, or for the follow-up job.
export type LineItemCategorizer = (
  items: readonly CategorizedLineItem[],
  ai: LineItemAi,
) => Promise<{ items: CategorizedLineItem[]; again?: Date }>;

let categorizer: LineItemCategorizer | undefined;

// Registers the line-items module's work. Returns a function that removes it again.
export function registerLineItemCategorizer(work: LineItemCategorizer): () => void {
  if (categorizer !== undefined) throw new Error("A Line item categorizer is already registered.");
  categorizer = work;
  return () => {
    if (categorizer === work) categorizer = undefined;
  };
}

// What a Transaction's Line items say at step 1a: each Category's total in cents, and the total of
// the Line items that follow the Transaction's own Category (spec 14, Step 4), or null when none
// does. "waits" while a Line item waits for the AI.
export type LineItemTotals = { byCategory: Map<Category, number>; own: number | null } | "waits";

// The Line item totals of each of these Transactions that has linked Line items, with any Line
// item that has no Category yet chosen first. One read of the Line items for all of them (K3).
export async function lineItemTotals(
  database: Database,
  transactionIds: readonly string[],
  ai: LineItemAi,
): Promise<{ totals: Map<string, LineItemTotals>; again?: Date }> {
  const totals = new Map<string, LineItemTotals>();
  if (transactionIds.length === 0) return { totals };
  const linked = await readLinkedLineItems(database, transactionIds);
  if (linked.size === 0) return { totals };
  const unchosen = [...linked.values()].flat().filter((item) => item.categorySource === null);
  let again: Date | undefined;
  const now = new Map<string, CategorizedLineItem>();
  if (unchosen.length > 0 && categorizer !== undefined) {
    const chosen = await categorizer(unchosen, ai);
    again = chosen.again;
    for (const item of chosen.items) now.set(item.id, item);
  }
  for (const [transactionId, stored] of linked) {
    const items = stored.map((item) => now.get(item.id) ?? item);
    if (categorizer !== undefined && items.some((item) => item.categorySource === null)) {
      totals.set(transactionId, "waits");
      continue;
    }
    const byCategory = new Map<Category, number>();
    let own: number | null = null;
    for (const item of items) {
      const category = item.category;
      if (item.categorySource === "Transaction" || category === null || !isCategory(category)) {
        own = (own ?? 0) + item.total;
      } else {
        byCategory.set(category, (byCategory.get(category) ?? 0) + item.total);
      }
    }
    totals.set(transactionId, { byCategory, own });
  }
  return again === undefined ? { totals } : { totals, again };
}
