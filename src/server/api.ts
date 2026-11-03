import { Hono } from "hono";
import * as z from "zod";
import { PLAID_ITEM_LIMIT } from "../bank/plaid-view.ts";
import type { TransactionQuery } from "./bank-views.ts";
import type { ServerEnv } from "./env.ts";

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

// A Plaid client ID or secret, as Plaid's dashboard shows it: letters and digits.
const PLAID_KEY = /^[A-Za-z0-9]{16,64}$/;

// The filters of GET /api/transactions: account, and a date range on the posted date.
function transactionQuery(query: Record<string, string>): TransactionQuery | undefined {
  const { account, from, to } = query;
  for (const date of [from, to]) {
    if (date !== undefined && !CALENDAR_DATE.test(date)) return undefined;
  }
  return {
    ...(account === undefined || account === "" ? {} : { accountId: account }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

// Changing the Plaid keys is a sensitive action, so it takes a fresh TOTP or backup code.
const plaidKeysBody = z.object({
  clientId: z.string().trim().regex(PLAID_KEY),
  secret: z.string().trim().regex(PLAID_KEY),
  code: z.string().trim().min(1).max(64),
});

const itemsUsedBody = z.object({ itemsUsed: z.number().int().min(0).max(PLAID_ITEM_LIMIT) });

// The body as JSON, or undefined when it is not JSON.
async function jsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export const api = new Hono<ServerEnv>()
  .get("/ping", (c) => c.json({ ok: true }))
  .get("/security-mode", (c) => c.json({ mode: c.var.appUrl.mode, appUrl: c.var.appUrl.origin }))
  .get("/accounts", async (c) => c.json({ accounts: await c.var.bank.accounts() }))
  .get("/transactions", async (c) => {
    const query = transactionQuery(c.req.query());
    if (query === undefined) return c.json({ error: "Write dates as YYYY-MM-DD." }, 400);
    return c.json({ transactions: await c.var.bank.transactions(query) });
  })
  .get("/connections", async (c) => c.json({ connections: await c.var.bank.connections() }))
  // The Plaid secret is never in an answer: only whether it is set.
  .get("/plaid/settings", async (c) => c.json({ plaid: await c.var.plaid.view() }))
  .post("/plaid/keys", async (c) => {
    const body = plaidKeysBody.safeParse(await jsonBody(c));
    if (!body.success) {
      return c.json({ error: "Enter the client ID, the Production secret, and a code." }, 400);
    }
    const { clientId, secret, code } = body.data;
    const fresh = await c.var.checkFreshCode(code);
    if (fresh === "too many tries") {
      return c.json({ error: "Too many wrong codes. Wait 15 minutes, then try again." }, 429);
    }
    if (fresh === "wrong") return c.json({ error: "Wrong code." }, 401);
    const keys = await c.var.plaid.saveKeys({ clientId, secret });
    if (keys === "refused") {
      return c.json({ keys, error: "Plaid refused these keys. Nothing was saved." }, 422);
    }
    if (keys === "no answer") {
      return c.json({ keys, error: "Plaid did not answer. Nothing was saved. Try again." }, 502);
    }
    return c.json({ keys, plaid: await c.var.plaid.view() });
  })
  .post("/plaid/items-used", async (c) => {
    const body = itemsUsedBody.safeParse(await jsonBody(c));
    if (!body.success) {
      return c.json({ error: `Enter a whole number from 0 to ${PLAID_ITEM_LIMIT}.` }, 400);
    }
    const plaid = await c.var.plaid.setItemsUsed(body.data.itemsUsed);
    if (plaid === undefined) {
      const { appItems } = await c.var.plaid.view();
      return c.json({ error: `The app itself has used ${appItems}, so N cannot be lower.` }, 400);
    }
    return c.json({ plaid });
  });

export type Api = typeof api;
