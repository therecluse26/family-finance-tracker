import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import * as z from "zod";
import {
  addInvite,
  claimInvite,
  claimTotpStep,
  type Database,
  listOpenInviteHashes,
} from "../db/index.ts";
import { registerSecretValue } from "../log.ts";
import { linkTokenHash, newLinkToken, type Secrets, sameLinkTokenHash } from "../secrets/index.ts";
import {
  tryLinkToken,
  WRONG_LINK_TOKEN_WINDOW_MS,
  WRONG_LINK_TOKENS_ALLOWED,
} from "./link-token-tries.ts";
import { newBackupCodes, newTotpSecret, storedTwoFactor, totpURI } from "./my-login.ts";
import { totpStepOf } from "./totp-once.ts";

// Invite links (spec 09, Invites). Any Member makes one; the new Member joins through the routes
// under /api/auth/invite/, with no session. The token is the only thing that lets them in:
// - 32 random bytes from the operating system's secure source, so no one can guess it;
// - app.db keeps only its SHA-256 hash, and the check compares hashes in constant time;
// - it works once and for 7 days, and Cancel ends it;
// - 5 wrong tokens per 15 minutes per IP address, as for failed sign-ins. Past that, every token
//   is refused without being checked;
// - the logger refuses it wherever it appears.

export const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
export const WRONG_INVITE_TOKENS_ALLOWED = WRONG_LINK_TOKENS_ALLOWED;
export const WRONG_INVITE_TOKEN_WINDOW_MS = WRONG_LINK_TOKEN_WINDOW_MS;

// How long a new TOTP secret waits for its first code, as in My login.
const NEW_TOTP_WAIT_MS = 10 * 60 * 1000;
// The TOTP secret that waits for the Member who joins by this invite. Its identifier stands for
// the row ID in the secret's place.
const newTotpIdentifier = (inviteId: string) => `invite-new-totp-${inviteId}`;
const pendingPlace = (identifier: string) => ({ rowId: identifier, column: "verifications.value" });

const token = z.string().min(1).max(128);
const name = z.string().trim().min(1).max(100);
const email = z.email().max(254);

type EndpointContext = { headers?: Headers; request?: Request };

// Makes an invite link's token and stores its hash. Only the Member who made it sees the token,
// once, in the link.
export async function makeInvite(
  database: Database,
  madeBy: string,
  at: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const made = newLinkToken();
  registerSecretValue(made.token);
  const expiresAt = new Date(at.getTime() + INVITE_LIFETIME_MS);
  await addInvite(database, {
    id: crypto.randomUUID(),
    tokenHash: made.hash,
    madeBy,
    at,
    expiresAt,
  });
  return { token: made.token, expiresAt };
}

// The open invite whose token this is. Every open invite's hash is compared, each in constant
// time, so the time taken says nothing about the token.
async function openInviteOf(database: Database, entered: string): Promise<string | undefined> {
  const enteredHash = linkTokenHash(entered);
  let found: string | undefined;
  for (const invite of await listOpenInviteHashes(database, new Date())) {
    if (sameLinkTokenHash(invite.tokenHash, enteredHash)) found = invite.id;
  }
  return found;
}

const notOpen = () =>
  APIError.from("FORBIDDEN", {
    code: "INVITE_NOT_OPEN",
    message:
      "This invite link does not work. It was used or cancelled, or it is more than 7 days old. Ask a Member for a new one.",
  });

export function invites(options: { database: Database; secrets: Secrets }): BetterAuthPlugin {
  const { database, secrets } = options;

  // Makes Members one request at a time, so two requests with one link make one Member, and two
  // with one email address make one. The app is one Node process (ADR 0002), so this queue covers
  // every request.
  let queue: Promise<unknown> = Promise.resolve();
  const oneAtATime = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work);
    queue = run.catch(() => {});
    return run;
  };

  // The ID of the open invite whose token this is. Counts the token as wrong until it is checked;
  // a wrong token, and a token refused because too many were wrong, stay counted. Of tries at the
  // same time, only the first 5 in the window are checked.
  const tryToken = (ctx: EndpointContext, entered: string): Promise<string> =>
    tryLinkToken(database, ctx, {
      keyPrefix: "invite-ip:",
      find: () => openInviteOf(database, entered),
      tooMany: () =>
        APIError.from("TOO_MANY_REQUESTS", {
          code: "TOO_MANY_WRONG_INVITE_TOKENS",
          message: "Too many invite links that do not work. Wait 15 minutes, then try again.",
        }),
      notOpen,
    });

  // No two Members share an email address (spec 09, Members).
  async function refuseEmailInUse(
    adapter: { findUserByEmail(email: string): Promise<unknown> },
    address: string,
  ): Promise<void> {
    if ((await adapter.findUserByEmail(address)) !== null) {
      throw APIError.from("BAD_REQUEST", {
        code: "EMAIL_IN_USE",
        message: "Another Member has this email address. Use a different one.",
      });
    }
  }

  return {
    id: "invites",
    endpoints: {
      // The join page checks its link before the new Member types anything.
      checkInvite: createAuthEndpoint(
        "/invite/check",
        { method: "POST", body: z.object({ token }) },
        async (ctx) => {
          await tryToken(ctx, ctx.body.token);
          return ctx.json({ status: true });
        },
      ),

      newInviteTotp: createAuthEndpoint(
        "/invite/new-totp",
        { method: "POST", body: z.object({ token, email }) },
        async (ctx) => {
          const inviteId = await tryToken(ctx, ctx.body.token);
          const address = ctx.body.email.toLowerCase();
          const adapter = ctx.context.internalAdapter;
          await refuseEmailInUse(adapter, address);
          const secret = newTotpSecret();
          const identifier = newTotpIdentifier(inviteId);
          await adapter.deleteVerificationByIdentifier(identifier);
          await adapter.createVerificationValue({
            identifier,
            value: secrets.encrypt(secret, pendingPlace(identifier)),
            expiresAt: new Date(Date.now() + NEW_TOTP_WAIT_MS),
          });
          ctx.setHeader("Cache-Control", "no-store");
          return ctx.json({ totpURI: totpURI(secret, address) });
        },
      ),

      acceptInvite: createAuthEndpoint(
        "/invite/accept",
        {
          method: "POST",
          body: z.object({
            token,
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
            const inviteId = await tryToken(ctx, ctx.body.token);
            const address = ctx.body.email.toLowerCase();
            const adapter = ctx.context.internalAdapter;
            await refuseEmailInUse(adapter, address);

            const identifier = newTotpIdentifier(inviteId);
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
            // The link is used up here, after every check, so a refusal leaves it open.
            if (!(await claimInvite(database, inviteId, new Date()))) throw notOpen();

            const user = await adapter.createUser(
              { name: ctx.body.name, email: address, emailVerified: false, twoFactorEnabled: true },
              { method: "email-password" },
            );
            await adapter.linkAccount({
              userId: user.id,
              providerId: "credential",
              accountId: user.id,
              password: await ctx.context.password.hash(password),
            });
            const backupCodes = newBackupCodes();
            await ctx.context.adapter.create({
              model: "twoFactor",
              data: {
                userId: user.id,
                verified: true,
                ...(await storedTwoFactor(ctx.context.secretConfig, { secret, backupCodes })),
              },
            });
            // The code that made the Member cannot sign them in again.
            await claimTotpStep(database, user.id, step);
            await adapter.deleteVerificationByIdentifier(identifier);

            const session = await adapter.createSession(user.id);
            await setSessionCookie(ctx, { session, user });
            ctx.setHeader("Cache-Control", "no-store");
            return ctx.json({ backupCodes });
          }),
      ),
    },
  };
}
