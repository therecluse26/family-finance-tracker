import * as z from "zod";
import { type AiTools, aiTool } from "../ai/index.ts";
import type { Database } from "../db/index.ts";
import {
  editShoppingList,
  LIST_ITEM_UNIT_NAMES,
  MAX_EDIT_CHANGES,
  SHOPPING_LIST_RULES,
  type ShoppingListEditInput,
  shoppingListForChat,
} from "../deal-finder/index.ts";

// Chat's Shopping list tools (spec 15, Chat tools). get_shopping_list reads the list.
// edit_shopping_list changes it: up to 30 changes, applied at once, which show as a card in the
// thread with Undo (owner decision, 2026-11-11). It answers "done" with the card's ID, or an error
// that names the broken rule. get_shopping_plan reads the last Shopping plan. The AI cannot start a
// plan run. Each call counts toward Chat's 5 tool calls for a question.

export type ShoppingToolOptions = {
  database: Database;
  // The thread and the answer the tools run in, which the card shows under.
  threadId: string;
  answerId: string;
  // The Member whose question the AI answers. A List item the AI adds is theirs.
  memberId: string;
  now?: () => Date;
};

// One change. Every field is in each one, as every AI provider's tool input needs: null is "not
// given", and for a change, "leave as it is".
const CHANGE = z.object({
  action: z.enum(["add", "change", "remove"]),
  id: z
    .string()
    .max(100)
    .nullable()
    .describe("The List item's ID from get_shopping_list, for a change or a remove; null to add"),
  words: z.string().nullable().describe('What to buy, in plain words, such as "ground beef"'),
  quantity: z.number().nullable().describe("How many of the unit, above 0, such as 2 or 1.5"),
  unit: z.enum(LIST_ITEM_UNIT_NAMES).nullable(),
  brandLock: z
    .string()
    .nullable()
    .describe('Only this brand, such as "Jif". An empty string allows any brand'),
  note: z.string().nullable().describe("A short note, such as what it is for"),
  ticked: z.boolean().nullable().describe("For a change: true when it is bought"),
});
type Change = z.infer<typeof CHANGE>;

// The change as the shopping-list module takes it, or the rule it broke.
function editOf(change: Change): ShoppingListEditInput | { rule: "add" | "id" } {
  if (change.action === "add") {
    if (
      change.id !== null ||
      change.words === null ||
      change.quantity === null ||
      change.unit === null
    ) {
      return { rule: "add" };
    }
    return {
      action: "add",
      words: change.words,
      quantity: change.quantity,
      unit: change.unit,
      brandLock: change.brandLock,
      note: change.note,
    };
  }
  if (change.id === null) return { rule: "id" };
  if (change.action === "remove") return { action: "remove", id: change.id };
  return {
    action: "change",
    id: change.id,
    ...(change.words === null ? {} : { words: change.words }),
    ...(change.quantity === null ? {} : { quantity: change.quantity }),
    ...(change.unit === null ? {} : { unit: change.unit }),
    ...(change.brandLock === null ? {} : { brandLock: change.brandLock }),
    ...(change.note === null ? {} : { note: change.note }),
    ...(change.ticked === null ? {} : { ticked: change.ticked }),
  };
}

// What get_shopping_plan answers until the plan view is built (ticket X49).
export const NO_PLAN_YET = { result: "No plan yet" };

export function shoppingTools({
  database,
  threadId,
  answerId,
  memberId,
  now = () => new Date(),
}: ShoppingToolOptions): AiTools {
  const get_shopping_list = aiTool({
    description:
      "Read the Household's Shopping list: each List item's ID, words, quantity, unit, brand lock, note, and whether it is ticked, and the Household's dietary needs.",
    input: z.object({}),
    run: () => shoppingListForChat(database),
  });

  const edit_shopping_list = aiTool({
    description: `Change the Household's Shopping list: add, change or remove List items, 1 to ${MAX_EDIT_CHANGES} changes in one call. The change applies at once, and the Member sees it as a card with Undo. Read the list first for each List item's ID. An add gives words, quantity and unit. A change gives the ID and only the fields to change; null leaves a field as it is. Answers done with the card's ID, or an error that names the broken rule; then nothing changed.`,
    input: z.object({
      changes: z.array(CHANGE).describe(`1 to ${MAX_EDIT_CHANGES} changes, applied together`),
    }),
    async run(input) {
      const edits: ShoppingListEditInput[] = [];
      for (const change of input.changes) {
        const edit = editOf(change);
        if ("rule" in edit) return { error: SHOPPING_LIST_RULES[edit.rule] };
        edits.push(edit);
      }
      const edited = await editShoppingList(database, edits, {
        threadId,
        answerId,
        memberId,
        at: now(),
      });
      return "changeId" in edited ? { result: "done", card: edited.changeId } : edited;
    },
  });

  const get_shopping_plan = aiTool({
    description:
      "Read the last Shopping plan: its Stores, List items, prices, Deals, total, trips, and the date of each price. Only a Member starts a plan run, with Find the best prices.",
    input: z.object({}),
    run: async () => NO_PLAN_YET,
  });

  return { get_shopping_list, edit_shopping_list, get_shopping_plan };
}
