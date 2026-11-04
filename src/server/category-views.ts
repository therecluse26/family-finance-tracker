// What the Category rule routes answer. This file imports nothing, so the web app's type check can
// follow it through api.ts.

// A Category rule (spec 04, Category rules): every Transaction with its Merchant, except those a
// Member set by hand, takes its Category.
export type CategoryRuleView = {
  id: string;
  // The Merchant's clean name.
  merchantName: string;
  category: string;
  madeAt: string;
};

// The answer to a Member's Category for one Transaction.
export type CategoryCorrectionView = {
  category: string;
  // The rule the correction made for the Transaction's Merchant, or null when it made none: for
  // "only this Transaction", a Transaction with no Merchant, or a payment-app line that names no
  // person.
  rule: CategoryRuleView | null;
  // True when the Transaction was a Transfer, Income, or Saving, so its type is now Spending by
  // hand.
  setSpending: boolean;
};

export type CategoryRoutes = {
  // "not found" when no Transaction that shows has the ID; "not decided" before the app has decided
  // its type.
  correct(
    transactionId: string,
    category: string,
    onlyThisTransaction: boolean,
    memberId: string,
  ): Promise<CategoryCorrectionView | "not found" | "not decided">;
  // Every rule, by Merchant name.
  rules(): Promise<CategoryRuleView[]>;
  // False when no rule has the ID.
  deleteRule(id: string): Promise<boolean>;
};
