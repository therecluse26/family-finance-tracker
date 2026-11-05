// What the Alert routes answer. This file imports nothing, so the web app's type check can follow
// it through api.ts.

// An Alert in the Alert list (spec 06, The Alert list). Amounts in `facts` are whole cents spent,
// and dates are YYYY-MM-DD.
export type AlertView = {
  id: string;
  kind: "Duplicate charge" | "Price increase" | "New Recurring charge" | "Large purchase";
  // When it was created, as ISO 8601 text in UTC.
  createdAt: string;
  // The template's text, and the facts it states.
  text: string;
  facts: Record<string, unknown>;
  // The Transactions it is about, or the Category.
  transactionIds: string[];
  category: string | null;
  // The AI's advice, if any.
  advice: string | null;
  // Each "Not a problem" press: who, and when, as ISO 8601 text in UTC.
  notAProblem: { memberId: string | null; pressedAt: string }[];
  // Null until the Alerts step decides it.
  state: "sent" | "held back (weekly cap)" | "found in history" | null;
};

export type AlertRoutes = {
  // Every Alert, newest first.
  list(): Promise<AlertView[]>;
};
