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
  // The AI's one-sentence reason for an "AI draft" Budget, or null.
  reason: string | null;
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
  // A Bills Budget's Benchmark context (spec 05, Context for Bills Budgets), such as "Housing is
  // 41% of Income; typical is 33%", or "Housing is 41% of Income" for a Household that rents. Null
  // for a Category with no context Benchmark, before the Household facts are recorded, and with
  // Steady Income at $0.
  context: string | null;
};

export type BudgetsView = {
  month: string;
  // The label every drafted amount carries while its Benchmarks are the sample, such as "Sample
  // numbers, not real data", or null for real data.
  notice: string | null;
  // The draft's note when it stayed above Steady Income after the "must fit" cuts: "The fixed costs
  // pass Steady Income." Null otherwise.
  fitNote: string | null;
  // True once the first draft ran. Before it, no month has a Budget.
  drafted: boolean;
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

// "A usual month" (spec 07, 5. "A usual month"). It counts the same Categories as Left to spend:
// every one but Travel, and Gifts and donations. A month before the first posted Transaction is
// left out.
export type UsualMonthView = {
  // Whole cents: the median of the Spending of the 12 complete months before the month, or null
  // before the first complete month of history.
  usual: number | null;
  // Each Category group, in the group order.
  groups: {
    categoryGroup: string;
    // The Categories the box counts, in Category list order.
    categories: string[];
    // The 12 complete months, then the month so far, oldest first. Whole cents: the group's
    // Spending, and its Budget in effect that month, the sum of its Categories' monthly Budgets.
    // The Budget is null before the first draft's month, and when no Category in the group has a
    // monthly Budget.
    bars: { month: string; spending: number; budget: number | null }[];
  }[];
};

export type BudgetRoutes = {
  budgets(month: string): Promise<BudgetsView>;
  // "A usual month" for a month written YYYY-MM.
  usualMonth(month: string): Promise<UsualMonthView>;
  // A Member's edit, or undefined when the Category has no Budget.
  edit(category: string, amount: number, memberId: string): Promise<BudgetView | undefined>;
  followTheBill(
    category: string,
    memberId: string,
  ): Promise<BudgetView | "no Budget" | "not pinned">;
  // The draft's acceptance, the first one standing, or undefined before the first draft.
  acceptAll(memberId: string): Promise<DraftAcceptanceView | undefined>;
};
