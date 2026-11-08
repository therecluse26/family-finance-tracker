// What the Review list routes answer. This file imports nothing, so the web app's type check can
// follow it through api.ts.

export type ReviewChoiceView = { value: string; label: string };

// One Transaction an item is about, as the page shows it.
export type ReviewTransactionView = {
  id: string;
  // Whole cents. Money into the Account is positive.
  amount: number;
  postedDate: string;
  authorizedDate: string | null;
  description: string;
  merchantName: string | null;
  // Its Account's name, or null when the Account is gone.
  accountName: string | null;
  // The Category of each of its parts that has one, in part order, with no repeat. Empty when it
  // has none, such as a Transfer.
  categories: string[];
};

export type ReviewItemView = {
  id: string;
  kind: string;
  subject: { type: "transactions"; transactionIds: string[] } | { type: "loan"; accountId: string };
  // The Transactions it is about that still show, in the subject's order. Empty for a loan.
  transactions: ReviewTransactionView[];
  // The loan's name, for an item about a loan; else null.
  loanName: string | null;
  // The name a card of several Transactions shows in place of its first Transaction's Merchant,
  // such as the person a money from a person card is about. Null when it has none.
  cardName: string | null;
  decided: string;
  bestAnswer: ReviewChoiceView;
  createdAt: string;
  // The AI decides it once AI is back.
  needsAi: boolean;
  // Items the page shows as one group share it, such as Transfer pair guesses between the same two
  // Accounts. Null for an item shown alone.
  group: string | null;
};

export type ReviewRoutes = {
  // Every open item, newest first.
  open(): Promise<ReviewItemView[]>;
  count(): Promise<number>;
  // The choices behind "Not this". Undefined when no open item has this ID.
  otherChoices(id: string): Promise<ReviewChoiceView[] | undefined>;
  answer(
    id: string,
    value: string,
    memberId: string,
  ): Promise<"answered" | "not open" | "not a choice">;
};
