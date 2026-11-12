import { Hono, type MiddlewareHandler } from "hono";
import * as z from "zod";
import type { ServerEnv } from "./env.ts";
import type { TakeDealOutcome } from "./shopping-plan-views.ts";

// The Shopping plan on the Shopping list page (spec 15, What the plan shows): the last plan, and
// "Use this Deal" with its way back. The API mounts these routes; its session and Origin checks
// run first.

// A route that takes a JSON body refuses any other content type, so a form on another site cannot
// post to it.
const jsonOnly: MiddlewareHandler<ServerEnv> = async (c, next) => {
  if (c.req.header("content-type")?.split(";")[0]?.trim() !== "application/json") {
    return c.json({ error: "Send JSON." }, 415);
  }
  await next();
};

const PLAN_ID = z.string().min(1).max(100);
const PLACE = z.number().int().min(0).max(999);

const takeDealBody = z.strictObject({
  planId: PLAN_ID,
  place: PLACE,
  productId: z.string().min(1).max(200),
});
const dropDealBody = z.strictObject({ planId: PLAN_ID, place: PLACE });
const matchChoiceBody = z.strictObject({
  listItemId: z.string().min(1).max(100),
  productId: z.string().min(1).max(200),
  choice: z.enum(["confirmed", "rejected"]),
});

async function jsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

const REFUSED: Record<Exclude<TakeDealOutcome, "used">, { status: 404 | 409; error: string }> = {
  "no plan": { status: 404, error: "There is no Shopping plan yet." },
  "plan changed": { status: 409, error: "A newer Shopping plan is here. Look at it first." },
  "no line": { status: 404, error: "That List item is not in the plan." },
  "no deal": { status: 409, error: "That Deal is not offered for this List item now." },
};

export const shoppingPlanApi = new Hono<ServerEnv>()
  // The last plan as it stands today, or null before the first plan.
  .get("/shopping-plan", async (c) => c.json({ plan: (await c.var.shoppingPlan.view()) ?? null }))
  // "Use this Deal": the List item goes to the Deal's Store until the Deal ends.
  .post("/shopping-plan/deals", jsonOnly, async (c) => {
    const body = takeDealBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Name the plan, the List item and the Deal." }, 400);
    const outcome = await c.var.shoppingPlan.takeDeal(body.data, c.var.member.id);
    if (outcome !== "used") {
      const { status, error } = REFUSED[outcome];
      return c.json({ error }, status);
    }
    return c.json({ plan: (await c.var.shoppingPlan.view()) ?? null }, 200);
  })
  // Back to the regular price.
  .post("/shopping-plan/deals/stop", jsonOnly, async (c) => {
    const body = dropDealBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Name the plan and the List item." }, 400);
    if (!(await c.var.shoppingPlan.dropDeal(body.data))) {
      return c.json({ error: "That List item uses no Deal." }, 404);
    }
    return c.json({ plan: (await c.var.shoppingPlan.view()) ?? null }, 200);
  })
  // A Member confirms or rejects a found Product for a List item (spec 15, Matching List items to
  // Products, step 5). The app remembers it, and the next plan uses it.
  .post("/shopping-plan/matches", jsonOnly, async (c) => {
    const body = matchChoiceBody.safeParse(await jsonBody(c));
    if (!body.success)
      return c.json({ error: "Name the List item, the Product and a choice." }, 400);
    if (!(await c.var.shoppingPlan.chooseMatch(body.data, c.var.member.id))) {
      return c.json({ error: "That Product was not found for this List item." }, 404);
    }
    return c.json({ plan: (await c.var.shoppingPlan.view()) ?? null }, 200);
  });
