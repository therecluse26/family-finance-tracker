// What the AI box routes answer. This file imports nothing, so the web app's type check can follow
// it through api.ts.

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

export type AiBoxView = {
  // The notes in "Worth acting on" that are not Done, for the heading.
  worthActingOn: number;
  // In order: "Worth acting on", "Heads up", "Good news". An empty group is left out. Inside a
  // group: Proposals first, then Alert notes newest first, then Insight cards in the AI's order.
  groups: { name: AiBoxGroupName; notes: AiBoxNoteView[] }[];
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
};
