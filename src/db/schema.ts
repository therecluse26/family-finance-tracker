// The only source of app.db's shape. After a change here, `pnpm db:generate` writes its migration.
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { moment } from "./columns.ts";

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
// (spec 09, Failed sign-ins). Rows older than the window are deleted.
export const signInTries = sqliteTable(
  "sign_in_tries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // "member:" with a Member's ID, "email:" with an address no Member has, or "ip:" with an IP address.
    key: text("key").notNull(),
    at: moment("at").notNull(),
  },
  (table) => [index("sign_in_tries_key_at").on(table.key, table.at)],
);
