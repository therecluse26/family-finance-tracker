// The picture menu (spec 08, Picture menu): the AI picks a picture and names what to show, and the
// app draws it from its own data. This file imports nothing, so the web app's type check can follow
// it through api.ts.

// A new picture type is one more entry here, in PictureChoice and PictureView, in the pictures
// module's MENU, and in the web app's PICTURE_DRAWINGS.
export const PICTURE_TYPES = ["days", "trend", "cards", "recurring"] as const;
export type PictureType = (typeof PICTURE_TYPES)[number];

// The most Merchants a `days` picture names.
export const MAX_PICTURE_MERCHANTS = 5;

// A choice from the menu, as the AI writes it: the picture and what it shows. A Category is one
// from the fixed list, by name; a Merchant is its clean name.
export type PictureChoice =
  | { type: "days"; category: string }
  | { type: "days"; merchants: string[] }
  | { type: "trend"; category: string }
  | { type: "cards" }
  | { type: "recurring"; category: string };

// A calendar of the month, with each day it happened marked.
export type DaysPictureView = {
  type: "days";
  // YYYY-MM.
  month: string;
  // The Category, or the Merchants by the clean names the app holds, in the choice's order.
  of: { category: string } | { merchants: string[] };
  // Each day with Spending, oldest first, and how many Transactions that day.
  days: { date: string; count: number }[];
};

// 7 months of a Category's Spending against its Budget: the month and the 6 before it, oldest
// first. Whole cents. `budget` is the monthly Budget in effect that month, or null with none.
export type TrendPictureView = {
  type: "trend";
  category: string;
  months: { month: string; spending: number; budget: number | null }[];
};

// Each credit card's balance owed, in whole cents, with its purchase APR as a percent, such as
// 21.24, and the date a promo ends, YYYY-MM-DD. Each is null when the bank sends none.
export type CardsPictureView = {
  type: "cards";
  cards: { id: string; name: string; owed: number; apr: number | null; promoEnds: string | null }[];
};

// The monthly Recurring charges in a Category, largest first: each one's latest amount in whole
// cents spent.
export type RecurringPictureView = {
  type: "recurring";
  category: string;
  charges: { id: string; merchantName: string; amount: number }[];
};

export type PictureView =
  | DaysPictureView
  | TrendPictureView
  | CardsPictureView
  | RecurringPictureView;

export type PictureRoutes = {
  // The picture a choice names for a month written YYYY-MM, or null when the data does not bear the
  // choice out.
  draw(choice: PictureChoice, month: string): Promise<PictureView | null>;
};
