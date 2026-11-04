import { type Category, categoryGroupOf } from "../categories/index.ts";
import type { DraftedBudget, DraftTerms } from "./formulas.ts";

// The total must fit (spec 05, The total must fit): when the draft's monthly total passes Steady
// Income, the app cuts the Leisure group first, then the Shopping group other than Groceries and
// Superstores, by a fixed share of each Category's room. Bills, Interest and fees, Groceries,
// Superstores, Transportation, Health and care, and Other are never cut. Every amount is in whole
// cents.

// The two steps, in order: the Categories each one cuts.
const STEPS: readonly ((category: Category) => boolean)[] = [
  (category) => categoryGroupOf(category) === "Leisure",
  (category) =>
    categoryGroupOf(category) === "Shopping" &&
    category !== "Groceries" &&
    category !== "Superstores",
];

export type FittedDraft = {
  budgets: DraftedBudget[];
  // True when the gap is still above $0 after both steps: the fixed costs pass Steady Income.
  fixedCostsPassIncome: boolean;
};

const wholeDollars = (cents: number) => Math.max(0, Math.round(cents / 100) * 100);

// A Budget's share of the monthly total: a yearly Budget ÷ 12, and a monthly one with each yearly
// Recurring charge at 1/12 of its amount in place of its amount in its due month.
function monthlyShare(budget: DraftedBudget, terms: DraftTerms): number {
  if (budget.period === "yearly") return budget.amount / 12;
  const { y, yearlyCharges } = terms.categories[budget.category];
  return budget.amount - y + yearlyCharges / 12;
}

// The draft, cut to fit within Steady Income I. At or below I, or when I is $0, nothing is cut.
export function fitToIncome(drafted: readonly DraftedBudget[], terms: DraftTerms): FittedDraft {
  const budgets = drafted.map((budget) => ({ ...budget }));
  if (terms.income <= 0) return { budgets, fixedCostsPassIncome: false };
  const total = budgets.reduce((sum, budget) => sum + monthlyShare(budget, terms), 0);
  let gap = total - terms.income;
  if (gap <= 0) return { budgets, fixedCostsPassIncome: false };

  for (const inStep of STEPS) {
    // Each Category's draft per month, and its room: the draft − the larger of 50% of the draft
    // and K. A yearly Budget has no K.
    const step = budgets
      .filter((budget) => inStep(budget.category))
      .map((budget) => {
        const draft = budget.period === "yearly" ? budget.amount / 12 : budget.amount;
        const k = budget.period === "yearly" ? 0 : terms.categories[budget.category].k;
        return { budget, draft, room: Math.max(0, draft - Math.max(draft / 2, k)) };
      });
    const room = step.reduce((sum, each) => sum + each.room, 0);
    if (room <= 0) continue;
    const f = Math.min(1, gap / room);
    for (const { budget, draft, room: own } of step) {
      const cut = draft - f * own;
      budget.amount = wholeDollars(budget.period === "yearly" ? cut * 12 : cut);
    }
    gap = f < 1 ? 0 : gap - room;
    if (gap <= 0) break;
  }
  return { budgets, fixedCostsPassIncome: gap > 0 };
}
