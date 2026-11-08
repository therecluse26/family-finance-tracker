// What the Recurring charge routes answer. This file imports nothing, so the web app's type check
// can follow it through api.ts.

// A Recurring charge (spec 06, Recurring charges): Spending with one Merchant that repeats on a
// schedule at a similar amount. Amounts are whole cents spent.
export type RecurringChargeView = {
  id: string;
  // The name a Member gave it, or null: the pages then show the Merchant's.
  name: string | null;
  // The Merchant's clean name.
  merchantName: string;
  // A Member's Category, else its last Transaction's.
  category: string | null;
  categoryByHand: boolean;
  // The price band in percent, such as 7.5: a Member's, or null for the default.
  priceBand: number | null;
  // The default price band in percent: 7.5, or 0 (exact cents) for a masked Merchant.
  defaultPriceBand: number;
  schedule: "weekly" | "every 2 weeks" | "monthly" | "yearly";
  nextExpectedDate: string;
  latestAmount: number;
  // Each Transaction's posted date and amount, oldest first. `addedByHand` marks one a Member
  // added.
  priceHistory: { transactionId: string; date: string; amount: number; addedByHand: boolean }[];
  // Its price changes, oldest first: a Member's (`byHand`), which they may delete, and those the
  // checks found.
  priceChanges: { id: string; fromDate: string; amount: number; byHand: boolean }[];
  // The Account its last Transaction landed on.
  accountId: string;
  // True when that Account is a credit card: the page shows "on card".
  onCard: boolean;
  status: "active" | "inactive" | "ended";
};

// A Member's edit to a Recurring charge: the charge after it, or why it did not apply (spec 06,
// Member edits).
export type RecurringChargeEditView =
  | RecurringChargeView
  | "not found"
  | "no Transaction"
  | "no price change"
  | "ended"
  | "last Transaction";

// What a Member may change with an edit. Null clears one. The price band is in percent.
export type RecurringChargeEditsView = {
  name?: string | null;
  category?: string | null;
  priceBand?: number | null;
};

// A posted Spending Transaction of the Merchant's that a Member may add to the Recurring charge.
export type RecurringChargeCandidateView = {
  transactionId: string;
  date: string;
  amount: number;
  // True when a Member removed it from this Recurring charge before.
  removedByHand: boolean;
};

// One page of them, and whether older ones follow.
export type RecurringChargeCandidatesView = {
  candidates: RecurringChargeCandidateView[];
  more: boolean;
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
  // A Member names it, sets its Category, or sets its price band (spec 06, Member edits).
  edit(id: string, edits: RecurringChargeEditsView): Promise<RecurringChargeEditView>;
  // A Member sets a price change: a new amount in whole cents spent from a date.
  setPriceChange(
    id: string,
    change: { fromDate: string; amount: number },
  ): Promise<RecurringChargeEditView>;
  deletePriceChange(id: string, changeId: string): Promise<RecurringChargeEditView>;
  addTransaction(id: string, transactionId: string): Promise<RecurringChargeEditView>;
  removeTransaction(id: string, transactionId: string): Promise<RecurringChargeEditView>;
  // A page of them: those a Member removed first, then 50 at a time, newest first, at `amount` in
  // whole cents spent, older than the Transaction `before`. Undefined when no Recurring charge has
  // the ID; "no Transaction" when `before` is none of the Merchant's posted Spending.
  candidates(
    id: string,
    filter: { amount?: number; before?: string },
  ): Promise<RecurringChargeCandidatesView | "no Transaction" | undefined>;
  steadyIncome(): Promise<SteadyIncomeView>;
  // A typed figure in whole cents per month, or null to clear it.
  typeSteadyIncome(amount: number | null, memberId: string): Promise<SteadyIncomeView>;
  // Each counted Income series' next payday, by date.
  paydays(): Promise<PaydayView[]>;
};
