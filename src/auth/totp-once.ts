import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { symmetricDecrypt } from "better-auth/crypto";
import { claimTotpStep, type Database } from "../db/index.ts";
import { codeMemberId } from "./sign-in-limit.ts";

// RFC 6238, section 5.2: once the app accepts a TOTP code, that code, and every code from the
// same or an earlier time step, is refused. Each Member's two_factors row keeps the last step.

// Spec 09, Signing in.
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
// Codes from one step before or after now are accepted, as Better Auth accepts them.
const WINDOW = 1;
// Better Auth marks a TOTP secret that it stores as base32 with this prefix.
const BASE32_PREFIX = "base32:";

export const usedCode = () =>
  APIError.from("UNAUTHORIZED", { code: "INVALID_CODE", message: "The code is wrong." });

// The time step whose code this is, within the window around now, or undefined for a wrong code.
// Every step in the window is checked, so the time taken does not show which one matched.
export async function totpStepOf(
  secret: string | Uint8Array,
  code: string,
): Promise<number | undefined> {
  const otp = createOTP(secret, { digits: TOTP_DIGITS, period: TOTP_PERIOD_SECONDS });
  const now = Math.floor(Date.now() / (TOTP_PERIOD_SECONDS * 1000));
  let matched: number | undefined;
  for (let step = now - WINDOW; step <= now + WINDOW; step += 1) {
    if (equal(code, await otp.hotp(step))) matched = step;
  }
  return matched;
}

function equal(given: string, expected: string): boolean {
  let difference = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i += 1) {
    difference |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return difference === 0;
}

// Before Better Auth checks a code on /two-factor/verify-totp, for a sign-in or a sensitive
// action, this claims the code's time step for the Member. A code whose step is already used
// answers 401 as a wrong code, so the sign-in limit counts it. A wrong code goes on to Better
// Auth, which refuses it.
export function totpOnce(database: Database): BetterAuthPlugin {
  return {
    id: "totp-once",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/two-factor/verify-totp",
          handler: createAuthMiddleware(async (ctx) => {
            const code = (ctx.body as { code?: unknown } | undefined)?.code;
            const memberId = await codeMemberId(ctx);
            if (typeof code !== "string" || memberId === undefined) return;
            const row = await ctx.context.adapter.findOne<{ secret: string }>({
              model: "twoFactor",
              where: [{ field: "userId", value: memberId }],
            });
            if (!row) return;
            const stored = await symmetricDecrypt({
              key: ctx.context.secretConfig,
              data: row.secret,
            });
            const secret = stored.startsWith(BASE32_PREFIX)
              ? base32.decode(stored.slice(BASE32_PREFIX.length).toUpperCase())
              : stored;
            const step = await totpStepOf(secret, code);
            if (step === undefined) return;
            if (!(await claimTotpStep(database, memberId, step))) throw usedCode();
          }),
        },
      ],
    },
  };
}
