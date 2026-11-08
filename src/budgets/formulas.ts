import { CATEGORIES, type Category } from "../categories/index.ts";
import { YEARLY_CATEGORIES } from "./periods.ts";

// The draft formulas (spec 05, Drafting Budgets): fixed rules, with no AI, from the formula terms
// (spec 05, Formula terms). Bills follow the Household's Recurring charges and tracked loans.
// Flexible Budgets take the lower of the Benchmark and the Household's own figure, so history can
// tighten a Budget, never loosen it. Every amount is in whole cents.

// The yearly Categories live in periods.ts, which the web app reads too.
export { YEARLY_CATEGORIES };

// A Category with no Benchmark gets no Budget until there are this many months of history.
export const MIN_HISTORY_MONTHS = 3;

// One Category's terms for the month m, in whole cents.
export type CategoryTerms = {
  // The Category's Spending over the history window, or all Spending loaded so far when n is 0.
  spent: number;
  // A(c), A_other(c), and A_flex(c): Spending over the history window ÷ n. When n is 0, all
  // Spending loaded so far × the days in m ÷ the days of history.
  a: number;
  aOther: number;
  aFlex: number;
  // K(c, m): the known amounts in c for m.
  k: number;
  // Y(c, m): the yearly Recurring charges in c expected in m. Part of k.
  y: number;
  // The part of k from tracked loan payments expected in m. Part of k.
  kLoans: number;
  // Each active yearly Recurring charge in c at its latest amount, per year, whatever month it is
  // expected in. The "must fit" total counts it at 1/12 (spec 05, The total must fit).
  yearlyCharges: number;
};

export type DraftTerms = {
  // n: the months in the history window.
  n: number;
  // I, Steady Income per month.
  income: number;
  categories: Record<Category, CategoryTerms>;
  // The Groceries and Superstores Spending the split r comes from: over the history window, or
  // all Spending loaded so far when n is 0.
  split: { groceries: number; superstores: number };
  // B(c) for each Category whose Benchmark drafts its Budget, with B_GS for Groceries and
  // Superstores. Absent or null: the Category has no Benchmark.
  benchmarks: Partial<Record<Category, number | null>>;
};

export type DraftedBudget = {
  category: Category;
  // Whole dollars, in cents: per month, or per year for a yearly Budget.
  amount: number;
  period: "monthly" | "yearly";
};

// The Household's own figure for a flexible Category: its average × 1.10, room above typical
// Spending so a typical month stays under its Budget (spec 05, Formula terms). The draft rounds it
// with the rest of the Budget.
const withRoom = (average: number) => (average * 11) / 10;

const wholeDollars = (cents: number) => Math.max(0, Math.round(cents / 100) * 100);

// T and r for Groceries and Superstores (spec 05, Shopping: Groceries and Superstores): T is the
// lower of B_GS and their summed A_flex × 1.10, or B_GS with n < 3; r is Groceries' share of their
// Spending. With no Spending in either, they split T evenly.
function groceriesAndSuperstores(terms: DraftTerms, bGs: number): { t: number; r: number } {
  const { Groceries: groceries, Superstores: superstores } = terms.categories;
  const t =
    terms.n < MIN_HISTORY_MONTHS
      ? bGs
      : Math.min(bGs, withRoom(groceries.aFlex + superstores.aFlex));
  const both = terms.split.groceries + terms.split.superstores;
  return { t, r: both > 0 ? terms.split.groceries / both : 0.5 };
}

// Groceries and Superstores share one figure, T. The other Category of the two, or undefined for
// any other Category.
export function sharesTWith(category: Category): Category | undefined {
  if (category === "Groceries") return "Superstores";
  if (category === "Superstores") return "Groceries";
  return undefined;
}

// When I is $0, flexible Categories draft as if they had no Benchmark.
const benchmarkOf = (terms: DraftTerms, category: Category) =>
  terms.income > 0 ? (terms.benchmarks[category] ?? null) : null;

// Groceries' or Superstores' Budget from its share of T: max(K, Y + T × r) for Groceries, and
// max(K, Y + T × (1 − r)) for Superstores. K and Y are each Category's own.
function shareOf(terms: DraftTerms, category: Category, bGs: number): number {
  const { t, r } = groceriesAndSuperstores(terms, bGs);
  const { k, y } = terms.categories[category];
  return Math.max(k, y + t * (category === "Groceries" ? r : 1 - r));
}

// Groceries' or Superstores' Budget from its share of T. Undefined for any other Category, and when
// there is no T: with no B_GS, or when I is $0. The Month start sets it when the other of the two
// gets its first Budget (spec 05, Shopping: Groceries and Superstores).
export function shareOfT(terms: DraftTerms, category: Category): number | undefined {
  const bGs = benchmarkOf(terms, category);
  if (sharesTWith(category) === undefined || bGs === null) return undefined;
  return wholeDollars(shareOf(terms, category, bGs));
}

// Every Budget the formulas draft for m, in Category list order. A Category with none is left out.
export function draftBudgets(terms: DraftTerms): DraftedBudget[] {
  const { n } = terms;
  const drafted: DraftedBudget[] = [];
  for (const { name: category, group } of CATEGORIES) {
    const { spent, a, aOther, aFlex, k, y, kLoans } = terms.categories[category];
    const monthly = (cents: number) =>
      drafted.push({ category, amount: wholeDollars(cents), period: "monthly" });

    // Interest and fees always gets a Budget, even $0: the interest expected on every tracked
    // loan payment in m. Card interest and fees get $0.
    if (category === "Interest and fees") {
      monthly(kLoans);
      continue;
    }
    // No Spending in the history window (with n = 0, loaded so far) and no known amounts: no
    // Budget, never a $0 one.
    if (spent <= 0 && k <= 0) continue;
    if (group === "Bills") {
      monthly(k + aOther);
      continue;
    }
    if (YEARLY_CATEGORIES.includes(category)) {
      if (n >= MIN_HISTORY_MONTHS) {
        drafted.push({ category, amount: wholeDollars(withRoom(a) * 12), period: "yearly" });
      }
      continue;
    }
    const b = benchmarkOf(terms, category);
    if (b === null) {
      if (n >= MIN_HISTORY_MONTHS) monthly(Math.max(k, y + withRoom(aFlex)));
      continue;
    }
    if (sharesTWith(category) !== undefined) {
      // A share of T that rounds to $0 gives no Budget, never a $0 one (spec 05, Which Categories
      // get a Budget). So a newcomer with a tiny r gets no first Budget this month, and the one
      // that holds T keeps all of it.
      const share = shareOf(terms, category, b);
      if (wholeDollars(share) > 0) monthly(share);
      continue;
    }
    monthly(Math.max(k, y + (n < MIN_HISTORY_MONTHS ? b : Math.min(b, withRoom(aFlex)))));
  }
  return drafted;
}
