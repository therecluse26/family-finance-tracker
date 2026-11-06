import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { applyMigrations, closeDatabase, type Database, openDatabase } from "../db/index.ts";
import { createLogger, type Logger } from "../log.ts";
import { type MasterKey, type Secrets, unlockSecrets } from "../secrets/index.ts";
import { newMasterKey } from "../secrets/testing.ts";
import { type Auth, betterAuthOf, createAuth } from "./auth.ts";
import {
  newBackupCodes,
  newTotpSecret,
  storedTwoFactor,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  totpCode,
} from "./my-login.ts";

// Test support: an Auth on a new app.db, and Members made straight in app.db, as the first-run
// wizard (T09) and invites (T95) will make them. Each Master key, password, TOTP secret, and backup
// code is made when the test runs.

const SHIPPED_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

export type TestAuth = {
  auth: Auth;
  database: Database;
  secrets: Secrets;
  masterKey: MasterKey;
  // The app.db file, for a test that copies it.
  path: string;
  close(): void;
};

// An Auth on a new, migrated app.db in a new folder.
export async function newTestAuth(appOrigin: string, logger?: Logger): Promise<TestAuth> {
  const dir = mkdtempSync(join(tmpdir(), "fft-auth-"));
  const path = join(dir, "app.db");
  const database = await openDatabase(`file:${path}`);
  await applyMigrations(database, SHIPPED_FOLDER);
  const { masterKey } = newMasterKey();
  const quiet = createLogger(() => {}, { throwOnSecretField: true });
  const secrets = await unlockSecrets(database, masterKey, { logger: quiet });
  return {
    auth: createAuth({ database, secrets, appOrigin, logger: logger ?? quiet }),
    database,
    secrets,
    masterKey,
    path,
    close() {
      closeDatabase(database);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// An Auth that signs no one in and answers 404 under /api/auth/, for tests of the security check.
export const signedOutAuth: Auth = {
  handle: async () => Response.json({ error: "Not found" }, { status: 404 }),
  signedIn: async () => undefined,
  checkFreshCode: async () => "wrong",
  makeInvite: async () => {
    throw new Error("No Member is signed in to make an invite.");
  },
  removeLogin: async () => {},
};

export type TestMember = {
  id: string;
  email: string;
  password: string;
  totpSecret: string;
  backupCodes: string[];
  // The TOTP code for now, as the Member's authenticator app shows it.
  totpCode(): Promise<string>;
};

let made = 0;

// A new password with at least 12 characters, different for each Member.
export function newPassword(): string {
  made += 1;
  return `test password ${made} ${Math.random().toString(36).slice(2)}`;
}

export async function addMember(
  auth: Auth,
  member: { name: string; email: string; withTotp?: boolean },
): Promise<TestMember> {
  const context = await betterAuthOf(auth).$context;
  const password = newPassword();
  const withTotp = member.withTotp ?? true;
  const user = await context.internalAdapter.createUser(
    { name: member.name, email: member.email, emailVerified: false, twoFactorEnabled: withTotp },
    { method: "email-password" },
  );
  await context.internalAdapter.linkAccount({
    userId: user.id,
    providerId: "credential",
    accountId: user.id,
    password: await context.password.hash(password),
  });
  const totpSecret = newTotpSecret();
  const backupCodes = newBackupCodes();
  if (withTotp) {
    await context.adapter.create({
      model: "twoFactor",
      data: {
        userId: user.id,
        verified: true,
        ...(await storedTwoFactor(context.secretConfig, { secret: totpSecret, backupCodes })),
      },
    });
  }
  return {
    id: user.id,
    email: user.email,
    password,
    totpSecret,
    backupCodes,
    totpCode: () => totpCode(totpSecret),
  };
}

// The TOTP code for now from an otpauth:// link, as an authenticator app that read it shows it.
export function totpCodeFromURI(uri: string): Promise<string> {
  const secret = base32.decode(new URL(uri).searchParams.get("secret") ?? "");
  return createOTP(secret, { digits: TOTP_DIGITS, period: TOTP_PERIOD_SECONDS }).totp();
}
