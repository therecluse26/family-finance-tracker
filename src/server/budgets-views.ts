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

export type BudgetStatusView = "Over Budget" | "On pace" | "on track";

// A Budget in a month, with its Spending, projection and status (spec 06, Overspending).
export type MonthBudgetView = BudgetView & {
  // Whole cents: the month's Spending, net of Refunds and Reimbursements, or for a yearly Budget
  // the year's Spending through the month.
  spending: number;
  // The projected month-end Spending in whole cents. Null for a yearly Budget, for Interest and
  // fees, and for a month that has not started.
  projected: number | null;
  status: BudgetStatusView;
  // A yearly Budget's share of the year passed: the day of the year ÷ the days in the year. Null
  // for a monthly Budget.
  shareOfYear: number | null;
};

export type BudgetsView = {
  month: string;
  // The label every drafted amount carries while its Benchmarks are the sample, such as "Sample
  // numbers, not real data", or null for real data.
  notice: string | null;
  // The draft's note when it stayed above Steady Income after the "must fit" cuts: "The fixed costs
  // pass Steady Income." Null otherwise.
  fitNote: string | null;
  // True once a Member accepted the whole draft with "Accept all".
  draftAccepted: boolean;
  // Each Category's Budget in effect that month, in Category list order. A Category with no Budget
  // is left out. Empty before the first draft's month.
  budgets: MonthBudgetView[];
  // Each Category with Spending that month and no Budget. It has no status.
  unbudgeted: {
    category: string;
    categoryGroup: string;
    spending: number;
    projected: number | null;
  }[];
  // Each Category group's Budget, the sum of its Categories' Budgets: monthly and yearly apart.
  // Its box (spec 07, A usual month): the Spending and projection of its monthly Budgets and its
  // monthly Categories with no Budget, how many Categories are Over Budget and On pace, and the
  // status they give, Over Budget winning over On pace. Null with none.
  groups: {
    categoryGroup: string;
    monthly: number;
    yearly: number;
    spending: number | null;
    projected: number | null;
    overBudget: number | null;
    onPace: number | null;
    status: BudgetStatusView | null;
  }[];
};

export type DraftAcceptanceView = { acceptedAt: Date; acceptedBy: string | null };

export type BudgetRoutes = {
  budgets(month: string): Promise<BudgetsView>;
  // A Member's edit, or undefined when the Category has no Budget.
  edit(category: string, amount: number, memberId: string): Promise<BudgetView | undefined>;
  followTheBill(
    category: string,
    memberId: string,
  ): Promise<BudgetView | "no Budget" | "not pinned">;
  // The draft's acceptance, the first one standing, or undefined before the first draft.
  acceptAll(memberId: string): Promise<DraftAcceptanceView | undefined>;
};
