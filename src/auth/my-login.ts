import { createOTP } from "@better-auth/utils/otp";
import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  sessionMiddleware,
} from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { generateRandomString, symmetricEncrypt } from "better-auth/crypto";
import * as z from "zod";
import { claimTotpStep, type Database } from "../db/index.ts";
import { registerSecretValue } from "../log.ts";
import type { Secrets } from "../secrets/index.ts";
import type { HookContext } from "./sign-in-limit.ts";
import { TOTP_DIGITS, TOTP_PERIOD_SECONDS, totpStepOf } from "./totp-once.ts";

export { TOTP_DIGITS, TOTP_PERIOD_SECONDS };

export const APP_NAME = "Family Finance Tracker";

// Spec 09, Signing in.
export const BACKUP_CODE_COUNT = 10;
// How long a new TOTP secret waits for the Member to enter its first code.
const NEW_TOTP_WAIT_MS = 10 * 60 * 1000;

// Checks a fresh TOTP or backup code for the Member signed in on these request headers.
export type FreshCodeCheck = (headers: Headers, code: string) => Promise<boolean>;

const codeBody = z.object({ code: z.string().min(1).max(64) });

const wrongCode = () =>
  APIError.from("UNAUTHORIZED", { code: "INVALID_CODE", message: "The code is wrong." });

// A new TOTP secret, in the form Better Auth makes one.
export function newTotpSecret(): string {
  const secret = generateRandomString(32);
  registerSecretValue(secret);
  return secret;
}

// The link an authenticator app reads, with the secret in it. The logger refuses both.
export function totpURI(secret: string, email: string): string {
  const uri = createOTP(secret, { digits: TOTP_DIGITS, period: TOTP_PERIOD_SECONDS }).url(
    APP_NAME,
    email,
  );
  registerSecretValue(uri);
  registerSecretValue(new URL(uri).searchParams.get("secret") ?? "");
  return uri;
}

export function totpCode(secret: string): Promise<string> {
  return createOTP(secret, { digits: TOTP_DIGITS, period: TOTP_PERIOD_SECONDS }).totp();
}

// Ten one-use backup codes, in the form Better Auth makes them.
export function newBackupCodes(): string[] {
  return Array.from({ length: BACKUP_CODE_COUNT }, () => {
    const code = generateRandomString(10, "a-z", "0-9", "A-Z");
    const written = `${code.slice(0, 5)}-${code.slice(5)}`;
    registerSecretValue(written);
    return written;
  });
}

// The TOTP secret and backup codes as Better Auth stores them: each encrypted with the login
// signing secret. The sealed adapter then encrypts them again, bound to their row.
export async function storedTwoFactor(
  signingSecret: Parameters<typeof symmetricEncrypt>[0]["key"],
  values: { secret?: string; backupCodes?: string[] },
): Promise<{ secret?: string; backupCodes?: string }> {
  const encrypt = (data: string) => symmetricEncrypt({ key: signingSecret, data });
  return {
    ...(values.secret === undefined ? {} : { secret: await encrypt(values.secret) }),
    ...(values.backupCodes === undefined
      ? {}
      : { backupCodes: await encrypt(JSON.stringify(values.backupCodes)) }),
  };
}

// The pending TOTP secret of a Member who changes their TOTP.
export const newTotpIdentifier = (memberId: string) => `new-totp-${memberId}`;

// Better Auth's two-factor plugin keeps a sign-in that waits for its code as a verification
// whose identifier starts with this and whose value is the Member's ID, with a count of its tries
// beside it.
const WAITING_SIGN_IN = "2fa-";
const waitingSignInTries = (identifier: string) => `2fa-attempts-${identifier}`;

// After a change to a Member's password, TOTP, or backup codes (spec 09, Sessions): ends their
// other sessions and their sign-ins that wait for a code, at once, so a thief who held either is
// out. The session that made the change stays.
async function endOtherSignIns(
  context: HookContext["context"],
  memberId: string,
  keptToken: string,
): Promise<void> {
  const sessions = await context.internalAdapter.listSessions(memberId);
  const others = sessions.map((one) => one.token).filter((token) => token !== keptToken);
  if (others.length > 0) await context.internalAdapter.deleteSessions(others);
  const waiting = await context.adapter.findMany<{ identifier: string }>({
    model: "verification",
    where: [
      { field: "identifier", operator: "starts_with", value: WAITING_SIGN_IN },
      { field: "value", value: memberId },
    ],
  });
  for (const { identifier } of waiting) {
    await context.internalAdapter.deleteVerificationByIdentifier(identifier);
    await context.internalAdapter.deleteVerificationByIdentifier(waitingSignInTries(identifier));
  }
}

// The house rules for Better Auth's sign-in routes, and the routes that let a signed-in Member
// change their own password, TOTP, and backup codes. Each change asks for a fresh code.
export function myLogin(options: {
  database: Database;
  secrets: Secrets;
  freshCode: FreshCodeCheck;
}): BetterAuthPlugin {
  const { database, secrets, freshCode } = options;

  // A pending TOTP secret sits in Better Auth's verifications table. Its identifier is unique,
  // so it stands for the row ID in the secret's place.
  const pendingPlace = (identifier: string) => ({
    rowId: identifier,
    column: "verifications.value",
  });

  return {
    id: "my-login",
    hooks: {
      before: [
        {
          // A trusted device would skip TOTP at the next sign-in, and there is no password-only
          // login. A session always lasts 30 days.
          matcher: (ctx) => ctx.path?.startsWith("/two-factor/") || ctx.path === "/sign-in/email",
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as { trustDevice?: unknown; rememberMe?: unknown };
            if (body.trustDevice !== undefined && body.trustDevice !== false) {
              throw APIError.from("BAD_REQUEST", {
                code: "TRUSTED_DEVICES_OFF",
                message: "This app asks for a code at every sign-in.",
              });
            }
            if (body.rememberMe !== undefined && body.rememberMe !== true) {
              throw APIError.from("BAD_REQUEST", {
                code: "SESSIONS_LAST_30_DAYS",
                message: "Every session lasts 30 days.",
              });
            }
          }),
        },
      ],
      after: [
        {
          // Better Auth's two-factor plugin turns a correct password into a wait for the code, but
          // only for a Member whose TOTP is set up. Any other Member gets no session.
          matcher: (ctx) => ctx.path === "/sign-in/email",
          handler: createAuthMiddleware(async (ctx) => {
            const signedIn = ctx.context.newSession;
            if (!signedIn || signedIn.user.twoFactorEnabled === true) return;
            await ctx.context.internalAdapter.deleteSession(signedIn.session.token);
            ctx.context.setNewSession(null);
            deleteSessionCookie(ctx, true);
            throw APIError.from("FORBIDDEN", {
              code: "NO_TOTP",
              message: "This Member has no TOTP yet, so the app cannot sign them in.",
            });
          }),
        },
      ],
    },
    endpoints: {
      changePassword: createAuthEndpoint(
        "/my-login/change-password",
        {
          method: "POST",
          use: [sessionMiddleware],
          body: z.object({ newPassword: z.string(), code: codeBody.shape.code }),
        },
        async (ctx) => {
          const { minPasswordLength, maxPasswordLength } = ctx.context.password.config;
          const { newPassword, code } = ctx.body;
          if (newPassword.length < minPasswordLength || newPassword.length > maxPasswordLength) {
            throw APIError.from("BAD_REQUEST", {
              code: "PASSWORD_LENGTH",
              message: `A password has ${minPasswordLength} to ${maxPasswordLength} characters.`,
            });
          }
          if (!(await freshCode(ctx.headers ?? new Headers(), code))) throw wrongCode();
          const hash = await ctx.context.password.hash(newPassword);
          const { user, session } = ctx.context.session;
          await ctx.context.internalAdapter.updatePassword(user.id, hash);
          await endOtherSignIns(ctx.context, user.id, session.token);
          return ctx.json({ status: true });
        },
      ),

      newTotp: createAuthEndpoint(
        "/my-login/new-totp",
        { method: "POST", use: [sessionMiddleware], body: codeBody },
        async (ctx) => {
          if (!(await freshCode(ctx.headers ?? new Headers(), ctx.body.code))) throw wrongCode();
          const { user } = ctx.context.session;
          const identifier = newTotpIdentifier(user.id);
          const secret = newTotpSecret();
          await ctx.context.internalAdapter.deleteVerificationByIdentifier(identifier);
          await ctx.context.internalAdapter.createVerificationValue({
            identifier,
            value: secrets.encrypt(secret, pendingPlace(identifier)),
            expiresAt: new Date(Date.now() + NEW_TOTP_WAIT_MS),
          });
          ctx.setHeader("Cache-Control", "no-store");
          return ctx.json({ totpURI: totpURI(secret, user.email) });
        },
      ),

      confirmTotp: createAuthEndpoint(
        "/my-login/confirm-totp",
        { method: "POST", use: [sessionMiddleware], body: codeBody },
        async (ctx) => {
          const memberId = ctx.context.session.user.id;
          const identifier = newTotpIdentifier(memberId);
          const pending = await ctx.context.internalAdapter.findVerificationValue(identifier);
          if (!pending || pending.expiresAt <= new Date()) {
            throw APIError.from("BAD_REQUEST", {
              code: "NO_NEW_TOTP",
              message: "Start the TOTP change again.",
            });
          }
          const secret = secrets.decrypt(pending.value, pendingPlace(identifier));
          // The new secret's code also claims its time step, so it cannot be used again, and a
          // code from a step already used, such as the fresh code's, is refused.
          const step = await totpStepOf(secret, ctx.body.code);
          if (step === undefined || !(await claimTotpStep(database, memberId, step))) {
            throw wrongCode();
          }
          if (!(await ctx.context.internalAdapter.consumeVerificationValue(identifier))) {
            throw APIError.from("BAD_REQUEST", {
              code: "NO_NEW_TOTP",
              message: "Start the TOTP change again.",
            });
          }
          await ctx.context.adapter.update({
            model: "twoFactor",
            where: [{ field: "userId", value: memberId }],
            update: await storedTwoFactor(ctx.context.secretConfig, { secret }),
          });
          await endOtherSignIns(ctx.context, memberId, ctx.context.session.session.token);
          return ctx.json({ status: true });
        },
      ),

      newBackupCodes: createAuthEndpoint(
        "/my-login/new-backup-codes",
        { method: "POST", use: [sessionMiddleware], body: codeBody },
        async (ctx) => {
          if (!(await freshCode(ctx.headers ?? new Headers(), ctx.body.code))) throw wrongCode();
          const backupCodes = newBackupCodes();
          const { user, session } = ctx.context.session;
          await ctx.context.adapter.update({
            model: "twoFactor",
            where: [{ field: "userId", value: user.id }],
            update: await storedTwoFactor(ctx.context.secretConfig, { backupCodes }),
          });
          await endOtherSignIns(ctx.context, user.id, session.token);
          ctx.setHeader("Cache-Control", "no-store");
          return ctx.json({ backupCodes });
        },
      ),
    },
  };
}
