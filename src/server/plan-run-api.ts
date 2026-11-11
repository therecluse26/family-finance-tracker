import { Hono } from "hono";
import * as z from "zod";
import type { ServerEnv } from "./env.ts";

// "Find the best prices" (spec 15, The Shopping plan): starts a plan run, or joins the one that
// runs, and its progress for each Store. The API mounts these routes; its session and Origin checks
// run first, and the app's check before /api/shopping-plan/run refuses any body that is not JSON. An
// app with no Price source adapter answers 404.

// The expected cost the Member confirmed, in billionths of a dollar, when the run holds a full
// search. A run with only re-reads takes an empty body.
const startBody = z.strictObject({
  confirmedCostNanos: z.number().int().min(0).max(1_000_000_000_000).optional(),
});

// The body as JSON, or undefined when it is not JSON. A parse error is never read.
async function jsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export const planRunApi = new Hono<ServerEnv>()
  // The running plan run, else the last one, with each Store's progress. Null before any.
  .get("/shopping-plan/run", async (c) => c.json({ run: await c.var.planRuns.view() }, 200))
  .post("/shopping-plan/run", async (c) => {
    const body = startBody.safeParse(await jsonBody(c));
    if (!body.success) {
      return c.json({ error: "Send an empty body, or the cost you confirmed." }, 400);
    }
    const started = await c.var.planRuns.start(c.var.member.id, body.data.confirmedCostNanos);
    switch (started.outcome) {
      case "no items":
        return c.json({ error: "Add List items to the Shopping list first." }, 409);
      case "no stores":
        return c.json({ error: "Turn on a Store on the Price sources page first." }, 409);
      case "confirm":
        return c.json({ outcome: started.outcome, cost: started.cost }, 200);
      default:
        return c.json({ outcome: started.outcome, run: started.run }, 200);
    }
  });
