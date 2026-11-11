import { MAX_LIST_ITEMS } from "./view.ts";

// The Shopping list as the page and Chat see it (spec 15, Shopping list; Chat tools). This file
// imports only view.ts, which imports nothing, so the web app's type check can follow it.

// The units a List item takes, as app.db's schema lists them.
export const LIST_ITEM_UNIT_NAMES = ["each", "oz", "lb", "fl oz", "gal", "ct", "pack"] as const;
export type ListItemUnitName = (typeof LIST_ITEM_UNIT_NAMES)[number];

// The most changes one edit_shopping_list call takes.
export const MAX_EDIT_CHANGES = 30;
// The longest words, brand lock, note and dietary needs, in characters.
export const LIST_ITEM_WORDS_LENGTH = 100;
export const BRAND_LOCK_LENGTH = 60;
export const LIST_ITEM_NOTE_LENGTH = 200;
export const DIETARY_NEEDS_LENGTH = 300;
// The largest quantity, and the highest trip setting: $10,000.
export const MAX_QUANTITY = 9_999;
export const MAX_TRIP_SAVING_CENTS = 1_000_000;

// The rules a Shopping list write may break, each in the words the page and the AI read.
export const SHOPPING_LIST_RULES = {
  words: `A List item's words take 1 to ${LIST_ITEM_WORDS_LENGTH} characters.`,
  quantity: `A quantity is a number above 0 and up to ${MAX_QUANTITY.toLocaleString("en-US")}, with at most 2 decimals.`,
  unit: `The unit is one of ${LIST_ITEM_UNIT_NAMES.join(", ")}.`,
  brandLock: `A brand lock takes up to ${BRAND_LOCK_LENGTH} characters.`,
  note: `A note takes up to ${LIST_ITEM_NOTE_LENGTH} characters.`,
  full: `The Shopping list holds at most ${MAX_LIST_ITEMS} List items.`,
  changes: `An edit takes 1 to ${MAX_EDIT_CHANGES} changes.`,
  once: "An edit changes each List item at most once.",
  nothing: "A change names at least one field to change.",
  add: "An add names its words, quantity and unit, and no ID.",
  id: "A change or a remove names a List item's ID, from get_shopping_list.",
  dietaryNeeds: `Dietary needs take up to ${DIETARY_NEEDS_LENGTH} characters.`,
  tripSaving: "Enter the trip setting in dollars, from $0 to $10,000.",
} as const;
export type ShoppingListRule = keyof typeof SHOPPING_LIST_RULES;

export type ListItemView = {
  id: string;
  words: string;
  quantity: number;
  unit: ListItemUnitName;
  brandLock: string | null;
  note: string | null;
  ticked: boolean;
};

export type ShoppingListView = {
  items: ListItemView[];
  // In plain words, such as "no peanuts, gluten-free". Empty when none is set.
  dietaryNeeds: string;
  // "An extra trip must save at least $X", in whole cents.
  tripSaving: number;
  maxItems: number;
};

// A quantity as a Member writes it: 2, 1.5, 0.25.
const amount = (value: number) => String(Number(value.toFixed(2)));

// A List item in one line, such as "2 lb ground beef, only Jif (for tacos)". A count in `each`
// shows no unit: "3 avocados".
export function listItemLine(
  item: Pick<ListItemView, "words" | "quantity" | "unit" | "brandLock" | "note">,
): string {
  const size =
    item.unit === "each" ? amount(item.quantity) : `${amount(item.quantity)} ${item.unit}`;
  const brand = item.brandLock === null ? "" : `, only ${item.brandLock}`;
  const note = item.note === null ? "" : ` (${item.note})`;
  return `${size} ${item.words}${brand}${note}`;
}

// A List item's fields as a Member or the AI sends them. An empty brand lock or note is none.
export type ListItemInput = {
  words: string;
  quantity: number;
  unit: ListItemUnitName;
  brandLock?: string | null;
  note?: string | null;
};
export type ListItemChangeInput = Partial<ListItemInput & { ticked: boolean }>;

// One change of an edit_shopping_list call.
export type ShoppingListEditInput =
  | ({ action: "add" } & ListItemInput)
  | ({ action: "change"; id: string } & ListItemChangeInput)
  | { action: "remove"; id: string };

// A Shopping list change Chat made: its card in the thread, with Undo until a Member presses it.
export type ShoppingListChangeCardView = {
  id: string;
  // The AI answer that made it, or null when that answer was not stored.
  answerId: string | null;
  // One line for each change, such as "Added 2 lb ground beef".
  lines: string[];
  // As ISO 8601 text in UTC, or null while it can be undone.
  undoneAt: string | null;
};

// Why a write changed nothing.
export type ShoppingListRefusal =
  | { refused: "rule"; rule: ShoppingListRule }
  | { refused: "no item" }
  | { refused: "no change" }
  | { refused: "undone already" }
  | { refused: "changed since" };

export type ShoppingListOutcome = { view: ShoppingListView } | ShoppingListRefusal;

export type ShoppingList = {
  view(): Promise<ShoppingListView>;
  add(memberId: string, item: ListItemInput): Promise<ShoppingListOutcome>;
  change(id: string, changes: ListItemChangeInput): Promise<ShoppingListOutcome>;
  remove(id: string): Promise<ShoppingListOutcome>;
  // "Clear ticked items".
  clearTicked(): Promise<ShoppingListOutcome>;
  setDietaryNeeds(words: string): Promise<ShoppingListOutcome>;
  setTripSaving(cents: number): Promise<ShoppingListOutcome>;
  // Undo on a Shopping list change's card in Chat.
  undo(changeId: string, memberId: string): Promise<ShoppingListOutcome>;
};
