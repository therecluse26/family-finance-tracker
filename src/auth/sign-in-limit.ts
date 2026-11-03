import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from "better-auth/api";
import {
  addSignInTries,
  countSignInTries,
  type Database,
  removeSignInTries,
  removeSignInTriesUpTo,
} from "../db/index.ts";

// Spec 09, Failed sign-ins: 5 failed sign-ins per 15 minutes, per Member and per IP address.
export const FAILED_SIGN_INS_ALLOWED = 5;
export const FAILED_SIGN_IN_WINDOW_MS = 15 * 60 * 1000;

// The request header that carries the security check's client address to Better Auth. The auth
// module sets it from c.var.clientAddress on every request it hands Better Auth.
export const CLIENT_ADDRESS_HEADER = "x-fft-client-address";

// The routes that check a password or a code. A code check for a sensitive action goes through
// the same two code routes, so it counts too.
const CHECKS = new Set([
  "/sign-in/email",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]);

export type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

// The Member a code on a /two-factor/ route is for: the signed-in Member, or the sign-in that the
// two-factor cookie names and that waits for its code.
export async function codeMemberId(ctx: HookContext): Promise<string | undefined> {
  const session = await getSessionFromCtx(ctx);
  if (session) return session.user.id;
  const cookie = ctx.context.createAuthCookie("two_factor");
  const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!identifier) return undefined;
  const waiting = await ctx.context.internalAdapter.findVerificationValue(identifier);
  return waiting && waiting.expiresAt > new Date() ? waiting.value : undefined;
}

// The Member a password or code is for, or the email address when no Member has it.
async function memberKey(ctx: HookContext): Promise<string | undefined> {
  if (ctx.path === "/sign-in/email") {
    const email = (ctx.body as { email?: unknown } | undefined)?.email;
    if (typeof email !== "string") return undefined;
    const found = await ctx.context.internalAdapter.findUserByEmail(email);
    return found ? `member:${found.user.id}` : `email:${email.toLowerCase()}`;
  }
  const memberId = await codeMemberId(ctx);
  return memberId === undefined ? undefined : `member:${memberId}`;
}

function ipKey(ctx: HookContext): string | undefined {
  const address = (ctx.request?.headers ?? ctx.headers)?.get(CLIENT_ADDRESS_HEADER);
  return address ? `ip:${address}` : undefined;
}

// Counts each password or code check as a failed sign-in until it succeeds. A try adds its rows
// before it counts the ones before it, so of tries that run at the same time, only the first 5
// are checked. The 6th try in the window is refused before its password or code is checked, and
// a refused try adds nothing.
export function signInLimit(database: Database): BetterAuthPlugin {
  // The rows each check added, by the request's context, which its before and after hooks share.
  const pending = new WeakMap<object, number[]>();

  return {
    id: "sign-in-limit",
    hooks: {
      before: [
        {
          matcher: (ctx) => CHECKS.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const keys = [await memberKey(ctx), ipKey(ctx)].filter((key) => key !== undefined);
            const now = new Date();
            const since = new Date(now.getTime() - FAILED_SIGN_IN_WINDOW_MS);
            await removeSignInTriesUpTo(database, since);
            const added = await addSignInTries(database, keys, now);
            const ids = added.map((row) => row.id);
            for (const { key, id } of added) {
              if ((await countSignInTries(database, key, since, id)) > FAILED_SIGN_INS_ALLOWED) {
                await removeSignInTries(database, ids);
                throw APIError.from("TOO_MANY_REQUESTS", {
                  code: "TOO_MANY_FAILED_SIGN_INS",
                  message: "Too many failed sign-ins. Wait 15 minutes, then try again.",
                });
              }
            }
            pending.set(ctx.context, ids);
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) => CHECKS.has(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const ids = pending.get(ctx.context);
            if (ids === undefined) return;
            pending.delete(ctx.context);
            // A wrong password or code answers 401, and its rows stay as the failure.
            const returned = ctx.context.returned;
            if (isAPIError(returned) && returned.status === "UNAUTHORIZED") return;
            await removeSignInTries(database, ids);
          }),
        },
      ],
    },
  };
}
