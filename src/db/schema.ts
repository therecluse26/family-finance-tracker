// The only source of app.db's shape. After a change here, `pnpm db:generate` writes its migration.
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { calendarDate, cents, moment } from "./columns.ts";

// The data key that encrypts every Master-key secret (spec 09, Encryption at rest). v1 stores one.
export const dataKeys = sqliteTable("data_keys", {
  // The key ID that starts each ciphertext the data key makes.
  id: text("id").primaryKey(),
  // The data key, encrypted with the Master key by the secrets module.
  encryptedKey: text("encrypted_key").notNull(),
});

// The schedule state of each scheduled task, which the scheduler tick in src/jobs keeps.
// Sidequest keeps its own schedules only in memory, so a run missed while the app was off would
// be lost without this table.
export const scheduledTasks = sqliteTable("scheduled_tasks", {
  name: text("name").primaryKey(),
  lastRunAt: moment("last_run_at"),
  nextRunAt: moment("next_run_at").notNull(),
  // The time zone that next_run_at follows. When the Household time zone changes, the tick moves
  // next_run_at to the new zone.
  timeZone: text("time_zone").notNull(),
});

// Better Auth's tables (spec 09, Signing in). Only the auth module reads or writes them, through
// Better Auth's Drizzle adapter. Each property name is the field name Better Auth uses.

// A Member: a person in the Household with a login. Better Auth calls it a user.
export const members = sqliteTable("members", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // Better Auth stores it in lowercase, so no two Members share one in any letter case.
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  // True once the Member's TOTP is set up. Sign-in refuses a Member without it.
  twoFactorEnabled: integer("two_factor_enabled", { mode: "boolean" }).notNull().default(false),
  createdAt: moment("created_at").notNull(),
  updatedAt: moment("updated_at").notNull(),
});

// One signed-in browser. Its cookie holds the token with an HMAC made with the login signing
// secret, so the token alone signs no one in.
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    userId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    expiresAt: moment("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: moment("created_at").notNull(),
    updatedAt: moment("updated_at").notNull(),
  },
  (table) => [index("sessions_member_id").on(table.userId)],
);

// A Member's password, as a hash. Better Auth calls it the credential account.
export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    password: text("password"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: moment("access_token_expires_at"),
    refreshTokenExpiresAt: moment("refresh_token_expires_at"),
    scope: text("scope"),
    createdAt: moment("created_at").notNull(),
    updatedAt: moment("updated_at").notNull(),
  },
  (table) => [index("accounts_member_id").on(table.userId)],
);

// Short-lived values, such as a sign-in that waits for its TOTP code.
export const verifications = sqliteTable(
  "verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: moment("expires_at").notNull(),
    createdAt: moment("created_at").notNull(),
    updatedAt: moment("updated_at").notNull(),
  },
  (table) => [index("verifications_identifier").on(table.identifier)],
);

// A Member's TOTP secret and backup codes. Better Auth encrypts each with the login signing secret,
// and the auth module encrypts that again with the secrets module, bound to the row and column.
export const twoFactors = sqliteTable("two_factors", {
  id: text("id").primaryKey(),
  userId: text("member_id")
    .notNull()
    .unique()
    .references(() => members.id, { onDelete: "cascade" }),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  verified: integer("verified", { mode: "boolean" }).notNull().default(true),
  failedVerificationCount: integer("failed_verification_count").notNull().default(0),
  lockedUntil: moment("locked_until"),
  // The TOTP time step of the last code the app accepted, so no code works twice (RFC 6238,
  // section 5.2). Better Auth does not know this column; only the auth module's claim writes it.
  lastTotpStep: integer("last_totp_step"),
});

// Better Auth's request counts for its own rate limits, one row for each client address and path.
export const rateLimits = sqliteTable("rate_limits", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  // Milliseconds since 1970, as Better Auth keeps it.
  lastRequest: integer("last_request").notNull(),
});

// One row for each failed sign-in, or a try still being checked, per Member and per IP address
// (spec 09, Failed sign-ins), for each setup code that is wrong or refused, and for each pasted
// Master key that is wrong or refused. Rows older than the window are deleted.
export const signInTries = sqliteTable(
  "sign_in_tries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // "member:" with a Member's ID, "email:" with an address no Member has, or "ip:" with an IP address.
    // For the setup code: "setup-code" for the whole app, or "setup-code-ip:" with an IP address.
    // For a pasted Master key: "master-key:" with the Member's ID.
    key: text("key").notNull(),
    at: moment("at").notNull(),
  },
  (table) => [index("sign_in_tries_key_at").on(table.key, table.at)],
);

// The first-run wizard's steps after the first Member, each one done or skipped (spec 12, The
// first-run wizard). Steps 1 and 2 need no row: they are done once a Member exists.
export const setupSteps = sqliteTable("setup_steps", {
  step: text("step").primaryKey(),
  status: text("status", { enum: ["done", "skipped"] }).notNull(),
  at: moment("at").notNull(),
});

// The Household facts (spec 05, Household facts). One row, with ID 1, once the wizard's step 4 is
// done. The facts stay on the server: no AI provider ever receives them.
export const householdFacts = sqliteTable(
  "household_facts",
  {
    id: integer("id").primaryKey(),
    zipCode: text("zip_code").notNull(),
    // The ZIP code's state and IANA time zone, from the ZIP table. The time zone is the Household
    // time zone, which every Household-time rule uses.
    state: text("state").notNull(),
    timeZone: text("time_zone").notNull(),
    // Each person's age in years, people without a login included, as JSON.
    ages: text("ages", { mode: "json" }).$type<number[]>().notNull(),
    rentOrOwn: text("rent_or_own", { enum: ["rent", "own"] }).notNull(),
    updatedAt: moment("updated_at").notNull(),
    updatedBy: text("updated_by").references(() => members.id, { onDelete: "set null" }),
  },
  (table) => [check("household_facts_one_row", sql`${table.id} = 1`)],
);

// The Plaid keys and the count of Plaid Items (spec 02, Plaid keys and The 10 lifetime Items). It
// has one row, whose ID is 1.
export const plaidSettings = sqliteTable(
  "plaid_settings",
  {
    id: integer("id").primaryKey(),
    clientId: text("client_id"),
    // The Production secret, encrypted with the Master key and bound to this row and column.
    secret: text("secret"),
    // Every Plaid Connection the app created or imported. It only grows, so a removed Connection
    // stays counted, even when its row is gone.
    appItems: integer("app_items").notNull().default(0),
    // Items spent outside the app, from the N a Member set. N is app_items plus outside_items.
    outsideItems: integer("outside_items").notNull().default(0),
  },
  (table) => [check("plaid_settings_one_row", sql`${table.id} = 1`)],
);

// The last check of a pasted Master key, by the wizard's step 3 or "Check my master key" (spec 09,
// The Master key). One row, with ID 1. It holds who checked, when, and whether the key matched, and
// never the key.
export const masterKeyChecks = sqliteTable("master_key_checks", {
  id: integer("id").primaryKey(),
  memberId: text("member_id").references(() => members.id, { onDelete: "set null" }),
  at: moment("at").notNull(),
  matched: integer("matched", { mode: "boolean" }).notNull(),
});

// System notices: notices to every Member about the app itself, never about the Household's
// Spending (spec 06, System notices). They are not Alerts, so they never count against the weekly
// Alert cap. An event notice stays open until a Member closes it, for every Member. A condition
// notice stays open until its condition ends; one condition has at most one open notice.
export const systemNotices = sqliteTable(
  "system_notices",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["event", "condition"] }).notNull(),
    text: text("text").notNull(),
    // The condition's key, such as "connection broken:<Connection ID>". Condition notices only.
    condition: text("condition"),
    raisedAt: moment("raised_at").notNull(),
    // When a Member closed the event, or the condition ended.
    closedAt: moment("closed_at"),
    closedBy: text("closed_by").references(() => members.id, { onDelete: "set null" }),
  },
  (table) => [
    uniqueIndex("system_notices_open_condition")
      .on(table.condition)
      .where(sql`${table.closedAt} IS NULL`),
  ],
);

// One delivery record for each new System notice. The email and push Delivery jobs send them.
export const noticeDeliveries = sqliteTable("notice_deliveries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  noticeId: text("notice_id")
    .notNull()
    .references(() => systemNotices.id),
  createdAt: moment("created_at").notNull(),
});

// The Household's one AI provider (spec 08, AI settings page). It has at most one row, whose ID is
// 1. Removing the AI provider empties the row but keeps it, with its generation.
export const aiSettings = sqliteTable(
  "ai_settings",
  {
    id: integer("id").primaryKey(),
    // Empty, with both models, after Remove AI provider.
    provider: text("provider", {
      enum: ["anthropic", "openai", "openrouter", "openai-compatible"],
    }),
    // The API key, encrypted with the Master key and bound to this row and column. Empty only for
    // an OpenAI-compatible endpoint that needs no key.
    apiKey: text("api_key"),
    baseUrl: text("base_url"),
    // The Cloudflare AI Gateway token, stored like the API key.
    gatewayToken: text("gateway_token"),
    quickModel: text("quick_model"),
    writerModel: text("writer_model"),
    // When the AI provider last answered 401 or 403. Empty once a call works again.
    keyRejectedAt: moment("key_rejected_at"),
    // Goes up by 1 on each save and each Remove AI provider. A save writes only when the row is
    // still at the generation it read before its checks, so it never undoes a later change.
    generation: integer("generation").notNull().default(0),
  },
  (table) => [
    check("ai_settings_one_row", sql`${table.id} = 1`),
    check(
      "ai_settings_whole",
      sql`(${table.provider} IS NULL) = (${table.quickModel} IS NULL) AND (${table.provider} IS NULL) = (${table.writerModel} IS NULL)`,
    ),
  ],
);

// Each AI use, as the AI usage page names it (spec 08, Every AI use). The check on save is the one
// call to each model when a Member saves the AI settings.
export const AI_USE_NAMES = [
  "category fix",
  "merchant cleanup",
  "unclear transfer",
  "reimbursement linking",
  "reading a goal",
  "alert advice",
  "budget tailoring",
  "insight cards",
  "monthly review",
  "chat",
  "check on save",
] as const;

// One AI call, for the AI usage page and the AI cost cap (spec 08, Counting cost). It holds
// metadata only, never prompt text or reply text.
export const aiCalls = sqliteTable(
  "ai_calls",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: moment("at").notNull(),
    // The calendar month in the Household time zone when the call ended, written YYYY-MM.
    month: text("month").notNull(),
    use: text("use", { enum: AI_USE_NAMES }).notNull(),
    provider: text("provider", {
      enum: ["anthropic", "openai", "openrouter", "openai-compatible"],
    }).notNull(),
    model: text("model").notNull(),
    noCacheTokens: integer("no_cache_tokens").notNull(),
    cacheReadTokens: integer("cache_read_tokens").notNull(),
    cacheWriteTokens: integer("cache_write_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    // In billionths of a dollar: one call can cost far less than a cent.
    costNanos: integer("cost_nanos").notNull(),
  },
  (table) => [index("ai_calls_month").on(table.month)],
);

// The AI cost cap, per Household, whatever the AI provider (spec 08, The AI cost cap). It has at
// most one row, whose ID is 1. With no row, the cap is the default.
export const aiCostCap = sqliteTable(
  "ai_cost_cap",
  {
    id: integer("id").primaryKey(),
    capCents: cents("cap_cents"),
    // The month, YYYY-MM, whose 80% and 100% System notices went out. Each goes out once a month.
    warnedMonth: text("warned_month"),
    reachedMonth: text("reached_month"),
  },
  (table) => [check("ai_cost_cap_one_row", sql`${table.id} = 1`)],
);

// The prices a Member entered for a model not in the app's price table (spec 08, AI settings
// page), in millionths of a dollar per million tokens. Cache reads and writes count at the input
// price.
export const aiModelPrices = sqliteTable(
  "ai_model_prices",
  {
    provider: text("provider", {
      enum: ["anthropic", "openai", "openrouter", "openai-compatible"],
    }).notNull(),
    model: text("model").notNull(),
    input: integer("input").notNull(),
    output: integer("output").notNull(),
  },
  (table) => [primaryKey({ columns: [table.provider, table.model] })],
);

// One link to one bank through one Bank-data provider (spec 02, Connections). bank_id is not
// unique: a bank can be linked again after its Connection is removed, and "Link again" on a Broken
// Connection links the same bank. The duplicate check before a token exchange belongs to linking.
export const connections = sqliteTable(
  "connections",
  {
    id: text("id").primaryKey(),
    provider: text("provider", { enum: ["plaid", "fake"] }).notNull(),
    // The bank's ID and name, from the provider.
    bankId: text("bank_id").notNull(),
    bankName: text("bank_name").notNull(),
    health: text("health", { enum: ["healthy", "retrying", "needs a member", "broken"] })
      .notNull()
      .default("healthy"),
    // True once the provider has sent all the history it will send.
    historyLoaded: integer("history_loaded", { mode: "boolean" }).notNull().default(false),
    // The cursor the next sync starts from. Saved only after a sync stores every record.
    syncCursor: text("sync_cursor"),
    // The minute past the hour of each scheduled sync, picked once, 0 to 59.
    syncMinute: integer("sync_minute").notNull(),
    // The provider credential, such as a Plaid access token, encrypted with the Master key.
    credential: text("credential"),
    origin: text("origin", { enum: ["linked", "imported"] }).notNull(),
    // The last successful sync.
    lastSyncedAt: moment("last_synced_at"),
    // When the last sync started, whatever came of it. At startup, a Connection whose last attempt
    // is more than 6 hours old syncs at once (spec 02, Sync schedule).
    lastSyncAttemptAt: moment("last_sync_attempt_at"),
    // When the sync schedule next starts this Connection's sync job: its next sync, or, while it
    // needs a Member, its next daily check. Empty for a new Connection, which syncs at once, and
    // for a Broken one, which never polls.
    nextSyncAt: moment("next_sync_at"),
    // While Retrying: when it became Retrying, and how many Temporary errors came in a row
    // (spec 02, Back-off).
    retryingSince: moment("retrying_since"),
    failedSyncs: integer("failed_syncs").notNull().default(0),
    createdAt: moment("created_at").notNull(),
  },
  (table) => [index("connections_bank_id").on(table.bankId)],
);

// The Household's Accounts (spec 02, Account fields). Better Auth's credential table already has
// the name "accounts", so this one is named for whose Accounts they are.
export const householdAccounts = sqliteTable(
  "household_accounts",
  {
    id: text("id").primaryKey(),
    // Empty for an Account that no provider syncs.
    connectionId: text("connection_id").references(() => connections.id),
    // The adapter's stable ID for the Account.
    providerAccountId: text("provider_account_id"),
    // The name from the provider. A Member's rename is memberName, which sync never writes.
    name: text("name").notNull(),
    memberName: text("member_name"),
    // Kind and subtype, such as "loan" and "personal".
    kind: text("kind").notNull(),
    subtype: text("subtype"),
    institutionId: text("institution_id"),
    institutionName: text("institution_name"),
    // The last 4 digits.
    mask: text("mask"),
    currentBalance: cents("current_balance"),
    availableBalance: cents("available_balance"),
    creditLimit: cents("credit_limit"),
    // Card details: each APR, as JSON, then the statement balance.
    cardAprs: text("card_aprs", { mode: "json" }).$type<{ type: string; apr: number }[]>(),
    statementBalance: cents("statement_balance"),
    // Card and loan details.
    minimumPayment: cents("minimum_payment"),
    paymentDueDate: calendarDate("payment_due_date"),
    // Loan details. An APR is a percent, such as 6.5.
    loanApr: real("loan_apr"),
    loanPrincipal: cents("loan_principal"),
    interestPaidThisYear: cents("interest_paid_this_year"),
    // Loans only.
    loanType: text("loan_type", { enum: ["cash loan", "purchase loan"] }),
    // An APR a Member typed, for a loan.
    memberApr: real("member_apr"),
    excluded: integer("excluded", { mode: "boolean" }).notNull().default(false),
    // Set when the Account is Closed (spec 02, Closed Accounts), with the reason.
    closedAt: moment("closed_at"),
    closedReason: text("closed_reason", {
      enum: ["vanished", "connection removed", "paid off", "closed by a member"],
    }),
    // True while the Account's provider no longer returns it. The sync that sees it go closes it
    // once, so a Member's reopening holds.
    providerMissing: integer("provider_missing", { mode: "boolean" }).notNull().default(false),
    // Day D of the last carry-over from another Connection (spec 02, Carrying Accounts over). The
    // current Connection's Transactions dated before it are hidden as "replaced by re-link".
    historySplitDate: calendarDate("history_split_date"),
    // The provider's original data for the Account, from the last sync.
    raw: text("raw", { mode: "json" }),
  },
  (table) => [
    uniqueIndex("household_accounts_connection_provider_id").on(
      table.connectionId,
      table.providerAccountId,
    ),
  ],
);

// Transactions as the bank reports them (spec 02, Records the adapter returns). Sync writes the
// provider's fields and never handSet. A hidden Transaction is kept, with the reason.
export const transactions = sqliteTable(
  "transactions",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id),
    accountId: text("account_id")
      .notNull()
      .references(() => householdAccounts.id),
    // The adapter's stable ID.
    providerTransactionId: text("provider_transaction_id").notNull(),
    // Money into the Account is positive.
    amount: cents("amount").notNull(),
    postedDate: calendarDate("posted_date").notNull(),
    authorizedDate: calendarDate("authorized_date"),
    pending: integer("pending", { mode: "boolean" }).notNull(),
    // The provider ID of the pending Transaction that this posted one replaces.
    pendingTransactionId: text("pending_transaction_id"),
    // The original bank description.
    description: text("description").notNull(),
    // The provider's Merchant name and Merchant ID.
    merchantName: text("merchant_name"),
    merchantId: text("merchant_id"),
    // The Merchant's clean name (spec 04, Names). Null when the Transaction has no Merchant, such
    // as a paper check.
    merchantCleanName: text("merchant_clean_name"),
    // Set when the cleanup rules could not fix the clean name, so AI cleanup takes it later.
    merchantNeedsAi: integer("merchant_needs_ai", { mode: "boolean" }).notNull().default(false),
    // The other parties named on it, with their types, as JSON.
    counterparties: text("counterparties", { mode: "json" })
      .$type<{ name: string; type: string }[]>()
      .notNull(),
    // Optional category data from the provider.
    providerCategory: text("provider_category"),
    providerCategoryConfidence: text("provider_category_confidence"),
    providerCategoryVersion: text("provider_category_version"),
    mcc: text("mcc"),
    // The provider's original data, so a later version can reprocess history.
    raw: text("raw", { mode: "json" }).notNull(),
    // Each field a Member set by hand, by name. Sync never writes it. Pending to posted carries it.
    handSet: text("hand_set", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    hiddenReason: text("hidden_reason", {
      enum: ["posted", "removed by provider", "replaced by re-link"],
    }),
    hiddenAt: moment("hidden_at"),
  },
  (table) => [
    uniqueIndex("transactions_connection_provider_id").on(
      table.connectionId,
      table.providerTransactionId,
    ),
    index("transactions_account_posted_date").on(table.accountId, table.postedDate),
  ],
);

// One balance per Account per day, from the first sync on (spec 02, Balances). Each sync writes
// the day's row again, so the day's last sync wins. Card and loan details are saved with it.
// Balances use the Transaction sign: money owed on a card or loan is negative.
export const dailyBalances = sqliteTable(
  "daily_balances",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => householdAccounts.id),
    // The day of the sync in the Household's time zone.
    date: calendarDate("date").notNull(),
    currentBalance: cents("current_balance"),
    availableBalance: cents("available_balance"),
    creditLimit: cents("credit_limit"),
    // Card details.
    cardAprs: text("card_aprs", { mode: "json" }).$type<{ type: string; apr: number }[]>(),
    statementBalance: cents("statement_balance"),
    // Card and loan details.
    minimumPayment: cents("minimum_payment"),
    paymentDueDate: calendarDate("payment_due_date"),
    // Loan details. An APR is a percent, such as 6.5.
    loanApr: real("loan_apr"),
    loanPrincipal: cents("loan_principal"),
    interestPaidThisYear: cents("interest_paid_this_year"),
    // The sync that wrote the row.
    syncedAt: moment("synced_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.date] })],
);

// The balances a Member typed for an Unconnected account (spec 02, Balance estimate), one per day.
// The latest one starts the account's balance estimate. A second one on the same day replaces it.
export const typedBalances = sqliteTable(
  "typed_balances",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => householdAccounts.id),
    // The day it was typed, in the Household time zone.
    date: calendarDate("date").notNull(),
    // Money in the account is positive.
    balance: cents("balance").notNull(),
    typedAt: moment("typed_at").notNull(),
    typedBy: text("typed_by").references(() => members.id, { onDelete: "set null" }),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.date] })],
);

// The Transfers and Saving the app assigns to an Unconnected account (spec 03, Unconnected
// accounts): each one is a Transaction on a connected Account whose other side is the Unconnected
// account. A Transaction goes to at most one account. They move the account's balance estimate.
export const unconnectedAssignments = sqliteTable(
  "unconnected_assignments",
  {
    transactionId: text("transaction_id")
      .primaryKey()
      .references(() => transactions.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => householdAccounts.id),
    assignedAt: moment("assigned_at").notNull(),
  },
  (table) => [index("unconnected_assignments_account_id").on(table.accountId)],
);

// Each Transaction's type, as the order of decisions last decided it (spec 03, Order of
// decisions). Its parts are in transaction_parts. A hidden Transaction has none.
export const transactionDecisions = sqliteTable(
  "transaction_decisions",
  {
    transactionId: text("transaction_id")
      .primaryKey()
      .references(() => transactions.id, { onDelete: "cascade" }),
    // The step that decided it, such as "1" for a hand-set type or "5.7" for Spending.
    step: text("step").notNull(),
    // A one-sided result is provisional to the end of this day, the last day of its window.
    provisionalUntil: calendarDate("provisional_until"),
    decidedAt: moment("decided_at").notNull(),
  },
  (table) => [index("transaction_decisions_provisional_until").on(table.provisionalUntil)],
);

// The parts of each decided Transaction: one part, or several that add up to its amount (spec 03,
// Transaction types). Each has one type and, for Spending, one Category.
export const transactionParts = sqliteTable(
  "transaction_parts",
  {
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactionDecisions.transactionId, { onDelete: "cascade" }),
    part: integer("part").notNull(),
    type: text("type", {
      enum: ["Spending", "Income", "Transfer", "Saving", "Refund", "Reimbursement"],
    }).notNull(),
    // The Transaction's sign: money into the Account is positive.
    amount: cents("amount").notNull(),
    // Null until the categorization step picks one, and always null for Transfers, Income, and
    // Saving.
    category: text("category"),
  },
  (table) => [primaryKey({ columns: [table.transactionId, table.part] })],
);

// Each follow-up step's handled mark on each Transaction (spec 10, The follow-up pipeline). A step
// handles every Transaction it has no mark on. A sync that changes or hides a Transaction deletes
// its marks, so every step handles it again.
export const followUpMarks = sqliteTable(
  "follow_up_marks",
  {
    step: text("step").notNull(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    handledAt: moment("handled_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.step, table.transactionId] }),
    index("follow_up_marks_transaction_id").on(table.transactionId),
  ],
);

// The Review list: the app's uncertain decisions, and things it cannot settle alone (spec 07,
// Review list page). Each item already has a result that counts, so nothing waits for it. An item
// closes when a Member answers it, or when a later event settles it.
export const reviewItems = sqliteTable(
  "review_items",
  {
    id: text("id").primaryKey(),
    // The kind of item, such as "category guess". Each kind registers its choices and its answer.
    kind: text("kind").notNull(),
    // What the item is about: Transactions, or a loan Account.
    subjectType: text("subject_type", { enum: ["transactions", "loan"] }).notNull(),
    // The Transaction IDs, or the loan Account's ID, as JSON.
    subjectIds: text("subject_ids", { mode: "json" }).$type<string[]>().notNull(),
    // What the app decided, or could not settle, in words.
    decided: text("decided").notNull(),
    // The app's best answer, which one button accepts, such as "Yes, Restaurants".
    bestAnswer: text("best_answer", { mode: "json" })
      .$type<{ value: string; label: string }>()
      .notNull(),
    createdAt: moment("created_at").notNull(),
    // Set when the item closes, with the reason: "answered" by a Member, or the event that settled
    // it.
    closedAt: moment("closed_at"),
    closedReason: text("closed_reason"),
    // A Member's answer.
    answer: text("answer", { mode: "json" }).$type<{ value: string; label: string }>(),
    answeredBy: text("answered_by").references(() => members.id, { onDelete: "set null" }),
  },
  (table) => [index("review_items_closed_at_created_at").on(table.closedAt, table.createdAt)],
);
