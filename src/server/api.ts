import { Hono } from "hono";
import type { TransactionQuery } from "./bank-views.ts";
import type { ServerEnv } from "./env.ts";

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

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

export const api = new Hono<ServerEnv>()
  .get("/ping", (c) => c.json({ ok: true }))
  .get("/security-mode", (c) => c.json({ mode: c.var.appUrl.mode, appUrl: c.var.appUrl.origin }))
  .get("/accounts", async (c) => c.json({ accounts: await c.var.bank.accounts() }))
  .get("/transactions", async (c) => {
    const query = transactionQuery(c.req.query());
    if (query === undefined) return c.json({ error: "Write dates as YYYY-MM-DD." }, 400);
    return c.json({ transactions: await c.var.bank.transactions(query) });
  })
  .get("/connections", async (c) => c.json({ connections: await c.var.bank.connections() }));

export type Api = typeof api;
