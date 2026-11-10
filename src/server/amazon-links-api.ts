import { Hono, type MiddlewareHandler } from "hono";
import * as z from "zod";
import type { AmazonHandLinkOutcome } from "./amazon-links-views.ts";
import type { ServerEnv } from "./env.ts";

// The Amazon link routes on a Transaction's detail view (spec 14, Hand links). The API mounts them;
// its session and Origin checks run first.

// A route that takes a JSON body refuses any other content type, so a form on another site cannot
// post to it.
const jsonOnly: MiddlewareHandler<ServerEnv> = async (c, next) => {
  if (c.req.header("content-type")?.split(";")[0]?.trim() !== "application/json") {
    return c.json({ error: "Send JSON." }, 415);
  }
  await next();
};

const handLinkBody = z.strictObject({
  orderId: z.string().min(1).max(100),
  shipTime: z.string().min(1).max(100),
});

const REFUSED: Record<
  Exclude<AmazonHandLinkOutcome, "linked">,
  { status: 400 | 404 | 409; error: string }
> = {
  "no Transaction": { status: 404, error: "Not found" },
  pending: { status: 400, error: "A pending Transaction has no links. Link its posted copy." },
  "not Spending": { status: 400, error: "Only Spending takes Amazon items." },
  "no shipment": { status: 404, error: "No Amazon shipment has that order ID and ship time." },
  "already linked": { status: 409, error: "That shipment is linked already. Undo its link first." },
  "another order": {
    status: 409,
    error: "This Transaction holds another order's items. Undo that link first.",
  },
};

export const amazonLinkApi = new Hono<ServerEnv>()
  // The unlinked shipments ordered from 30 days before to 3 days after its purchase date.
  .get("/transactions/:id/amazon-shipments", async (c) => {
    const shipments = await c.var.amazonLinks.shipmentsToLink(c.req.param("id"));
    if (shipments === undefined) return c.json({ error: "Not found" }, 404);
    return c.json({ shipments }, 200);
  })
  // A Member links a shipment by hand. Its amount may differ from the Transaction's.
  .post("/transactions/:id/amazon-link", jsonOnly, async (c) => {
    let json: unknown;
    try {
      json = await c.req.json();
    } catch {
      json = undefined;
    }
    const body = handLinkBody.safeParse(json);
    if (!body.success) return c.json({ error: "Name the shipment's order ID and ship time." }, 400);
    const outcome = await c.var.amazonLinks.link(c.req.param("id"), body.data);
    if (outcome === "linked") return c.json({ linked: true }, 200);
    const { status, error } = REFUSED[outcome];
    return c.json({ error }, status);
  })
  // Undo: every Line item linked to it is unlinked. The app never links those shipments to it
  // again.
  .delete("/transactions/:id/amazon-link", async (c) => {
    if (!(await c.var.amazonLinks.undo(c.req.param("id"), c.var.member.id))) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json({ undone: true }, 200);
  });
