// What the Alert routes answer. This file imports nothing, so the web app's type check can follow
// it through api.ts.

type AlertKindView =
  | "Duplicate charge"
  | "Price increase"
  | "New Recurring charge"
  | "Large purchase"
  | "Over Budget"
  | "On pace"
  | "Card interest or fee";

// One part of an Alert. Amounts in `facts` are whole cents spent, and dates are YYYY-MM-DD.
export type AlertPartView = {
  id: string;
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
};

// An Alert in the Alert list (spec 06, The Alert list; Merging): one part, or the parts of one kind
// created on one day under one heading. Its ID and time are its first part's.
export type AlertView = {
  id: string;
  kind: AlertKindView;
  // When its first part was created, as ISO 8601 text in UTC.
  createdAt: string;
  // Such as "2 Categories are over Budget", for two or more parts. Null for one part.
  heading: string | null;
  // The first part, then each later part, oldest first.
  parts: AlertPartView[];
  // Null until the Alerts step decides it.
  state: "sent" | "held back (weekly cap)" | "found in history" | null;
};

// Settings, Alerts (spec 06, The weekly cap).
export type AlertSettingsView = {
  // How many Alerts the app sends a week. Duplicate charges and card interest or fees go out
  // outside it.
  weeklyCap: number;
};

export type AlertRoutes = {
  // Every Alert, newest first.
  list(): Promise<AlertView[]>;
  settings(): Promise<AlertSettingsView>;
  // Any Member may change the weekly cap, to any whole number from 0.
  setWeeklyCap(cap: number): Promise<AlertSettingsView>;
};
