import { Hono, type MiddlewareHandler } from "hono";
import * as z from "zod";
import type { Database } from "../db/index.ts";
import { changeLineItemCategory, deleteLineItemRule, itemRules } from "../line-items/index.ts";
import type { ServerEnv } from "./env.ts";
import type { LineItemCategoryRoutes } from "./line-item-category-views.ts";

// The Line item Category routes (spec 14, Item rules; Pages), through the line-items module, which
// runs one change at a time.
export function lineItemCategoryRoutes(database: Database): LineItemCategoryRoutes {
  return {
    change: (id, change, memberId) => changeLineItemCategory(database, id, change, memberId),
    async itemRules() {
      return (await itemRules(database)).map((rule) => ({
        id: rule.id,
        name: rule.name,
        category: rule.category,
        madeAt: rule.madeAt.toISOString(),
      }));
    },
    deleteItemRule: (id) => deleteLineItemRule(database, id),
  };
}

// A route that takes a JSON body refuses any other content type, so a form on another site cannot
// post to it.
const jsonOnly: MiddlewareHandler<ServerEnv> = async (c, next) => {
  if (c.req.header("content-type")?.split(";")[0]?.trim() !== "application/json") {
    return c.json({ error: "Send JSON." }, 415);
  }
  await next();
};

const changeBody = z
  .object({ category: z.string().min(1).max(100), onlyThisItem: z.boolean() })
  .strict();

// Mounted under /api. The app's session and same-origin checks run first.
export const lineItemCategoryApi = new Hono<ServerEnv>()
  // A Member changes a Line item's Category on the Transaction's detail view. Unless "only this
  // item", the app makes or replaces the product's Item rule.
  .put("/line-items/:id/category", jsonOnly, async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      json = undefined;
    }
    const body = changeBody.safeParse(json);
    if (!body.success) return c.json({ error: "Pick a Category." }, 400);
    const changed = await c.var.lineItemCategories.change(
      c.req.param("id"),
      body.data,
      c.var.member.id,
    );
    if (changed === "not found") return c.json({ error: "Not found" }, 404);
    if (changed === "not a Category") return c.json({ error: "Pick a Category." }, 400);
    return c.json({ changed: true }, 200);
  })
  // Settings > Categories: every Item rule, by name.
  .get("/item-rules", async (c) =>
    c.json({ rules: await c.var.lineItemCategories.itemRules() }, 200),
  )
  // Deleting a rule sends its Line items not set by hand down the steps again.
  .delete("/item-rules/:id", async (c) => {
    if (!(await c.var.lineItemCategories.deleteItemRule(c.req.param("id")))) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json({ deleted: true }, 200);
  });
