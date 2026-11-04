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

export type RecurringRoutes = {
  // Every Recurring charge, by next expected date.
  list(): Promise<RecurringChargeView[]>;
  // Undefined when no Recurring charge has the ID.
  end(id: string, memberId: string): Promise<RecurringChargeView | undefined>;
};
