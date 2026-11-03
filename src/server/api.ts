import { type Context, Hono } from "hono";
import * as z from "zod";
import { PLAID_ITEM_LIMIT } from "../bank/plaid-view.ts";
import type { BalanceQuery, TransactionQuery } from "./bank-views.ts";
import type { ServerEnv } from "./env.ts";
import type { MasterKeyCheckResult } from "./master-key-views.ts";

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

// A Plaid client ID or secret, as Plaid's dashboard shows it: letters and digits.
const PLAID_KEY = /^[A-Za-z0-9]{16,64}$/;

// 64 hexadecimal characters, with room for spaces and line breaks.
const MAX_PASTED_KEY_LENGTH = 1000;

// The pasted Master key in a request body such as {"masterKey": "..."}, or undefined. A body that
// is not JSON is refused as it is: a JSON parse error quotes part of the body, which may hold the
// key, and must not reach the log.
async function pastedKey(c: Context<ServerEnv>): Promise<string | undefined> {
  const body: unknown = await c.req.json().catch(() => undefined);
  if (typeof body !== "object" || body === null || !("masterKey" in body)) return undefined;
  const { masterKey } = body;
  if (typeof masterKey !== "string" || masterKey.length > MAX_PASTED_KEY_LENGTH) return undefined;
  return masterKey;
}

// The answer to a pasted Master key. It never holds the pasted text.
function checkAnswer(c: Context<ServerEnv>, result: MasterKeyCheckResult) {
  switch (result) {
    case "matches":
      return c.json({ matches: true }, 200);
    case "wrong":
      return c.json({ matches: false }, 200);
    case "too many tries":
      return c.json({ error: "Too many wrong keys. Wait 15 minutes, then try again." }, 429);
    case "step done":
      return c.json({ error: "This step is done. Use Check my master key in Settings." }, 409);
  }
}

const NO_KEY = "Paste the Master key.";

const NO_REVIEW_ITEM = "No open Review list item has this ID.";
const MAX_CHOICE_LENGTH = 200;

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

// The range of GET /api/accounts/:id/balances.
function balanceQuery(query: Record<string, string>): BalanceQuery | undefined {
  const { from, to } = query;
  for (const date of [from, to]) {
    if (date !== undefined && !CALENDAR_DATE.test(date)) return undefined;
  }
  return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}

export const api = new Hono<ServerEnv>()
  .get("/ping", (c) => c.json({ ok: true }))
  .get("/security-mode", (c) => c.json({ mode: c.var.appUrl.mode, appUrl: c.var.appUrl.origin }))
  .get("/accounts", async (c) => c.json({ accounts: await c.var.bank.accounts() }))
  // Daily balances, with estimated days marked, and month-end balances, for graphs.
  .get("/accounts/:id/balances", async (c) => {
    const query = balanceQuery(c.req.query());
    if (query === undefined) return c.json({ error: "Write dates as YYYY-MM-DD." }, 400);
    const balances = await c.var.bank.balances(c.req.param("id"), query);
    if (balances === undefined) return c.json({ error: "Not found" }, 404);
    return c.json(balances);
  })
  // A Member closes or reopens any Account (spec 02, Closed Accounts).
  .post("/accounts/:id/close", async (c) => {
    const account = await c.var.bank.closeAccount(c.req.param("id"));
    if (account === undefined) return c.json({ error: "Not found" }, 404);
    return c.json({ account });
  })
  .post("/accounts/:id/reopen", async (c) => {
    const account = await c.var.bank.reopenAccount(c.req.param("id"));
    if (account === undefined) return c.json({ error: "Not found" }, 404);
    return c.json({ account });
  })
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
  })
  // The wizard's step 3 (spec 12): the Master key on each visit, until the paste-back succeeds.
  .get("/setup/master-key", async (c) => {
    c.header("Cache-Control", "no-store");
    const masterKey = await c.var.masterKey.shown();
    if (masterKey === undefined) {
      return c.json(
        { error: "The Master key was shown during setup, and is never shown again." },
        410,
      );
    }
    return c.json({ masterKey }, 200);
  })
  .post("/setup/master-key", async (c) => {
    const pasted = await pastedKey(c);
    if (pasted === undefined) return c.json({ error: NO_KEY }, 400);
    return checkAnswer(c, await c.var.masterKey.pasteBack(c.var.member.id, pasted));
  })
  // "Check my master key" in Settings, Backups and data (spec 09).
  .get("/master-key/check", async (c) => c.json({ lastCheck: await c.var.masterKey.lastCheck() }))
  .post("/master-key/check", async (c) => {
    const pasted = await pastedKey(c);
    if (pasted === undefined) return c.json({ error: NO_KEY }, 400);
    return checkAnswer(c, await c.var.masterKey.check(c.var.member.id, pasted));
  })
  // System notices: the dashboard shows each open one as a line above its boxes (spec 07).
  .get("/notices", async (c) => c.json({ notices: await c.var.notices.open() }))
  .post("/notices/:id/close", async (c) => {
    const result = await c.var.notices.close(c.req.param("id"), c.var.member.id);
    if (result === "not open") return c.json({ error: "No open System notice has this ID." }, 404);
    if (result === "condition") {
      return c.json({ error: "This notice stays until its condition ends." }, 409);
    }
    return c.json({ closed: true }, 200);
  })
  // The Review list (spec 07, Review list page). The main menu shows the open count.
  .get("/review-list", async (c) => c.json({ items: await c.var.reviewList.open() }))
  .get("/review-list/count", async (c) => c.json({ open: await c.var.reviewList.count() }))
  .get("/review-list/:id/choices", async (c) => {
    const choices = await c.var.reviewList.otherChoices(c.req.param("id"));
    if (choices === undefined) return c.json({ error: NO_REVIEW_ITEM }, 404);
    return c.json({ choices }, 200);
  })
  // A Member's answer: {"value": ...}, the best answer's value or another choice's.
  .post("/review-list/:id/answer", async (c) => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const value =
      typeof body === "object" && body !== null && "value" in body ? body.value : undefined;
    if (typeof value !== "string" || value === "" || value.length > MAX_CHOICE_LENGTH) {
      return c.json({ error: "Pick an answer." }, 400);
    }
    const result = await c.var.reviewList.answer(c.req.param("id"), value, c.var.member.id);
    if (result === "not open") return c.json({ error: NO_REVIEW_ITEM }, 404);
    if (result === "not a choice") {
      return c.json({ error: "That is not a choice for this item." }, 400);
    }
    return c.json({ answered: true }, 200);
  });

export type Api = typeof api;
