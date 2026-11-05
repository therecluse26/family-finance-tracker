// What the AI box routes answer. This file imports only other views files, so the web app's type
// check can follow it through api.ts.

import type { PictureChoice } from "../pictures/picture-view.ts";
import type { ProposalView } from "./proposals-views.ts";

export type AiBoxGroupName = "Worth acting on" | "Heads up" | "Good news";

// One note in the AI box (spec 07, 1. AI box). An Alert note's words come from the Alert's
// template facts; only its Next step is the AI's.
export type AiBoxNoteView = {
  kind: "Alert note";
  // The Alert's ID: a merged Alert's first part.
  id: string;
  // When the Alert was created, as ISO 8601 text in UTC.
  createdAt: string;
  // The left column: the number, and a short label under it.
  figure: string;
  figureLabel: string;
  // What it is about, then the title.
  about: string;
  title: string;
  // The reason "Why?" opens: one line, or one per part of a merged Alert.
  why: string[];
  // The AI's words after "Next step:", or null for no Next step line.
  nextStep: string | null;
  // Marked Done for every Member.
  done: boolean;
};

// An open Proposal in the AI box (spec 07, 1. AI box): always in "Worth acting on", first in its
// group, with "Accept", "Edit", "Skip", and "Ask about this", and no Done button.
export type AiBoxProposalView = {
  kind: "Proposal";
  id: string;
  createdAt: string;
  proposal: ProposalView;
};

// The Monthly review's link (spec 07, 1. AI box): "Your <Month> review is ready", in "Heads up",
// from when the review is written until a Member marks it Done or 7 days pass.
export type AiBoxReviewLinkView = {
  kind: "Review link";
  // The review's month, YYYY-MM.
  id: string;
  // When the review was written, as ISO 8601 text in UTC.
  createdAt: string;
};

// An Insight card in the AI box (spec 07, 1. AI box): every word is the AI's, in the group the AI
// picked, after the Alert notes, in the AI's order.
export type AiBoxInsightCardView = {
  kind: "Insight card";
  id: string;
  // The left column: the figure, or empty with none, and its label.
  figure: string;
  figureLabel: string;
  about: string;
  title: string;
  // The reason "Why?" opens, with the card's picture under it.
  why: string;
  // A choice from the picture menu, drawn for `month`, YYYY-MM. Null for no picture.
  picture: PictureChoice | null;
  month: string;
  // The words after "Next step:". A Good news card's say what the news means, with no label.
  nextStep: string;
  // Marked Done for every Member.
  done: boolean;
};

export type AiBoxView = {
  // The notes in "Worth acting on" that are not Done, for the heading. Every open Proposal counts.
  worthActingOn: number;
  // In order: "Worth acting on", "Heads up", "Good news". An empty group is left out. Inside a
  // group: Proposals first, then Alert notes newest first, then the review link, then Insight cards
  // in the AI's order.
  groups: {
    name: AiBoxGroupName;
    notes: (AiBoxProposalView | AiBoxNoteView | AiBoxReviewLinkView | AiBoxInsightCardView)[];
  }[];
  // True with no AI provider: the box shows "Set up AI for insights".
  setUpAi: boolean;
  // While background AI is paused: at the AI cost cap until a date written YYYY-MM-DD, or with a
  // rejected key. Null otherwise.
  paused: { reason: "cost cap"; until: string } | { reason: "key rejected" } | null;
};

export type AiBoxRoutes = {
  view(): Promise<AiBoxView>;
  // Marks an Alert note Done for every Member, or clears the mark. It makes no AI call. False when
  // no Alert note in the box has the ID.
  markAlertNote(alertId: string, memberId: string, done: boolean): Promise<boolean>;
  // Marks a review link Done for every Member, so it leaves the box, or clears the mark. It makes
  // no AI call. False when no review link in the box has the month.
  markReviewLink(month: string, memberId: string, done: boolean): Promise<boolean>;
  // Marks an Insight card Done for every Member, or clears the mark. It makes no AI call: the next
  // Insight card run reads it as feedback. False when no current card has the ID.
  markInsightCard(cardId: string, memberId: string, done: boolean): Promise<boolean>;
};
