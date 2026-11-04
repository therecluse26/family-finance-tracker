import { type Context, Hono } from "hono";
import * as z from "zod";
import { AI_PROVIDERS, baseUrlProblem, MAX_COST_CAP_CENTS, onGateway } from "../ai/ai-view.ts";
import type {
  CoveringConnection,
  LinkRefusal,
  ProviderFailure,
  UpdateModeFinish,
  UpdateModeStart,
} from "../bank/connect-view.ts";
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

// A TOTP code or a backup code, asked again for a sensitive action (spec 09).
const codeBody = z.object({ code: z.string().trim().min(1).max(64) });

// Delete history's own confirmation.
const deleteHistoryBody = z.object({ confirmed: z.literal(true) });

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

// A Member's change to a connected loan: its type, and an APR as a percent from 0 to 100.
const loanBody = z
  .object({
    loanType: z.enum(["cash loan", "purchase loan"]).nullable().optional(),
    apr: z.number().min(0).max(100).nullable().optional(),
  })
  .strict();

const itemsUsedBody = z.object({ itemsUsed: z.number().int().min(0).max(PLAID_ITEM_LIMIT) });

// Linking a new bank (spec 02, Linking a new bank). `confirmed` is the second confirmation at N of
// 8 or more; `replaces` is the Broken Connection that Link again replaces.
const linkOptionsBody = z.object({
  confirmed: z.boolean().optional(),
  replaces: z.string().trim().min(1).max(100).optional(),
});

// A Plaid public token as Link hands it out, such as public-production- and an ID.
const PUBLIC_TOKEN = /^public-[a-z]+-[A-Za-z0-9-]{8,200}$/;

// Link's public token, with the institution and the Accounts the Member picked from Link's
// metadata, which the app checks for a duplicate bank before it exchanges the token.
const linkResultBody = linkOptionsBody.extend({
  publicToken: z.string().regex(PUBLIC_TOKEN),
  bankId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  bankName: z.string().trim().min(1).max(200),
  accounts: z
    .array(
      z.object({
        name: z.string().trim().max(200),
        type: z.string().trim().min(1).max(50),
        subtype: z.string().trim().max(50).nullable(),
        mask: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9]{1,8}$/)
          .nullable(),
      }),
    )
    .max(100),
});

// A Plaid access token pasted for Import Plaid Connection, such as access-production- and an ID.
// The answer to it never holds it.
const importBody = z.object({
  accessToken: z
    .string()
    .trim()
    .regex(/^access-[a-z]+-[A-Za-z0-9-]{8,200}$/),
});

// The answer to a duplicate bank: it names the Connection that covers it.
function duplicateBank(c: Context<ServerEnv>, coveredBy: CoveringConnection) {
  return c.json(
    {
      coveredBy,
      error: `This bank is already connected as ${coveredBy.bankName}. A bank has one Connection, so the app did not link it again.`,
    },
    409,
  );
}

// The answer when the app refuses to link or import a bank, or Plaid refuses. Nothing was saved.
function connectRefusal(c: Context<ServerEnv>, refused: LinkRefusal | ProviderFailure) {
  switch (refused.outcome) {
    case "item limit":
      return c.json(
        {
          itemsUsed: refused.itemsUsed,
          error: `At least ${refused.itemsUsed} of Plaid's ${PLAID_ITEM_LIMIT} lifetime Items are used, so the app cannot link a new bank.`,
        },
        409,
      );
    case "not broken":
      return c.json({ error: "Link again works only for a Broken Connection." }, 400);
    case "other bank":
      return c.json(
        {
          error: "Link again must link the same bank as the Broken Connection. Nothing was linked.",
        },
        409,
      );
    case "provider error":
      return c.json({ error: `${refused.message} Nothing was saved.` }, 502);
  }
}

const HELD =
  "This Connection is not in use: it is a second Connection to a bank another Connection covers, so it never syncs. Remove it.";

const LINK_AGAIN =
  "The bank's provider says access is gone, so Repair cannot fix this Connection. Use Link again.";

// The answer to a Connection that is gone or Broken after update mode. The Broken one needs Link
// again.
function updateModeRefusal(
  c: Context<ServerEnv>,
  refused: Exclude<
    UpdateModeStart | UpdateModeFinish,
    { outcome: "ready" | "syncing" | "sync soon" }
  >,
) {
  switch (refused.outcome) {
    case "not found":
      return c.json({ error: "Not found" }, 404);
    case "link again":
      return c.json({ linkAgain: true, error: LINK_AGAIN }, 409);
    case "not needed":
      return c.json({ error: "This Connection does not need Repair." }, 409);
    case "no repair":
      return c.json({ error: "This Connection's provider has no Repair in the app." }, 409);
    case "held":
      return c.json({ error: HELD }, 409);
    case "provider error":
      return c.json({ error: `${refused.message} Nothing changed.` }, 502);
  }
}

// A link token in update mode, for the browser's link screen only. It is not cached.
function updateModeStarted(c: Context<ServerEnv>, started: UpdateModeStart) {
  if (started.outcome !== "ready") return updateModeRefusal(c, started);
  c.header("Cache-Control", "no-store");
  return c.json({ linkToken: started.linkToken }, 200);
}

// An AI API key, gateway token, or model ID: visible ASCII with no spaces, so it fits in a header
// and a JSON body as written.
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
const aiSecret = z.string().trim().min(1).max(512).regex(VISIBLE_ASCII);
const modelId = z.string().trim().min(1).max(200).regex(VISIBLE_ASCII);

// A price a Member enters for a model not in the price table, in millionths of a dollar per
// million tokens: at most $1,000 per million tokens. A local model may be $0.
const MAX_PRICE = 1_000_000_000;
const price = z.number().int().min(0).max(MAX_PRICE);
const enteredPrice = z.object({ input: price, output: price });

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
  prices: z.object({ quick: enteredPrice.optional(), writer: enteredPrice.optional() }).optional(),
  code: z.string().trim().min(1).max(64).optional(),
});

// The AI cost cap, in whole cents.
const costCapBody = z.object({ capCents: z.number().int().min(0).max(MAX_COST_CAP_CENTS) });

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

const TIER_NAMES = { quick: "Quick model", writer: "Writer model" } as const;

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
  // One Transaction, with its type and its Transfer link's evidence (spec 03, Evidence).
  .get("/transactions/:id", async (c) => {
    const detail = await c.var.moneyMovement.transaction(c.req.param("id"));
    if (detail === undefined) return c.json({ error: "Not found" }, 404);
    return c.json(detail);
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
  // A connected loan's type and the APR a Member typed (spec 02, Account fields). A Member's type
  // wins over the subtype and the payout. Its payments are decided again.
  .get("/accounts/:id/loan", async (c) => {
    const loan = await c.var.moneyMovement.loan(c.req.param("id"));
    if (loan === undefined) return c.json({ error: "Not found" }, 404);
    return c.json({ loan });
  })
  .put("/accounts/:id/loan", async (c) => {
    const body = loanBody.safeParse(await jsonBody(c));
    if (!body.success) {
      return c.json({ error: "Pick Cash loan or Purchase loan, and an APR from 0 to 100." }, 400);
    }
    const loan = await c.var.moneyMovement.setLoan(c.req.param("id"), body.data);
    if (loan === undefined) return c.json({ error: "Not found" }, 404);
    return c.json({ loan });
  })
  // Spending, Income, and Saving by month, by Category, and by Category group. Posted Transactions
  // only.
  .get("/totals", async (c) => c.json({ months: await c.var.moneyMovement.totals() }))
  .get("/connections", async (c) => c.json({ connections: await c.var.bank.connections() }))
  // Removing a Connection asks for a TOTP code or a backup code again (spec 09, Sensitive
  // actions). The Accounts become Closed, and their history stays.
  .post("/connections/:id/remove", async (c) => {
    const body = codeBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Enter a code." }, 400);
    const fresh = await c.var.checkFreshCode(body.data.code);
    if (fresh === "too many tries") {
      return c.json({ error: "Too many wrong codes. Wait 15 minutes, then try again." }, 429);
    }
    if (fresh === "wrong") return c.json({ error: "Wrong code." }, 401);
    const removed = await c.var.removing.remove(c.req.param("id"));
    if (removed.outcome === "not found") return c.json({ error: "Not found" }, 404);
    if (removed.outcome === "provider error") {
      return c.json(
        {
          error: `The bank's provider did not remove the Connection: ${removed.message} Nothing changed. Try again.`,
        },
        502,
      );
    }
    return c.json({ removed: true }, 200);
  })
  // Delete history: a separate action, with its own confirmation, for a removed Connection.
  .post("/connections/:id/delete-history", async (c) => {
    const body = deleteHistoryBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Confirm that the history goes for good." }, 400);
    const deleted = await c.var.removing.deleteHistory(c.req.param("id"));
    if (deleted.outcome === "not found") return c.json({ error: "Not found" }, 404);
    if (deleted.outcome === "not removed") {
      return c.json({ error: "Remove the Connection before you delete its history." }, 409);
    }
    return c.json({ accounts: deleted.accounts, transactions: deleted.transactions }, 200);
  })
  // Repair (spec 02, Repair): Plaid Link in update mode for a Connection that needs a Member. It
  // keeps the Connection and its access token, and spends no Item. A Broken one answers 409 with
  // linkAgain.
  .post("/connections/:id/repair", async (c) =>
    updateModeStarted(c, await c.var.repairing.startRepair(c.req.param("id"))),
  )
  // Add accounts (spec 02, New accounts at a bank): update mode with account selection. It spends no
  // Item.
  .post("/connections/:id/add-accounts", async (c) =>
    updateModeStarted(c, await c.var.repairing.startAddAccounts(c.req.param("id"))),
  )
  // Link's onSuccess in update mode. The public token is not needed: the access token stays the
  // same. The Connection's sync starts at once.
  .post("/connections/:id/update-finished", async (c) => {
    const finished = await c.var.repairing.finishUpdate(c.req.param("id"));
    if (finished.outcome === "syncing") return c.json({ syncing: true }, 200);
    // A sync started a few minutes ago: the next one starts when the gap has passed.
    if (finished.outcome === "sync soon") return c.json({ syncing: false }, 200);
    return updateModeRefusal(c, finished);
  })
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
  // A link token for Plaid Link, after the Item count's gates (spec 02, The 10 lifetime Items).
  .post("/plaid/link-token", async (c) => {
    const body = linkOptionsBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "That request is not one the app makes." }, 400);
    const started = await c.var.plaidConnecting.startLink(body.data);
    if (started.outcome === "ready") {
      c.header("Cache-Control", "no-store");
      return c.json({ linkToken: started.linkToken, itemsUsed: started.itemsUsed }, 200);
    }
    if (started.outcome === "confirm") {
      return c.json(
        {
          confirm: true,
          itemsUsed: started.itemsUsed,
          error: `At least ${started.itemsUsed} of ${PLAID_ITEM_LIMIT} Plaid Items are used. Confirm a second time to link a new bank.`,
        },
        409,
      );
    }
    return connectRefusal(c, started);
  })
  // Link's onSuccess: a duplicate bank is blocked before the token exchange.
  .post("/plaid/link", async (c) => {
    const body = linkResultBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "That request is not one the app makes." }, 400);
    const { confirmed, replaces, ...result } = body.data;
    const linked = await c.var.plaidConnecting.finishLink(result, { confirmed, replaces });
    if (linked.outcome === "linked") {
      return c.json({ connection: { id: linked.connectionId, bankName: linked.bankName } }, 200);
    }
    if (linked.outcome === "duplicate") return duplicateBank(c, linked.coveredBy);
    // After the exchange, Plaid's own answer named another bank than the browser did.
    if (linked.outcome === "added other bank") {
      return c.json(
        {
          connection: { id: linked.connectionId, bankName: linked.bankName },
          error: `Plaid linked ${linked.bankName}, not the Broken Connection's bank. It was added as a new Connection, and nothing was replaced.`,
        },
        409,
      );
    }
    // Plaid did not confirm the bank after the exchange: it was added, and replaced nothing.
    if (linked.outcome === "added unconfirmed") {
      const connection = { id: linked.connectionId, bankName: linked.bankName };
      if (!linked.replacedNothing) return c.json({ connection, bankConfirmed: false }, 200);
      return c.json(
        {
          connection,
          error:
            "Plaid did not confirm which bank was linked, so it was added as a new Connection, and nothing was replaced. If it is the Broken Connection's bank, Remove the Broken Connection.",
        },
        409,
      );
    }
    if (linked.outcome === "duplicate after link") {
      const { bankName } = linked.coveredBy;
      return c.json(
        {
          coveredBy: linked.coveredBy,
          error: linked.removed
            ? `Plaid linked a bank already connected as ${bankName}. The app removed the new Connection; it still counts as one of Plaid's ${PLAID_ITEM_LIMIT} lifetime Items.`
            : `Plaid linked a bank already connected as ${bankName}, and Plaid did not end the new Connection. Remove it.`,
        },
        409,
      );
    }
    return connectRefusal(c, linked);
  })
  // Import Plaid Connection (spec 02): the bank and its Accounts, before anything is saved.
  .post("/plaid/import/preview", async (c) => {
    const body = importBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "That is not a Plaid access token." }, 400);
    const preview = await c.var.plaidConnecting.previewImport(body.data.accessToken);
    if (preview.outcome === "preview") {
      return c.json({ bankName: preview.bankName, accounts: preview.accounts }, 200);
    }
    if (preview.outcome === "duplicate") return duplicateBank(c, preview.coveredBy);
    return connectRefusal(c, preview);
  })
  // Saves the imported Connection, which syncs from an empty cursor. The answer has no token.
  .post("/plaid/import", async (c) => {
    const body = importBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "That is not a Plaid access token." }, 400);
    const saved = await c.var.plaidConnecting.importConnection(body.data.accessToken);
    if (saved.outcome === "imported") {
      return c.json({ connection: { id: saved.connectionId, bankName: saved.bankName } }, 200);
    }
    if (saved.outcome === "duplicate") return duplicateBank(c, saved.coveredBy);
    return connectRefusal(c, saved);
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
      if (saved.refusal === "price needed") {
        const error = `The app has no price for the ${TIER_NAMES[saved.tier]}. Enter its input and output prices.`;
        return c.json({ error }, 400);
      }
      const { status, error } = SAVE_REFUSALS[saved.refusal];
      return c.json({ error }, status);
    }
    return c.json({ check: saved.check, ai: saved.ai });
  })
  .post("/ai/remove", async (c) => {
    await c.var.ai.remove();
    return c.json({ ai: null });
  })
  // The AI usage page: metadata only, never prompt text or reply text (spec 08, AI usage page).
  .get("/ai/usage", async (c) => c.json({ usage: await c.var.ai.usage() }))
  .put("/ai/cost-cap", async (c) => {
    const body = costCapBody.safeParse(await jsonBody(c));
    if (!body.success) {
      return c.json({ error: "Enter the AI cost cap in dollars, from $0 to $10,000." }, 400);
    }
    return c.json({ usage: await c.var.ai.setCostCap(body.data.capCents) }, 200);
  });

export type Api = typeof api;
