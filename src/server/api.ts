import { type Context, Hono, type MiddlewareHandler } from "hono";
import * as z from "zod";
import { AI_PROVIDERS, baseUrlProblem, MAX_COST_CAP_CENTS, onGateway } from "../ai/ai-view.ts";
import { AI_REQUEST_LOG_KEEP_DAYS } from "../ai/request-log-view.ts";
import type {
  CoveringConnection,
  LinkRefusal,
  ProviderFailure,
  UpdateModeFinish,
  UpdateModeStart,
} from "../bank/connect-view.ts";
import { PLAID_ITEM_LIMIT } from "../bank/plaid-view.ts";
import { UNCONNECTED_KINDS } from "../bank/unconnected-kinds.ts";
import { CATEGORIES, CATEGORY_GROUPS, type CategoryGroup } from "../categories/list.ts";
import { timeLabel } from "../format.ts";
import { HAND_SET_TYPES, MAX_SPLIT_PARTS, MIN_SPLIT_PARTS } from "../money-movement/types.ts";
import type { SendProblem, SmtpRefusal } from "../notify/email-view.ts";
import type { DeviceRefusal } from "../notify/push-view.ts";
import { pictureChoice } from "../pictures/choice.ts";
import { AI_WORK_REFUSALS, type AiWorkKind, retryWaitRefusal } from "../redo/work-view.ts";
import { DEFAULT_REPORT_RANGE, REPORT_RANGES } from "../reports/range.ts";
import { aiActivityStream } from "./ai-activity.ts";
import { amazonUploadKind, readAmazonUpload } from "./amazon.ts";
import { amazonLinkApi } from "./amazon-links-api.ts";
import type { BalanceQuery, TransactionQuery } from "./bank-views.ts";
import { CHAT_NOTE_KINDS } from "./chat-views.ts";
import type { ServerEnv } from "./env.ts";
import { lineItemCategoryApi } from "./line-item-categories.ts";
import type { MasterKeyCheckResult } from "./master-key-views.ts";
import { MANUAL_LOAN_KINDS } from "./money-movement-views.ts";
import { priceSourcesApi } from "./price-sources-api.ts";
import type { ProposalAcceptResult } from "./proposals-views.ts";
import type { RecurringChargeEditView } from "./recurring-views.ts";
import { type SetupProgressView, type SetupRefusal, SKIPPABLE_SETUP_STEPS } from "./setup-views.ts";
import { shoppingListApi } from "./shopping-list.ts";
import { TOP_MERCHANT_PERIODS } from "./top-merchants-views.ts";

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;

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
  }
}

const NO_KEY = "Paste the Master key.";

const NO_REVIEW_ITEM = "No open Review list item has this ID.";

const AMAZON_BUSY = "An Amazon import or delete is running. Try again when it ends.";
const MAX_CHOICE_LENGTH = 200;

// The filters of GET /api/transactions (spec 07, Transactions page): Account, a date range on the
// posted date, Merchant, Category, type, and month; and a page of at most 200. An empty filter is
// left out. A page after a Transaction needs a limit.
const MAX_TRANSACTION_PAGE = 200;
const TRANSACTION_TYPES = [
  "Spending",
  "Income",
  "Transfer",
  "Saving",
  "Refund",
  "Reimbursement",
] as const;
const transactionFilters = z
  .object({
    account: z.string().max(100).optional(),
    from: z.string().regex(CALENDAR_DATE).optional(),
    to: z.string().regex(CALENDAR_DATE).optional(),
    merchant: z.string().max(200).optional(),
    merchantId: z.string().max(200).optional(),
    category: z
      .string()
      .refine((name) => CATEGORY_NAMES.has(name))
      .optional(),
    type: z.enum(TRANSACTION_TYPES).optional(),
    month: z.string().regex(MONTH).optional(),
    limit: z
      .string()
      .regex(/^\d{1,3}$/)
      .transform(Number)
      .pipe(z.number().min(1).max(MAX_TRANSACTION_PAGE))
      .optional(),
    after: z.string().max(100).optional(),
  })
  .refine((query) => query.after === undefined || query.limit !== undefined);
const TRANSACTION_QUERY_REFUSED = `Write dates as YYYY-MM-DD and a month as YYYY-MM, pick a Category and a type from the lists, and ask for 1 to ${MAX_TRANSACTION_PAGE} Transactions a page. A page after a Transaction needs a limit.`;

function transactionQuery(query: Record<string, string>): TransactionQuery | undefined {
  const given = Object.fromEntries(Object.entries(query).filter(([, value]) => value !== ""));
  const parsed = transactionFilters.safeParse(given);
  if (!parsed.success) return undefined;
  const { account, ...filters } = parsed.data;
  return { ...(account === undefined ? {} : { accountId: account }), ...filters };
}

// The Plaid keys. TOTP is asked only at sign-in (spec 09, Sensitive actions).
const plaidKeysBody = z.object({
  clientId: z.string().trim().regex(PLAID_KEY),
  secret: z.string().trim().regex(PLAID_KEY),
});

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

// A Steady Income figure a Member typed, in whole cents per month, or null to clear it.
const MAX_STEADY_INCOME_CENTS = 10_000_000_000;
const steadyIncomeBody = z
  .object({ typed: z.number().int().min(0).max(MAX_STEADY_INCOME_CENTS).nullable() })
  .strict();

// A Member's Budget (spec 05, Changing Budgets), in whole cents: per month, or per year for a
// yearly Budget.
const MAX_BUDGET_CENTS = 100_000_000_000;
const budgetEditBody = z.object({ amount: z.number().int().min(0).max(MAX_BUDGET_CENTS) }).strict();

const NO_BUDGET = "This Category has no Budget to change.";

// Done on a note in the AI box, or "Done ✓" tapped again to clear the mark.
const noteDoneBody = z.object({ done: z.boolean() }).strict();

// Accept, Skip, and Undo on a Proposal send an empty JSON body.
const emptyBody = z.object({}).strict();

// "Save and accept" on a Proposal (spec 08, Proposals): the Member's Edit of any of a Budget
// change's amounts, in whole cents, a Goal amount, or a new Goal's words. A Member's own edit is not
// bound by the 50% rule.
const proposalEditBody = z
  .object({
    budgets: z
      .record(
        z.string().refine((name) => CATEGORY_NAMES.has(name)),
        z.number().int().min(0).max(MAX_BUDGET_CENTS),
      )
      .optional(),
    goalAmount: z.number().int().min(0).max(MAX_BUDGET_CENTS).optional(),
    words: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((edit) => Object.keys(edit).length > 0);

const NO_OPEN_PROPOSAL = "No open Proposal has this ID.";

// A plan item's place in a Monthly review's plan of exactly 3, as the path writes it.
const planItem = z.enum(["0", "1", "2"]).transform(Number);
const NO_REVIEW = "No Monthly review has this month.";

// A new Chat thread (spec 08, Threads): its first message, the AI box note it asks about, if any,
// and the Member's yes to "Send anyway?" at the AI cost cap. The app reads the note itself.
const chatThreadBody = z
  .object({
    text: z.string().max(20_000),
    note: z
      .object({ kind: z.enum(CHAT_NOTE_KINDS), id: z.string().min(1).max(100) })
      .strict()
      .nullable(),
    sendAnyway: z.boolean(),
  })
  .strict();

// What @ai-sdk/react's useChat sends for an answer: the thread's ID, its messages as the page holds
// them, and why it sends. The app reads only the new message's text from them, and the thread's
// history from app.db. "regenerate-message" answers the thread's last message again: "Try again",
// "Send anyway", or a new thread's first answer.
const chatAnswerBody = z.object({
  id: z.string().min(1).max(100),
  trigger: z.enum(["submit-message", "regenerate-message"]),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        parts: z.array(z.object({ type: z.string(), text: z.unknown().optional() })).max(100),
      }),
    )
    .max(500),
  sendAnyway: z.boolean().optional(),
});

// A Member's mark on a Goal (spec 05, Rules).
const goalStatusBody = z.object({ status: z.enum(["done", "dropped"]) }).strict();

// A Goal's words, as a Member wrote them, and the Member's yes to "Send anyway?" at the AI cost
// cap. The goals module checks the words' length once it has made them one plain line.
const goalWordsBody = z.object({ words: z.string().max(20_000), sendAnyway: z.boolean() }).strict();

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

// A Manual loan (spec 02, Manual loans). Money is whole cents, and the balance is what is owed on
// its date. Escrow is for a mortgage only. A credit card or a line of credit is never one.
const realDate = (date: string) =>
  CALENDAR_DATE.test(date) && new Date(`${date}T00:00:00.000Z`).toISOString().startsWith(date);
const manualLoanBody = z.object({
  lender: z.string().trim().min(1).max(100),
  kind: z.enum(MANUAL_LOAN_KINDS),
  balance: z.number().int().min(0).max(MAX_BALANCE_CENTS),
  balanceDate: z.string().refine(realDate),
  apr: z.number().min(0).max(100),
  regularPayment: z
    .number()
    .int()
    .min(1)
    .max(MAX_BALANCE_CENTS)
    .nullish()
    .transform((amount) => amount ?? null),
  escrow: z
    .number()
    .int()
    .min(0)
    .max(MAX_BALANCE_CENTS)
    .nullish()
    .transform((amount) => amount ?? null),
  loanType: z
    .enum(["cash loan", "purchase loan"])
    .nullish()
    .transform((type) => type ?? null),
});
const MANUAL_LOAN_REFUSED =
  "Enter the lender, the loan type, the balance and its date, and an APR from 0 to 100. Amounts are in dollars and cents.";
const NOT_A_MANUAL_LOAN =
  "A credit card or a line of credit can't be a Manual loan: its balance moves with purchases the app cannot see.";
const ESCROW_REFUSED = "Escrow is for mortgages only.";

// Why the app refuses a Manual loan body, or the loan.
function manualLoanOrRefusal(
  raw: unknown,
): { loan: z.infer<typeof manualLoanBody> } | { error: string } {
  const kind = typeof raw === "object" && raw !== null && "kind" in raw ? raw.kind : undefined;
  if (kind === "credit card" || kind === "line of credit") return { error: NOT_A_MANUAL_LOAN };
  const body = manualLoanBody.safeParse(raw);
  if (!body.success) return { error: MANUAL_LOAN_REFUSED };
  if (body.data.kind !== "mortgage" && body.data.escrow !== null) return { error: ESCROW_REFUSED };
  return { loan: body.data };
}
// The Update check's switch (spec 12, Updates).
const updateCheckBody = z.object({ on: z.boolean() }).strict();

// "Back up now" takes an empty JSON body.
const backUpNowBody = z.object({}).strict();

const BACKUP_FAILURES = {
  "copy failed":
    "The backup failed: the app could not copy its data into the backup folder. Check that the folder has free space and that the app can write to it.",
  "check failed":
    "The backup failed: the copy did not pass its integrity check, so the app deleted it. Try again.",
  "write failed":
    "The backup failed: the app could not write the backup file. Check that the folder has free space and that the app can write to it.",
} as const;

// The weekly Alert cap (spec 06, The weekly cap): any whole number from 0.
const weeklyCapBody = z
  .object({ weeklyCap: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) })
  .strict();

// The types a Member may set by hand.
const transactionTypeBody = z.object({ type: z.enum(HAND_SET_TYPES) });

// A link a Member makes by hand (spec 03, Undo and hand links), by the IDs of its Transactions, or
// of its Transaction and Manual loan.
const ID = z.string().min(1).max(100);
const handLinkBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("Transfer"), outTransactionId: ID, inTransactionId: ID }),
  z.object({
    kind: z.enum(["Refund", "Reimbursement"]),
    transactionId: ID,
    spendingTransactionId: ID,
  }),
  z.object({ kind: z.literal("loan"), transactionId: ID, loanAccountId: ID }),
]);
// A Member's Category for one Transaction. Without "only this Transaction", it also makes a
// Category rule for the Transaction's Merchant (spec 04, Category rules).
const CATEGORY_NAMES = new Set<string>(CATEGORIES.map((category) => category.name));
const transactionCategoryBody = z.object({
  category: z.string().refine((name) => CATEGORY_NAMES.has(name)),
  onlyThisTransaction: z.boolean().optional(),
});

// A report's range and its one filter (spec 07, Reports). With no range, a report covers 12 months.
const CATEGORY_GROUP_NAMES = new Set<string>(CATEGORY_GROUPS.map((group) => group.name));
const reportQuery = z.object({ range: z.enum(REPORT_RANGES).default(DEFAULT_REPORT_RANGE) });
const spendingReportQuery = reportQuery.extend({
  group: z
    .custom<CategoryGroup>((name) => typeof name === "string" && CATEGORY_GROUP_NAMES.has(name))
    .optional(),
});
const balancesReportQuery = reportQuery.extend({ account: z.string().min(1).max(100).optional() });
const merchantsReportQuery = reportQuery.extend({
  merchant: z.string().min(1).max(200).optional(),
});
const REPORT_QUERY_REFUSED =
  'Choose a range of "3m", "12m", "24m" or "all", and a Category group from the list.';

// A split (spec 04, Splits): its parts, in whole cents spent, each with a Category.
const splitBody = z.object({
  parts: z
    .array(
      z.object({
        amount: z.number().int().positive(),
        category: z.string().refine((name) => CATEGORY_NAMES.has(name)),
      }),
    )
    .min(MIN_SPLIT_PARTS)
    .max(MAX_SPLIT_PARTS),
});
const SPLIT_REFUSED = `Split it into ${MIN_SPLIT_PARTS} to ${MAX_SPLIT_PARTS} parts, each with an amount in cents and a Category.`;

// An Account's Exclude switch.
const excludeBody = z.object({ excluded: z.boolean() }).strict();

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

// An API key or gateway token left out keeps the one stored, but only for the same AI provider and
// base URL.
const aiSettingsBody = z.object({
  provider: z.enum(AI_PROVIDERS),
  apiKey: aiSecret.optional(),
  baseUrl: z.string().trim().max(2048).nullable(),
  gatewayToken: aiSecret.nullable().optional(),
  quickModel: modelId,
  writerModel: modelId,
  // Left out, Chat uses the Writer model.
  chatModel: modelId.optional(),
  prices: z
    .object({
      quick: enteredPrice.optional(),
      writer: enteredPrice.optional(),
      chat: enteredPrice.optional(),
    })
    .optional(),
});

// The AI cost cap, in whole cents.
const costCapBody = z.object({ capCents: z.number().int().min(0).max(MAX_COST_CAP_CENTS) });

// The Web lookup's switch (spec 08, AI settings page).
const webLookupBody = z.object({ on: z.boolean() });

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
  "unclear host":
    "The app does not call an address whose destination it cannot judge, such as 0.0.0.0.",
} as const;

// The answer to each save refusal.
const SAVE_REFUSALS = {
  "key needed": { status: 400, error: "Enter the API key." },
  "token needed": { status: 400, error: "Enter the gateway token." },
  changed: {
    status: 409,
    error: "The AI settings changed while the app checked them. Save again.",
  },
} as const;

const TIER_NAMES = { quick: "Quick model", writer: "Writer model", chat: "Chat model" } as const;

// A JSON route takes only JSON bodies, so a form on another site cannot post to it.
function sentJson(c: { req: { header(name: string): string | undefined } }): boolean {
  return c.req.header("content-type")?.split(";")[0]?.trim() === "application/json";
}

// The body as JSON, or undefined when it is not JSON.
async function jsonBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

// A route that takes a JSON body refuses any other content type, so a form on another site cannot
// post to it.
const jsonOnly: MiddlewareHandler<ServerEnv> = async (c, next) => {
  if (c.req.header("content-type")?.split(";")[0]?.trim() !== "application/json") {
    return c.json({ error: "Send JSON." }, 415);
  }
  await next();
};

// A press of "Finish AI work now" or "Run AI on all history", with an empty JSON body. A refusal
// starts no run and makes no AI call.
async function pressAiWork(c: Context<ServerEnv>, kind: AiWorkKind) {
  if (c.var.aiWork === undefined) return c.json({ error: "Not found" }, 404);
  if (!emptyBody.safeParse(await jsonBody(c)).success) {
    return c.json({ error: "Send an empty body." }, 400);
  }
  const pressed = await c.var.aiWork.press(kind);
  if (!pressed.started && pressed.refusal === "retry wait") {
    // The time the AI tries again, in Household time (spec 08, AI work on your Transactions).
    const zone = (await c.var.household.timeZone()) ?? "UTC";
    return c.json({ error: retryWaitRefusal(timeLabel(new Date(pressed.retryAt), zone)) }, 409);
  }
  if (!pressed.started) return c.json({ error: AI_WORK_REFUSALS[pressed.refusal] }, 409);
  return c.json({ work: pressed.work }, 202);
}

// The Member signed in, as Chat stores them on a message: their ID and name, never their email.
const chatMember = (c: Context<ServerEnv>) => ({ id: c.var.member.id, name: c.var.member.name });

// The answer to Accept or "Save and accept" on a Proposal.
function proposalAnswer(c: Context<ServerEnv>, result: ProposalAcceptResult) {
  if (result === undefined) return c.json({ error: NO_OPEN_PROPOSAL }, 404);
  if (result === "not open") return c.json({ error: "This Proposal is closed." }, 409);
  if (typeof result === "object") return c.json({ error: result.refused }, 400);
  return c.json({ accepted: true }, 200);
}

// The range of GET /api/accounts/:id/balances.
function balanceQuery(query: Record<string, string>): BalanceQuery | undefined {
  const { from, to } = query;
  for (const date of [from, to]) {
    if (date !== undefined && !CALENDAR_DATE.test(date)) return undefined;
  }
  return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}

// The Household's SMTP server (spec 06, Recipients and channels). A password left out keeps the one
// stored, but only for the same server and sign-in name.
const DNS_NAME =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const IPV6 = /^(?=.*:)[0-9A-Fa-f:.]{2,45}$/;
const NO_CONTROL = /^[^\p{Cc}]+$/u;
const MAX_PORT = 65_535;
const smtpBody = z
  .object({
    host: z
      .string()
      .trim()
      .refine((host) => DNS_NAME.test(host) || IPV6.test(host)),
    port: z.number().int().min(1).max(MAX_PORT),
    username: z.string().trim().min(1).max(320).regex(NO_CONTROL),
    password: z.string().min(1).max(1000).regex(NO_CONTROL).optional(),
    sender: z.email().max(320),
  })
  .strict();

// "Send a test email" takes an empty JSON body: a write with no body has no JSON content type, and
// secretRoutes answers it 415.
const testEmailBody = z.object({}).strict();

// A Member's edit to a Recurring charge (spec 06, Member edits): a name of 1 to 60 characters, plain
// text, trimmed; a Category; a price band in percent from 0 to 100 in steps of 0.1. Null clears
// one. It names at least one.
const MAX_CHARGE_NAME = 60;
const MAX_PRICE_BAND = 100;
const MAX_PRICE_CHANGE_CENTS = 100_000_000_000;
const inTenths = (percent: number) => Math.abs(percent * 10 - Math.round(percent * 10)) < 1e-9;
const chargeEditBody = z
  .object({
    name: z
      .string()
      .trim()
      .regex(NO_CONTROL)
      .refine((name) => [...name].length <= MAX_CHARGE_NAME)
      .nullable()
      .optional(),
    category: z
      .string()
      .refine((name) => CATEGORY_NAMES.has(name))
      .nullable()
      .optional(),
    priceBand: z.number().min(0).max(MAX_PRICE_BAND).refine(inTenths).nullable().optional(),
  })
  .strict()
  .refine((edits) => Object.keys(edits).length > 0);
const CHARGE_EDIT_REFUSED =
  "Send a name of 1 to 60 characters, a Category, or a price band from 0 to 100% in steps of 0.1.";
// A Member's price change: a new amount in whole cents spent, from a calendar date.
const priceChangeBody = z
  .object({
    fromDate: z.string().refine(realDate),
    amount: z.number().int().min(1).max(MAX_PRICE_CHANGE_CENTS),
  })
  .strict();
const chargeTransactionBody = z.object({ transactionId: z.string().min(1).max(200) }).strict();
// A page of the charges a Member may add: an exact amount in whole cents spent, and the
// Transaction the page before ended with.
const candidateQuery = z
  .object({
    amount: z
      .string()
      .regex(/^[1-9]\d{0,10}$/)
      .refine((amount) => Number(amount) <= MAX_PRICE_CHANGE_CENTS)
      .optional(),
    before: z.string().min(1).max(200).optional(),
  })
  .strict();
const CHARGE_EDIT_ANSWERS = {
  "not found": [404, "No Recurring charge has this ID."],
  "no Transaction": [404, "The Recurring charge has no such Transaction to take or give up."],
  "no price change": [404, "The Recurring charge has no price change with this ID."],
  ended: [409, "This Recurring charge is marked ended, so it does not change."],
  "last Transaction": [409, "A Recurring charge keeps at least one Transaction."],
} as const;

function chargeEditAnswer(c: Context<ServerEnv>, edit: RecurringChargeEditView) {
  if (typeof edit === "string") {
    const [status, error] = CHARGE_EDIT_ANSWERS[edit];
    return c.json({ error }, status);
  }
  return c.json({ charge: edit }, 200);
}

const SMTP_REFUSALS: Record<SmtpRefusal, string> = {
  "password needed": "Enter the SMTP password.",
};

const SEND_PROBLEMS: Record<SendProblem, string> = {
  "not set up": "Save the SMTP server first.",
  "password unreadable":
    "The app cannot read the saved SMTP password. Enter the password again, and save.",
  "sign-in refused": "The SMTP server refused the sign-in name or password.",
  "no answer": "The app could not reach the SMTP server over TLS. Check the host and port.",
  "message refused": "The SMTP server did not take the email. Check the sender address.",
};

// A Member's own channels: push, email, both, or none.
const channelsBody = z.object({ push: z.boolean(), email: z.boolean() }).strict();

// A Member's own weekly summary email switch: on or off, for the signed-in Member only.
const weeklySummaryBody = z.object({ on: z.boolean() }).strict();

// The AI request log's switch and kept days (spec 08, AI request log).
const aiRequestLogBody = z
  .object({
    on: z.boolean(),
    keepDays: z.union(AI_REQUEST_LOG_KEEP_DAYS.map((days) => z.literal(days))),
  })
  .strict();

// A kept call's ID, and the cursor of the log page's next page: the last ID of the page before.
const AI_REQUEST_LOG_ID = /^[1-9]\d{0,14}$/;

// A browser's push subscription (spec 06, Recipients and channels). Its keys are base64url: the
// browser's P-256 public key, 65 bytes, and its auth secret, 16 bytes.
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const keyOf = (bytes: number) =>
  z
    .string()
    .max(200)
    .regex(BASE64URL)
    .refine((key) => Buffer.from(key, "base64url").length === bytes);
const endpointField = z.string().min(1).max(2048);
const subscriptionBody = z
  .object({
    endpoint: endpointField,
    keys: z.object({ p256dh: keyOf(65), auth: keyOf(16) }).strict(),
  })
  .strict();
const endpointBody = z.object({ endpoint: endpointField }).strict();

const DEVICE_REFUSALS: Record<DeviceRefusal, string> = {
  "plain HTTP": "Push needs HTTPS. In plain-HTTP mode, Alerts come by email only.",
  "setup not done": "Finish the first-run wizard first.",
  "unknown push service": "This browser's push service is not one the app sends to.",
  "another Member's device":
    "Alerts are on for another Member in this browser. They turn them off first, in Settings, Alerts.",
};

// The wizard's step 5, Banks, the one step with "Skip for now" (spec 12, The first-run wizard).
const setupStep = z.enum(SKIPPABLE_SETUP_STEPS);

const SETUP_REFUSALS: Record<SetupRefusal, { status: 403 | 409; error: string }> = {
  "setup not done": { status: 409, error: "Finish the first-run wizard's steps 1 to 4 first." },
  "not the first member": {
    status: 403,
    error: "Only the first Member goes through the first-run wizard.",
  },
  "steps left": { status: 409, error: "Link a bank, or skip the Banks step for now, first." },
};

function setupAnswer(c: Context<ServerEnv>, answer: SetupProgressView | SetupRefusal) {
  if (typeof answer === "object") return c.json({ progress: answer }, 200);
  const { status, error } = SETUP_REFUSALS[answer];
  return c.json({ error }, status);
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
  // A Member turns any Account's Exclude switch on or off (spec 02, Exclude). Its own Transactions
  // then count nowhere, and its balance drops out of every balance and total. It still syncs.
  .put("/accounts/:id/exclude", async (c) => {
    if (!sentJson(c)) return c.json({ error: "Send JSON." }, 415);
    const body = excludeBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Say whether to exclude the Account." }, 400);
    const account = await c.var.bank.setExcluded(c.req.param("id"), body.data.excluded);
    if (account === undefined) return c.json({ error: "Not found" }, 404);
    return c.json({ account });
  })
  // The Transactions page's list (spec 07, Transactions page), newest first, with each row's parts.
  // With a limit, one page and the ID to read the next page after.
  .get("/transactions", async (c) => {
    const query = transactionQuery(c.req.query());
    if (query === undefined) return c.json({ error: TRANSACTION_QUERY_REFUSED }, 400);
    const list = await c.var.bank.transactions(query);
    if (list === undefined) return c.json({ error: "No Transaction has the ID after." }, 400);
    return c.json(list);
  })
  // One Transaction, with its parts and how each Category was chosen (spec 04, Provenance), and
  // each link's evidence with the Transaction it matched (spec 03, Evidence).
  .get("/transactions/:id", async (c) => {
    const detail = await c.var.moneyMovement.transaction(c.req.param("id"));
    if (detail === undefined) return c.json({ error: "Not found" }, 404);
    return c.json(detail);
  })
  // A Member sets a Transaction's type by hand (spec 03, Transaction types). It wins over every
  // rule and survives every re-run.
  .put("/transactions/:id/type", jsonOnly, async (c) => {
    const body = transactionTypeBody.safeParse(await jsonBody(c));
    if (!body.success) {
      return c.json({ error: "Pick Spending, Transfer, Income, or Saving." }, 400);
    }
    const decision = await c.var.moneyMovement.setType(c.req.param("id"), body.data.type);
    if (decision === undefined) return c.json({ error: "Not found" }, 404);
    return c.json({ decision }, 200);
  })
  // A Member sets a Transaction's Category by hand. Unless the Member picks "only this
  // Transaction", the app also makes a Category rule for its Merchant (spec 04, Category rules).
  .put("/transactions/:id/category", async (c) => {
    const body = transactionCategoryBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Pick a Category." }, 400);
    const corrected = await c.var.categories.correct(
      c.req.param("id"),
      body.data.category,
      body.data.onlyThisTransaction ?? false,
      c.var.member.id,
    );
    if (corrected === "not found") return c.json({ error: "Not found" }, 404);
    if (corrected === "not decided") {
      return c.json(
        { error: "The app has not decided this Transaction's type yet. Try again soon." },
        409,
      );
    }
    return c.json(corrected, 200);
  })
  // A Member splits a Spending Transaction by amount across Categories, or removes the split (spec
  // 04, Splits). The parts add up to the Transaction's amount.
  .put("/transactions/:id/split", jsonOnly, async (c) => {
    const body = splitBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: SPLIT_REFUSED }, 400);
    const split = await c.var.moneyMovement.split(c.req.param("id"), body.data);
    if (split.outcome === "not found") return c.json({ error: "Not found" }, 404);
    if (split.outcome === "not Spending") {
      return c.json({ error: "Only a Spending Transaction can be split." }, 409);
    }
    if (split.outcome === "wrong total") {
      return c.json({ error: "The parts must add up to the Transaction's amount." }, 400);
    }
    return c.json({ decision: split.decision }, 200);
  })
  .delete("/transactions/:id/split", async (c) => {
    if (!(await c.var.moneyMovement.removeSplit(c.req.param("id")))) {
      return c.json({ error: "No split on a Transaction with this ID." }, 404);
    }
    return c.json({ removed: true }, 200);
  })
  // Settings → Categories: every Category rule, with Delete. Deleting one runs the cascade again on
  // its Merchant's Transactions not set by hand.
  .get("/category-rules", async (c) => c.json({ rules: await c.var.categories.rules() }))
  .delete("/category-rules/:id", async (c) => {
    if (!(await c.var.categories.deleteRule(c.req.param("id")))) {
      return c.json({ error: "No Category rule has this ID." }, 404);
    }
    return c.json({ deleted: true }, 200);
  })
  // Settings → Categories: every remembered one-sided Transfer answer, with Delete. Deleting one
  // sends the one-sided Transfers it decided back through the follow-up job, so they ask again.
  .get("/transfer-answers", async (c) =>
    c.json({ answers: await c.var.moneyMovement.transferAnswers() }),
  )
  .delete("/transfer-answers/:id", async (c) => {
    if (!(await c.var.moneyMovement.deleteTransferAnswer(c.req.param("id")))) {
      return c.json({ error: "No remembered Transfer answer has this ID." }, 404);
    }
    return c.json({ deleted: true }, 200);
  })
  // The Alert list (spec 06, The Alert list), newest first.
  .get("/alerts", async (c) => c.json({ alerts: await c.var.alerts.list() }))
  // "Ask the AI" (spec 06, "Ask the AI"): the Member's Chat thread about this Alert, 201 when new
  // and 200 when it was already there. The route takes only JSON and reads no body: the app reads
  // the Alert itself from its ID. It makes no AI call.
  .post("/alerts/:id/ask-ai", jsonOnly, async (c) => {
    const asked = await c.var.chat.askAboutAlert(chatMember(c), c.req.param("id"));
    if ("threadId" in asked) return c.json({ threadId: asked.threadId }, asked.started ? 201 : 200);
    const { status, ...refused } = asked;
    return c.json(refused, status);
  })
  // "Not a problem" (spec 06): any Member marks an Alert, or one part of a merged Alert, for the
  // whole Household. A Member's second press records nothing. It makes no AI call.
  .post("/alerts/:id/not-a-problem", jsonOnly, async (c) => {
    const notAProblem = await c.var.alerts.notAProblem(c.req.param("id"), c.var.member.id);
    if (notAProblem === undefined) return c.json({ error: "No Alert has this ID." }, 404);
    return c.json({ notAProblem }, 200);
  })
  // Settings, Alerts (spec 06, The weekly cap). Any Member may change the weekly cap.
  .get("/alert-settings", async (c) => c.json(await c.var.alerts.settings()))
  .put("/alert-settings/weekly-cap", async (c) => {
    if (!sentJson(c)) return c.json({ error: "Send JSON." }, 415);
    const body = weeklyCapBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "The weekly cap is a whole number from 0." }, 400);
    return c.json(await c.var.alerts.setWeeklyCap(body.data.weeklyCap), 200);
  })
  // Recurring charges (spec 06), by next expected date.
  .get("/recurring-charges", async (c) => c.json({ charges: await c.var.recurring.list() }))
  // A Member marks a Recurring charge ended. It never comes back by itself.
  .post("/recurring-charges/:id/end", async (c) => {
    const ended = await c.var.recurring.end(c.req.param("id"), c.var.member.id);
    if (ended === undefined) return c.json({ error: "No Recurring charge has this ID." }, 404);
    return c.json({ charge: ended }, 200);
  })
  // A Member's edits (spec 06, Member edits): a name, a Category, a price band, price changes, and
  // the Transactions in it. Each one is kept through every check after.
  .put("/recurring-charges/:id", jsonOnly, async (c) => {
    const body = chargeEditBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: CHARGE_EDIT_REFUSED }, 400);
    return chargeEditAnswer(c, await c.var.recurring.edit(c.req.param("id"), body.data));
  })
  .post("/recurring-charges/:id/price-changes", jsonOnly, async (c) => {
    const body = priceChangeBody.safeParse(await jsonBody(c));
    if (!body.success) {
      return c.json({ error: "Enter a date and an amount in dollars and cents." }, 400);
    }
    return chargeEditAnswer(c, await c.var.recurring.setPriceChange(c.req.param("id"), body.data));
  })
  .delete("/recurring-charges/:id/price-changes/:changeId", async (c) =>
    chargeEditAnswer(
      c,
      await c.var.recurring.deletePriceChange(c.req.param("id"), c.req.param("changeId")),
    ),
  )
  .post("/recurring-charges/:id/transactions", jsonOnly, async (c) => {
    const body = chargeTransactionBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Send a Transaction ID." }, 400);
    return chargeEditAnswer(
      c,
      await c.var.recurring.addTransaction(c.req.param("id"), body.data.transactionId),
    );
  })
  .delete("/recurring-charges/:id/transactions/:transactionId", async (c) =>
    chargeEditAnswer(
      c,
      await c.var.recurring.removeTransaction(c.req.param("id"), c.req.param("transactionId")),
    ),
  )
  // The Merchant's posted Spending a Member may add: those a Member removed first, then a page of
  // 50, newest first, at `amount` in whole cents spent, and older than the Transaction `before`.
  .get("/recurring-charges/:id/candidates", async (c) => {
    const query = candidateQuery.safeParse(c.req.query());
    if (!query.success) {
      return c.json(
        { error: "Ask for an amount in whole cents, and the page before a charge." },
        400,
      );
    }
    const { amount, before } = query.data;
    const page = await c.var.recurring.candidates(c.req.param("id"), {
      ...(amount === undefined ? {} : { amount: Number(amount) }),
      ...(before === undefined ? {} : { before }),
    });
    if (page === undefined) return c.json({ error: "No Recurring charge has this ID." }, 404);
    if (page === "no Transaction") {
      return c.json(
        { error: "The page before must start from one of the Merchant's charges." },
        404,
      );
    }
    return c.json(page, 200);
  })
  // Steady Income (spec 05): the detected figure, and the one a Member typed in Settings,
  // Household, which replaces it until a Member clears it with null.
  .get("/steady-income", async (c) =>
    c.json({ steadyIncome: await c.var.recurring.steadyIncome() }),
  )
  .put("/steady-income", async (c) => {
    const body = steadyIncomeBody.safeParse(await jsonBody(c));
    if (!body.success) {
      return c.json({ error: "Enter Steady Income in dollars and cents per month." }, 400);
    }
    const typed = await c.var.recurring.typeSteadyIncome(body.data.typed, c.var.member.id);
    return c.json({ steadyIncome: typed }, 200);
  })
  // Each counted Income series' next payday, at its latest amount, by date.
  .get("/paydays", async (c) => c.json({ paydays: await c.var.recurring.paydays() }))
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
  // A Member links Transactions by hand, of any kind (spec 03, Undo and hand links). Re-matching
  // never breaks it.
  .post("/links", jsonOnly, async (c) => {
    const body = handLinkBody.safeParse(await jsonBody(c));
    if (!body.success) {
      return c.json({ error: "Name the link's kind and the IDs of what it links." }, 400);
    }
    const linked = await c.var.moneyMovement.link(body.data, c.var.member.id);
    if (linked.outcome === "not found") return c.json({ error: "Not found" }, 404);
    if (linked.outcome === "refused") return c.json({ error: linked.reason }, 400);
    return c.json({ linkId: linked.linkId }, 200);
  })
  // A Member undoes any link. The app never makes that same link again.
  .delete("/links/:id", async (c) => {
    if (!(await c.var.moneyMovement.undoLink(c.req.param("id"), c.var.member.id))) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json({ undone: true }, 200);
  })
  // Spending, Income, and Saving by month, by Category, and by Category group. Posted Transactions
  // only.
  .get("/totals", async (c) => c.json({ months: await c.var.moneyMovement.totals() }))
  // The dashboard's four number tiles (spec 07, 4. Number tiles), on the Household's date.
  .get("/number-tiles", async (c) => c.json(await c.var.bank.numberTiles()))
  // "Coming up" (spec 07, 6. Coming up): what is due in the next 14 days, Household time.
  .get("/coming-up", async (c) => c.json(await c.var.comingUp.view()))
  // Top Merchants (spec 07, Top Merchants): Merchants ranked by Spending, "This month" or "Last 12
  // months", Household time.
  .get("/top-merchants", async (c) => {
    const period = z.enum(TOP_MERCHANT_PERIODS).safeParse(c.req.query("period"));
    if (!period.success) {
      return c.json({ error: 'Choose "This month" or "Last 12 months".' }, 400);
    }
    return c.json(await c.var.topMerchants.view(period.data), 200);
  })
  // The Reports page (spec 07, Reports): read-only, over the months of a range. Each route checks
  // its range and its filter. The reports themselves come in R1 to R3.
  // Spending over time, for every Category group or one.
  .get("/reports/spending", async (c) => {
    const query = spendingReportQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ error: REPORT_QUERY_REFUSED }, 400);
    return c.json(await c.var.reports.spending(query.data), 200);
  })
  // Cash flow: Income, Spending and Saving by month.
  .get("/reports/cash-flow", async (c) => {
    const query = reportQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ error: REPORT_QUERY_REFUSED }, 400);
    return c.json(await c.var.reports.cashFlow(query.data), 200);
  })
  // Balances and total Debt over time, for every Account or one.
  .get("/reports/balances", async (c) => {
    const query = balancesReportQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ error: REPORT_QUERY_REFUSED }, 400);
    const report = await c.var.reports.balances(query.data);
    if (report === undefined) return c.json({ error: "Not found" }, 404);
    return c.json(report, 200);
  })
  // Spending at the top Merchants, or at one. A Merchant key that names no Merchant group gets an
  // empty series.
  .get("/reports/merchants", async (c) => {
    const query = merchantsReportQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ error: REPORT_QUERY_REFUSED }, 400);
    return c.json(await c.var.reports.merchants(query.data), 200);
  })
  // Recurring charges over time.
  .get("/reports/recurring", async (c) => {
    const query = reportQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ error: REPORT_QUERY_REFUSED }, 400);
    return c.json(await c.var.reports.recurring(query.data), 200);
  })
  // The AI box, "This week" (spec 07, 1. AI box): every current note, in three groups.
  .get("/ai-box", async (c) => c.json(await c.var.aiBox.view()))
  // Done on an Alert note marks it for every Member; {"done": false} clears the mark. It makes no
  // AI call.
  .put("/ai-box/alert-notes/:id/done", jsonOnly, async (c) => {
    const body = noteDoneBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Send done as true or false." }, 400);
    const { done } = body.data;
    if (!(await c.var.aiBox.markAlertNote(c.req.param("id"), c.var.member.id, done))) {
      return c.json({ error: "No Alert note in the AI box has this ID." }, 404);
    }
    return c.json({ done }, 200);
  })
  // Done on an Insight card marks it for every Member; {"done": false} clears the mark. It makes no
  // AI call: the next Insight card run reads it as feedback.
  .put("/ai-box/insight-cards/:id/done", jsonOnly, async (c) => {
    const body = noteDoneBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Send done as true or false." }, 400);
    const { done } = body.data;
    if (!(await c.var.aiBox.markInsightCard(c.req.param("id"), c.var.member.id, done))) {
      return c.json({ error: "No Insight card in the AI box has this ID." }, 404);
    }
    return c.json({ done }, 200);
  })
  // Accept on a Proposal (spec 08, Lifecycle): it applies the change, and records the Member and
  // the time. It makes no AI call.
  .post("/proposals/:id/accept", jsonOnly, async (c) => {
    if (!emptyBody.safeParse(await jsonBody(c)).success) {
      return c.json({ error: "Send an empty JSON body." }, 400);
    }
    return proposalAnswer(c, await c.var.proposals.accept(c.req.param("id"), c.var.member.id));
  })
  // "Save and accept" after Edit: the Member's own amounts or words, then Accept.
  .post("/proposals/:id/edit", jsonOnly, async (c) => {
    const body = proposalEditBody.safeParse(await jsonBody(c));
    if (!body.success) {
      return c.json({ error: "Enter each amount in dollars and cents, or the Goal's words." }, 400);
    }
    const edit = Object.fromEntries(
      Object.entries(body.data).filter(([, value]) => value !== undefined),
    );
    return proposalAnswer(
      c,
      await c.var.proposals.accept(c.req.param("id"), c.var.member.id, edit),
    );
  })
  // Skip closes the Proposal, and nothing changes. It makes no AI call.
  .post("/proposals/:id/skip", jsonOnly, async (c) => {
    if (!emptyBody.safeParse(await jsonBody(c)).success) {
      return c.json({ error: "Send an empty JSON body." }, 400);
    }
    if (!(await c.var.proposals.skip(c.req.param("id"), c.var.member.id))) {
      return c.json({ error: NO_OPEN_PROPOSAL }, 404);
    }
    return c.json({ skipped: true }, 200);
  })
  // The accepted Proposals whose Undo is still offered, and Undo on one of them.
  .get("/proposals/undoable", async (c) => c.json({ proposals: await c.var.proposals.undoable() }))
  .post("/proposals/:id/undo", jsonOnly, async (c) => {
    if (!emptyBody.safeParse(await jsonBody(c)).success) {
      return c.json({ error: "Send an empty JSON body." }, 400);
    }
    const undone = await c.var.proposals.undo(c.req.param("id"), c.var.member.id);
    if (undone === "not found") return c.json({ error: "No Proposal has this ID." }, 404);
    if (undone === "already undone") {
      return c.json({ error: "This change is already undone." }, 409);
    }
    if (undone === "not offered") {
      return c.json({ error: "A later change touched the same Budget or Goal." }, 409);
    }
    return c.json({ undone: true }, 200);
  })
  // Chat (spec 08, Chat; spec 07, Chat page): whether it can answer now, and every thread, newest
  // first by last message. Every Member sees every thread.
  .get("/chat", async (c) =>
    c.json({ status: await c.var.chat.status(), threads: await c.var.chat.threads() }),
  )
  .get("/chat/threads/:id", async (c) => {
    const thread = await c.var.chat.thread(chatMember(c), c.req.param("id"));
    if (thread === undefined) return c.json({ error: "No Chat thread has this ID." }, 404);
    return c.json(thread, 200);
  })
  // A new thread with its first message. Nothing goes to the AI here: its answer comes from
  .post("/chat/threads", jsonOnly, async (c) => {
    const body = chatThreadBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Type a message." }, 400);
    const started = await c.var.chat.start(chatMember(c), body.data);
    if ("threadId" in started) return c.json(started, 201);
    const { status, ...refused } = started;
    return c.json(refused, status);
  })
  // Any Member can delete any thread, with its messages. Its Proposals stay in the AI box.
  .delete("/chat/threads/:id", async (c) => {
    if (!(await c.var.chat.remove(c.req.param("id")))) {
      return c.json({ error: "No Chat thread has this ID." }, 404);
    }
    return c.json({ deleted: true }, 200);
  })
  // The answer, streamed as the AI writes it (spec 08, Answers). With "submit-message", the new
  // message is the last one sent, a Member's text; the app stores it first.
  .post("/chat", jsonOnly, async (c) => {
    const body = chatAnswerBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Type a message." }, 400);
    const { id, trigger, messages, sendAnyway = false } = body.data;
    let text: string | null = null;
    if (trigger === "submit-message") {
      const last = messages.at(-1);
      const parts = last?.role === "user" ? last.parts : [];
      text = parts.map((part) => (part.type === "text" ? String(part.text ?? "") : "")).join("");
    }
    const answered = await c.var.chat.answer(chatMember(c), id, { text, sendAnyway });
    if (answered instanceof Response) return answered;
    const { status, ...refused } = answered;
    return c.json(refused, status);
  })
  // `fakeBank` is true only when the fake adapter runs, as under `pnpm dev`.
  .get("/connections", async (c) =>
    c.json({ connections: await c.var.bank.connections(), fakeBank: c.var.bank.fakeBank() }),
  )
  // Progress per Connection while its history loads (spec 02, First history load).
  .get("/history-status", async (c) => c.json(await c.var.bank.historyStatus()))
  // Retry on the notice of a stopped First run or bank-added-later job (spec 08, When AI does not
  // run): any Member starts it again, with its restart count reset.
  .post("/history-jobs/retry", async (c) => c.json(await c.var.bank.retryHistoryJobs()))
  // Sync now: any Member syncs every Healthy or Retrying Connection (spec 02, Sync now).
  .post("/sync-now", async (c) => c.json({ connections: await c.var.bank.syncNow() }))
  // Removing a Connection takes an empty JSON body. The Accounts become Closed, and their history
  // stays.
  .post("/connections/:id/remove", async (c) => {
    if (!emptyBody.safeParse(await jsonBody(c)).success) {
      return c.json({ error: "Send an empty body." }, 400);
    }
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
  // Manual loans: any Member adds and edits one at any time (spec 02, Manual loans).
  .get("/manual-loans", async (c) => c.json({ loans: await c.var.moneyMovement.manualLoans() }))
  .post("/manual-loans", jsonOnly, async (c) => {
    const body = manualLoanOrRefusal(await jsonBody(c));
    if ("error" in body) return c.json({ error: body.error }, 400);
    const loan = await c.var.moneyMovement.addManualLoan(body.loan, c.var.member.id);
    return c.json({ loan }, 200);
  })
  .put("/manual-loans/:id", jsonOnly, async (c) => {
    const body = manualLoanOrRefusal(await jsonBody(c));
    if ("error" in body) return c.json({ error: body.error }, 400);
    const loan = await c.var.moneyMovement.editManualLoan(
      c.req.param("id"),
      body.loan,
      c.var.member.id,
    );
    if (loan === undefined) return c.json({ error: "Not found" }, 404);
    return c.json({ loan }, 200);
  })
  // The Plaid secret is never in an answer: only whether it is set.
  .get("/plaid/settings", async (c) => c.json({ plaid: await c.var.plaid.view() }))
  .post("/plaid/keys", async (c) => {
    const body = plaidKeysBody.safeParse(await jsonBody(c));
    if (!body.success) {
      return c.json({ error: "Enter the client ID and the Production secret." }, 400);
    }
    const { clientId, secret } = body.data;
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
  // The wizard's step 3 (spec 12): the Master key on each visit, until the Member says they saved
  // it.
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
  // Step 3's "I saved it". The app asks for no paste-back: the key is never sent back to it here.
  .post("/setup/master-key", jsonOnly, async (c) => {
    if (!emptyBody.safeParse(await jsonBody(c)).success) {
      return c.json({ error: "Send an empty body." }, 400);
    }
    await c.var.masterKey.confirmSaved();
    return c.json({ saved: true }, 200);
  })
  // The wizard's steps 5 and 6 (spec 12): the step it opens for the signed-in Member, and the
  // dashboard's "Finish setup" list (spec 07, Header and status lines).
  .get("/setup/progress", async (c) =>
    c.json({ progress: await c.var.setup.progress(c.var.member.id) }),
  )
  // "Skip for now" on step 5, Banks.
  .post("/setup/steps/:step/skip", jsonOnly, async (c) => {
    const step = setupStep.safeParse(c.req.param("step"));
    if (!step.success) return c.json({ error: "Not found" }, 404);
    if (!emptyBody.safeParse(await jsonBody(c)).success) {
      return c.json({ error: "Send an empty body." }, 400);
    }
    return setupAnswer(c, await c.var.setup.skip(c.var.member.id, step.data));
  })
  // Step 6's "Open the dashboard".
  .post("/setup/finish", jsonOnly, async (c) => {
    if (!emptyBody.safeParse(await jsonBody(c)).success) {
      return c.json({ error: "Send an empty body." }, 400);
    }
    return setupAnswer(c, await c.var.setup.finish(c.var.member.id));
  })
  // "Check my Master key" in Settings, Backups and data (spec 09).
  .get("/master-key/check", async (c) => c.json({ lastCheck: await c.var.masterKey.lastCheck() }))
  .post("/master-key/check", async (c) => {
    const pasted = await pastedKey(c);
    if (pasted === undefined) return c.json({ error: NO_KEY }, 400);
    return checkAnswer(c, await c.var.masterKey.check(c.var.member.id, pasted));
  })
  // The Household facts: the wizard's step 4, and Settings, Household (spec 05, Household facts).
  .get("/household", async (c) => c.json({ facts: await c.var.household.facts() }))
  // The Household time zone alone, with no ZIP code or ages, for the pages that show times.
  .get("/household/time-zone", async (c) => c.json({ timeZone: await c.var.household.timeZone() }))
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
  // Settings, About (spec 07, Settings overview): the version, the Source code link, the Update
  // check, and the Data sources page's CPI date. Any Member may turn the Update check off.
  .get("/about", async (c) => c.json(await c.var.about.about()))
  .put("/about/update-check", async (c) => {
    if (!sentJson(c)) return c.json({ error: "Send JSON." }, 415);
    const body = updateCheckBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Say whether to check for updates." }, 400);
    return c.json({ updateCheck: await c.var.about.switchUpdateCheck(body.data.on) }, 200);
  })
  // Settings, Backups and data (spec 11): the backup folder, the last backup, the number of files
  // and their size, and "Back up now" for any Member, with its result.
  .get("/backups", async (c) => c.json({ backups: await c.var.backups.status() }))
  .post("/backups/now", jsonOnly, async (c) => {
    if (!backUpNowBody.safeParse(await jsonBody(c)).success) {
      return c.json({ error: "Send an empty body." }, 400);
    }
    const result = await c.var.backups.backUpNow();
    const backups = await c.var.backups.status();
    if (!result.ok) return c.json({ error: BACKUP_FAILURES[result.failure], backups }, 500);
    return c.json({ backup: { file: result.file, at: result.at }, backups }, 200);
  })
  // "Download my data" (spec 11, Data export): any Member, with an empty JSON body. The ZIP is not
  // encrypted, and streams as it is written.
  .post("/export", jsonOnly, async (c) => {
    if (!emptyBody.safeParse(await jsonBody(c)).success) {
      return c.json({ error: "Send an empty body." }, 400);
    }
    const { fileName, stream } = await c.var.dataExport.download();
    return c.body(stream, 200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    });
  })
  // Settings, Store orders (spec 14, The Store orders page in Settings): the Amazon card's last
  // import, its counts, and the link counts.
  .get("/amazon", async (c) => c.json(await c.var.amazon.status(), 200))
  // An upload of Amazon's ZIP file, or the order file inside it, as the raw body: no form, so the
  // body is read once, with its own 50 MB limit, and no page on another site can post it as a form.
  // One import or delete runs at a time.
  .post("/amazon/import", async (c) => {
    const kind = amazonUploadKind(c.req.header("content-type"));
    if (kind === undefined) {
      return c.json({ error: "Send Amazon's ZIP file, or the CSV file inside it." }, 415);
    }
    const result = await c.var.amazon.importFile(
      kind,
      () => readAmazonUpload(c.req.raw),
      c.var.member.id,
    );
    switch (result.outcome) {
      case "imported":
        return c.json({ import: result.import, status: result.status }, 200);
      case "refused":
        return c.json({ error: result.reason }, 400);
      case "too large":
        return c.json({ error: "The file is larger than 50 MB." }, 413);
      case "busy":
        return c.json({ error: AMAZON_BUSY }, 409);
    }
  })
  // "Delete all Amazon data": every Line item, link, and Item rule. Each Transaction that had Line
  // items goes back to the cascade.
  .delete("/amazon", async (c) => {
    const result = await c.var.amazon.deleteAll();
    if (result.outcome === "busy") return c.json({ error: AMAZON_BUSY }, 409);
    return c.json({ status: result.status }, 200);
  })
  // A Line item's Category and Item rules (spec 14, Item rules).
  .route("/", lineItemCategoryApi)
  // The Line items linked to a Transaction, for its detail view (spec 14, Pages).
  .get("/transactions/:id/line-items", async (c) =>
    c.json({ lineItems: await c.var.amazon.lineItemsOf(c.req.param("id")) }, 200),
  )
  // A Transaction's Amazon links: the shipments to link by hand, the hand link, and Undo.
  .route("/", amazonLinkApi)
  // Settings, Price sources (spec 15): the deal finder's keys, Stores, and its data.
  .route("/", priceSourcesApi)
  // The Shopping list page (spec 15), and Undo on a Shopping list change's card in Chat.
  .route("/", shoppingListApi)
  // Settings, Members (spec 09, Members; Invites): every Member and the open invite links.
  .get("/members", async (c) => c.json(await c.var.members.members(c.var.member.id)))
  // "Make an invite link": any Member, with an empty JSON body. The answer holds the link once; the
  // app keeps its hash.
  .post("/invites", jsonOnly, async (c) => {
    if (!emptyBody.safeParse(await jsonBody(c)).success) {
      return c.json({ error: "Send an empty body." }, 400);
    }
    const made = await c.var.members.makeInvite(c.var.member.id);
    if (made === "wizard not done") {
      return c.json({ error: "Finish the first-run wizard first." }, 409);
    }
    // The "Finish setup" item for Invite Members is done once an invite link is made.
    await c.var.setup.done("invite members");
    c.header("Cache-Control", "no-store");
    return c.json({ invite: made }, 200);
  })
  // Cancel on an open invite link.
  .post("/invites/:id/cancel", jsonOnly, async (c) => {
    if (!emptyBody.safeParse(await jsonBody(c)).success) {
      return c.json({ error: "Send an empty body." }, 400);
    }
    if (!(await c.var.members.cancelInvite(c.req.param("id")))) {
      return c.json({ error: "No open invite link has this ID." }, 404);
    }
    return c.json({ cancelled: true }, 200);
  })
  // "Remove": any Member removes any Member, themselves included, with an empty JSON body. The app
  // refuses to remove the last Member.
  .post("/members/:id/remove", jsonOnly, async (c) => {
    if (!emptyBody.safeParse(await jsonBody(c)).success) {
      return c.json({ error: "Send an empty body." }, 400);
    }
    const id = c.req.param("id");
    const removed = await c.var.members.remove(id);
    if (removed === "no such Member") return c.json({ error: "No Member has this ID." }, 404);
    if (removed === "last Member") {
      return c.json({ error: "The app cannot remove the last Member." }, 409);
    }
    return c.json({ removed: true, you: id === c.var.member.id }, 200);
  })
  // "Reset login": any Member resets another Member's login, with an empty JSON body. The answer
  // holds the reset link once; the app keeps its hash. A Member changes their own login in My login.
  .post("/members/:id/reset-login", jsonOnly, async (c) => {
    if (!emptyBody.safeParse(await jsonBody(c)).success) {
      return c.json({ error: "Send an empty body." }, 400);
    }
    const id = c.req.param("id");
    if (id === c.var.member.id) {
      return c.json({ error: "Change your own login in Settings, My login." }, 409);
    }
    const reset = await c.var.members.resetLogin(id);
    if (reset === "no such Member") return c.json({ error: "No Member has this ID." }, 404);
    c.header("Cache-Control", "no-store");
    return c.json({ reset }, 200);
  })
  // Settings, My login, Signed-in devices (spec 09): the signed-in Member's own sessions that have
  // not expired. Each row has a name made from its user agent, never the user agent or the IP
  // address.
  .get("/my-login/devices", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ devices: await c.var.devices.devices(c.var.member.id, c.var.sessionId) });
  })
  // "Sign out" on another device, with an empty JSON body. Another Member's session, an expired
  // one, and an unknown ID get the same answer, so it does not show that a session exists.
  .post("/my-login/devices/:id/sign-out", jsonOnly, async (c) => {
    if (!emptyBody.safeParse(await jsonBody(c)).success) {
      return c.json({ error: "Send an empty body." }, 400);
    }
    const { id: memberId } = c.var.member;
    const result = await c.var.devices.signOut(memberId, c.var.sessionId, c.req.param("id"));
    if (result === "this device") {
      return c.json({ error: "Sign this device out with Sign out." }, 409);
    }
    if (result === "already signed out") {
      return c.json({ error: "That device is already signed out." }, 404);
    }
    return c.json({ signedOut: true }, 200);
  })
  // "Sign out everywhere else", with an empty JSON body. This device stays signed in.
  .post("/my-login/sign-out-other-devices", jsonOnly, async (c) => {
    if (!emptyBody.safeParse(await jsonBody(c)).success) {
      return c.json({ error: "Send an empty body." }, 400);
    }
    await c.var.devices.signOutOthers(c.var.member.id, c.var.sessionId);
    return c.json({ signedOut: true }, 200);
  })
  // Each Category's Benchmark and role (spec 05, Benchmarks), with the sample label while the
  // snapshot is the sample.
  .get("/benchmarks", async (c) => c.json(await c.var.benchmarks.benchmarks()))
  // Each Category's Budget for a month (spec 05, Stored Budgets), with the sample label while the
  // Benchmarks behind the drafted amounts are the sample.
  .get("/budgets", async (c) => {
    const month = c.req.query("month");
    if (month === undefined || !MONTH.test(month)) {
      return c.json({ error: "Write the month as YYYY-MM." }, 400);
    }
    return c.json(await c.var.budgets.budgets(month));
  })
  // "A usual month" on the dashboard (spec 07, 5. "A usual month"): each Category group's
  // Spending and Budget in the 12 complete months before the month and in the month so far.
  .get("/usual-month", async (c) => {
    const month = c.req.query("month");
    if (month === undefined || !MONTH.test(month)) {
      return c.json({ error: "Write the month as YYYY-MM." }, 400);
    }
    return c.json(await c.var.budgets.usualMonth(month));
  })
  // A picture from the picture menu (spec 08, Picture menu), drawn for a month from app.db. A
  // choice the data does not bear out, such as an unknown Category, answers no picture.
  .get("/picture", async (c) => {
    const month = c.req.query("month");
    if (month === undefined || !MONTH.test(month)) {
      return c.json({ error: "Write the month as YYYY-MM." }, 400);
    }
    // Only the fields the query holds: a choice takes no field its type does not use.
    const category = c.req.query("category");
    const merchants = c.req.queries("merchant");
    const choice = pictureChoice.safeParse({
      type: c.req.query("type"),
      ...(category === undefined ? {} : { category }),
      ...(merchants === undefined ? {} : { merchants }),
    });
    if (!choice.success) return c.json({ error: "Choose a picture from the menu." }, 400);
    return c.json({ picture: await c.var.pictures.draw(choice.data, month) });
  })
  // A Member's edit of any Budget (spec 05, Changing Budgets): it takes effect this month, or for a
  // yearly Budget the whole current year. An edited Bills Budget is pinned. A Category with no
  // Budget gets its first one this way.
  .put("/budgets/:category", jsonOnly, async (c) => {
    const body = budgetEditBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Enter the Budget in dollars and cents." }, 400);
    const budget = await c.var.budgets.edit(
      c.req.param("category"),
      body.data.amount,
      c.var.member.id,
    );
    if (budget === undefined) return c.json({ error: NO_BUDGET }, 404);
    return c.json({ budget }, 200);
  })
  // "Follow the bill" puts a pinned Bills Budget back on the formula from the next month.
  .post("/budgets/:category/follow-the-bill", jsonOnly, async (c) => {
    const result = await c.var.budgets.followTheBill(c.req.param("category"), c.var.member.id);
    if (result === "no Budget") return c.json({ error: NO_BUDGET }, 404);
    if (result === "not pinned") {
      return c.json({ error: "Only a pinned Bills Budget can follow the bill." }, 409);
    }
    return c.json({ budget: result }, 200);
  })
  // "Accept all" accepts the whole draft with one click (spec 05, When the app drafts).
  .post("/budgets/accept-all", jsonOnly, async (c) => {
    const accepted = await c.var.budgets.acceptAll(c.var.member.id);
    if (accepted === undefined) return c.json({ error: "There is no draft to accept yet." }, 404);
    return c.json({ accepted }, 200);
  })
  // Every Goal with its progress (spec 05, Goals): the active Goals first, then the done list, then
  // the dropped list. With no AI provider, the pages say that Goals need one.
  .get("/goals", async (c) =>
    c.json({
      goals: await c.var.goals.list(),
      aiProvider: await c.var.goals.aiProvider(),
      waitsForHistory: await c.var.goals.waitsForHistory(),
    }),
  )
  // "Add a Goal" (spec 05, Rules): one Quick-tier call reads the words, then the Goal is stored
  // with its reading, and its Budget tailoring run makes its Proposals.
  .post("/goals", jsonOnly, async (c) => {
    const body = goalWordsBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Write the Goal in your own words." }, 400);
    const saved = await c.var.goals.save(c.var.member.id, { goalId: null, ...body.data });
    if ("goal" in saved) return c.json(saved, 200);
    const { status, ...refusal } = saved;
    return c.json(refusal, status);
  })
  // "Edit the words" of an active Goal: the AI reads the new words, as for a new Goal.
  .post("/goals/:id/words", jsonOnly, async (c) => {
    const body = goalWordsBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Write the Goal in your own words." }, 400);
    const goalId = c.req.param("id");
    const saved = await c.var.goals.save(c.var.member.id, { goalId, ...body.data });
    if ("goal" in saved) return c.json(saved, 200);
    const { status, ...refusal } = saved;
    return c.json(refusal, status);
  })
  // A Member marks an active Goal done or dropped.
  .post("/goals/:id/status", jsonOnly, async (c) => {
    const body = goalStatusBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Mark the Goal done or dropped." }, 400);
    const goal = await c.var.goals.mark(c.req.param("id"), body.data.status, c.var.member.id);
    if (goal === undefined) return c.json({ error: "No Goal has this ID." }, 404);
    if (goal === "not active") {
      return c.json({ error: "Only an active Goal can be marked done or dropped." }, 409);
    }
    return c.json({ goal }, 200);
  })
  // The Reviews page (spec 07, Reviews page): the past Monthly reviews, newest first, and one
  // month's review as it was written. Reading one makes no AI call and writes nothing.
  .get("/monthly-reviews", async (c) => c.json(await c.var.monthlyReviews.list()))
  .get("/monthly-reviews/:month", async (c) => {
    const review = await c.var.monthlyReviews.view(c.req.param("month"));
    if (review === undefined) return c.json({ error: NO_REVIEW }, 404);
    return c.json(review, 200);
  })
  // A tick on a plan item, for every Member; {"done": false} clears it. Ticks are stored apart
  // from the review, which never changes.
  .put("/monthly-reviews/:month/plan/:item", jsonOnly, async (c) => {
    const item = planItem.safeParse(c.req.param("item"));
    const body = noteDoneBody.safeParse(await jsonBody(c));
    if (!item.success || !body.success) {
      return c.json({ error: "Tick plan item 0, 1, or 2 with done as true or false." }, 400);
    }
    const { done } = body.data;
    const month = c.req.param("month");
    if (!(await c.var.monthlyReviews.tick(month, item.data, c.var.member.id, done))) {
      return c.json({ error: NO_REVIEW }, 404);
    }
    return c.json({ done }, 200);
  })
  // Done on the review link in the AI box marks it for every Member, and it leaves the box.
  .put("/ai-box/review-links/:month/done", jsonOnly, async (c) => {
    const body = noteDoneBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Send done as true or false." }, 400);
    const { done } = body.data;
    if (!(await c.var.aiBox.markReviewLink(c.req.param("month"), c.var.member.id, done))) {
      return c.json({ error: "No review link in the AI box has this month." }, 404);
    }
    return c.json({ done }, 200);
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
  .post("/review-list/:id/answer", jsonOnly, async (c) => {
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
    const fields = body.data;
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
    const saved = await c.var.ai.save({ ...fields, baseUrl });
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
  // "Test the key" (spec 08, Test the key): one call to the saved Quick model, with the result. A
  // rate limit or an AI error is a result, not a failed request. The key is never in an answer.
  .post("/ai/test", async (c) => {
    if (!emptyBody.safeParse(await jsonBody(c)).success) {
      return c.json({ error: "Send an empty body." }, 400);
    }
    const test = await c.var.ai.testKey();
    if (test.tested) return c.json({ result: test.result, ai: test.ai }, 200);
    switch (test.refusal) {
      case "busy":
        return c.json({ error: "A test of the key is running. Wait for its answer." }, 409);
      case "too soon":
        c.header("Retry-After", String(test.waitSeconds));
        return c.json(
          {
            error: `Wait ${test.waitSeconds} ${test.waitSeconds === 1 ? "second" : "seconds"}, then test the key again.`,
          },
          429,
        );
      case "key unreadable":
        return c.json(
          { error: "The app cannot read the saved key. Enter it again, then save." },
          409,
        );
      case "token unreadable":
        return c.json(
          { error: "The app cannot read the saved gateway token. Enter it again, then save." },
          409,
        );
      case "price needed":
        return c.json(
          { error: "The app has no price for the Quick model. Enter its prices, then save." },
          409,
        );
      case "changed":
        return c.json(
          { error: "The AI settings changed during the test. Test again.", ai: test.ai },
          409,
        );
    }
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
  })
  // The Web lookup's switch: on or off for the Household. Turning it off stops new lookups and the
  // use of kept answers (spec 04, Web lookup).
  .put("/ai/web-lookup", async (c) => {
    const body = webLookupBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Turn the Web lookup on or off." }, 400);
    const ai = await c.var.ai.setWebLookup(body.data.on);
    if (ai === undefined) return c.json({ error: "Set up an AI provider first." }, 409);
    return c.json({ ai }, 200);
  })
  // AI work on your Transactions (spec 08): the status line, "Finish AI work now", and "Run AI on
  // all history". Reading the line and a refused press make no AI call. A press answers 202: its
  // run goes on in a job, and the page reads the line again.
  .get("/ai/work", async (c) => {
    if (c.var.aiWork === undefined) return c.json({ error: "Not found" }, 404);
    return c.json({ work: await c.var.aiWork.view() }, 200);
  })
  .post("/ai/work/finish", (c) => pressAiWork(c, "finish"))
  .post("/ai/work/all-history", (c) => pressAiWork(c, "all history"))
  // The live AI status (spec 08, Live AI status): server-sent events of the background AI work.
  .get("/ai/activity/stream", aiActivityStream)
  // The AI request log (spec 08, AI request log): its switch and kept days, and a page of kept
  // calls, newest first, older than the call `before` when given. Any Member may read and change it.
  .get("/ai-request-log", async (c) => {
    const before = c.req.query("before");
    if (before !== undefined && !AI_REQUEST_LOG_ID.test(before)) {
      return c.json({ error: "Ask for the page before a kept call's ID." }, 400);
    }
    const page = await c.var.aiRequestLog.page(
      before === undefined ? {} : { before: Number(before) },
    );
    return c.json({ log: page });
  })
  // The switch and the kept days alone. Before the kept call's route, which would take "settings"
  // for an ID.
  .get("/ai-request-log/settings", async (c) =>
    c.json({ settings: await c.var.aiRequestLog.settings() }),
  )
  // One kept call's request and reply.
  .get("/ai-request-log/:id", async (c) => {
    const id = c.req.param("id");
    const entry = AI_REQUEST_LOG_ID.test(id)
      ? await c.var.aiRequestLog.entry(Number(id))
      : undefined;
    if (entry === undefined) return c.json({ error: "No kept AI request has this ID." }, 404);
    return c.json({ entry });
  })
  // Off deletes every kept text. Fewer kept days deletes the text older than them at once.
  .put("/ai-request-log/settings", async (c) => {
    const body = aiRequestLogBody.safeParse(await jsonBody(c));
    if (!body.success) {
      return c.json(
        { error: "Turn the AI request log on or off, and keep 7, 30, or 90 days." },
        400,
      );
    }
    return c.json({ settings: await c.var.aiRequestLog.set(body.data) }, 200);
  })
  // Settings, Alerts: the Household's SMTP server. The password is never in an answer.
  .get("/smtp/settings", async (c) => c.json({ smtp: await c.var.smtp.view() }))
  .post("/smtp/settings", async (c) => {
    const body = smtpBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Check the SMTP server's fields." }, 400);
    const fields = body.data;
    const saved = await c.var.smtp.save(fields);
    if (!saved.saved) return c.json({ error: SMTP_REFUSALS[saved.refusal] }, 400);
    return c.json({ smtp: saved.smtp }, 200);
  })
  // "Send a test email": to the signed-in Member, with the result.
  .post("/smtp/test", async (c) => {
    if (!testEmailBody.safeParse(await jsonBody(c)).success) {
      return c.json({ sent: false, error: "Send an empty body." }, 400);
    }
    const tested = await c.var.smtp.sendTest(c.var.member.email);
    if (tested.sent) {
      // The "Finish setup" item for Alerts is done only once a test email goes out.
      await c.var.setup.done("alerts");
      return c.json({ sent: true }, 200);
    }
    const status =
      tested.problem === "not set up" || tested.problem === "password unreadable" ? 409 : 502;
    return c.json({ sent: false, error: SEND_PROBLEMS[tested.problem] }, status);
  })
  // Settings, Alerts: the signed-in Member's own channels for Alerts and System notices.
  .get("/alert-channels", async (c) =>
    c.json({ channels: await c.var.channels.view(c.var.member.id) }),
  )
  .put("/alert-channels", async (c) => {
    const body = channelsBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Pick push, email, both, or none." }, 400);
    return c.json({ channels: await c.var.channels.set(c.var.member.id, body.data) }, 200);
  })
  // Settings, Alerts: the signed-in Member's own weekly summary email (spec 06, Weekly summary
  // email). The Member comes from the session, never from the body.
  .get("/weekly-summary", async (c) =>
    c.json({ weeklySummary: await c.var.weeklySummary.view(c.var.member.id) }),
  )
  .put("/weekly-summary", async (c) => {
    const body = weeklySummaryBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Turn the weekly summary on or off." }, 400);
    const weeklySummary = await c.var.weeklySummary.set(c.var.member.id, body.data.on);
    return c.json({ weeklySummary }, 200);
  })
  // Settings, Alerts: web push, over HTTPS only. The answer holds the VAPID public key, never the
  // private key.
  .get("/push", async (c) => c.json({ push: await c.var.push.view() }))
  // "Turn on Alerts on this device": the signed-in Member's browser subscription.
  .post("/push/devices", async (c) => {
    const body = subscriptionBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Send this browser's push subscription." }, 400);
    const added = await c.var.push.addDevice(c.var.member.id, body.data);
    if (added.added) return c.json({ added: true }, 200);
    const status = added.refusal === "unknown push service" ? 400 : 409;
    return c.json({ error: DEVICE_REFUSALS[added.refusal] }, status);
  })
  // Whose push is on in this browser. The endpoint goes in the body, never in the URL.
  .post("/push/devices/owner", async (c) => {
    const body = endpointBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Send this browser's push endpoint." }, 400);
    return c.json({ owner: await c.var.push.deviceOwner(c.var.member.id, body.data.endpoint) });
  })
  // "Turn off Alerts on this device": only the signed-in Member's own device.
  .delete("/push/devices", async (c) => {
    const body = endpointBody.safeParse(await jsonBody(c));
    if (!body.success) return c.json({ error: "Send this browser's push endpoint." }, 400);
    return c.json({ removed: await c.var.push.removeDevice(c.var.member.id, body.data.endpoint) });
  });

export type Api = typeof api;
