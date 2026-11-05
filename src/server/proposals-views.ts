// What the Proposal routes answer. This file imports nothing, so the web app's type check can follow
// it through api.ts.

export type ProposalKindView = "Budget change" | "Goal amount" | "new Goal";

// A Proposal as its card shows it (spec 07, 1. AI box; spec 08, Proposals): the change, one line
// each, such as "Restaurants Budget: $600 → $480", and the AI's one-sentence reason.
export type ProposalView = {
  id: string;
  kind: ProposalKindView;
  source: "Chat" | "Monthly review" | "Budget tailoring";
  // When the AI made it, as ISO 8601 text in UTC.
  createdAt: string;
  reason: string;
  changes: string[];
  // A Budget change's Categories, each with its Budget in effect now (or, once accepted, the one it
  // replaced), null with none, and the proposed one, in whole cents per month or per year. Empty
  // for a Goal Proposal.
  budgets: { category: string; from: number | null; to: number; period: "monthly" | "yearly" }[];
  // A Goal amount's Goal, with its words, and the amount in whole cents.
  goal: { id: string; words: string; goalAmount: number } | null;
  // A new Goal's words.
  words: string | null;
};

// A Member's Edit before "Save and accept": the amount of any of a Budget change's Categories, a
// Goal amount, or a new Goal's words.
export type ProposalEditView = {
  budgets?: Record<string, number>;
  goalAmount?: number;
  words?: string;
};

export type ProposalAcceptResult = "accepted" | "not open" | { refused: string } | undefined;

export type ProposalRoutes = {
  // The accepted Proposals whose Undo is still offered, newest first.
  undoable(): Promise<ProposalView[]>;
  // Accept, or "Save and accept" with the Member's Edit. Undefined when no Proposal has the ID.
  accept(id: string, memberId: string, edit?: ProposalEditView): Promise<ProposalAcceptResult>;
  // False when no open Proposal has the ID.
  skip(id: string, memberId: string): Promise<boolean>;
  undo(
    id: string,
    memberId: string,
  ): Promise<"undone" | "not found" | "already undone" | "not offered">;
};
