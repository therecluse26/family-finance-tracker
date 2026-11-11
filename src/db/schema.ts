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

// A Member's passkeys (spec 09, Signing in), each a WebAuthn public key that signs the Member in
// with no TOTP code. A passkey works at one web address only: each row keeps the APP_URL host it
// was made under, and the start deletes every row made under another host (spec 09, Changing
// APP_URL). Removing the Member, or a reset of their login, deletes their rows.
export const passkeys = sqliteTable(
  "passkeys",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    // The credential ID the authenticator gave, which a sign-in names. No two passkeys share one.
    credentialID: text("credential_id").notNull().unique(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: integer("backed_up", { mode: "boolean" }).notNull(),
    transports: text("transports"),
    createdAt: moment("created_at").notNull(),
    aaguid: text("aaguid"),
    // The APP_URL host, without its port, when the passkey was made: its WebAuthn RP ID.
    appHost: text("app_host").notNull(),
  },
  (table) => [index("passkeys_member_id").on(table.userId)],
);

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

// The open invite links (spec 09, Invites). A link holds its token after "#". The app keeps only
// the token's SHA-256 hash, so a copy of app.db lets no one join. A link is deleted when it is used
// or cancelled, or when the Member who made it is removed, and stops working when it expires.
export const invites = sqliteTable(
  "invites",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    madeBy: text("made_by")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    createdAt: moment("created_at").notNull(),
    expiresAt: moment("expires_at").notNull(),
  },
  (table) => [index("invites_expires_at").on(table.expiresAt)],
);

// The open reset links (spec 09, Login reset), at most one for each Member. A link holds its token
// after "#", and the app keeps only the token's SHA-256 hash. A link is deleted when it is used,
// when a new reset for the same Member replaces it, or when the Member is removed, and stops
// working when it expires.
export const loginResets = sqliteTable(
  "login_resets",
  {
    id: text("id").primaryKey(),
    memberId: text("member_id")
      .notNull()
      .unique()
      .references(() => members.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: moment("created_at").notNull(),
    expiresAt: moment("expires_at").notNull(),
  },
  (table) => [index("login_resets_expires_at").on(table.expiresAt)],
);

// Each removed Member: their label number and their name (spec 09, Members). Label numbers follow
// the order Members joined, 0 for the first Member, and a removed Member's number is never given
// again, so every other Member keeps theirs. Nothing reads the name but the data export.
export const removedMembers = sqliteTable("removed_members", {
  labelNumber: integer("label_number").primaryKey(),
  name: text("name").notNull(),
  removedAt: moment("removed_at").notNull(),
});

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

// The CPI values the app fetched from the BLS API (spec 05, CPI): one per series and month. The
// shipped values stay in the Benchmark snapshot; the app uses the newest of both.
export const cpiValues = sqliteTable(
  "cpi_values",
  {
    series: text("series", { enum: ["CUUR0000SA0", "CUUR0000SAF11"] }).notNull(),
    // The month, such as "2026-09".
    month: text("month").notNull(),
    value: real("value").notNull(),
    fetchedAt: moment("fetched_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.series, table.month] })],
);

// The monthly CPI fetch (spec 05, CPI). One row, with ID 1, once the first fetch has run. A round
// is the month of the 20th it follows, such as "2026-11" from Nov 20 to Dec 19, Household time.
export const cpiFetch = sqliteTable(
  "cpi_fetch",
  {
    id: integer("id").primaryKey(),
    // The last successful fetch, which the Data sources page shows, and its round.
    fetchedAt: moment("fetched_at"),
    fetchedRound: text("fetched_round"),
    // The round that failed, and how often. At the cap the round stops until the next 20th.
    failedRound: text("failed_round"),
    failedTries: integer("failed_tries").notNull().default(0),
    // Why the last try failed, such as "timed out".
    lastFailure: text("last_failure"),
  },
  (table) => [check("cpi_fetch_one_row", sql`${table.id} = 1`)],
);

// The daily Update check (spec 12, Updates). One row, with ID 1, once a Member turns the check off
// or the first check runs. With no row the check is on.
export const updateCheck = sqliteTable(
  "update_check",
  {
    id: integer("id").primaryKey(),
    // Any Member may turn the check off. Off means no request.
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    // The last check GitHub answered, and the latest release it named, such as "1.2.0" from the
    // tag "v1.2.0". A failed check keeps both.
    checkedAt: moment("checked_at"),
    latestVersion: text("latest_version"),
    latestTag: text("latest_tag"),
    // Why the last check failed, such as "rate limited", or null after a check GitHub answered.
    lastFailure: text("last_failure"),
  },
  (table) => [check("update_check_one_row", sql`${table.id} = 1`)],
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

// The last check of a pasted Master key, by the wizard's step 3 or "Check my Master key" (spec 09,
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

// One delivery record for each new System notice. The Delivery job sends it by each channel, and
// keeps each channel's state here.
export const noticeDeliveries = sqliteTable("notice_deliveries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  noticeId: text("notice_id")
    .notNull()
    .references(() => systemNotices.id),
  createdAt: moment("created_at").notNull(),
  // Email: the Delivery job's failed tries in a row, and when email was done with the notice. Done
  // is sent, skipped (no SMTP server, no Member chose email, or the condition already ended), or
  // given up after the last try.
  emailTries: integer("email_tries").notNull().default(0),
  emailDoneAt: moment("email_done_at"),
  // Push: when push was done with the notice. Done is handed to each device's push_sends row, or
  // skipped (plain-HTTP mode, no device turned on, or the condition already ended).
  pushDoneAt: moment("push_done_at"),
});

// One delivery record for each sent Alert: an Alert of one part, or a merged Alert's first part
// (spec 06, Recipients and channels). The Alerts step stores it with its decision, in one
// transaction. It keeps the message as it read when the Alert was sent, since a sent Alert never
// changes. Deleting the Alert deletes it.
export const alertDeliveries = sqliteTable("alert_deliveries", {
  alertId: text("alert_id")
    .primaryKey()
    .references(() => alerts.id, { onDelete: "cascade" }),
  // The Alert's kind.
  title: text("title").notNull(),
  // The template's text; for a merged Alert, its heading and each part's line.
  text: text("text").notNull(),
  // The AI's advice, if any.
  advice: text("advice"),
  createdAt: moment("created_at").notNull(),
  // As in notice_deliveries.
  emailTries: integer("email_tries").notNull().default(0),
  emailDoneAt: moment("email_done_at"),
  pushDoneAt: moment("push_done_at"),
});

// The Household's SMTP server, for email Alerts and System notices (spec 06, Recipients and
// channels; spec 01, 11. Privacy). It has at most one row, whose ID is 1. With no row, email is
// not set up.
export const smtpSettings = sqliteTable(
  "smtp_settings",
  {
    id: integer("id").primaryKey(),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    // The sign-in name on the SMTP server.
    username: text("username").notNull(),
    // The password, encrypted with the Master key and bound to this row and column.
    password: text("password").notNull(),
    // The sender address on each email.
    sender: text("sender").notNull(),
  },
  (table) => [check("smtp_settings_one_row", sql`${table.id} = 1`)],
);

// Each Member's own channels for Alerts and System notices: push, email, both, or none (spec 06,
// Recipients and channels). A Member with no row has both, so a new Member starts with both. The
// row also holds the Member's own weekly summary email switch, which is off until they turn it on
// (spec 06, Weekly summary email).
export const alertChannels = sqliteTable("alert_channels", {
  memberId: text("member_id")
    .primaryKey()
    .references(() => members.id, { onDelete: "cascade" }),
  push: integer("push", { mode: "boolean" }).notNull(),
  email: integer("email", { mode: "boolean" }).notNull(),
  weeklySummary: integer("weekly_summary", { mode: "boolean" }).notNull().default(false),
});

// One weekly summary email for one Member and one week (spec 06, Weekly summary email). The run
// takes the row before it sends, in the same write as the check, so a Member gets at most one
// summary a week. Deleting the Member deletes their rows.
export const weeklySummarySends = sqliteTable(
  "weekly_summary_sends",
  {
    memberId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    // The Sunday the summary's 7 days start on, Household time.
    weekStart: calendarDate("week_start").notNull(),
    // "sending" while a run holds it, "failed" after a failed try with tries left, "sent", or
    // "gave up" after the last try.
    state: text("state", { enum: ["sending", "failed", "sent", "gave up"] }).notNull(),
    // The failed tries so far.
    tries: integer("tries").notNull().default(0),
    updatedAt: moment("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.memberId, table.weekStart] })],
);

// The app's VAPID keys for web push (spec 09, Encryption at rest). It has at most one row, whose ID
// is 1. Both keys are Master-key secrets, encrypted and bound to this row and column. The app makes
// them itself once the first-run wizard's step 3 is done, and makes new ones when they cannot be
// decrypted.
export const vapidKeys = sqliteTable(
  "vapid_keys",
  {
    id: integer("id").primaryKey(),
    publicKey: text("public_key").notNull(),
    privateKey: text("private_key").notNull(),
  },
  (table) => [check("vapid_keys_one_row", sql`${table.id} = 1`)],
);

// Each device a Member turned Alerts on for: its browser's push subscription (spec 06, Recipients
// and channels). The endpoint is the push service's address for that browser. Deleting the Member
// deletes their devices.
export const pushDevices = sqliteTable("push_devices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  memberId: text("member_id")
    .notNull()
    .references(() => members.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull().unique(),
  // The browser's public key and auth secret, which encrypt each push to it.
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: moment("created_at").notNull(),
});

// One push that waits for one device: an Alert's or a System notice's, as the Delivery job handed
// it out. Quiet hours hold it until 8 AM. It keeps its own title and body, so it reads as the
// message did when it was sent. Deleting the device, the Alert, or the notice deletes it.
export const pushSends = sqliteTable(
  "push_sends",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    deviceId: integer("device_id")
      .notNull()
      .references(() => pushDevices.id, { onDelete: "cascade" }),
    alertId: text("alert_id").references(() => alerts.id, { onDelete: "cascade" }),
    noticeId: text("notice_id").references(() => systemNotices.id, { onDelete: "cascade" }),
    // The Alert's kind, or "System notice".
    title: text("title").notNull(),
    // The template text, or the notice's text.
    body: text("body").notNull(),
    createdAt: moment("created_at").notNull(),
    // The failed tries in a row.
    tries: integer("tries").notNull().default(0),
  },
  // A delete of a device, an Alert, or a notice finds its rows by index.
  (table) => [
    index("push_sends_device").on(table.deviceId),
    index("push_sends_alert").on(table.alertId),
    index("push_sends_notice").on(table.noticeId),
  ],
);

// The Household's one AI provider (spec 08, AI settings page). It has at most one row, whose ID is
// 1. Removing the AI provider empties the row but keeps it, with its generation.
export const aiSettings = sqliteTable(
  "ai_settings",
  {
    id: integer("id").primaryKey(),
    // Empty, with each model, after Remove AI provider.
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
    // Empty while Chat uses the Writer model: for settings saved before Chat had its own tier.
    chatModel: text("chat_model"),
    // When the AI provider last answered 401 or 403. Empty once a call works again.
    keyRejectedAt: moment("key_rejected_at"),
    // Goes up by 1 on each save and each Remove AI provider. A save writes only when the row is
    // still at the generation it read before its checks, so it never undoes a later change.
    generation: integer("generation").notNull().default(0),
    // The Web lookup's switch (spec 08, Merchant web lookup): on whenever AI is on, until a Member
    // turns it off. A save and a Remove AI provider keep it.
    webLookup: integer("web_lookup", { mode: "boolean" }).notNull().default(true),
    // The AI provider and Quick model, as "provider:model", whose AI provider refused the Web
    // lookup's search request: that model has no web search, until the Quick model changes.
    webSearchRefused: text("web_search_refused"),
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
// call to each model when a Member saves the AI settings, and the key test is the one call to the
// Quick model when a Member presses "Test the key".
export const AI_USE_NAMES = [
  "category fix",
  "line item category",
  "merchant cleanup",
  "merchant lookup",
  "unclear transfer",
  "reimbursement linking",
  "reading a goal",
  "alert advice",
  "budget tailoring",
  "insight cards",
  "monthly review",
  "chat",
  "check on save",
  "key test",
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

// The days a Member may keep AI request text (spec 08, AI request log).
export const AI_REQUEST_LOG_KEEP_DAYS = [7, 30, 90] as const;

// The AI request log's switch and kept days (spec 08, AI request log). It has at most one row,
// whose ID is 1. With no row, the log is off and keeps 30 days.
export const aiRequestLogSettings = sqliteTable(
  "ai_request_log_settings",
  {
    id: integer("id").primaryKey(),
    on: integer("on", { mode: "boolean" }).notNull(),
    keepDays: integer("keep_days").notNull(),
    // Daily cleanup runs that failed in a row. At the cap, the cleanup stops and the log keeps no
    // new text, until a Member changes the switch or the kept days.
    cleanupFailures: integer("cleanup_failures").notNull().default(0),
    // Times a Member turned the log off. A call notes it when it starts, and keeps its text only
    // while it is unchanged: a call that runs while the log goes off and on again keeps nothing.
    switchOffs: integer("switch_offs").notNull().default(0),
  },
  (table) => [
    check("ai_request_log_settings_one_row", sql`${table.id} = 1`),
    check("ai_request_log_settings_keep_days", sql`${table.keepDays} IN (7, 30, 90)`),
  ],
);

// What went wrong with a call the AI request log kept: an AI failure, or "stopped" for a call cut
// off before its reply ended, or "app error" for a failure in the app. Never the error's own text.
export const AI_REQUEST_FAILURES = [
  "network",
  "timeout",
  "rate limit",
  "server error",
  "bad reply",
  "key rejected",
  "stopped",
  "app error",
] as const;

// The text of one AI call, kept only while the AI request log is on (spec 08, AI request log): the
// request as the app hands it to the AI provider, and the reply as the
// AI wrote it. It never holds a key, a token, a header, or the base URL. Each text is cut at
// 256 KB, and all rows together hold at most 100 MB. A call counted on the AI usage page links its
// ai_calls row; a failed call that counted nothing has none. Deleting the call's Chat thread
// deletes its row.
export const aiRequestLog = sqliteTable(
  "ai_request_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: moment("at").notNull(),
    aiCallId: integer("ai_call_id").references(() => aiCalls.id, { onDelete: "cascade" }),
    chatThreadId: text("chat_thread_id").references(() => chatThreads.id, {
      onDelete: "cascade",
    }),
    use: text("use", { enum: AI_USE_NAMES }).notNull(),
    model: text("model").notNull(),
    // The UTF-8 bytes of the request and the reply together, for the size cap. Its index lets the
    // cap add them up without reading the text.
    bytes: integer("bytes").notNull(),
    request: text("request").notNull(),
    requestCut: integer("request_cut", { mode: "boolean" }).notNull(),
    // Empty for a call that failed before any reply.
    response: text("response").notNull(),
    responseCut: integer("response_cut", { mode: "boolean" }).notNull(),
    failure: text("failure", { enum: AI_REQUEST_FAILURES }),
    // The AI provider's HTTP status for a failed call, when it answered with one.
    failureStatus: integer("failure_status"),
  },
  (table) => [
    // Newest first, for the log page's pages and the cleanup.
    index("ai_request_log_at").on(table.at, table.id),
    uniqueIndex("ai_request_log_ai_call_id").on(table.aiCallId),
    index("ai_request_log_chat_thread_id").on(table.chatThreadId),
    index("ai_request_log_bytes").on(table.bytes),
  ],
);

// The AI retry of each background AI use whose last call failed (spec 08, Failures): how many
// calls in a row failed, and when the next try is due. A use has a row only while it waits for a
// retry. The AI retry job asks for the use's work again once retry_at has passed, and notes that
// in asked_at, so it asks once for each retry time.
export const aiRetries = sqliteTable("ai_retries", {
  use: text("use", { enum: AI_USE_NAMES }).primaryKey(),
  failures: integer("failures").notNull(),
  retryAt: moment("retry_at").notNull(),
  askedAt: moment("asked_at"),
});

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
    // When Sync now last asked the provider to Refresh, so it asks at most once an hour (spec 02,
    // Sync now).
    lastRefreshAt: moment("last_refresh_at"),
    // When the Connection became Needs a Member or Broken before its history loaded. From then on
    // it no longer holds back AI, even once repaired (spec 02, First history load).
    historyWaitReleasedAt: moment("history_wait_released_at"),
    // Set when the history of a bank added later has loaded, and cleared once the bank-added-later
    // job has run its hooks (spec 02, A bank added later). It is the time that job last started.
    laterHooksStartedAt: moment("later_hooks_started_at"),
    // How often that job was started again after it was lost or used up its retries. At the cap it
    // stops, until a Member presses Retry.
    laterHooksRestarts: integer("later_hooks_restarts").notNull().default(0),
    createdAt: moment("created_at").notNull(),
    // When a Member removed the Connection (spec 02, Removing a Connection). A removed Connection
    // has no credential, never syncs, and blocks no new link. Its Closed Accounts keep their
    // history until a Member deletes it.
    removedAt: moment("removed_at"),
    // The provider linked a bank that another Connection covers, and did not end the new one
    // (spec 02, Linking a new bank). A held Connection never syncs, so the bank's money does not
    // count twice. It is set when the row is made, and only Remove clears it.
    syncHeld: integer("sync_held", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [index("connections_bank_id").on(table.bankId)],
);

// The old Connection whose Accounts a new Connection carries on, after Link again or a new link of
// a removed bank (spec 02, Carrying Accounts over). It is written in the same transaction that
// carries an Account over. The row goes with the new Connection, and its pointer empties when the
// old Connection's row goes. It is its own table, since drizzle-kit leaves ON DELETE out of the
// REFERENCES of a column it adds to a SQLite table.
export const connectionCarryOvers = sqliteTable("connection_carry_overs", {
  connectionId: text("connection_id")
    .primaryKey()
    .references(() => connections.id, { onDelete: "cascade" }),
  oldConnectionId: text("old_connection_id").references(() => connections.id, {
    onDelete: "set null",
  }),
  createdAt: moment("created_at").notNull(),
  // The wait of hand-made links for new copies ends COPIES_WAIT_CAP_DAYS after `created_at`, if the
  // first history load has not ended it (spec 02, Link carry-over). The sync schedule's job counts
  // each try to end it here, and the first try ends the wait. A try that makes the waiting old
  // Transactions unhandled records the time, so it happens once.
  copiesWaitEndTries: integer("copies_wait_end_tries").notNull().default(0),
  copiesWaitEndedAt: moment("copies_wait_ended_at"),
});

// The wait for the first history load (spec 02, First history load). It has at most one row,
// whose ID is 1. With no row, the wait has not ended.
export const historyWait = sqliteTable(
  "history_wait",
  {
    id: integer("id").primaryKey(),
    // When every Connection's history had loaded, or stopped holding back AI. A Connection made
    // after this never holds back AI.
    endedAt: moment("ended_at"),
    // When the First run job last started. A First run job lost to a stop, or one that used up its
    // retries, starts again an hour later, at most twice.
    firstRunStartedAt: moment("first_run_started_at"),
    // How often the First run job was started again. At the cap it stops, until a Member presses
    // Retry.
    firstRunRestarts: integer("first_run_restarts").notNull().default(0),
    // When the First run job finished its steps and sent "Your history is ready".
    firstRunDoneAt: moment("first_run_done_at"),
  },
  (table) => [check("history_wait_one_row", sql`${table.id} = 1`)],
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
    // Card details: each APR, as JSON, then the statement balance and the day it was issued.
    cardAprs: text("card_aprs", { mode: "json" }).$type<{ type: string; apr: number }[]>(),
    statementBalance: cents("statement_balance"),
    statementIssueDate: calendarDate("statement_issue_date"),
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
    // A Manual loan's regular payment and, on a mortgage, its escrow per payment, as a Member
    // typed them.
    regularPayment: cents("regular_payment"),
    escrow: cents("escrow"),
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
    // The "history load" mark: the Transaction arrived while its Connection's history loaded, for
    // a bank added later too. An Anomaly it fires is "found in history" (spec 06, When checks run).
    historyLoad: integer("history_load", { mode: "boolean" }).notNull().default(false),
    // When a sync first stored the Transaction as posted: a new posted record, or a pending one
    // that turned posted. A change to a posted one, or a Member's edit, keeps it. The day's Insight
    // card run starts only when one arrived since the last run (spec 08, When AI does not run).
    postedSeenAt: moment("posted_seen_at"),
  },
  (table) => [
    uniqueIndex("transactions_connection_provider_id").on(
      table.connectionId,
      table.providerTransactionId,
    ),
    index("transactions_account_posted_date").on(table.accountId, table.postedDate),
    // Transfer pairing reads the Transactions of one amount around some dates.
    index("transactions_amount_posted_date").on(table.amount, table.postedDate),
    // The Insight card check asks for a posted Transaction stored since the last run.
    index("transactions_posted_seen_at").on(table.postedSeenAt),
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
    statementIssueDate: calendarDate("statement_issue_date"),
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

// Transfer pairs between two of the Household's Accounts, with their evidence (spec 03, Links,
// Evidence, Transfers). Each Transaction joins at most one pair. A pair ends when either
// Transaction is deleted.
export const transferLinks = sqliteTable(
  "transfer_links",
  {
    id: text("id").primaryKey(),
    // The side that takes money out, and the side that brings it in.
    outTransactionId: text("out_transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    inTransactionId: text("in_transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    // Strong when at least one strong signal matched, else Unclear.
    tier: text("tier", { enum: ["Strong", "Unclear"] }).notNull(),
    // Each strong signal that matched, as JSON.
    signals: text("signals", { mode: "json" }).$type<string[]>().notNull(),
    // The AI's answer and confidence, when the app asked it.
    aiAnswer: text("ai_answer", { enum: ["yes", "no"] }),
    aiConfidence: text("ai_confidence", { enum: ["high", "medium", "low"] }),
    // Who made the link. Re-matching changes only the app's links.
    madeBy: text("made_by", { enum: ["app", "AI", "Member"] }).notNull(),
    memberId: text("member_id").references(() => members.id, { onDelete: "set null" }),
    // True when the app picked it from two equally good sets of pairs.
    uncertain: integer("uncertain", { mode: "boolean" }).notNull().default(false),
    createdAt: moment("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("transfer_links_out_transaction_id").on(table.outTransactionId),
    uniqueIndex("transfer_links_in_transaction_id").on(table.inTransactionId),
  ],
);

// Transfer pairs that a Member undid, or the AI rejected with high confidence. The app never makes
// them again (spec 03, Undo and hand links, Global pairing).
export const refusedTransferLinks = sqliteTable(
  "refused_transfer_links",
  {
    outTransactionId: text("out_transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    inTransactionId: text("in_transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    refusedBy: text("refused_by", { enum: ["AI", "Member"] }).notNull(),
    memberId: text("member_id").references(() => members.id, { onDelete: "set null" }),
    refusedAt: moment("refused_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.outTransactionId, table.inTransactionId] }),
    index("refused_transfer_links_in_transaction_id").on(table.inTransactionId),
  ],
);

// A Refund or a Reimbursement and the Spending it reduces (spec 03, Links, Refunds,
// Reimbursements). Several may reduce one Spending, and each links to at most one. A link ends
// when either Transaction is deleted.
export const spendingLinks = sqliteTable(
  "spending_links",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["Refund", "Reimbursement"] }).notNull(),
    // The money in: the Refund or the Reimbursement.
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    // The Spending it reduces.
    spendingTransactionId: text("spending_transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    tier: text("tier", { enum: ["Strong", "Unclear"] }).notNull(),
    signals: text("signals", { mode: "json" }).$type<string[]>().notNull(),
    aiAnswer: text("ai_answer", { enum: ["yes", "no"] }),
    aiConfidence: text("ai_confidence", { enum: ["high", "medium", "low"] }),
    madeBy: text("made_by", { enum: ["app", "AI", "Member"] }).notNull(),
    memberId: text("member_id").references(() => members.id, { onDelete: "set null" }),
    createdAt: moment("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("spending_links_transaction_id").on(table.transactionId),
    index("spending_links_spending_transaction_id").on(table.spendingTransactionId),
  ],
);

// A Manual loan and its payment or its payout (spec 03, Links, Loans). Each Transaction links to
// at most one loan. A link ends when its Transaction is deleted.
export const loanLinks = sqliteTable(
  "loan_links",
  {
    id: text("id").primaryKey(),
    // The payment, money out of a Household Account, or the payout, money into one.
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    loanAccountId: text("loan_account_id")
      .notNull()
      .references(() => householdAccounts.id, { onDelete: "cascade" }),
    tier: text("tier", { enum: ["Strong", "Unclear"] }).notNull(),
    signals: text("signals", { mode: "json" }).$type<string[]>().notNull(),
    aiAnswer: text("ai_answer", { enum: ["yes", "no"] }),
    aiConfidence: text("ai_confidence", { enum: ["high", "medium", "low"] }),
    madeBy: text("made_by", { enum: ["app", "AI", "Member"] }).notNull(),
    memberId: text("member_id").references(() => members.id, { onDelete: "set null" }),
    createdAt: moment("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("loan_links_transaction_id").on(table.transactionId),
    index("loan_links_loan_account_id").on(table.loanAccountId),
  ],
);

// Refund, Reimbursement, and loan links that a Member undid, or the AI rejected with high
// confidence. The app never makes them again (spec 03, Undo and hand links). `otherId` is the
// Spending's Transaction ID, or the loan's Account ID.
export const refusedLinks = sqliteTable(
  "refused_links",
  {
    kind: text("kind", { enum: ["Refund", "Reimbursement", "loan"] }).notNull(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    otherId: text("other_id").notNull(),
    refusedBy: text("refused_by", { enum: ["AI", "Member"] }).notNull(),
    memberId: text("member_id").references(() => members.id, { onDelete: "set null" }),
    refusedAt: moment("refused_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.transactionId, table.otherId] }),
    // The key leads with the kind, so a deleted Transaction's check finds its rows here.
    index("refused_links_transaction_id").on(table.transactionId),
  ],
);

// The AI's answer about each candidate it was asked about, so the app never asks about the same
// candidate twice (spec 03, Tiers, Reimbursements): an Unclear Transfer pair, an Unclear payment to
// a Manual loan, or money from a person. `otherId` is the pair's money-in side, or the Manual
// loan's Account ID; money from a person has "". A row ends when its Transaction is deleted.
export const aiLinkAnswers = sqliteTable(
  "ai_link_answers",
  {
    kind: text("kind", { enum: ["Transfer", "loan", "Reimbursement"] }).notNull(),
    // The pair's money-out side, the payment, or the money from a person.
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    otherId: text("other_id").notNull(),
    // For money from a person, "yes" when the AI named a Spending, and "no" when it named none.
    answer: text("answer", { enum: ["yes", "no"] }).notNull(),
    confidence: text("confidence", { enum: ["high", "medium", "low"] }).notNull(),
    // The Spending the AI named for money from a person. Null when it named none, or once that
    // Spending is deleted.
    spendingTransactionId: text("spending_transaction_id").references(() => transactions.id, {
      onDelete: "set null",
    }),
    askedAt: moment("asked_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.transactionId, table.otherId] }),
    // The key leads with the kind, so a deleted Transaction's check finds its rows here.
    index("ai_link_answers_transaction_id").on(table.transactionId),
    index("ai_link_answers_spending_transaction_id").on(table.spendingTransactionId),
  ],
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
// Transaction types). A payment on a tracked loan that no Household Account sent is the exception:
// its parts sit on the loan's own Transaction with the paying side's sign, so they add up to minus
// its amount. Each has one type and, for Spending, one Category.
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
    // Saving. A Money movement rule may name it, such as Cash.
    category: text("category"),
    // True for a part of a tracked loan payment: it keeps Money movement's Category, and only a
    // hand edit changes it (spec 04, Categories that Money movement names).
    keepsCategory: integer("keeps_category", { mode: "boolean" }).notNull().default(false),
    // True for the part of a Refund or Reimbursement that its spending_links row reduces. It takes
    // that Spending's Category and month, so its own Category stays null (spec 03, Which month a
    // link changes).
    linked: integer("linked", { mode: "boolean" }).notNull().default(false),
    // The step of the categorization cascade that chose the Category, and its confidence (spec 04,
    // Provenance). Null until the categorization step has handled the part.
    categorySource: text("category_source", {
      enum: [
        "hand-set",
        "Category rule",
        "Recurring charge",
        "provider",
        "Merchant history",
        "AI",
        "Web lookup",
        "best guess",
        "money movement",
        // Cascade step 1a: the Transaction's linked Line items (spec 14, Splits from Line items).
        "Line items",
      ],
    }),
    categoryConfidence: text("category_confidence", {
      enum: ["certain", "very high", "high", "medium", "low"],
    }),
    // Set when a no-AI path chose the Category, so the AI decides it once AI is back (spec 03, AI
    // decisions and the no-AI path).
    categoryNeedsAi: integer("category_needs_ai", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [primaryKey({ columns: [table.transactionId, table.part] })],
);

// Each follow-up step's handled mark on each Transaction (spec 10, The follow-up pipeline). A step
// handles every Transaction it has no mark on. A sync that changes or hides a Transaction deletes
// its marks, so every step handles it again. The key leads with the Transaction, so one b-tree
// serves both the lookup by Transaction and step and the delete of a Transaction's marks: a
// deleted Transaction's marks leave one b-tree, not three.
export const followUpMarks = sqliteTable(
  "follow_up_marks",
  {
    step: text("step").notNull(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    handledAt: moment("handled_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.transactionId, table.step] })],
);

// Each time a Member's change made a Transaction unhandled again, in order. A follow-up step that
// was already running does not mark a Transaction handled when it changed after the step began, so
// the next job handles it again. A step drops the rows it no longer needs.
export const followUpChanges = sqliteTable(
  "follow_up_changes",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
  },
  (table) => [index("follow_up_changes_transaction_id").on(table.transactionId)],
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
    // What the item is about: Transactions, a loan Account, or Line items.
    subjectType: text("subject_type", { enum: ["transactions", "loan", "line items"] }).notNull(),
    // The Transaction IDs, the loan Account's ID, or the Line item IDs, as JSON.
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
    // Set when a no-AI path decided the item, so the AI decides it once AI is back (spec 03, AI
    // decisions and the no-AI path).
    needsAi: integer("needs_ai", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [index("review_items_closed_at_created_at").on(table.closedAt, table.createdAt)],
);

// Category rules (spec 04, Category rules). A Member's correction makes one for the Transaction's
// Merchant, and it gives each of that Merchant's Transactions not set by hand the same Category.
// Each Merchant has at most one rule.
export const categoryRules = sqliteTable(
  "category_rules",
  {
    id: text("id").primaryKey(),
    // The provider's Merchant ID, when the Transaction had one, and the clean name.
    merchantId: text("merchant_id"),
    merchantName: text("merchant_name").notNull(),
    // The clean name as Merchant identity compares it: no case, no spaces, no punctuation.
    merchantKey: text("merchant_key").notNull(),
    category: text("category").notNull(),
    madeAt: moment("made_at").notNull(),
    madeBy: text("made_by").references(() => members.id, { onDelete: "set null" }),
  },
  (table) => [
    index("category_rules_merchant_id").on(table.merchantId),
    index("category_rules_merchant_key").on(table.merchantKey),
  ],
);

// Remembered one-sided Transfer answers (spec 03, Review list items). A Member's answer to a
// one-sided Transfer card is kept for the card's key, and each later one-sided Transfer with that key
// takes it. Each key has at most one answer. The key's digits stay in the app and never go to the
// AI.
export const transferAnswers = sqliteTable(
  "transfer_answers",
  {
    id: text("id").primaryKey(),
    // The clean name as Merchant identity compares it, and the clean name the list shows.
    merchantKey: text("merchant_key").notNull(),
    merchantName: text("merchant_name").notNull(),
    // The last 4 digits of each account number the line holds, joined by ",", or "" for none.
    lastFours: text("last_fours").notNull(),
    // "keep", "not a transfer", or "account".
    answer: text("answer").notNull(),
    // The account picked, for "account". The answer goes with its account.
    accountId: text("account_id").references(() => householdAccounts.id, { onDelete: "cascade" }),
    madeAt: moment("made_at").notNull(),
    madeBy: text("made_by").references(() => members.id, { onDelete: "set null" }),
  },
  (table) => [uniqueIndex("transfer_answers_key").on(table.merchantKey, table.lastFours)],
);

// AI cleanup's Merchant names (spec 04, Names): each answer by the bank description text it
// cleaned. The app reuses an answer for every Transaction with the same description, so the AI
// sees each description once.
export const merchantNameAnswers = sqliteTable("merchant_name_answers", {
  description: text("description").primaryKey(),
  name: text("name").notNull(),
  answeredAt: moment("answered_at").notNull(),
});

// The Web lookup's answer for each Merchant (spec 04, Web lookup), by the key Merchant identity
// gives it: "id:" and the provider's Merchant ID, else "name:" and the clean name as identity
// compares it. A Household-wide fact about the Merchant, not about a Connection: a Connection's
// delete removes only the answers no Transaction's Merchant holds any more. A lookup that found
// nothing keeps no Category, and the Merchant is looked up again only 90 days after it.
export const merchantLookups = sqliteTable(
  "merchant_lookups",
  {
    merchantKey: text("merchant_key").primaryKey(),
    outcome: text("outcome", { enum: ["found", "nothing found"] }).notNull(),
    category: text("category"),
    confidence: text("confidence", { enum: ["high", "medium", "low"] }),
    // One line about the business, in the one plain voice.
    description: text("description"),
    lookedUpAt: moment("looked_up_at").notNull(),
  },
  (table) => [
    check(
      "merchant_lookups_found",
      sql`(${table.outcome} = 'found') = (${table.category} IS NOT NULL AND ${table.confidence} IS NOT NULL AND ${table.description} IS NOT NULL)`,
    ),
  ],
);

// The Merchant lookups of each month, YYYY-MM in Household time, for their cap of 200 (spec 08,
// Merchant web lookup). A lookup takes its place here before it calls, in one statement.
export const merchantLookupMonths = sqliteTable("merchant_lookup_months", {
  month: text("month").primaryKey(),
  lookups: integer("lookups").notNull(),
});

// Recurring charges (spec 06, What the app stores): Spending with one Merchant that repeats on a
// schedule at a similar amount. The checks after each sync find them again from posted Spending,
// except one a Member marked ended, which never changes again, and one a Member edited, whose edits
// they keep (spec 06, Member edits). Its Transactions are in recurring_charge_transactions.
export const recurringCharges = sqliteTable(
  "recurring_charges",
  {
    id: text("id").primaryKey(),
    // The Merchant: the provider's Merchant ID, when it has one, and the clean name.
    merchantId: text("merchant_id"),
    merchantName: text("merchant_name").notNull(),
    // The Category of its last Transaction.
    category: text("category"),
    // A Member's edits (spec 06, Member edits): the name the pages show with the Merchant's, the
    // Category that covers its Transactions not set by hand, and the price band in tenths of a
    // percent, in place of the default. Null when no Member set one.
    name: text("name"),
    handSetCategory: text("hand_set_category"),
    priceBand: integer("price_band"),
    schedule: text("schedule", {
      enum: ["weekly", "every 2 weeks", "monthly", "yearly"],
    }).notNull(),
    nextExpectedDate: calendarDate("next_expected_date").notNull(),
    // The amount of its last Transaction, in whole cents spent.
    latestAmount: cents("latest_amount").notNull(),
    // The price history from before recurring_charge_transactions held it: each Transaction's ID,
    // posted date, and amount in whole cents spent, as JSON. The start moves it into that table and
    // leaves it empty.
    oldPriceHistory: text("price_history", { mode: "json" })
      .$type<{ transactionId: string; date: string; amount: number }[]>()
      .notNull(),
    // The Account its last Transaction landed on.
    accountId: text("account_id")
      .notNull()
      .references(() => householdAccounts.id),
    status: text("status", { enum: ["active", "inactive", "ended"] }).notNull(),
    foundAt: moment("found_at").notNull(),
    endedAt: moment("ended_at"),
    endedBy: text("ended_by").references(() => members.id, { onDelete: "set null" }),
  },
  // Delete history deletes by Account.
  (table) => [index("recurring_charges_account_id").on(table.accountId)],
);

// Each Recurring charge's Transactions, with the posted date and the amount in whole cents spent
// (spec 06, What the app stores). `byHand` is "added" for one a Member added, which the checks never
// drop, and "removed" for one a Member removed, which never joins that Recurring charge again by
// itself. A Transaction is in at most one Recurring charge.
export const recurringChargeTransactions = sqliteTable(
  "recurring_charge_transactions",
  {
    chargeId: text("charge_id")
      .notNull()
      .references(() => recurringCharges.id, { onDelete: "cascade" }),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    date: calendarDate("date").notNull(),
    amount: cents("amount").notNull(),
    byHand: text("by_hand", { enum: ["added", "removed"] }),
  },
  (table) => [
    primaryKey({ columns: [table.chargeId, table.transactionId] }),
    // Cascade step 2 reads a Transaction's Recurring charge (spec 04), and a deleted Transaction
    // deletes its rows.
    index("recurring_charge_transactions_transaction_id").on(table.transactionId),
    uniqueIndex("recurring_charge_transactions_in_one")
      .on(table.transactionId)
      .where(sql`${table.byHand} IS NOT 'removed'`),
  ],
);

// Each Recurring charge's price changes (spec 06, Member edits): a new amount in whole cents spent,
// from a date. A Member's (`byHand`) judges the Transactions from its date on. The checks find the
// others again each run, from the Transactions that changed the price.
export const recurringChargePriceChanges = sqliteTable(
  "recurring_charge_price_changes",
  {
    id: text("id").primaryKey(),
    chargeId: text("charge_id")
      .notNull()
      .references(() => recurringCharges.id, { onDelete: "cascade" }),
    fromDate: calendarDate("from_date").notNull(),
    amount: cents("amount").notNull(),
    byHand: integer("by_hand", { mode: "boolean" }).notNull(),
  },
  (table) => [
    uniqueIndex("recurring_charge_price_changes_one_a_day").on(
      table.chargeId,
      table.byHand,
      table.fromDate,
    ),
  ],
);

// Income series (spec 05, Steady Income): Income from one payer that repeats on a schedule at a
// similar amount, on checking and savings Accounts. The checks after each sync find them again
// from posted Income. Yearly series never count, so none is stored.
export const incomeSeries = sqliteTable(
  "income_series",
  {
    id: text("id").primaryKey(),
    // The payer: the Merchant on the Income Transactions, by the provider's Merchant ID when it has
    // one, and the clean name.
    merchantId: text("merchant_id"),
    merchantName: text("merchant_name").notNull(),
    schedule: text("schedule", {
      enum: ["weekly", "every 2 weeks", "twice a month", "monthly"],
    }).notNull(),
    // A twice-a-month series' two fixed days of the month, the earlier first, as JSON. 31 is the last
    // day of every month.
    fixedDays: text("fixed_days", { mode: "json" }).$type<[number, number]>(),
    nextExpectedDate: calendarDate("next_expected_date").notNull(),
    // The amount of its last Transaction, in whole cents received.
    latestAmount: cents("latest_amount").notNull(),
    // Each Transaction's ID, posted date, and amount in whole cents received, oldest first, as JSON.
    history: text("history", { mode: "json" })
      .$type<{ transactionId: string; date: string; amount: number }[]>()
      .notNull(),
    // The Account its last Transaction landed on. Delete history deletes the series with it.
    accountId: text("account_id")
      .notNull()
      .references(() => householdAccounts.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["active", "inactive"] }).notNull(),
  },
  // Delete history deletes the Accounts, and the series go by cascade.
  (table) => [index("income_series_account_id").on(table.accountId)],
);

// The Steady Income figure a Member typed in Settings, Household (spec 05, Steady Income). It
// replaces the detected one until a Member clears it, which deletes the row. It has at most one
// row, whose ID is 1.
export const typedSteadyIncome = sqliteTable(
  "typed_steady_income",
  {
    id: integer("id").primaryKey(),
    // Whole cents per month.
    amount: cents("amount").notNull(),
    typedAt: moment("typed_at").notNull(),
    typedBy: text("typed_by").references(() => members.id, { onDelete: "set null" }),
  },
  (table) => [check("typed_steady_income_one_row", sql`${table.id} = 1`)],
);

// Budgets (spec 05, Stored Budgets). Each row is one Budget for one Category, from the month or
// year it takes effect. A month uses the newest Budget in effect that month, so a past month keeps
// its Budget when a later one changes. The app stores each Bills Budget per month.
export const budgets = sqliteTable(
  "budgets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    category: text("category").notNull(),
    // Whole cents: per month for a monthly Budget, per calendar year for a yearly one.
    amount: cents("amount").notNull(),
    period: text("period", { enum: ["monthly", "yearly"] }).notNull(),
    // The month a monthly Budget takes effect, written YYYY-MM, or the year a yearly one takes
    // effect, written YYYY.
    takesEffect: text("takes_effect").notNull(),
    source: text("source", { enum: ["formula", "AI draft", "Member edit", "Proposal"] }).notNull(),
    // The Member who set it, or null when the app set it.
    setBy: text("set_by").references(() => members.id, { onDelete: "set null" }),
    // A Bills Budget's pinned flag: true once a Member's edit pins it to the typed amount. Null for
    // every other Budget.
    pinned: integer("pinned", { mode: "boolean" }),
    setAt: moment("set_at").notNull(),
    // True on a row that ends the Category's Budget: from its month on, the Category has no Budget
    // in effect, and earlier months keep theirs. Undo writes one for a Proposal that gave a Category
    // its first Budget, in this month or an earlier one (spec 08, Lifecycle), so the Category stays
    // without a Budget until a Member sets one (spec 05, When the app drafts). Its amount is 0.
    noBudget: integer("no_budget", { mode: "boolean" }).notNull().default(false),
    // The AI's one-sentence reason for an "AI draft" Budget (spec 05, The AI's part in a draft),
    // with each Member's name in place of their label. Null for every other Budget.
    reason: text("reason"),
  },
  (table) => [index("budgets_takes_effect").on(table.takesEffect)],
);

// The inputs behind the current Budgets (spec 05, Which Proposals exist): Steady Income and the CE
// data year. The first draft records them, with its month: there is no Budget before it. A redraft
// records its own once it is handled (spec 05, What accepting a Proposal changes). It has at most
// one row, whose ID is 1.
export const budgetInputs = sqliteTable(
  "budget_inputs",
  {
    id: integer("id").primaryKey(),
    // I, in whole cents per month.
    steadyIncome: cents("steady_income").notNull(),
    ceDataYear: integer("ce_data_year").notNull(),
    // True when the Benchmarks behind the current Budgets came from the sample snapshot.
    sampleBenchmarks: integer("sample_benchmarks", { mode: "boolean" }).notNull(),
    // The month the first draft took effect, written YYYY-MM.
    firstDraftMonth: text("first_draft_month").notNull(),
    // True when the draft stayed above Steady Income after the "must fit" cuts: its note says the
    // fixed costs pass Steady Income (spec 05, The total must fit).
    fixedCostsPassIncome: integer("fixed_costs_pass_income", { mode: "boolean" })
      .notNull()
      .default(false),
    // When the first draft recorded them.
    recordedAt: moment("recorded_at").notNull(),
    // When the redraft whose inputs these are drafted, or null for the first draft's. A redraft's
    // inputs replace only older ones.
    redraftedAt: moment("redrafted_at"),
    // When the last Benchmark redraft started: there is at most one a year.
    benchmarkRedraftAt: moment("benchmark_redraft_at"),
  },
  (table) => [check("budget_inputs_one_row", sql`${table.id} = 1`)],
);

// A Member's "Accept all" of the draft (spec 05, When the app drafts): when, and who. The draft is
// active whether or not anyone accepts it. It has at most one row, whose ID is 1.
export const budgetDraftAcceptance = sqliteTable(
  "budget_draft_acceptance",
  {
    id: integer("id").primaryKey(),
    acceptedAt: moment("accepted_at").notNull(),
    acceptedBy: text("accepted_by").references(() => members.id, { onDelete: "set null" }),
  },
  (table) => [check("budget_draft_acceptance_one_row", sql`${table.id} = 1`)],
);

// The Month start job's work for each month (spec 05, When the app drafts; spec 10, Jobs): that
// month's Bills Budgets, and a first Budget for each Category that has qualified. A month is done
// once; a failed run counts a try, and the job stops for that month at its cap.
export const budgetMonthStarts = sqliteTable("budget_month_starts", {
  // The month, written YYYY-MM.
  month: text("month").primaryKey(),
  doneAt: moment("done_at"),
  failedTries: integer("failed_tries").notNull().default(0),
});

// Alerts (spec 06, The Alert list). The Anomaly and Overspending checks create them after each
// sync. Each holds its kind, the template's facts and text, the Transactions or Category it is
// about, a slot for the AI's advice, and one state. The state is null until the Alerts step
// decides it, except for an Alert found in a history load, which is "found in history" at once and
// is never sent. Alerts of one kind created on one day merge into one (spec 06, Merging): see
// alert_parts.
export const alerts = sqliteTable(
  "alerts",
  {
    id: text("id").primaryKey(),
    kind: text("kind", {
      enum: [
        "Duplicate charge",
        "Price increase",
        "New Recurring charge",
        "Large purchase",
        "Over Budget",
        "On pace",
        "Card interest or fee",
      ],
    }).notNull(),
    createdAt: moment("created_at").notNull(),
    // The template's facts, as JSON: the Merchant, amounts in whole cents, and dates.
    facts: text("facts", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    // The template's text from those facts, as it read on the day the Alert was created.
    text: text("text").notNull(),
    // The Category an Alert is about, when it is about a Category rather than Transactions.
    category: text("category"),
    // The AI's one or two sentences of advice, if any.
    advice: text("advice"),
    // When the advice call was done with the Alert: its advice stored, or none, such as with no AI
    // provider or after the last retry failed. Null until then. An Alert gets its advice before the
    // Alerts step decides it, and never later.
    advisedAt: moment("advised_at"),
    state: text("state", { enum: ["sent", "held back (weekly cap)", "found in history"] }),
  },
  (table) => [index("alerts_created_at").on(table.createdAt)],
);

// The later parts of each merged Alert (spec 06, Merging): each names the merged Alert's first
// part, whose state it shares. Deleting the first part leaves each later part an Alert of its own.
export const alertParts = sqliteTable(
  "alert_parts",
  {
    alertId: text("alert_id")
      .primaryKey()
      .references(() => alerts.id, { onDelete: "cascade" }),
    mergedInto: text("merged_into")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
  },
  (table) => [index("alert_parts_merged_into").on(table.mergedInto)],
);

// The Alert settings (spec 06, The weekly cap): how many Alerts the app sends a week. Any Member
// may change it, to any whole number from 0. It has at most one row, whose ID is 1. With no row,
// the cap is 3.
export const alertSettings = sqliteTable(
  "alert_settings",
  {
    id: integer("id").primaryKey(),
    weeklyCap: integer("weekly_cap").notNull(),
  },
  (table) => [
    check("alert_settings_one_row", sql`${table.id} = 1`),
    check("alert_settings_weekly_cap", sql`${table.weeklyCap} >= 0`),
  ],
);

// The Alerts step's failed tries in a row. A run that fails counts one; the run that reaches the
// cap leaves its Alerts undecided for a later run and raises one System notice. It has at most one
// row, whose ID is 1.
export const alertDecisions = sqliteTable(
  "alert_decisions",
  {
    id: integer("id").primaryKey(),
    failedTries: integer("failed_tries").notNull().default(0),
  },
  (table) => [check("alert_decisions_one_row", sql`${table.id} = 1`)],
);

// The Transactions an Alert is about. A Transaction fires each Anomaly at most once, so the checks
// read these by Transaction. Deleting a Connection's history deletes its Alerts with them.
export const alertTransactions = sqliteTable(
  "alert_transactions",
  {
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    alertId: text("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.transactionId, table.alertId] }),
    index("alert_transactions_alert_id").on(table.alertId),
  ],
);

// Each "Not a problem" press on an Alert (spec 06, "Not a problem"): who pressed it, and when.
export const alertPresses = sqliteTable(
  "alert_presses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    alertId: text("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
    memberId: text("member_id").references(() => members.id, { onDelete: "set null" }),
    pressedAt: moment("pressed_at").notNull(),
  },
  (table) => [index("alert_presses_alert_id").on(table.alertId)],
);

// The Alert notes marked Done in the dashboard's AI box (spec 07, 1. AI box): one row per Alert,
// for every Member, with who marked it and when. Tapping "Done ✓" again deletes the row.
export const alertNotesDone = sqliteTable("alert_notes_done", {
  alertId: text("alert_id")
    .primaryKey()
    .references(() => alerts.id, { onDelete: "cascade" }),
  memberId: text("member_id").references(() => members.id, { onDelete: "set null" }),
  doneAt: moment("done_at").notNull(),
});

// Each Monthly review (spec 08, Monthly review), written on the 1st for the month just ended. It
// never changes once written: the row holds the AI's words and the app's figures as they were
// that day, as the monthly-review module's StoredReview.
export const monthlyReviews = sqliteTable("monthly_reviews", {
  // The month it is about, written YYYY-MM.
  month: text("month").primaryKey(),
  writtenAt: moment("written_at").notNull(),
  review: text("review", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
});

// The plan's ticks (spec 07, Reviews page): one row per ticked plan item, for every Member, with
// who ticked it and when. They are stored apart from the review, so the review never changes.
export const reviewPlanTicks = sqliteTable(
  "review_plan_ticks",
  {
    month: text("month")
      .notNull()
      .references(() => monthlyReviews.month, { onDelete: "cascade" }),
    // The plan item's place in the plan: 0, 1, or 2.
    item: integer("item").notNull(),
    memberId: text("member_id").references(() => members.id, { onDelete: "set null" }),
    tickedAt: moment("ticked_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.month, table.item] }),
    check("review_plan_ticks_item", sql`${table.item} BETWEEN 0 AND 2`),
  ],
);

// The review links marked Done in the dashboard's AI box (spec 07, 1. AI box): one row per
// review, for every Member, with who marked it and when.
export const reviewLinksDone = sqliteTable("review_links_done", {
  month: text("month")
    .primaryKey()
    .references(() => monthlyReviews.month, { onDelete: "cascade" }),
  memberId: text("member_id").references(() => members.id, { onDelete: "set null" }),
  doneAt: moment("done_at").notNull(),
});

// Each Monthly review's run (spec 08, Monthly review; Failures): one row per month the review is
// due for, from the 1st until the review is written or the run ends without one. It holds the
// AI's reply from the moment it comes back, so a failure after the call never pays for a second.
export const monthlyReviewRuns = sqliteTable("monthly_review_runs", {
  // The month the review is about, written YYYY-MM.
  month: text("month").primaryKey(),
  dueAt: moment("due_at").notNull(),
  // No try before this time: the AI retry's time, or a wait after a pause or a failure.
  retryAt: moment("retry_at"),
  // The Writer's reply, in the review fields, before the app stores the review.
  reply: text("reply", { mode: "json" }).$type<Record<string, unknown>>(),
  // When the reply's Budget changes went to the proposals module.
  proposedAt: moment("proposed_at"),
  endedAt: moment("ended_at"),
  outcome: text("outcome", { enum: ["written", "no AI provider", "stopped"] }),
});

// The Anomaly checks' failed tries in a row. A run that fails counts one; the run that reaches the
// cap gives up on its Transactions and raises one System notice. It has at most one row, whose ID
// is 1.
export const anomalyChecks = sqliteTable(
  "anomaly_checks",
  {
    id: integer("id").primaryKey(),
    failedTries: integer("failed_tries").notNull().default(0),
  },
  (table) => [check("anomaly_checks_one_row", sql`${table.id} = 1`)],
);

// Goals (spec 05, Goals): the Member's own words, the author, the Goal's date, a status, the AI's
// reading, and the Goal amount. The reading names its Category, Merchant, Accounts or loan by
// value, with no foreign key: a removed Account leaves the Goal as it is.
export const goals = sqliteTable(
  "goals",
  {
    id: text("id").primaryKey(),
    words: text("words").notNull(),
    authorId: text("author_id").references(() => members.id, { onDelete: "set null" }),
    // The author's name, written when that Member is removed: a removed Member's Goals keep their
    // name (spec 09, Members). Empty while the author is a Member.
    authorName: text("author_name"),
    // The Goal's date, in the Household time zone.
    date: calendarDate("date").notNull(),
    status: text("status", { enum: ["active", "done", "dropped"] }).notNull(),
    // The day it became done or dropped, in the Household time zone, and the Member who marked it.
    // A Goal the app set to done has no Member.
    endedOn: calendarDate("ended_on"),
    endedBy: text("ended_by").references(() => members.id, { onDelete: "set null" }),
    // The AI's reading. Each field is empty when the words do not say. The target and the change
    // are JSON: the goals module's GoalTarget and GoalChange.
    target: text("target", { mode: "json" }).$type<Record<string, unknown>>(),
    change: text("change", { mode: "json" }).$type<Record<string, unknown>>(),
    deadline: calendarDate("deadline"),
    // The Goal amount in whole cents, empty until it is set, and the start (spec 05, Progress): the
    // day it took effect, and the balance on that day, or the loan's balance owed. A spend less
    // Goal keeps the baseline its Goal amount was set against.
    goalAmount: cents("goal_amount"),
    startsOn: calendarDate("starts_on"),
    startBalance: cents("start_balance"),
    baseline: cents("baseline"),
  },
  (table) => [index("goals_status").on(table.status)],
);

// The Overspending checks' failed tries in a row, kept as for the Anomaly checks. It has at most
// one row, whose ID is 1.
export const overspendingChecks = sqliteTable(
  "overspending_checks",
  {
    id: integer("id").primaryKey(),
    failedTries: integer("failed_tries").notNull().default(0),
  },
  (table) => [check("overspending_checks_one_row", sql`${table.id} = 1`)],
);

// Proposals (spec 08, Proposals; spec 05, What accepting a Proposal changes): a change the AI
// suggests, which changes nothing until a Member accepts it. Each holds its kind, its source and
// the run that made it, the AI's one-sentence reason, and one status. A Budget change keeps its
// Categories in proposal_budgets.
export const proposals = sqliteTable(
  "proposals",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["Budget change", "Goal amount", "new Goal"] }).notNull(),
    source: text("source", { enum: ["Chat", "Monthly review", "Budget tailoring"] }).notNull(),
    // The Chat answer, Monthly review or Budget tailoring run that made it. A run makes at most 2.
    runId: text("run_id").notNull(),
    reason: text("reason").notNull(),
    // A Goal amount: its Goal, and the amount in whole cents. A new Goal: its words, and once a
    // Member accepts it, the Goal it created.
    goalId: text("goal_id").references(() => goals.id, { onDelete: "cascade" }),
    goalAmount: cents("goal_amount"),
    words: text("words"),
    status: text("status", {
      enum: ["open", "accepted", "skipped", "replaced", "expired"],
    }).notNull(),
    createdAt: moment("created_at").notNull(),
    // When it closed, and the Member who accepted or skipped it. A replaced or expired Proposal has
    // no Member.
    closedAt: moment("closed_at"),
    closedBy: text("closed_by").references(() => members.id, { onDelete: "set null" }),
    // What accepting a Goal Proposal set, for Undo: the db module's AppliedGoalChange.
    applied: text("applied", { mode: "json" }).$type<Record<string, unknown>>(),
    // When a Member undid the accepted change, and who.
    undoneAt: moment("undone_at"),
    undoneBy: text("undone_by").references(() => members.id, { onDelete: "set null" }),
  },
  (table) => [
    index("proposals_status").on(table.status),
    index("proposals_run").on(table.source, table.runId),
    index("proposals_goal_id").on(table.goalId),
  ],
);

// Each Category of a Budget change Proposal, with its proposed Budget. Once a Member accepts it:
// the Budget record it wrote, and the one in effect before, for Undo.
export const proposalBudgets = sqliteTable(
  "proposal_budgets",
  {
    proposalId: text("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    // Whole cents: per month for a monthly Budget, per calendar year for a yearly one.
    amount: cents("amount").notNull(),
    // The AI's one-sentence reason for this Category, from a Budget tailoring run, with each
    // Member's name in place of their label. Null from Chat and the Monthly review.
    reason: text("reason"),
    appliedBudgetId: integer("applied_budget_id").references(() => budgets.id, {
      onDelete: "set null",
    }),
    // Null when the Category had no Budget.
    replacedBudgetId: integer("replaced_budget_id").references(() => budgets.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    primaryKey({ columns: [table.proposalId, table.category] }),
    index("proposal_budgets_category").on(table.category),
  ],
);

// The Household summary that today's Writer uses read (spec 08, Household summary): built before
// the day's first Writer use, and kept for the rest of that day, Household time. It is app-built
// text. It has at most one row, whose ID is 1.
export const householdSummary = sqliteTable(
  "household_summary",
  {
    id: integer("id").primaryKey(),
    // The Household's date it was built for.
    day: calendarDate("day").notNull(),
    text: text("text").notNull(),
    builtAt: moment("built_at").notNull(),
  },
  (table) => [check("household_summary_one_row", sql`${table.id} = 1`)],
);

// Budget tailoring runs (spec 05, Which Proposals exist; spec 08, Runs that reuse these uses): the
// Tailoring run when an AI provider is set up after the first draft, and the Goal run when a Goal
// is added or its words change, and the redraft when one of its triggers fires. A run waits here
// until its one AI call ends, so it outlasts an AI retry, a pause such as the AI cost cap, and a
// restart. A Goal run and a redraft are deleted when they end. The Tailoring run is kept, with
// endedAt, so it runs once.
export const budgetTailoringRuns = sqliteTable(
  "budget_tailoring_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind", { enum: ["Tailoring", "Goal", "Redraft"] }).notNull(),
    // A Goal run's Goal. Deleting the Goal deletes its run.
    goalId: text("goal_id").references(() => goals.id, { onDelete: "cascade" }),
    requestedAt: moment("requested_at").notNull(),
    // How many times the run threw an error other than an AI error. At the cap, the run ends.
    failedTries: integer("failed_tries").notNull().default(0),
    // When the Tailoring run ended: its AI call answered, or the first draft took the AI's figures.
    endedAt: moment("ended_at"),
  },
  (table) => [
    index("budget_tailoring_runs_goal_id").on(table.goalId),
    // The Tailoring run is stored once ever: at most one row.
    uniqueIndex("budget_tailoring_runs_one_tailoring")
      .on(table.kind)
      .where(sql`${table.kind} = 'Tailoring'`),
    // At most one redraft waits: triggers close together make one run.
    uniqueIndex("budget_tailoring_runs_one_redraft")
      .on(table.kind)
      .where(sql`${table.kind} = 'Redraft'`),
  ],
);

// The inputs a redraft Proposal was drafted at (spec 05, What accepting a Proposal changes). When
// the Proposal closes, by any route, they become the inputs behind the current Budgets.
export const redraftProposals = sqliteTable("redraft_proposals", {
  proposalId: text("proposal_id")
    .primaryKey()
    .references(() => proposals.id, { onDelete: "cascade" }),
  // I, in whole cents per month.
  steadyIncome: cents("steady_income").notNull(),
  ceDataYear: integer("ce_data_year").notNull(),
  sampleBenchmarks: integer("sample_benchmarks", { mode: "boolean" }).notNull(),
});

// The current Insight cards in the dashboard's AI box (spec 08, Insight cards): the 4 to 7 cards
// the last Insight card run wrote, in the AI's order. A new run replaces the whole set. Each text
// is the AI's, as the screen shows it. Done marks a card for every Member, with who and when.
export const insightCards = sqliteTable(
  "insight_cards",
  {
    id: text("id").primaryKey(),
    // The card's place in the AI's order, from 1.
    position: integer("position").notNull(),
    // When the run that wrote it started, as its Household summary is from then, and the
    // Household's month then, YYYY-MM, which its picture shows.
    writtenAt: moment("written_at").notNull(),
    month: text("month").notNull(),
    group: text("card_group", { enum: ["worth_acting_on", "heads_up", "good_news"] }).notNull(),
    about: text("about").notNull(),
    // The key number, or null.
    figure: real("figure"),
    figureKind: text("figure_kind", { enum: ["dollars", "count", "percent"] }).notNull(),
    figureLabel: text("figure_label").notNull(),
    title: text("title").notNull(),
    why: text("why").notNull(),
    nextStep: text("next_step").notNull(),
    // A choice from the picture menu, the pictures module's PictureChoice, or null.
    picture: text("picture", { mode: "json" }).$type<Record<string, unknown>>(),
    doneAt: moment("done_at"),
    doneBy: text("done_by").references(() => members.id, { onDelete: "set null" }),
  },
  (table) => [uniqueIndex("insight_cards_position").on(table.position)],
);

// Chat threads (spec 08, Chat; Threads). Every thread is shared: every Member sees it, and any
// Member can continue or delete it. Its title is its first Member message, cut to 60 characters.
// A thread started with "Ask about this" keeps the note it was started from, as the chat module
// built it for the AI (src/chat/note.ts): what the note is about, its title, and its pieces.
// A thread started with "Ask the AI" on an Alert keeps the Alert as its note: see
// chat_alert_threads.
export const chatThreads = sqliteTable(
  "chat_threads",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    note: text("note", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: moment("created_at").notNull(),
    // When its last message was written. Threads run newest first by it.
    lastMessageAt: moment("last_message_at").notNull(),
  },
  (table) => [index("chat_threads_last_message_at").on(table.lastMessageAt)],
);

// The Chat threads "Ask the AI" started on an Alert (spec 06, "Ask the AI"): the Alert and the
// Member who pressed it, so that Member's next press on that Alert opens the same thread. Each
// Member has at most one per Alert. Deleting the thread, the Alert, or the Member deletes the row
// and keeps the thread, with its copy of the Alert: no press opens it again.
export const chatAlertThreads = sqliteTable(
  "chat_alert_threads",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    alertId: text("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
    memberId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
  },
  (table) => [uniqueIndex("chat_alert_threads_alert_member").on(table.alertId, table.memberId)],
);

// The messages of a Chat thread, oldest first. A Member's message keeps the Member and their name
// as it was then: a removed Member's messages keep their name (spec 09, Members). An AI message
// holds the AI's answer as it wrote it.
export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    author: text("author", { enum: ["Member", "AI"] }).notNull(),
    memberId: text("member_id").references(() => members.id, { onDelete: "set null" }),
    memberName: text("member_name"),
    text: text("text").notNull(),
    createdAt: moment("created_at").notNull(),
  },
  (table) => [
    index("chat_messages_thread_id").on(table.threadId),
    check(
      "chat_messages_author",
      sql`(${table.author} = 'Member' AND ${table.memberName} IS NOT NULL) OR (${table.author} = 'AI' AND ${table.memberId} IS NULL AND ${table.memberName} IS NULL)`,
    ),
  ],
);

// The first AI run and the redo of no-AI work (spec 08, Runs that reuse these uses; Redo of no-AI
// work). One row. AI is away while a background AI use takes its no-AI path, and comes back once:
// a pause comes back when it ends, such as when the AI cost cap resets or a Member fixes a rejected
// key, and an outage when an AI call succeeds. Each return starts one redo.
export const aiRedo = sqliteTable(
  "ai_redo",
  {
    id: integer("id").primaryKey(),
    // When a background AI use first found AI away, since AI last came back.
    awayAt: moment("away_at"),
    // Why AI is away: "pause", such as the AI cost cap, a rejected key, or no AI provider; or
    // "outage", an AI call that failed.
    awayReason: text("away_reason", { enum: ["pause", "outage"] }),
    // When AI came back, while the redo it starts has not finished.
    dueAt: moment("due_at"),
    // How often the redo failed in a row. At the cap it stops until AI is next back.
    failures: integer("failures").notNull().default(0),
    // When the first AI run finished, with its Insight card run.
    firstRunDoneAt: moment("first_run_done_at"),
    // The last redo that ended (spec 08, AI work on your Transactions): when it ended, how many
    // marked items it decided, how many Transactions' Categories the AI answered, and whether it
    // finished or stopped.
    lastRunAt: moment("last_run_at"),
    lastRunItems: integer("last_run_items").notNull().default(0),
    lastRunAiCategories: integer("last_run_ai_categories").notNull().default(0),
    lastRunOutcome: text("last_run_outcome", { enum: ["finished", "stopped"] }),
  },
  (table) => [check("ai_redo_one_row", sql`${table.id} = 1`)],
);

// Line items (spec 14, Line items and Amazon orders): one product on a store order, read from a
// file a Member uploads. The first source is Amazon's order history file. One row per product per
// shipment, as the file has it.
export const lineItems = sqliteTable(
  "line_items",
  {
    id: text("id").primaryKey(),
    source: text("source", { enum: ["amazon"] }).notNull(),
    // The import key (spec 14, Importing the same orders again), as JSON: the order ID, the product
    // ID or, with none, the name, the ship time, and `place`. A newer file's row with a stored key
    // updates that Line item.
    key: text("key").notNull(),
    orderId: text("order_id").notNull(),
    // The order date and the ship date, as days in the Household time zone.
    orderDate: calendarDate("order_date").notNull(),
    shipDate: calendarDate("ship_date").notNull(),
    // The ship time in UTC, to the second, as the file gives it, such as "2026-05-01T14:03:22Z".
    // One order's Line items with the same ship time are one shipment (spec 14, Linking).
    shipTime: text("ship_time").notNull(),
    // Amazon's ASIN, when the row has one.
    productId: text("product_id"),
    // The name as the file gives it, and its clean name, which Item rules match when there is no
    // product ID (spec 14, Item rules).
    name: text("name").notNull(),
    cleanName: text("clean_name").notNull(),
    quantity: integer("quantity").notNull(),
    unitPrice: cents("unit_price").notNull(),
    unitTax: cents("unit_tax").notNull(),
    shippingCharge: cents("shipping_charge").notNull(),
    // Negative or 0.
    discounts: cents("discounts").notNull(),
    // What the row says was owed for it, tax included.
    total: cents("total").notNull(),
    // The card's last 4 digits, when the payment method names a card, stored as an Account's mask
    // is. They never go to the AI, a log line, or an error. The card's name is never stored.
    cardLast4: text("card_last4"),
    // The payment method names a gift card, so the card charge is less than the total.
    giftCard: integer("gift_card", { mode: "boolean" }).notNull().default(false),
    // The row's place among identical rows of its order (same product, same ship time): 0 for the
    // first.
    place: integer("place").notNull(),
    // The Category, which step chose it, and how sure (spec 14, Categories of Line items). Null
    // until a step chooses one.
    category: text("category"),
    categorySource: text("category_source", {
      enum: ["hand-set", "Item rule", "AI", "Transaction"],
    }),
    categoryConfidence: text("category_confidence", {
      enum: ["certain", "very high", "high", "medium", "low"],
    }),
    // Set when the Transaction step chose the Category with no AI, so the AI decides it once AI is
    // back (spec 14, Step 4).
    categoryNeedsAi: integer("category_needs_ai", { mode: "boolean" }).notNull().default(false),
    // The Transaction that paid for it, and whether the app or a Member linked it (spec 14, Linking).
    // Deleting the Transaction unlinks it. link_kind counts only while transaction_id is set.
    transactionId: text("transaction_id").references(() => transactions.id, {
      onDelete: "set null",
    }),
    linkKind: text("link_kind", { enum: ["app", "hand"] }),
    // When an import first stored it, and when an import last changed its file fields.
    addedAt: moment("added_at").notNull(),
    updatedAt: moment("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("line_items_key").on(table.key),
    index("line_items_transaction_id").on(table.transactionId),
    index("line_items_shipment").on(table.orderId, table.shipTime),
    index("line_items_ship_date").on(table.shipDate),
    index("line_items_product_id").on(table.productId),
    index("line_items_clean_name").on(table.cleanName),
  ],
);

// A shipment and a Transaction the app never links again (spec 14, Hand links; Review list
// items): after Undo, or "None of these". A shipment is an order ID and a ship time.
export const refusedLineItemLinks = sqliteTable(
  "refused_line_item_links",
  {
    orderId: text("order_id").notNull(),
    shipTime: text("ship_time").notNull(),
    transactionId: text("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    memberId: text("member_id").references(() => members.id, { onDelete: "set null" }),
    refusedAt: moment("refused_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orderId, table.shipTime, table.transactionId] }),
    index("refused_line_item_links_transaction_id").on(table.transactionId),
  ],
);

// Item rules (spec 14, Item rules): one Category for every Line item of one product. A product is
// its product ID or, with none, its clean name. Each product has at most one rule.
export const itemRules = sqliteTable(
  "item_rules",
  {
    id: text("id").primaryKey(),
    // The product ID, else the clean name, as JSON: ["id","B000000001"] or ["name","paper towels"].
    productKey: text("product_key").notNull(),
    productId: text("product_id"),
    // A Line item with no product ID matches the rule by clean name.
    cleanName: text("clean_name").notNull(),
    // The name of the Line item it was made from, for Settings.
    name: text("name").notNull(),
    category: text("category").notNull(),
    madeAt: moment("made_at").notNull(),
    madeBy: text("made_by").references(() => members.id, { onDelete: "set null" }),
  },
  (table) => [
    uniqueIndex("item_rules_product_key").on(table.productKey),
    index("item_rules_product_id").on(table.productId),
    index("item_rules_clean_name").on(table.cleanName),
  ],
);

// Each upload of an order file (spec 14, The Store orders page in Settings): when, who, and the counts.
export const lineItemImports = sqliteTable(
  "line_item_imports",
  {
    id: text("id").primaryKey(),
    source: text("source", { enum: ["amazon"] }).notNull(),
    importedAt: moment("imported_at").notNull(),
    memberId: text("member_id").references(() => members.id, { onDelete: "set null" }),
    // The file's data rows, not its header.
    rowsRead: integer("rows_read").notNull(),
    added: integer("added").notNull(),
    updated: integer("updated").notNull(),
    // Rows stored already, with the same file fields.
    unchanged: integer("unchanged").notNull(),
    // Each reason rows were skipped, with how many and the first one's row number, as JSON.
    skipped: text("skipped", { mode: "json" })
      .$type<{ reason: string; rows: number; firstRow: number }[]>()
      .notNull(),
  },
  (table) => [index("line_item_imports_imported_at").on(table.importedAt)],
);

// The deal finder (spec 15, Deal finder). Every table below holds Household data that stays in
// app.db: no Store data leaves the Household but to the AI provider.

// What a Price source's Test found: the source accepted the key, refused it, said its usage limit
// was reached, or did not answer.
export const PRICE_SOURCE_CHECKS = ["passed", "refused", "usage limit", "no answer"] as const;

// The deal finder's Household settings (spec 15, The Price sources page in Settings; Trip setting).
// It has at most one row, whose ID is 1. With no row, every setting is its default.
export const dealFinderSettings = sqliteTable(
  "deal_finder_settings",
  {
    id: integer("id").primaryKey(),
    // The Scraping service's API token (Apify), encrypted with the Master key and bound to this row
    // and column, and its last 4 characters, which the page shows.
    apifyToken: text("apify_token"),
    apifyTokenLast4: text("apify_token_last4"),
    // The last Test of the token, and when. Saving a new token clears both.
    apifyCheck: text("apify_check", { enum: PRICE_SOURCE_CHECKS }),
    apifyCheckedAt: moment("apify_checked_at"),
    // The Kroger API's client ID and client secret, each stored like the token.
    krogerClientId: text("kroger_client_id"),
    krogerClientIdLast4: text("kroger_client_id_last4"),
    krogerClientSecret: text("kroger_client_secret"),
    krogerClientSecretLast4: text("kroger_client_secret_last4"),
    krogerCheck: text("kroger_check", { enum: PRICE_SOURCE_CHECKS }),
    krogerCheckedAt: moment("kroger_checked_at"),
    // Open Food Facts, which needs no key. Off until a Member turns it on.
    openFoodFacts: integer("open_food_facts", { mode: "boolean" }).notNull().default(false),
    // "Use our ZIP code to find stores": off until a Member turns it on (owner decision, 2026-11-07).
    useZip: integer("use_zip", { mode: "boolean" }).notNull().default(false),
    // Find Stores near us: the distance in miles, 10, 25 or 50, and the ZIP code and time of the
    // last lookup.
    findDistanceMiles: integer("find_distance_miles").notNull().default(25),
    storesFoundZip: text("stores_found_zip"),
    storesFoundAt: moment("stores_found_at"),
    // The Price source cost cap, for the Scraping service, each month: Apify's Free plan credit.
    costCap: cents("cost_cap").notNull().default(500),
    // "An extra trip must save at least $X" (spec 15, Trip setting).
    tripSaving: cents("trip_saving").notNull().default(1000),
    // The Household's dietary needs, in plain words, such as "no peanuts, gluten-free".
    dietaryNeeds: text("dietary_needs").notNull().default(""),
  },
  (table) => [
    check("deal_finder_settings_one_row", sql`${table.id} = 1`),
    check("deal_finder_settings_distance", sql`${table.findDistanceMiles} IN (10, 25, 50)`),
    check("deal_finder_settings_cost_cap", sql`${table.costCap} >= 0`),
    check("deal_finder_settings_trip_saving", sql`${table.tripSaving} >= 0`),
  ],
);

// The Scraping service's cost in each month, in the Household time zone, from each run's own record
// (spec 15, Cost and limits).
export const priceSourceCosts = sqliteTable("price_source_costs", {
  // The month, YYYY-MM.
  month: text("month").primaryKey(),
  // In billionths of a dollar: one run can cost far less than a cent.
  costNanos: integer("cost_nanos").notNull().default(0),
});

// Each Store the deal finder found or reads, and its settings (spec 15, Stores and their readers;
// Find Stores near us). A chain's ID is its name, such as "kroger"; a weekly-ad-only Store's ID
// starts with "ad-". Delete all deal finder data keeps every row.
export const dealFinderStores = sqliteTable(
  "deal_finder_stores",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    // A Store visited in person is a trip; an online Store is not. A weekly-ad-only Store has only
    // its weekly-ad Deals.
    kind: text("kind", { enum: ["in person", "online", "weekly ad only"] }).notNull(),
    reader: text("reader", { enum: ["Store API", "Scraping service"] }).notNull(),
    // Ticked on the Stores card. Only a Store that is on is read.
    on: integer("on", { mode: "boolean" }).notNull().default(false),
    // Found by the last Find Stores near us. A Store that is not is off, and its settings stay.
    nearby: integer("nearby", { mode: "boolean" }).notNull().default(true),
    // The locations to pick the Home store from, nearest first, as JSON. Empty for a Store whose
    // reader picks its own store.
    locations: text("locations", { mode: "json" })
      .$type<{ id: string; name: string; distanceMiles: number }[]>()
      .notNull(),
    // The Home store, one of its locations, and its distance in miles.
    homeStoreId: text("home_store_id"),
    homeStoreName: text("home_store_name"),
    distanceMiles: real("distance_miles"),
    // Empty means no fee (spec 15, Trip setting).
    deliveryFee: cents("delivery_fee"),
    freeDeliveryFrom: cents("free_delivery_from"),
    lastGoodReadAt: moment("last_good_read_at"),
    foundAt: moment("found_at").notNull(),
  },
  (table) => [
    check("deal_finder_stores_delivery_fee", sql`${table.deliveryFee} >= 0`),
    check("deal_finder_stores_free_delivery_from", sql`${table.freeDeliveryFrom} >= 0`),
  ],
);

// A Product at one Store, as its Price source read it (spec 15, Matching List items to Products).
export const dealFinderProducts = sqliteTable(
  "deal_finder_products",
  {
    id: text("id").primaryKey(),
    storeId: text("store_id")
      .notNull()
      .references(() => dealFinderStores.id, { onDelete: "cascade" }),
    // The Store's re-read key: its item number, ASIN, or Product link (spec 15, Search once, then
    // re-read).
    readKey: text("read_key").notNull(),
    name: text("name").notNull(),
    brand: text("brand"),
    size: text("size"),
    upc: text("upc"),
    // Shown as a link only when it is https: on the Store's own domain (K15).
    link: text("link"),
    addedAt: moment("added_at").notNull(),
  },
  (table) => [uniqueIndex("deal_finder_products_store_read_key").on(table.storeId, table.readKey)],
);

// Price history: each price read of a Product, kept 400 days (spec 15, Prices and Deals). Costco
// gives its warehouse price as the regular price, and its online price beside it.
export const dealFinderPriceReads = sqliteTable(
  "deal_finder_price_reads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    productId: text("product_id")
      .notNull()
      .references(() => dealFinderProducts.id, { onDelete: "cascade" }),
    readAt: moment("read_at").notNull(),
    // Empty for a weekly-ad-only Store, which has only Deals.
    regularPrice: cents("regular_price"),
    dealPrice: cents("deal_price"),
    dealEndsOn: calendarDate("deal_ends_on"),
    onlinePrice: cents("online_price"),
  },
  (table) => [
    index("deal_finder_price_reads_product").on(table.productId, table.readAt),
    index("deal_finder_price_reads_read_at").on(table.readAt),
    // Each price is above $0.00 and below $10,000.00 (spec 15, Checks on every price).
    check(
      "deal_finder_price_reads_prices",
      sql`coalesce(${table.regularPrice}, ${table.dealPrice}, ${table.onlinePrice}) IS NOT NULL AND coalesce(${table.regularPrice}, 1) BETWEEN 1 AND 999999 AND coalesce(${table.dealPrice}, 1) BETWEEN 1 AND 999999 AND coalesce(${table.onlinePrice}, 1) BETWEEN 1 AND 999999`,
    ),
  ],
);

// The units a List item takes (spec 15, Shopping list).
export const LIST_ITEM_UNITS = ["each", "oz", "lb", "fl oz", "gal", "ct", "pack"] as const;

// The Household's one Shopping list, of at most 100 List items (spec 15, Shopping list). Delete all
// deal finder data keeps it.
export const shoppingListItems = sqliteTable(
  "shopping_list_items",
  {
    id: text("id").primaryKey(),
    // Its words, such as "ground beef", and its quantity and unit, such as 2 lb.
    words: text("words").notNull(),
    quantity: real("quantity").notNull(),
    unit: text("unit", { enum: LIST_ITEM_UNITS }).notNull(),
    // A brand lock, such as "Jif": every other brand is `no`.
    brandLock: text("brand_lock"),
    note: text("note"),
    // The search words the AI wrote once, such as "ground beef 80/20". Empty until then.
    searchWords: text("search_words"),
    ticked: integer("ticked", { mode: "boolean" }).notNull().default(false),
    // Its place on the list, from 0.
    place: integer("place").notNull(),
    addedAt: moment("added_at").notNull(),
    addedBy: text("added_by").references(() => members.id, { onDelete: "set null" }),
  },
  (table) => [
    check("shopping_list_items_quantity", sql`${table.quantity} > 0`),
    index("shopping_list_items_added_by").on(table.addedBy),
  ],
);

// A Member's confirm or reject of a match, kept for the same List item words and Product (so the
// same Store), so the AI is not asked again (spec 15, Matching List items to Products, step 5).
export const memberMatchChoices = sqliteTable(
  "member_match_choices",
  {
    // The List item's words, trimmed and in lower case.
    words: text("words").notNull(),
    productId: text("product_id")
      .notNull()
      .references(() => dealFinderProducts.id, { onDelete: "cascade" }),
    choice: text("choice", { enum: ["confirmed", "rejected"] }).notNull(),
    memberId: text("member_id").references(() => members.id, { onDelete: "set null" }),
    at: moment("at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.words, table.productId] }),
    index("member_match_choices_product").on(table.productId),
    index("member_match_choices_member").on(table.memberId),
  ],
);

// The AI's answer for one List item and one Product (spec 15, Matching List items to Products). It
// keeps the Store's re-read key and the time of the List item's last full search at that Store, so
// later plan runs re-read a `match` and search again after 30 days (Search once, then re-read).
export const productMatches = sqliteTable(
  "product_matches",
  {
    listItemId: text("list_item_id")
      .notNull()
      .references(() => shoppingListItems.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => dealFinderProducts.id, { onDelete: "cascade" }),
    storeId: text("store_id")
      .notNull()
      .references(() => dealFinderStores.id, { onDelete: "cascade" }),
    answer: text("answer", { enum: ["match", "substitute", "no"] }).notNull(),
    // One line, for a substitute, such as "Turkey instead of beef".
    reason: text("reason"),
    readKey: text("read_key").notNull(),
    lastFullSearchAt: moment("last_full_search_at").notNull(),
    matchedAt: moment("matched_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.listItemId, table.productId] }),
    index("product_matches_product").on(table.productId),
    index("product_matches_store").on(table.storeId, table.listItemId),
  ],
);

// Each Shopping plan a Member started with "Find the best prices" (spec 15, The Shopping plan).
export const shoppingPlans = sqliteTable(
  "shopping_plans",
  {
    id: text("id").primaryKey(),
    startedAt: moment("started_at").notNull(),
    startedBy: text("started_by").references(() => members.id, { onDelete: "set null" }),
    state: text("state", { enum: ["running", "done", "failed"] }).notNull(),
    finishedAt: moment("finished_at"),
    // The trip setting the plan used.
    tripSaving: cents("trip_saving").notNull(),
    total: cents("total"),
    trips: integer("trips"),
    // Against the best one-Store plan.
    saving: cents("saving"),
    // Each Store that could not be read, with its reason, as JSON.
    storeFailures: text("store_failures", { mode: "json" })
      .$type<{ storeId: string; reason: string }[]>()
      .notNull(),
  },
  (table) => [
    index("shopping_plans_started_at").on(table.startedAt),
    index("shopping_plans_started_by").on(table.startedBy),
  ],
);

// One List item's line in a Shopping plan: its Store, Product, packages and price, or "Not found"
// with no Store. It keeps the words and the Product's name, so it reads the same after a change.
export const shoppingPlanLines = sqliteTable(
  "shopping_plan_lines",
  {
    planId: text("plan_id")
      .notNull()
      .references(() => shoppingPlans.id, { onDelete: "cascade" }),
    place: integer("place").notNull(),
    listItemId: text("list_item_id").references(() => shoppingListItems.id, {
      onDelete: "set null",
    }),
    words: text("words").notNull(),
    storeId: text("store_id").references(() => dealFinderStores.id, { onDelete: "set null" }),
    productId: text("product_id").references(() => dealFinderProducts.id, {
      onDelete: "set null",
    }),
    productName: text("product_name"),
    packages: integer("packages"),
    price: cents("price"),
    total: cents("total"),
    priceKind: text("price_kind", { enum: ["regular", "deal", "online"] }),
    priceReadAt: moment("price_read_at"),
  },
  (table) => [
    primaryKey({ columns: [table.planId, table.place] }),
    index("shopping_plan_lines_list_item").on(table.listItemId),
    index("shopping_plan_lines_store").on(table.storeId),
    index("shopping_plan_lines_product").on(table.productId),
  ],
);

// A Deal a Member used in a Shopping plan with "Use this Deal" (spec 15, What the plan shows). It
// moves the plan's line at `place` to the Deal's Store until the Deal ends; then the line is back
// at its regular-price Store. It keeps the Deal as it was shown, so it reads the same later.
export const shoppingPlanDeals = sqliteTable(
  "shopping_plan_deals",
  {
    planId: text("plan_id")
      .notNull()
      .references(() => shoppingPlans.id, { onDelete: "cascade" }),
    place: integer("place").notNull(),
    storeId: text("store_id")
      .notNull()
      .references(() => dealFinderStores.id, { onDelete: "cascade" }),
    productId: text("product_id")
      .notNull()
      .references(() => dealFinderProducts.id, { onDelete: "cascade" }),
    productName: text("product_name").notNull(),
    packages: integer("packages").notNull(),
    price: cents("price").notNull(),
    total: cents("total").notNull(),
    // Empty when the source gave no end date: the Deal holds until the next plan.
    endsOn: calendarDate("ends_on"),
    priceReadAt: moment("price_read_at").notNull(),
    usedAt: moment("used_at").notNull(),
    usedBy: text("used_by").references(() => members.id, { onDelete: "set null" }),
  },
  (table) => [
    primaryKey({ columns: [table.planId, table.place] }),
    index("shopping_plan_deals_store").on(table.storeId),
    index("shopping_plan_deals_product").on(table.productId),
    index("shopping_plan_deals_used_by").on(table.usedBy),
    check("shopping_plan_deals_amounts", sql`${table.packages} >= 1 AND ${table.price} >= 1`),
  ],
);
