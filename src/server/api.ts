import { type Context, Hono } from "hono";
import * as z from "zod";
import { AI_PROVIDERS, baseUrlProblem, onGateway } from "../ai/ai-view.ts";
import { PLAID_ITEM_LIMIT } from "../bank/plaid-view.ts";
import { UNCONNECTED_KINDS } from "../bank/unconnected-kinds.ts";
import { HAND_SET_TYPES } from "../money-movement/types.ts";
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

// The Household facts (spec 05): the ZIP code, each person's age, people without a login
// included, and rent or own. No one is asked their sex.
const MAX_PEOPLE = 20;
const MAX_AGE = 120;
const householdFactsBody = z.object({
  zipCode: z
    .string()
    .trim()
    .regex(/^\d{5}$/),
  ages: z.array(z.number().int().min(0).max(MAX_AGE)).min(1).max(MAX_PEOPLE),
  rentOrOwn: z.enum(["rent", "own"]),
});

// An Unconnected account (spec 02, Unconnected accounts). An empty institution name or last 4
// digits is none. A balance is whole cents.
const MAX_BALANCE_CENTS = 100_000_000_000;
const unconnectedAccountBody = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(UNCONNECTED_KINDS),
  institutionName: z
    .string()
    .trim()
    .max(100)
    .nullish()
    .transform((name) => (name === "" || name === undefined ? null : name)),
  mask: z
    .string()
    .trim()
    .regex(/^(\d{4})?$/)
    .nullish()
    .transform((mask) => (mask === "" || mask === undefined ? null : mask)),
  balance: z
    .number()
    .int()
    .min(-MAX_BALANCE_CENTS)
    .max(MAX_BALANCE_CENTS)
    .nullish()
    .transform((balance) => balance ?? null),
});
const UNCONNECTED_REFUSED =
  "Enter a name and a kind. The last 4 digits are 4 digits, and the balance is in dollars and cents.";

// The types a Member may set by hand.
const transactionTypeBody = z.object({ type: z.enum(HAND_SET_TYPES) });

const itemsUsedBody = z.object({ itemsUsed: z.number().int().min(0).max(PLAID_ITEM_LIMIT) });

// An AI API key, gateway token, or model ID: visible ASCII with no spaces, so it fits in a header
// and a JSON body as written.
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
const aiSecret = z.string().trim().min(1).max(512).regex(VISIBLE_ASCII);
const modelId = z.string().trim().min(1).max(200).regex(VISIBLE_ASCII);

// Changing the API key, the gateway token, the AI provider, or the base URL takes a fresh TOTP or
// backup code, checked when `code` is given. An API key or gateway token left out keeps the one
// stored.
const aiSettingsBody = z.object({
  provider: z.enum(AI_PROVIDERS),
  apiKey: aiSecret.optional(),
  baseUrl: z.string().trim().max(2048).nullable(),
  gatewayToken: aiSecret.nullable().optional(),
  quickModel: modelId,
  writerModel: modelId,
  code: z.string().trim().min(1).max(64).optional(),
});

// A base URL as the AI SDK takes it: http or https, with no login, query, or fragment, and no
// trailing slash. Empty is none. Undefined when it is not such a URL.
function aiBaseUrl(text: string | null): string | null | undefined {
  if (text === null || text === "") return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  const plain =
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "";
  return plain ? url.href.replace(/\/+$/, "") : undefined;
}

const BASE_URL_REFUSALS = {
  "link-local": "The app does not call a link-local address, such as a cloud metadata address.",
  "plain http":
    "Use https:// for this base URL. http:// works only for this computer or a private network.",
} as const;

// The answer to each save refusal.
const SAVE_REFUSALS = {
  "key needed": { status: 400, error: "Enter the API key." },
  "token needed": { status: 400, error: "Enter the gateway token." },
  "code needed": {
    status: 400,
    error: "Enter a code from your authenticator app, or a backup code.",
  },
  changed: {
    status: 409,
    error: "The AI settings changed while the app checked them. Check and save again.",
  },
} as const;

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
  // A Member sets a Transaction's type by hand (spec 03, Transaction types). It wins over every
  // rule and survives every re-run.
  .put("/transactions/:id/type", async (c) => {
    const body = transactionTypeBody.safeParse(await jsonBody(c));
    if (!body.success) {
      return c.json({ error: "Pick Spending, Transfer, Income, or Saving." }, 400);
    }
    const decision = await c.var.moneyMovement.setType(c.req.param("id"), body.data.type);
    if (decision === undefined) return c.json({ error: "Not found" }, 404);
    return c.json({ decision }, 200);
  })
  // Spending, Income, and Saving by month, by Category, and by Category group. Posted Transactions
  // only.
  .get("/totals", async (c) => c.json({ months: await c.var.moneyMovement.totals() }))
  .get("/connections", async (c) => c.json({ connections: await c.var.bank.connections() }))
  // Unconnected accounts: any Member adds and edits one at any time (spec 02).
  .get("/unconnected-accounts", async (c) =>
    c.json({ accounts: await c.var.bank.unconnectedAccounts() }),
  )
  .post("/unconnected-accounts", async (c) => {
    const body = unconnectedAccountBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: UNCONNECTED_REFUSED }, 400);
    const account = await c.var.bank.addUnconnectedAccount(body.data, c.var.member.id);
    return c.json({ account }, 200);
  })
  .put("/unconnected-accounts/:id", async (c) => {
    const body = unconnectedAccountBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: UNCONNECTED_REFUSED }, 400);
    const account = await c.var.bank.editUnconnectedAccount(
      c.req.param("id"),
      body.data,
      c.var.member.id,
    );
    if (account === undefined) return c.json({ error: "Not found" }, 404);
    return c.json({ account }, 200);
  })
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
  // The Household facts: the wizard's step 4, and Settings, Household (spec 05, Household facts).
  .get("/household", async (c) => c.json({ facts: await c.var.household.facts() }))
  .put("/household", async (c) => {
    const body = householdFactsBody.safeParse(await jsonBody(c));
    if (!body.success) {
      return c.json(
        {
          error: `Enter a 5-digit ZIP code, each person's age from 0 to ${MAX_AGE}, and rent or own.`,
        },
        400,
      );
    }
    const facts = await c.var.household.save(body.data, c.var.member.id);
    if (facts === "unknown zip code") {
      return c.json({ error: "The app does not know this ZIP code. Check it and try again." }, 400);
    }
    return c.json({ facts }, 200);
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
  })
  // The API key and the gateway token are never in an answer: only whether each is set.
  .get("/ai/settings", async (c) => c.json({ ai: (await c.var.ai.view()) ?? null }))
  .post("/ai/settings", async (c) => {
    const body = aiSettingsBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Check the AI provider's fields." }, 400);
    const { code, ...fields } = body.data;
    const baseUrl = aiBaseUrl(fields.baseUrl);
    if (baseUrl === undefined) {
      return c.json({ error: "Enter the base URL as an http or https address." }, 400);
    }
    if (fields.provider === "openai-compatible" && baseUrl === null) {
      return c.json({ error: "An OpenAI-compatible endpoint needs a base URL." }, 400);
    }
    const problem = baseUrl === null ? undefined : baseUrlProblem(baseUrl);
    if (problem !== undefined) return c.json({ error: BASE_URL_REFUSALS[problem] }, 400);
    if (typeof fields.gatewayToken === "string" && !onGateway(baseUrl)) {
      return c.json({ error: "A gateway token needs a Cloudflare AI Gateway base URL." }, 400);
    }
    let freshCode = false;
    if (code !== undefined) {
      const fresh = await c.var.checkFreshCode(code);
      if (fresh === "too many tries") {
        return c.json({ error: "Too many wrong codes. Wait 15 minutes, then try again." }, 429);
      }
      if (fresh === "wrong") return c.json({ error: "Wrong code." }, 401);
      freshCode = true;
    }
    const saved = await c.var.ai.save({ ...fields, baseUrl }, { freshCode });
    if (!saved.saved) {
      const { status, error } = SAVE_REFUSALS[saved.refusal];
      return c.json({ error }, status);
    }
    return c.json({ check: saved.check, ai: saved.ai });
  })
  .post("/ai/remove", async (c) => {
    await c.var.ai.remove();
    return c.json({ ai: null });
  });

export type Api = typeof api;
