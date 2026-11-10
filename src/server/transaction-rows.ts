import {
  countLineItemsOf,
  type Database,
  readChargeNames,
  readShownParts,
  type ShownPart,
} from "../db/index.ts";
import type { CategoryChosenBy, TransactionRowView } from "./money-movement-views.ts";

// The Transactions page's rows (spec 07, Transactions page): each Transaction with its Merchant and
// its parts, and how each part's Category was chosen. The parts of every row come from one batch.

type ListedTransaction = Omit<
  TransactionRowView,
  "merchant" | "recurringChargeName" | "itemCount" | "parts"
> & {
  merchantCleanName: string | null;
};

// How the part's Category was chosen (spec 04, Provenance), or null when it has none of its own.
export function categoryChosenBy(part: ShownPart): CategoryChosenBy | null {
  if (part.linked || part.category === null) return null;
  switch (part.categorySource) {
    case null:
      return null;
    case "provider":
      return "Plaid";
    case "AI":
      // Below "high", the AI counts as unsure (spec 04, The categorization cascade).
      return part.categoryConfidence === "medium" || part.categoryConfidence === "low"
        ? "AI, unsure"
        : "AI";
    case "Web lookup":
      return part.categoryConfidence === "medium" || part.categoryConfidence === "low"
        ? "Web lookup, unsure"
        : "Web lookup";
    case "money movement":
      return "Money movement";
    case "Line items":
      return "Amazon items";
    default:
      return part.categorySource;
  }
}

export async function transactionRows(
  database: Database,
  listed: readonly ListedTransaction[],
): Promise<TransactionRowView[]> {
  const ids = listed.map((txn) => txn.id);
  const [parts, chargeNames, itemCounts] = await Promise.all([
    readShownParts(database, ids),
    readChargeNames(database, ids),
    countLineItemsOf(database, ids),
  ]);
  return listed.map(({ merchantCleanName, ...txn }) => ({
    ...txn,
    merchant: merchantCleanName,
    recurringChargeName: chargeNames.get(txn.id) ?? null,
    itemCount: itemCounts.get(txn.id) ?? 0,
    parts: (parts.get(txn.id) ?? []).map((part) => ({
      type: part.type,
      amount: part.amount,
      category: part.category,
      linked: part.linked,
      categoryChosenBy: categoryChosenBy(part),
    })),
  }));
}
