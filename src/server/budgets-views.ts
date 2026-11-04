// What the Budget route answers. This file imports nothing, so the web app's type check can follow
// it through api.ts.

export type BudgetView = {
  category: string;
  categoryGroup: string;
  // Whole cents: per month, or per calendar year for a yearly Budget.
  amount: number;
  period: "monthly" | "yearly";
  // The month it takes effect, written YYYY-MM, or the year of a yearly Budget, written YYYY.
  takesEffect: string;
  source: "formula" | "AI draft" | "Member edit" | "Proposal";
  // The ID of the Member who set it, or null when the app set it.
  setBy: string | null;
  // A Bills Budget's pinned flag, or null for every other Budget.
  pinned: boolean | null;
};

export type BudgetsView = {
  month: string;
  // The label every drafted amount carries while its Benchmarks are the sample, such as "Sample
  // numbers, not real data", or null for real data.
  notice: string | null;
  // Each Category's Budget in effect that month, in Category list order. A Category with no Budget
  // is left out. Empty before the first draft's month.
  budgets: BudgetView[];
  // Each Category group's Budget, the sum of its Categories' Budgets: monthly and yearly apart.
  groups: { categoryGroup: string; monthly: number; yearly: number }[];
};

export type BudgetRoutes = {
  budgets(month: string): Promise<BudgetsView>;
};
