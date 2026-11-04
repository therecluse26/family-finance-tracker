// What the Recurring charge routes answer. This file imports nothing, so the web app's type check
// can follow it through api.ts.

// A Recurring charge (spec 06, Recurring charges): Spending with one Merchant that repeats on a
// schedule at a similar amount. Amounts are whole cents spent.
export type RecurringChargeView = {
  id: string;
  // The Merchant's clean name.
  merchantName: string;
  category: string | null;
  schedule: "weekly" | "every 2 weeks" | "monthly" | "yearly";
  nextExpectedDate: string;
  latestAmount: number;
  // Each Transaction's posted date and amount, oldest first.
  priceHistory: { date: string; amount: number }[];
  // The Account its last Transaction landed on.
  accountId: string;
  status: "active" | "inactive" | "ended";
};

// Steady Income (spec 05, Steady Income): the Household's regular Income per month, in whole
// cents. `amount` is the figure in use: the typed one while a Member has one, else the detected
// one.
export type SteadyIncomeView = {
  amount: number;
  detected: number;
  // "median" when no Income series counts: the median of total Income over the last 3 complete
  // months.
  detectedFrom: "Income series" | "median";
  typed: number | null;
};

// A predicted payday: a counted Income series' next expected date, at its latest amount in whole
// cents received.
export type PaydayView = {
  // The payer: the Merchant's clean name.
  payerName: string;
  schedule: "weekly" | "every 2 weeks" | "twice a month" | "monthly";
  date: string;
  amount: number;
};

export type RecurringRoutes = {
  // Every Recurring charge, by next expected date.
  list(): Promise<RecurringChargeView[]>;
  // Undefined when no Recurring charge has the ID.
  end(id: string, memberId: string): Promise<RecurringChargeView | undefined>;
  steadyIncome(): Promise<SteadyIncomeView>;
  // A typed figure in whole cents per month, or null to clear it.
  typeSteadyIncome(amount: number | null, memberId: string): Promise<SteadyIncomeView>;
  // Each counted Income series' next payday, by date.
  paydays(): Promise<PaydayView[]>;
};
