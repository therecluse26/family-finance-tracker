import { type BetterAuthPlugin, generateId } from "better-auth";
import { APIError, createAuthEndpoint, getIP } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import * as z from "zod";
import {
  addSignInTries,
  countSignInTries,
  type Database,
  type FirstMemberRows,
  hasMember,
  makeFirstMember,
  removeSignInTries,
  removeSignInTriesUpTo,
} from "../db/index.ts";
import type { Logger } from "../log.ts";
import type { Secrets } from "../secrets/index.ts";
import { newBackupCodes, newTotpSecret, storedTwoFactor, totpURI } from "./my-login.ts";
import { sealedValues } from "./sealed-adapter.ts";
import { limitedAddress } from "./sign-in-limit.ts";
import { totpStepOf } from "./totp-once.ts";

// The first-run wizard's steps 1 and 2 (spec 12, The first-run wizard): the setup code, then the
// first Member. Every route asks for the setup code, and every route refuses once a Member exists,
// so the code no longer works from then on.

// Spec 12, Step 1: 5 wrong codes per 15 minutes, counted for the whole app, since only one setup
// code exists. They are also counted per IP address, as failed sign-ins are.
export const WRONG_SETUP_CODES_ALLOWED = 5;
export const WRONG_SETUP_CODE_WINDOW_MS = 15 * 60 * 1000;
const APP_KEY = "setup-code";
const ipKey = (address: string) => `setup-code-ip:${address}`;

// How long a new TOTP secret waits for its first code, as in My login.
const NEW_TOTP_WAIT_MS = 10 * 60 * 1000;
// The one TOTP secret that waits for the first Member. Its identifier stands for the row ID in the
// secret's place.
const NEW_TOTP_IDENTIFIER = "first-member-new-totp";
const pendingPlace = { rowId: NEW_TOTP_IDENTIFIER, column: "verifications.value" };

const setupCode = z.string().max(64);
const name = z.string().trim().min(1).max(100);
const email = z.email().max(254);

type EndpointContext = { headers?: Headers; request?: Request };

// A failure is logged through `logger`, the auth module's own.
export function firstMember(options: {
  database: Database;
  secrets: Secrets;
  logger: Logger;
}): BetterAuthPlugin {
  const { database, secrets, logger } = options;

  // Makes the first Member one request at a time, so two requests at once with the right code
  // make exactly one. The app is one Node process (ADR 0002), so this queue covers every request.
  let queue: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work);
    queue = run.catch(() => {});
    return run;
  };

  // Refuses once a Member exists. Counts the code as wrong until it is checked; a wrong code, and a
  // code refused because too many were wrong, stay counted. Of tries at the same time, only the
  // first 5 in the window are checked.
  async function trySetupCode(ctx: EndpointContext, entered: string): Promise<void> {
    if (await hasMember(database)) {
      throw APIError.from("FORBIDDEN", {
        code: "SETUP_DONE",
        message: "Setup is done, so the setup code no longer works. Sign in instead.",
      });
    }
    const address = limitedAddress(ctx);
    const keys = address ? [APP_KEY, ipKey(address)] : [APP_KEY];
    const now = new Date();
    const since = new Date(now.getTime() - WRONG_SETUP_CODE_WINDOW_MS);
    await removeSignInTriesUpTo(database, since);
    const added = await addSignInTries(database, keys, now);
    for (const { key, id } of added) {
      if ((await countSignInTries(database, key, since, id)) > WRONG_SETUP_CODES_ALLOWED) {
        throw APIError.from("TOO_MANY_REQUESTS", {
          code: "TOO_MANY_WRONG_SETUP_CODES",
          message: "Too many wrong setup codes. Wait 15 minutes, then try again.",
        });
      }
    }
    if (!secrets.checkSetupCode(entered)) {
      throw APIError.from("UNAUTHORIZED", {
        code: "WRONG_SETUP_CODE",
        message: "The setup code is wrong.",
      });
    }
    await removeSignInTries(
      database,
      added.map((row) => row.id),
    );
  }

  return {
    id: "first-member",
    endpoints: {
      checkSetupCode: createAuthEndpoint(
        "/first-member/check-code",
        { method: "POST", body: z.object({ setupCode }) },
        async (ctx) => {
          await trySetupCode(ctx, ctx.body.setupCode);
          return ctx.json({ status: true });
        },
      ),

      newFirstMemberTotp: createAuthEndpoint(
        "/first-member/new-totp",
        { method: "POST", body: z.object({ setupCode, email }) },
        async (ctx) => {
          await trySetupCode(ctx, ctx.body.setupCode);
          const secret = newTotpSecret();
          const adapter = ctx.context.internalAdapter;
          await adapter.deleteVerificationByIdentifier(NEW_TOTP_IDENTIFIER);
          await adapter.createVerificationValue({
            identifier: NEW_TOTP_IDENTIFIER,
            value: secrets.encrypt(secret, pendingPlace),
            expiresAt: new Date(Date.now() + NEW_TOTP_WAIT_MS),
          });
          ctx.setHeader("Cache-Control", "no-store");
          return ctx.json({ totpURI: totpURI(secret, ctx.body.email.toLowerCase()) });
        },
      ),

      createFirstMember: createAuthEndpoint(
        "/first-member/create",
        {
          method: "POST",
          body: z.object({
            setupCode,
            name,
            email,
            password: z.string(),
            totpCode: z.string().max(64),
          }),
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
            await trySetupCode(ctx, ctx.body.setupCode);

            const adapter = ctx.context.internalAdapter;
            const pending = await adapter.findVerificationValue(NEW_TOTP_IDENTIFIER);
            if (!pending || pending.expiresAt <= new Date()) {
              throw APIError.from("BAD_REQUEST", {
                code: "NO_NEW_TOTP",
                message: "Set up TOTP again.",
              });
            }
            const secret = secrets.decrypt(pending.value, pendingPlace);
            const step = await totpStepOf(secret, totpCode.trim());
            if (step === undefined) {
              throw APIError.from("UNAUTHORIZED", {
                code: "INVALID_CODE",
                message: "The code is wrong.",
              });
            }

            // Every row of the new Member is written in one transaction, so a failure partway
            // leaves no half-made Member, and the setup code still works. The session is made as
            // Better Auth makes one. The code that made the Member cannot sign them in again.
            const at = new Date();
            const backupCodes = newBackupCodes();
            const twoFactorId = crypto.randomUUID();
            const sealed = sealedValues(
              secrets,
              "twoFactor",
              twoFactorId,
              await storedTwoFactor(ctx.context.secretConfig, { secret, backupCodes }),
            );
            const headers = ctx.request?.headers ?? ctx.headers;
            const user = {
              id: crypto.randomUUID(),
              name: ctx.body.name,
              email: ctx.body.email.toLowerCase(),
              emailVerified: false,
              image: null,
              twoFactorEnabled: true,
              createdAt: at,
              updatedAt: at,
            };
            const session = {
              id: crypto.randomUUID(),
              token: generateId(32),
              userId: user.id,
              expiresAt: new Date(at.getTime() + ctx.context.sessionConfig.expiresIn * 1000),
              ipAddress: (headers && getIP(headers, ctx.context.options)) || "",
              userAgent: headers?.get("user-agent") || "",
              createdAt: at,
              updatedAt: at,
            };
            const rows: FirstMemberRows = {
              at,
              member: { id: user.id, name: user.name, email: user.email },
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
              pendingTotp: NEW_TOTP_IDENTIFIER,
              session: {
                id: session.id,
                token: session.token,
                expiresAt: session.expiresAt,
                ipAddress: session.ipAddress,
                userAgent: session.userAgent,
              },
            };
            try {
              await makeFirstMember(database, rows);
            } catch (error) {
              // The error's name only: a database error repeats the rows it was writing.
              logger.error("The first Member was not made", {
                errorName: error instanceof Error ? error.name : typeof error,
              });
              throw APIError.from("INTERNAL_SERVER_ERROR", {
                code: "FIRST_MEMBER_NOT_MADE",
                message: "The first Member was not made, and nothing was saved. Try again.",
              });
            }

            await setSessionCookie(ctx, { session, user });
            ctx.setHeader("Cache-Control", "no-store");
            return ctx.json({ backupCodes });
          }),
      ),
    },
  };
}
