import { type Context, Hono, type MiddlewareHandler } from "hono";
import * as z from "zod";
import {
  LIST_ITEM_UNIT_NAMES,
  SHOPPING_LIST_RULES,
  type ShoppingListOutcome,
} from "../deal-finder/shopping-list-view.ts";
import type { ServerEnv } from "./env.ts";

// The Shopping list page's routes (spec 15, Shopping list; Pages), and Undo on a Shopping list
// change's card in Chat. The API mounts them; its session and Origin checks run first. Every write
// but removing a List item takes a JSON body. Each answer holds the whole list after the write, or
// the rule the write broke, and a refused write changes nothing.

// A route that takes a JSON body refuses any other content type, so a form on another site cannot
// post to it.
const jsonOnly: MiddlewareHandler<ServerEnv> = async (c, next) => {
  if (c.req.header("content-type")?.split(";")[0]?.trim() !== "application/json") {
    return c.json({ error: "Send JSON." }, 415);
  }
  await next();
};

// The body as JSON, or undefined when it is not JSON.
async function jsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

// The shapes the page sends. The shopping-list module checks each rule, such as the length of the
// words, and names the one broken.
const TEXT = z.string().max(2_000);
const OPTIONAL_TEXT = TEXT.nullable().optional();
const UNIT = z.enum(LIST_ITEM_UNIT_NAMES);
const itemBody = z.strictObject({
  words: TEXT,
  quantity: z.number(),
  unit: UNIT,
  brandLock: OPTIONAL_TEXT,
  note: OPTIONAL_TEXT,
});
const changeBody = z.strictObject({
  words: TEXT.optional(),
  quantity: z.number().optional(),
  unit: UNIT.optional(),
  brandLock: OPTIONAL_TEXT,
  note: OPTIONAL_TEXT,
  ticked: z.boolean().optional(),
});
const emptyBody = z.strictObject({});
const dietaryBody = z.strictObject({ dietaryNeeds: TEXT });
const tripBody = z.strictObject({ tripSaving: z.number() });

const ID = /^[A-Za-z0-9-]{1,64}$/;

const NOT_FOUND = { error: "Not found" };

function answer(c: Context<ServerEnv>, outcome: ShoppingListOutcome) {
  if ("view" in outcome) return c.json({ shoppingList: outcome.view }, 200);
  switch (outcome.refused) {
    case "rule":
      return c.json(
        { error: SHOPPING_LIST_RULES[outcome.rule] },
        outcome.rule === "full" ? 409 : 400,
      );
    case "no item":
      return c.json({ error: "No List item has this ID. It may be removed already." }, 404);
    case "no change":
      return c.json({ error: "No Shopping list change has this ID." }, 404);
    case "undone already":
      return c.json({ error: "This change is undone already." }, 409);
    case "changed since":
      return c.json(
        {
          error:
            "A List item this change touched has changed since, so Undo cannot put it back. Change the list by hand.",
        },
        409,
      );
  }
}

export const shoppingListApi = new Hono<ServerEnv>()
  .get("/shopping-list", async (c) => c.json({ shoppingList: await c.var.shoppingList.view() }))
  // Add a List item at the end of the list. The list holds at most 100.
  .post("/shopping-list/items", jsonOnly, async (c) => {
    const body = itemBody.safeParse(await jsonBody(c));
    if (!body.success) {
      return c.json({ error: "Send the List item's words, quantity and unit." }, 400);
    }
    return answer(c, await c.var.shoppingList.add(c.var.member.id, body.data));
  })
  // Edit or tick one List item.
  .put("/shopping-list/items/:id", jsonOnly, async (c) => {
    const id = c.req.param("id");
    if (!ID.test(id)) return c.json(NOT_FOUND, 404);
    const body = changeBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Send the List item's fields to change." }, 400);
    return answer(c, await c.var.shoppingList.change(id, body.data));
  })
  .delete("/shopping-list/items/:id", async (c) => {
    const id = c.req.param("id");
    if (!ID.test(id)) return c.json(NOT_FOUND, 404);
    return answer(c, await c.var.shoppingList.remove(id));
  })
  // "Clear ticked items", with an empty JSON body.
  .post("/shopping-list/clear-ticked", jsonOnly, async (c) => {
    if (!emptyBody.safeParse(await jsonBody(c)).success) {
      return c.json({ error: "Send an empty body." }, 400);
    }
    return answer(c, await c.var.shoppingList.clearTicked());
  })
  .put("/shopping-list/dietary-needs", jsonOnly, async (c) => {
    const body = dietaryBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: SHOPPING_LIST_RULES.dietaryNeeds }, 400);
    return answer(c, await c.var.shoppingList.setDietaryNeeds(body.data.dietaryNeeds));
  })
  // The trip setting, "An extra trip must save at least $X", in whole cents.
  .put("/shopping-list/trip-setting", jsonOnly, async (c) => {
    const body = tripBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: SHOPPING_LIST_RULES.tripSaving }, 400);
    return answer(c, await c.var.shoppingList.setTripSaving(body.data.tripSaving));
  })
  // Undo on a Shopping list change's card in Chat, with an empty JSON body. Any Member may press it.
  .post("/shopping-list/changes/:id/undo", jsonOnly, async (c) => {
    const id = c.req.param("id");
    if (!ID.test(id)) return c.json(NOT_FOUND, 404);
    if (!emptyBody.safeParse(await jsonBody(c)).success) {
      return c.json({ error: "Send an empty body." }, 400);
    }
    return answer(c, await c.var.shoppingList.undo(id, c.var.member.id));
  });
