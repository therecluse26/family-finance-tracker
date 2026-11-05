// What the Reviews page's routes answer. This file imports only other views files, so the web
// app's type check can follow it through api.ts.

import type { StoredReview } from "../monthly-review/review-view.ts";
import type { ProposalView } from "./proposals-views.ts";

// The Reviews page's list (spec 07, Reviews page): each past Monthly review, newest month first.
// With no AI provider, no review is written, and the page says so.
export type ReviewListView = {
  aiProvider: boolean;
  // The month, YYYY-MM, and the Household's date it was written, YYYY-MM-DD.
  reviews: { month: string; writtenOn: string }[];
};

// An Alert the weekly cap held back in the review's month, as the Alert list shows it: a merged
// Alert's heading, or null for one part, and each part's text.
export type HeldBackAlertView = {
  id: string;
  createdAt: string;
  heading: string | null;
  texts: string[];
};

// One Monthly review (spec 07, Reviews page): the review as it was written, and what the app lists
// beside it today.
export type MonthlyReviewView = {
  month: string;
  review: StoredReview;
  // The plan items ticked, by their place in the plan, for every Member.
  ticked: number[];
  // "Budget changes to consider": the open Proposals the review shows, with Accept, Edit, and Skip.
  proposals: ProposalView[];
  // "Alerts you did not get": the Alerts the weekly cap held back that month, oldest first.
  heldBack: HeldBackAlertView[];
};

export type MonthlyReviewRoutes = {
  list(): Promise<ReviewListView>;
  // A month's review, or undefined with none. It makes no AI call and writes nothing.
  view(month: string): Promise<MonthlyReviewView | undefined>;
  // Ticks a plan item for every Member, or clears the tick. False when the month has no review.
  tick(month: string, item: number, memberId: string, done: boolean): Promise<boolean>;
};
