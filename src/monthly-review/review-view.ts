import type { PictureView } from "../pictures/picture-view.ts";

// A stored Monthly review (spec 08, Review fields; spec 07, Reviews page). This file imports only
// another view file, so the web app's type check can follow it through api.ts.

// Each idea's effort and kind (spec 08, Ideas to save).
export const EFFORTS = ["Easy", "Some effort", "Big step"] as const;
export type Effort = (typeof EFFORTS)[number];
export const IDEA_KINDS = ["Habit", "Recurring charge", "Debt", "Bill"] as const;
export type IdeaKind = (typeof IDEA_KINDS)[number];

// The review as written on the 1st: the AI's words, and every number and picture the app drew
// from app.db that day. It never changes once written, so a later Refund or Reimbursement, a Goal
// that moves on, or a new Budget leaves it as it was. Amounts are whole cents.
export type StoredReview = {
  // The Household's date it was written, YYYY-MM-DD.
  writtenOn: string;
  // How the month went, in the AI's one sentence.
  headline: string;
  // The header, in the Categories Left to spend counts: the month's Spending and the sum of its
  // monthly Budgets, null with no monthly Budget that month. Debt is what every credit card and
  // every loan owed, Manual loans included, when the review was written.
  header: { spending: number; budget: number | null; debt: number };
  // 2 to 4 Habits. The picture is the one the AI chose, drawn by the app; null for a choice the
  // data did not bear out.
  habits: { name: string; line: string; costMonth: number; picture: PictureView | null }[];
  // 5 to 8 ideas, in the AI's order. `habit` is an index into `habits`, or null.
  ideas: {
    idea: string;
    savesMonth: number;
    effort: Effort;
    kind: IdeaKind;
    habit: number | null;
    why: string;
    catch: string | null;
  }[];
  // Exactly 3 items. `idea` is an index into `ideas`.
  plan: { idea: number; when: string }[];
  // One meter per Goal active when the review was written, with the app's progress, and the AI's
  // line on which idea moves it, or null when the AI wrote none.
  goals: {
    goalId: string;
    words: string;
    percentage: number | null;
    state: "On track" | "Behind" | "Done" | null;
    detail: string;
    line: string | null;
  }[];
};
