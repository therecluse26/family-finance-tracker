import { type Category, isCategory } from "../categories/index.ts";
import { inProportion } from "../db/index.ts";
import type { Decision, DecisionInput } from "./order.ts";
import { MIN_SPLIT_PARTS } from "./types.ts";

// Splits (spec 04, Splits). A Member may split one Spending Transaction by amount across
// Categories. The split is the Transaction's hand-set field `split`, so a sync never writes it.
// While the Transaction is Spending, each part counts in its own Category, as a hand-set Category,
// so the cascade never changes it; all parts count in the Transaction's month. A split part makes
// no Category rule. When the provider changes the amount, each part scales in proportion.

// One part of a split: whole cents spent, and its Category.
export type SplitPart = { amount: number; category: Category };

// The split in a Transaction's hand-set fields, or undefined when it has none.
export function readSplit(handSet: Record<string, unknown>): SplitPart[] | undefined {
  const { split } = handSet;
  if (!Array.isArray(split) || split.length < MIN_SPLIT_PARTS) return undefined;
  const parts: SplitPart[] = [];
  for (const each of split) {
    if (typeof each !== "object" || each === null) return undefined;
    const { amount, category } = each as Record<string, unknown>;
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
      return undefined;
    }
    if (typeof category !== "string" || !isCategory(category)) return undefined;
    parts.push({ amount, category });
  }
  return parts;
}

// Whether a rule's answer is plain Spending that a split may divide: money out, every part
// Spending, and no part of a tracked loan payment.
function divisible(txn: DecisionInput, decision: Decision): boolean {
  return (
    txn.amount < 0 &&
    decision.paidFromOutside !== true &&
    decision.parts.every((part) => part.type === "Spending" && part.keepsCategory !== true)
  );
}

// The rule's answer with the Transaction's split in place of its Spending parts. Each part takes
// its share of the Transaction's amount now, in proportion to the amounts the Member split, so the
// parts still add up when the provider changes the amount. Any other answer stays as it is: the
// split holds again once the Transaction is Spending again.
export function withSplit(txn: DecisionInput, decision: Decision): Decision {
  const split = readSplit(txn.handSet);
  if (split === undefined || !divisible(txn, decision)) return decision;
  const shares = inProportion(
    -txn.amount,
    split.map((part) => part.amount),
  );
  return {
    ...decision,
    parts: split.map((part, index) => ({
      type: "Spending",
      amount: -(shares[index] ?? 0),
      category: part.category,
      categorySource: "hand-set",
      categoryConfidence: "certain",
    })),
  };
}

// Whether the answer's parts are a split's.
export function isSplit(decision: Decision): boolean {
  return decision.parts.some((part) => part.categorySource === "hand-set");
}
