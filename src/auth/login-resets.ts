import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import * as z from "zod";
import {
  type Database,
  finishLoginReset,
  listOpenLoginResetHashes,
  startLoginReset,
} from "../db/index.ts";
import { registerSecretValue } from "../log.ts";
import { linkTokenHash, newLinkToken, type Secrets, sameLinkTokenHash } from "../secrets/index.ts";
import { tryLinkToken } from "./link-token-tries.ts";
import { newBackupCodes, newTotpSecret, storedTwoFactor, totpURI } from "./my-login.ts";
import { sealedValues } from "./sealed-adapter.ts";
import { totpStepOf } from "./totp-once.ts";

// Reset links (spec 09, Login reset). A Member resets another Member's login in Settings, or the
// self-hoster runs `fft reset-login <email>`; either way the reset Member opens the link and sets a
// new login through the routes under /api/auth/login-reset/, with no session. The token is the
// only thing that lets them in:
// - 32 random bytes from the operating system's secure source, so no one can guess it;
// - app.db keeps only its SHA-256 hash, and the check compares hashes in constant time;
// - it works once and for 24 hours, and a new reset for the same Member replaces it;
// - 5 wrong tokens per 15 minutes per IP address, as for invite links;
// - the logger refuses it wherever it appears.

export const LOGIN_RESET_LIFETIME_MS = 24 * 60 * 60 * 1000;

// How long a new TOTP secret waits for its first code, as in My login.
const NEW_TOTP_WAIT_MS = 10 * 60 * 1000;
// The TOTP secret that waits for the Member who uses this reset link. Its identifier stands for
// the row ID in the secret's place.
const newTotpIdentifier = (resetId: string) => `login-reset-new-totp-${resetId}`;
const pendingPlace = (identifier: string) => ({ rowId: identifier, column: "verifications.value" });

const token = z.string().min(1).max(128);

type EndpointContext = { headers?: Headers; request?: Request };
type OpenReset = { id: string; memberId: string; email: string };

// Makes a reset in one transaction: the Member's sessions end, and their password, TOTP and
// backup codes are deleted, as the new link's hash is stored. Only the resetting Member, or the
// terminal that ran `fft reset-login`, sees the token, once, in the link. Undefined, with nothing
// changed, when no Member has the ID.
export async function makeLoginReset(
  database: Database,
  memberId: string,
  at: Date,
): Promise<{ token: string; expiresAt: Date } | undefined> {
  const made = newLinkToken();
  registerSecretValue(made.token);
  const expiresAt = new Date(at.getTime() + LOGIN_RESET_LIFETIME_MS);
  const started = await startLoginReset(database, {
    id: crypto.randomUUID(),
    memberId,
    tokenHash: made.hash,
    at,
    expiresAt,
  });
  return started ? { token: made.token, expiresAt } : undefined;
}

// The open reset whose token this is. Every open reset's hash is compared, each in constant time,
// so the time taken says nothing about the token.
async function openResetOf(database: Database, entered: string): Promise<OpenReset | undefined> {
  const enteredHash = linkTokenHash(entered);
  let found: OpenReset | undefined;
  for (const reset of await listOpenLoginResetHashes(database, new Date())) {
    if (sameLinkTokenHash(reset.tokenHash, enteredHash)) {
      found = { id: reset.id, memberId: reset.memberId, email: reset.email };
    }
  }
  // A token made by `fft reset-login` is new to this process, so the logger learns it here.
  if (found !== undefined) registerSecretValue(entered);
  return found;
}

const notOpen = () =>
  APIError.from("FORBIDDEN", {
    code: "RESET_NOT_OPEN",
    message:
      "This reset link does not work. It was used or replaced, or it is more than 24 hours old. Ask a Member for a new one.",
  });

export function loginResets(options: { database: Database; secrets: Secrets }): BetterAuthPlugin {
  const { database, secrets } = options;

  // Finishes resets one request at a time, so two requests with one link set one login. The finish
  // also uses up the link in the same transaction as the new login, for a second process such as
  // `fft reset-login`.
  let queue: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work);
    queue = run.catch(() => {});
    return run;
  };

  const tryToken = (ctx: EndpointContext, entered: string): Promise<OpenReset> =>
    tryLinkToken(database, ctx, {
      keyPrefix: "login-reset-ip:",
      find: () => openResetOf(database, entered),
      tooMany: () =>
        APIError.from("TOO_MANY_REQUESTS", {
          code: "TOO_MANY_WRONG_RESET_TOKENS",
          message: "Too many reset links that do not work. Wait 15 minutes, then try again.",
        }),
      notOpen,
    });

  return {
    id: "login-resets",
    endpoints: {
      // The reset page checks its link before the Member types anything, and names the login.
      checkLoginReset: createAuthEndpoint(
        "/login-reset/check",
        { method: "POST", body: z.object({ token }) },
        async (ctx) => {
          const reset = await tryToken(ctx, ctx.body.token);
          return ctx.json({ email: reset.email });
        },
      ),

      newLoginResetTotp: createAuthEndpoint(
        "/login-reset/new-totp",
        { method: "POST", body: z.object({ token }) },
        async (ctx) => {
          const reset = await tryToken(ctx, ctx.body.token);
          const adapter = ctx.context.internalAdapter;
          const secret = newTotpSecret();
          const identifier = newTotpIdentifier(reset.id);
          await adapter.deleteVerificationByIdentifier(identifier);
          await adapter.createVerificationValue({
            identifier,
            value: secrets.encrypt(secret, pendingPlace(identifier)),
            expiresAt: new Date(Date.now() + NEW_TOTP_WAIT_MS),
          });
          ctx.setHeader("Cache-Control", "no-store");
          return ctx.json({ totpURI: totpURI(secret, reset.email) });
        },
      ),

      finishLoginReset: createAuthEndpoint(
        "/login-reset/finish",
        {
          method: "POST",
          body: z.object({ token, password: z.string(), totpCode: z.string().max(64) }),
        },
        (ctx) =>
          oneAtATime(async () => {
            const { minPasswordLength, maxPasswordLength } = ctx.context.password.config;
            const { password, totpCode } = ctx.body;
            if (password.length < minPasswordLength || password.length > maxPasswordLength) {
              throw APIError.from("BAD_REQUEST", {
                code: "PASSWORD_LENGTH",
                message: `A password has ${minPasswordLength} to ${maxPasswordLength} characters.`,
              });
            }
            const reset = await tryToken(ctx, ctx.body.token);
            const adapter = ctx.context.internalAdapter;
            const identifier = newTotpIdentifier(reset.id);
            const pending = await adapter.findVerificationValue(identifier);
            if (!pending || pending.expiresAt <= new Date()) {
              throw APIError.from("BAD_REQUEST", {
                code: "NO_NEW_TOTP",
                message: "Set up TOTP again.",
              });
            }
            const secret = secrets.decrypt(pending.value, pendingPlace(identifier));
            const step = await totpStepOf(secret, totpCode.trim());
            if (step === undefined) {
              throw APIError.from("UNAUTHORIZED", {
                code: "INVALID_CODE",
                message: "The code is wrong.",
              });
            }

            // The link is used up with the new login, after every check, so a refusal leaves it
            // open. The code that set the TOTP cannot sign the Member in again.
            const backupCodes = newBackupCodes();
            const twoFactorId = crypto.randomUUID();
            const sealed = sealedValues(
              secrets,
              "twoFactor",
              twoFactorId,
              await storedTwoFactor(ctx.context.secretConfig, { secret, backupCodes }),
            );
            const finished = await finishLoginReset(database, {
              resetId: reset.id,
              memberId: reset.memberId,
              at: new Date(),
              account: {
                id: crypto.randomUUID(),
                password: await ctx.context.password.hash(password),
              },
              twoFactor: {
                id: twoFactorId,
                secret: String(sealed.secret),
                backupCodes: String(sealed.backupCodes),
                lastTotpStep: step,
              },
            });
            if (!finished) throw notOpen();
            await adapter.deleteVerificationByIdentifier(identifier);

            const user = await adapter.findUserById(reset.memberId);
            if (user === null) throw notOpen();
            const session = await adapter.createSession(user.id);
            await setSessionCookie(ctx, { session, user });
            ctx.setHeader("Cache-Control", "no-store");
            return ctx.json({ backupCodes });
          }),
      ),
    },
  };
}
