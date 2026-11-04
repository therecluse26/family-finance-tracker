import type { Category } from "../categories/index.ts";
import type { DecisionRecord } from "../db/index.ts";
import { HAND_SET_TYPES, type HandSetType, type TransactionType } from "./types.ts";

// The order of decisions (spec 03, Order of decisions): each Transaction's type comes from an
// ordered list of steps, and the first step that fits wins. Steps 1 to 4 apply to every
// Transaction, steps 5.1 to 5.7 to money out, and steps 6.1 to 6.9 to money in. This ticket fills
// steps 1, 5.7, and 6.9; later tickets register their rules in the other steps. An empty step is
// skipped.

export const DECISION_STEPS = [
  { step: "1", name: "a type a Member set by hand" },
  { step: "2", name: "a link a Member made by hand" },
  { step: "3", name: "Transfer pairing" },
  { step: "4", name: "a link to a Manual loan" },
  { step: "5.1", name: "a card payment with no pair" },
  { step: "5.2", name: "a loan payment with no pair" },
  { step: "5.3", name: "a cash withdrawal" },
  { step: "5.4", name: "Zelle to a Member's own name" },
  { step: "5.5", name: "a payment to a person" },
  { step: "5.6", name: "transfer wording or a Plaid transfer category, money out" },
  { step: "5.7", name: "Spending" },
  { step: "6.1", name: "card rewards" },
  { step: "6.2", name: "a loan payout" },
  { step: "6.3", name: "Zelle from a Member's own name" },
  { step: "6.4", name: "a Refund link" },
  { step: "6.5", name: "money from a person" },
  { step: "6.6", name: "a payment on a card with no pair" },
  { step: "6.7", name: "transfer wording or a Plaid transfer category, money in" },
  { step: "6.8", name: "an unlinked Refund" },
  { step: "6.9", name: "Income" },
] as const;

export type DecisionStep = (typeof DECISION_STEPS)[number]["step"];

// One part of a Transaction. Amounts have the Transaction's sign: money into the Account is
// positive. Only Spending, Refunds, and Reimbursements have a Category, and a Spending part has
// none until the categorization step picks one.
export type Part = { type: TransactionType; amount: number; category: Category | null };

// A rule's answer. The parts add up to the Transaction's amount. A one-sided result may be
// provisional to the end of a day, the last day of its window; a daily task decides it again
// once that day has passed.
export type Decision = { parts: Part[]; provisionalUntil?: string };

// What a rule reads: the Transaction, and the Household's date.
export type DecisionInput = Omit<DecisionRecord, "hidden" | "decided" | "decidedAmount"> & {
  today: string;
};

// A rule fits when it gives a Decision, and does not fit when it gives undefined.
export type DecisionRule = (
  txn: DecisionInput,
) => Decision | undefined | Promise<Decision | undefined>;

// The whole Transaction as one part.
export function whole(txn: { amount: number }, type: TransactionType): Decision {
  return { parts: [{ type, amount: txn.amount, category: null }] };
}

export function isHandSetType(value: unknown): value is HandSetType {
  return HAND_SET_TYPES.includes(value as HandSetType);
}

// Step 1. The type is in the Transaction's hand-set fields, which a sync never writes.
const handSetType: DecisionRule = (txn) =>
  isHandSetType(txn.handSet.type) ? whole(txn, txn.handSet.type) : undefined;

const BUILT_IN = new Map<DecisionStep, DecisionRule>([
  ["1", handSetType],
  ["5.7", (txn) => whole(txn, "Spending")],
  ["6.9", (txn) => whole(txn, "Income")],
]);

const registered = new Map<DecisionStep, DecisionRule>();

// Registers a later ticket's rule in its step. Returns a function that removes it again.
export function registerDecisionRule(step: DecisionStep, rule: DecisionRule): () => void {
  if (BUILT_IN.has(step) || registered.has(step)) {
    throw new Error(`Step ${step} of the order of decisions already has a rule.`);
  }
  registered.set(step, rule);
  return () => {
    if (registered.get(step) === rule) registered.delete(step);
  };
}

// Money out is a negative amount. A $0 Transaction goes through the money-out steps.
const appliesTo = (step: DecisionStep, amount: number) =>
  step.startsWith("5.") ? amount <= 0 : step.startsWith("6.") ? amount > 0 : true;

function checkDecision(step: DecisionStep, txn: DecisionInput, decision: Decision): void {
  const sum = decision.parts.reduce((total, part) => total + part.amount, 0);
  if (decision.parts.length === 0 || sum !== txn.amount) {
    throw new Error(`Step ${step} gave parts that do not add up to the Transaction's amount.`);
  }
  for (const part of decision.parts) {
    const takesCategory =
      part.type !== "Transfer" && part.type !== "Income" && part.type !== "Saving";
    if (part.category !== null && !takesCategory) {
      throw new Error(`Step ${step} gave a ${part.type} part a Category.`);
    }
  }
}

// Runs the order on one Transaction. The first step that fits wins.
export async function decide(txn: DecisionInput): Promise<Decision & { step: DecisionStep }> {
  for (const { step } of DECISION_STEPS) {
    if (!appliesTo(step, txn.amount)) continue;
    const rule = BUILT_IN.get(step) ?? registered.get(step);
    if (rule === undefined) continue;
    const decision = await rule(txn);
    if (decision === undefined) continue;
    checkDecision(step, txn, decision);
    return { ...decision, step };
  }
  // Steps 5.7 and 6.9 always fit.
  throw new Error("No step of the order of decisions fit.");
}
