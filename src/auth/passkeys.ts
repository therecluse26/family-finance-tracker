import { passkey } from "@better-auth/passkey";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { type Database, removePasskeysUnderOtherHosts } from "../db/index.ts";
import { APP_NAME, isCurrentPassword, wrongPassword } from "./my-login.ts";

// Passkeys (spec 09, Signing in): over HTTPS, a Member adds passkeys in Settings, My login, and a
// passkey alone signs them in, with no TOTP code. Better Auth's passkey plugin runs each WebAuthn
// ceremony; these are the house rules around it:
// - in plain-HTTP mode every passkey route refuses;
// - adding a passkey asks for the Member's current password, as a password change does, so a
//   stolen session cannot add a way back in (spec 09, Sensitive actions);
// - the authenticator must verify the Member, by a PIN or a fingerprint, at each ceremony, since
//   the passkey then stands in for the password and the TOTP code;
// - each passkey keeps the APP_URL host it was made under, and the start deletes every passkey
//   made under another (spec 09, Changing APP_URL).

// The longest name a Member may give a passkey.
export const PASSKEY_NAME_MAX = 60;

export const PASSKEYS_NEED_HTTPS =
  "Passkeys need HTTPS. This app runs in plain-HTTP mode: its address starts with http://, and browsers make passkeys only for an https:// address. Sign in with your password and TOTP.";

// The WebAuthn RP ID: APP_URL's host without its port, as the URL parser writes it. APP_URL's
// origin comes from that same parser (src/server/app-url.ts), so the browser's origin and RP ID
// match these exactly or not at all.
export function passkeyHostOf(appOrigin: string): string {
  return new URL(appOrigin).hostname;
}

// The System notice for a Member whose passkeys the start deleted.
export function passkeysGoneText(memberName: string): string {
  return `The app's web address changed, so it deleted ${memberName}'s passkeys, which worked only at the old address. ${memberName} signs in with password and TOTP, and may add a new passkey in Settings, My login.`;
}

const notVerified = () =>
  APIError.from("UNAUTHORIZED", {
    code: "MEMBER_NOT_VERIFIED",
    message: "The passkey did not check that it was you, by a PIN or a fingerprint. Try again.",
  });

export function passkeys(options: { appOrigin: string }): {
  rules: BetterAuthPlugin;
  plugin: BetterAuthPlugin;
} {
  const { appOrigin } = options;
  const https = appOrigin.startsWith("https://");
  const host = passkeyHostOf(appOrigin);

  const rules: BetterAuthPlugin = {
    id: "passkey-rules",
    schema: {
      passkey: {
        fields: {
          // Set as each passkey is stored, in the same row write.
          appHost: { type: "string", required: true, input: false, defaultValue: () => host },
        },
      },
    },
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path?.startsWith("/passkey/") === true,
          handler: createAuthMiddleware(async () => {
            if (!https) {
              throw APIError.from("FORBIDDEN", {
                code: "PASSKEYS_NEED_HTTPS",
                message: PASSKEYS_NEED_HTTPS,
              });
            }
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/passkey/verify-registration",
          handler: createAuthMiddleware(async (ctx) => {
            const body = (ctx.body ?? {}) as { currentPassword?: unknown; name?: unknown };
            if (typeof body.name === "string" && body.name.trim().length > PASSKEY_NAME_MAX) {
              throw APIError.from("BAD_REQUEST", {
                code: "PASSKEY_NAME_LENGTH",
                message: `A passkey's name has at most ${PASSKEY_NAME_MAX} characters.`,
              });
            }
            const password = typeof body.currentPassword === "string" ? body.currentPassword : "";
            const session = await getSessionFromCtx(ctx);
            if (!session || !(await isCurrentPassword(ctx.context, session.user.id, password))) {
              throw wrongPassword();
            }
          }),
        },
      ],
    },
  };

  const plugin = passkey({
    rpID: host,
    rpName: APP_NAME,
    // Exactly APP_URL's origin, never the request's Origin header.
    origin: appOrigin,
    // A discoverable credential, so sign-in needs no email address first.
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    advanced: { webAuthnChallengeCookie: "passkey-challenge" },
    registration: {
      afterVerification: ({ verification }) => {
        if (verification.registrationInfo?.userVerified !== true) throw notVerified();
      },
    },
    authentication: {
      afterVerification: ({ verification }) => {
        if (!verification.authenticationInfo.userVerified) throw notVerified();
      },
    },
  });

  return { rules, plugin };
}

// Better Auth answers 500 to a new passkey that fails its checks, such as one made for another
// origin. That is the browser's answer, not the app's failure, so the Member gets 400.
export async function passkeyAnswer(path: string, res: Response): Promise<Response> {
  if (path !== "/passkey/verify-registration" || res.status !== 500) return res;
  const body = (await res
    .clone()
    .json()
    .catch(() => ({}))) as { code?: unknown };
  if (body.code !== "FAILED_TO_VERIFY_REGISTRATION") return res;
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return Response.json(
    { code: "PASSKEY_NOT_ADDED", message: "The app could not check this passkey. Try again." },
    { status: 400, headers },
  );
}

// The start's check (spec 09, Changing APP_URL): deletes every passkey made under another host than
// APP_URL's, with one System notice for each Member who lost one. Returns how many Members did.
export async function removeOtherHostPasskeys(
  database: Database,
  appOrigin: string,
  at: Date,
): Promise<number> {
  const lost = await removePasskeysUnderOtherHosts(database, {
    host: passkeyHostOf(appOrigin),
    at,
    noticeText: passkeysGoneText,
  });
  return lost.length;
}
