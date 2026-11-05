// What the "Coming up" route answers. This file imports nothing, so the web app's type check can
// follow it through api.ts.

// One row of "Coming up" (spec 07, 6. Coming up).
export type ComingUpRowView = {
  // Written YYYY-MM-DD. A Recurring charge expected today or before, with no charge yet, shows on
  // today's date.
  date: string;
  // True for an active Recurring charge whose expected date is before today in Household time,
  // with no charge yet. It still counts in the total and the checking balance.
  late: boolean;
  kind: "Recurring charge" | "payday" | "card payment" | "loan payment";
  // The Merchant, the payer, the card, or the loan.
  what: string;
  // Whole cents, with the Transaction sign: money out is negative, a payday positive.
  amount: number;
  // True for a Recurring charge that last landed on a credit card. It does not move the checking
  // balance; the card's payment due does.
  onCard: boolean;
  // The combined checking balance after the row, in whole cents. Null on a row on a card, and with
  // no connected checking Account.
  checkingAfter: number | null;
};

export type ComingUpView = {
  // The window: tomorrow to 14 days from today, Household time, written YYYY-MM-DD.
  from: string;
  to: string;
  // The total of every outgoing row, in whole cents spent.
  outgoing: number;
  // The combined current balance of every connected checking Account, or null with none.
  checking: number | null;
  // The lowest checking balance in the window and its day: today's, until a row takes it lower.
  // Null with no connected checking Account.
  lowest: { amount: number; date: string } | null;
  // In date order.
  rows: ComingUpRowView[];
};

export type ComingUpRoutes = {
  view(): Promise<ComingUpView>;
};
