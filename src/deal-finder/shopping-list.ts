import {
  addShoppingListItem,
  applyShoppingListEdit,
  changeShoppingListItem,
  clearTickedListItems,
  type Database,
  type ListItemChanges,
  type ListItemFields,
  listShoppingListChanges,
  listShoppingListItems,
  readDealFinderSettings,
  removeShoppingListItem,
  type ShoppingListOp,
  type StoredListItem,
  type StoredShoppingListChange,
  storeDealFinderSettings,
  undoShoppingListChange,
} from "../db/index.ts";
import {
  BRAND_LOCK_LENGTH,
  DIETARY_NEEDS_LENGTH,
  LIST_ITEM_NOTE_LENGTH,
  LIST_ITEM_UNIT_NAMES,
  LIST_ITEM_WORDS_LENGTH,
  type ListItemChangeInput,
  type ListItemInput,
  type ListItemView,
  listItemLine,
  MAX_EDIT_CHANGES,
  MAX_QUANTITY,
  MAX_TRIP_SAVING_CENTS,
  SHOPPING_LIST_RULES,
  type ShoppingList,
  type ShoppingListChangeCardView,
  type ShoppingListEditInput,
  type ShoppingListOutcome,
  type ShoppingListRule,
  type ShoppingListView,
} from "./shopping-list-view.ts";
import { MAX_LIST_ITEMS } from "./view.ts";

// The Household's one Shopping list (spec 15, Shopping list): every Member sees it and can change
// it, on the Shopping list page and through Chat's edit_shopping_list. Each write checks every rule
// in code and names the one it broke. A Chat edit applies at once and shows as a card with Undo
// (owner decision, 2026-11-11).

export type ShoppingListOptions = { database: Database; now?: () => Date };

// Every control character, and the line and paragraph separators.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters it replaces.
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu;

// Text as stored: well-formed, on one line, with no space at either end.
const plain = (text: string) => text.toWellFormed().replace(CONTROL, " ").trim();
const length = (text: string) => Array.from(text).length;

class RuleBroken extends Error {
  readonly rule: ShoppingListRule;
  constructor(rule: ShoppingListRule) {
    super(SHOPPING_LIST_RULES[rule]);
    this.rule = rule;
  }
}

function words(text: string): string {
  const cleaned = plain(text);
  if (cleaned === "" || length(cleaned) > LIST_ITEM_WORDS_LENGTH) throw new RuleBroken("words");
  return cleaned;
}

function quantity(value: number): number {
  const hundredths = value * 100;
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_QUANTITY ||
    Math.abs(hundredths - Math.round(hundredths)) > 1e-6
  ) {
    throw new RuleBroken("quantity");
  }
  return Math.round(hundredths) / 100;
}

function unit(value: string): ListItemInput["unit"] {
  const known = LIST_ITEM_UNIT_NAMES.find((each) => each === value);
  if (known === undefined) throw new RuleBroken("unit");
  return known;
}

// An optional field: empty is none.
function optional(
  value: string | null | undefined,
  most: number,
  rule: ShoppingListRule,
): string | null {
  const cleaned = plain(value ?? "");
  if (length(cleaned) > most) throw new RuleBroken(rule);
  return cleaned === "" ? null : cleaned;
}

function fieldsOf(input: ListItemInput): ListItemFields {
  return {
    words: words(input.words),
    quantity: quantity(input.quantity),
    unit: unit(input.unit),
    brandLock: optional(input.brandLock, BRAND_LOCK_LENGTH, "brandLock"),
    note: optional(input.note, LIST_ITEM_NOTE_LENGTH, "note"),
  };
}

function changesOf(input: ListItemChangeInput): ListItemChanges {
  const changes: ListItemChanges = {
    ...(input.words === undefined ? {} : { words: words(input.words) }),
    ...(input.quantity === undefined ? {} : { quantity: quantity(input.quantity) }),
    ...(input.unit === undefined ? {} : { unit: unit(input.unit) }),
    ...(input.brandLock === undefined
      ? {}
      : { brandLock: optional(input.brandLock, BRAND_LOCK_LENGTH, "brandLock") }),
    ...(input.note === undefined
      ? {}
      : { note: optional(input.note, LIST_ITEM_NOTE_LENGTH, "note") }),
    ...(input.ticked === undefined ? {} : { ticked: input.ticked }),
  };
  if (Object.keys(changes).length === 0) throw new RuleBroken("nothing");
  return changes;
}

const itemView = (item: StoredListItem): ListItemView => ({
  id: item.id,
  words: item.words,
  quantity: item.quantity,
  unit: item.unit,
  brandLock: item.brandLock,
  note: item.note,
  ticked: item.ticked,
});

// A change's card lines, one for each List item it touched.
export function changeLines(items: StoredShoppingListChange["items"]): string[] {
  return items.map(({ before, after }) => {
    if (before === null && after !== null) return `Added ${listItemLine(after)}`;
    if (before !== null && after === null) return `Removed ${listItemLine(before)}`;
    if (before === null || after === null) return "";
    const tick = after.ticked ? "Ticked" : "Unticked";
    if (listItemLine(before) === listItemLine(after)) return `${tick} ${listItemLine(after)}`;
    const ticked = before.ticked === after.ticked ? "" : `, ${tick.toLowerCase()}`;
    return `Changed ${listItemLine(before)} to ${listItemLine(after)}${ticked}`;
  });
}

async function readView(database: Database): Promise<ShoppingListView> {
  const [items, settings] = await Promise.all([
    listShoppingListItems(database),
    readDealFinderSettings(database),
  ]);
  return {
    items: items.map(itemView),
    dietaryNeeds: settings.dietaryNeeds,
    tripSaving: settings.tripSaving,
    maxItems: MAX_LIST_ITEMS,
  };
}

// A write's outcome: the list after it, or the rule it broke.
async function checked(
  database: Database,
  write: () => Promise<ShoppingListOutcome | undefined>,
): Promise<ShoppingListOutcome> {
  try {
    return (await write()) ?? { view: await readView(database) };
  } catch (error) {
    if (error instanceof RuleBroken) return { refused: "rule", rule: error.rule };
    throw error;
  }
}

export function shoppingList({
  database,
  now = () => new Date(),
}: ShoppingListOptions): ShoppingList {
  return {
    view: () => readView(database),

    add: (memberId, input) =>
      checked(database, async () => {
        const fields = fieldsOf(input);
        const item = { id: crypto.randomUUID(), ...fields, addedAt: now(), addedBy: memberId };
        if (!(await addShoppingListItem(database, item, MAX_LIST_ITEMS))) {
          return { refused: "rule", rule: "full" };
        }
        return undefined;
      }),

    change: (id, input) =>
      checked(database, async () =>
        (await changeShoppingListItem(database, id, changesOf(input)))
          ? undefined
          : { refused: "no item" },
      ),

    remove: (id) =>
      checked(database, async () =>
        (await removeShoppingListItem(database, id)) ? undefined : { refused: "no item" },
      ),

    clearTicked: () =>
      checked(database, async () => {
        await clearTickedListItems(database);
        return undefined;
      }),

    setDietaryNeeds: (text) =>
      checked(database, async () => {
        const dietaryNeeds = optional(text, DIETARY_NEEDS_LENGTH, "dietaryNeeds") ?? "";
        await storeDealFinderSettings(database, { dietaryNeeds });
        return undefined;
      }),

    setTripSaving: (cents) =>
      checked(database, async () => {
        if (!Number.isInteger(cents) || cents < 0 || cents > MAX_TRIP_SAVING_CENTS) {
          throw new RuleBroken("tripSaving");
        }
        await storeDealFinderSettings(database, { tripSaving: cents });
        return undefined;
      }),

    undo: (changeId, memberId) =>
      checked(database, async () => {
        const undone = await undoShoppingListChange(
          database,
          changeId,
          { memberId, at: now() },
          MAX_LIST_ITEMS,
        );
        switch (undone) {
          case "undone":
            return undefined;
          case "full":
            return { refused: "rule", rule: "full" };
          default:
            return { refused: undone };
        }
      }),
  };
}

// What get_shopping_list gives the AI: each List item with its ID, which a change names, and the
// dietary needs.
export async function shoppingListForChat(database: Database): Promise<{
  listItems: ListItemView[];
  dietaryNeeds: string;
}> {
  const view = await readView(database);
  return { listItems: view.items, dietaryNeeds: view.dietaryNeeds };
}

// edit_shopping_list: up to 30 changes, applied together at once, kept with the thread and the
// answer for the card and Undo. The change's ID, or the words of the rule it broke.
export async function editShoppingList(
  database: Database,
  edits: readonly ShoppingListEditInput[],
  by: { threadId: string; answerId: string; memberId: string | null; at: Date },
): Promise<{ changeId: string } | { error: string }> {
  let ops: ShoppingListOp[];
  try {
    if (edits.length === 0 || edits.length > MAX_EDIT_CHANGES) throw new RuleBroken("changes");
    ops = edits.map((edit): ShoppingListOp => {
      if (edit.action === "add") {
        return { op: "add", id: crypto.randomUUID(), fields: fieldsOf(edit) };
      }
      if (edit.action === "remove") return { op: "remove", id: edit.id };
      const { action: _action, id, ...changes } = edit;
      return { op: "change", id, changes: changesOf(changes) };
    });
    const named = ops.filter((op) => op.op !== "add").map((op) => op.id);
    if (new Set(named).size !== named.length) throw new RuleBroken("once");
  } catch (error) {
    if (error instanceof RuleBroken) return { error: error.message };
    throw error;
  }
  const result = await applyShoppingListEdit(
    database,
    {
      id: crypto.randomUUID(),
      threadId: by.threadId,
      answerId: by.answerId,
      madeBy: by.memberId,
      madeAt: by.at,
      ops,
    },
    MAX_LIST_ITEMS,
  );
  if ("applied" in result) return { changeId: result.applied.id };
  if (result.refused === "full") return { error: SHOPPING_LIST_RULES.full };
  return {
    error: `No List item has the ID "${result.id}". Read the list with get_shopping_list first.`,
  };
}

// The Shopping list change cards in a thread, oldest first. `answerId` is the stored answer's ID.
export async function shoppingListCards(
  database: Database,
  threadId: string,
): Promise<(Omit<ShoppingListChangeCardView, "answerId"> & { answerId: string })[]> {
  return (await listShoppingListChanges(database, threadId)).map((change) => ({
    id: change.id,
    answerId: change.answerId,
    lines: changeLines(change.items),
    undoneAt: change.undoneAt?.toISOString() ?? null,
  }));
}
