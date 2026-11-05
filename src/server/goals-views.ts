// What the Goal routes answer. This file imports nothing, so the web app's type check can follow it
// through api.ts.

// The AI's reading of a Goal (spec 05, What the app stores). Each field is null when the words do
// not say.
export type GoalReadingView = {
  // A Category or a Merchant, Saving or one or more Accounts by ID, or one tracked loan by its
  // Account ID.
  target:
    | { kind: "Category"; category: string }
    | { kind: "Merchant"; merchant: { id: string | null; name: string } }
    | { kind: "Saving" }
    | { kind: "Accounts"; accountIds: string[] }
    | { kind: "loan"; accountId: string }
    | null;
  // An amount in whole cents, or a percent such as 20.
  change: { amount: number } | { percent: number } | null;
  // Written YYYY-MM-DD.
  deadline: string | null;
};

// A Goal's progress (spec 05, Progress). The app computes every number.
export type GoalProgressView = {
  kind: "spend less" | "save toward an amount" | "pay down a loan";
  // A whole number from 0 to 100, or null before the Goal amount is set.
  percentage: number | null;
  // "Done" while a done Goal shows with the active Goals. Null before the Goal amount is set, and
  // for a save or loan Goal with no deadline, which shows the percentage only.
  state: "On track" | "Behind" | "Done" | null;
  // Such as "On pace for $540 this month; Goal is $480", or "Goal amount not set yet".
  detail: string;
  // True when the Goal's money sits in an Unconnected account, whose balance is an estimate.
  estimated: boolean;
};

export type GoalView = {
  id: string;
  // The Member's own words.
  words: string;
  // The ID of the Member who wrote it, or null once that Member is gone.
  authorId: string | null;
  // The Goal's date, written YYYY-MM-DD.
  date: string;
  status: "active" | "done" | "dropped";
  // The day it became done or dropped, and the ID of the Member who marked it: null when the app
  // set it to done.
  endedOn: string | null;
  endedBy: string | null;
  reading: GoalReadingView;
  // In whole cents: a monthly amount for a spend less Goal, a balance for a save Goal, or the
  // principal to pay on a loan. Null until it is set.
  goalAmount: number | null;
  // The day the Goal amount took effect, written YYYY-MM-DD.
  startsOn: string | null;
  // Where it shows: with the active Goals, which hold a done Goal for one month, or in the done or
  // dropped list.
  list: "active" | "done" | "dropped";
  // Null for a reading with no target, for a Goal in the done or dropped list, and when its loan
  // or the loan's balance is not known.
  progress: GoalProgressView | null;
};

export type GoalRoutes = {
  // Every Goal with its progress: the active Goals first, then the done list, then the dropped
  // list.
  list(): Promise<GoalView[]>;
  // A Member marks an active Goal done or dropped. Undefined when no Goal has the ID.
  mark(
    id: string,
    status: "done" | "dropped",
    memberId: string,
  ): Promise<GoalView | "not active" | undefined>;
};
