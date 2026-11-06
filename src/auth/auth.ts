import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { isAPIError } from "better-auth/api";
import { twoFactor } from "better-auth/plugins/two-factor";
import { type Database, loginTables } from "../db/index.ts";
import { type Logger, log } from "../log.ts";
import type { Secrets } from "../secrets/index.ts";
import { firstMember } from "./first-member.ts";
import { invites, makeInvite } from "./invites.ts";
import { loginResets, makeLoginReset } from "./login-resets.ts";
import {
  APP_NAME,
  BACKUP_CODE_COUNT,
  myLogin,
  newTotpIdentifier,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
} from "./my-login.ts";
import { passkeyAnswer, passkeys, removeOtherHostPasskeys } from "./passkeys.ts";
import { sealedAdapter } from "./sealed-adapter.ts";
import { CLIENT_ADDRESS_HEADER, signInLimit } from "./sign-in-limit.ts";
import { totpOnce } from "./totp-once.ts";

export const AUTH_BASE_PATH = "/api/auth";

// Spec 09, Signing in.
export const MIN_PASSWORD_LENGTH = 12;
export const SESSION_SECONDS = 30 * 24 * 60 * 60;

// The only Better Auth routes the app answers. Every other route Better Auth has, such as sign-up,
// turning TOTP off, or reading the TOTP secret again, answers 404.
const ROUTES = new Set([
  "POST /sign-in/email",
  "POST /two-factor/verify-totp",
  "POST /two-factor/verify-backup-code",
  "POST /sign-out",
  "GET /get-session",
  "POST /my-login/change-password",
  "POST /my-login/new-totp",
  "POST /my-login/confirm-totp",
  "POST /my-login/new-backup-codes",
  "POST /first-member/check-code",
  "POST /first-member/new-totp",
  "POST /first-member/create",
  "POST /invite/check",
  "POST /invite/new-totp",
  "POST /invite/accept",
  "POST /login-reset/check",
  "POST /login-reset/new-totp",
  "POST /login-reset/finish",
  // Passkeys, over HTTPS only. Each refuses in plain-HTTP mode.
  "GET /passkey/generate-register-options",
  "POST /passkey/verify-registration",
  "GET /passkey/list-user-passkeys",
  "POST /passkey/delete-passkey",
  "GET /passkey/generate-authenticate-options",
  "POST /passkey/verify-authentication",
]);

export type SignedInMember = { id: string; name: string; email: string };

export type Auth = {
  // Answers a request under /api/auth/. The client address is the security check's
  // c.var.clientAddress, the only address Better Auth sees.
  handle(request: Request, clientAddress: string): Promise<Response>;
  // The Member signed in on this request, and the Set-Cookie headers that renew their session.
  signedIn(
    request: Request,
    clientAddress: string,
  ): Promise<{ member: SignedInMember; setCookies: string[] } | undefined>;
  // A new invite link's token, made by this Member, and when it stops working (spec 09, Invites).
  // The app keeps only its hash, so this is the one time anyone sees it.
  makeInvite(madeBy: string, at: Date): Promise<{ token: string; expiresAt: Date }>;
  // The one credential-removal hook, as a Member is removed (spec 09, Members): ends every session
  // of the Member at once, and deletes their password, TOTP, backup codes, passkeys, and a TOTP
  // secret waiting for its first code. It runs after the Member's row is deleted, whose foreign
  // keys already took most of these, and is safe to run again.
  removeLogin(memberId: string): Promise<void>;
  // "Reset login" and `fft reset-login` (spec 09, Login reset): a new reset link's token for the
  // Member, and when it stops working. The Member's sessions end, and their password, TOTP, backup
  // codes and passkeys are deleted, in the transaction that stores the link's hash; then the
  // credential-removal hook runs. Undefined, with nothing changed, when no Member has the ID.
  resetLogin(memberId: string, at: Date): Promise<{ token: string; expiresAt: Date } | undefined>;
  // The start's check (spec 09, Changing APP_URL): deletes every passkey made under another host
  // than APP_URL's, and adds one System notice for each Member who lost one, in one transaction.
  // Returns how many Members lost a passkey.
  removeOtherHostPasskeys(at: Date): Promise<number>;
};

export type AuthOptions = {
  database: Database;
  secrets: Secrets;
  // APP_URL's origin, such as https://money.example.com. Its scheme sets the Secure cookie flag.
  appOrigin: string;
  logger?: Logger;
};

// The request headers Better Auth sees: the security check's allowed headers, plus the client
// address it found.
function withClientAddress(headers: Headers, clientAddress: string): Headers {
  const copy = new Headers(headers);
  copy.set(CLIENT_ADDRESS_HEADER, clientAddress);
  return copy;
}

// Better Auth's log lines go through the app's logger, which refuses secret fields and values.
function loggerFor(logger: Logger) {
  return {
    level: "warn" as const,
    log(level: "debug" | "info" | "warn" | "error", message: string, ...details: unknown[]) {
      const write = level === "error" ? logger.error : level === "warn" ? logger.warn : logger.info;
      try {
        write(`Better Auth: ${message}`, { details });
      } catch {
        // Only in tests and development, where the logger throws on a secret instead of refusing it.
        write("Better Auth wrote a line that held a secret");
      }
    },
  };
}

// Better Auth writes each refused request's message to stderr, outside the logger, and a message
// can repeat a value the client sent, such as its Content-Type. This writes one line through the
// logger instead, with the status and code only.
function apiErrorsFor(logger: Logger) {
  return (error: unknown) => {
    if (isAPIError(error)) {
      const fields = { status: error.status, code: error.body?.code };
      if (error.statusCode >= 500) logger.error("Better Auth failed a request", fields);
      else logger.warn("Better Auth refused a request", fields);
      return;
    }
    try {
      logger.error("Better Auth failed a request", { error });
    } catch {
      // Only in tests and development, where the logger throws on a secret instead of refusing it.
      logger.error("Better Auth failed a request, and its error held a secret");
    }
  };
}

function buildBetterAuth(options: AuthOptions) {
  const { database, secrets, appOrigin } = options;
  // The login signing secret signs session cookies and encrypts TOTP secrets and backup codes.
  const signingSecret = secrets.derive("login signing secret").toString("hex");
  const passkey = passkeys({ appOrigin });

  const auth = betterAuth({
    appName: APP_NAME,
    baseURL: appOrigin,
    basePath: AUTH_BASE_PATH,
    secret: signingSecret,
    trustedOrigins: [appOrigin],
    database: (betterAuthOptions: BetterAuthOptions) =>
      sealedAdapter(
        drizzleAdapter(database, { provider: "sqlite", schema: loginTables })(betterAuthOptions),
        secrets,
      ),
    emailAndPassword: {
      enabled: true,
      // Members join only by invite (T95), and the first-run wizard makes the first through
      // first-member.ts.
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      autoSignIn: false,
    },
    user: { changeEmail: { enabled: false }, deleteUser: { enabled: false } },
    session: {
      expiresIn: SESSION_SECONDS,
      // Renews the session each time the Member uses the app.
      updateAge: 0,
      cookieCache: { enabled: false },
      // Better Auth's "fresh session" age, which its passkey plugin asks of a Member who adds a
      // passkey, is off: the Member's current password stands for it instead.
      freshAge: 0,
    },
    rateLimit: { enabled: true, storage: "database" },
    advanced: {
      cookiePrefix: "fft",
      useSecureCookies: appOrigin.startsWith("https://"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
      ipAddress: { ipAddressHeaders: [CLIENT_ADDRESS_HEADER] },
      // Better Auth turns both checks off under NODE_ENV=test. Tests must see what runs.
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },
    telemetry: { enabled: false },
    logger: loggerFor(options.logger ?? log),
    onAPIError: { onError: apiErrorsFor(options.logger ?? log) },
    plugins: [
      myLogin({ database, secrets }),
      firstMember({ database, secrets }),
      invites({ database, secrets }),
      loginResets({ database, secrets }),
      signInLimit(database),
      // After the sign-in limit, so that a used code counts as a failed sign-in.
      totpOnce(database),
      twoFactor({
        issuer: APP_NAME,
        totpOptions: { digits: TOTP_DIGITS, period: TOTP_PERIOD_SECONDS },
        backupCodeOptions: { amount: BACKUP_CODE_COUNT, storeBackupCodes: "encrypted" },
        // The sign-in limit counts every failed password and code instead.
        accountLockout: { enabled: false },
      }),
      passkey.rules,
      passkey.plugin,
    ],
  });

  return { auth };
}

export type BetterAuthInstance = ReturnType<typeof buildBetterAuth>["auth"];

// For the auth module's tests only.
const instances = new WeakMap<Auth, BetterAuthInstance>();

export function betterAuthOf(auth: Auth): BetterAuthInstance {
  const instance = instances.get(auth);
  if (instance === undefined) throw new Error("This Auth was not made by createAuth.");
  return instance;
}

export function createAuth(options: AuthOptions): Auth {
  const { auth } = buildBetterAuth(options);

  const made: Auth = {
    async handle(request, clientAddress) {
      const path = new URL(request.url).pathname.slice(AUTH_BASE_PATH.length);
      if (!ROUTES.has(`${request.method} ${path}`)) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      const headers = withClientAddress(request.headers, clientAddress);
      const res = await auth.handler(
        new Request(request, { headers, duplex: "half" } as RequestInit),
      );
      return passkeyAnswer(path, res);
    },

    async signedIn(request, clientAddress) {
      const headers = withClientAddress(request.headers, clientAddress);
      const { headers: responseHeaders, response } = await auth.api.getSession({
        headers,
        returnHeaders: true,
      });
      if (!response) return undefined;
      const { id, name, email } = response.user;
      return { member: { id, name, email }, setCookies: responseHeaders.getSetCookie() };
    },

    makeInvite: (madeBy, at) => makeInvite(options.database, madeBy, at),

    async removeLogin(memberId) {
      const context = await auth.$context;
      await context.internalAdapter.deleteUserSessions(memberId);
      await context.internalAdapter.deleteAccounts(memberId);
      await context.adapter.deleteMany({
        model: "passkey",
        where: [{ field: "userId", value: memberId }],
      });
      await context.adapter.deleteMany({
        model: "twoFactor",
        where: [{ field: "userId", value: memberId }],
      });
      await context.internalAdapter.deleteVerificationByIdentifier(newTotpIdentifier(memberId));
    },

    async resetLogin(memberId, at) {
      const reset = await makeLoginReset(options.database, memberId, at);
      if (reset !== undefined) await made.removeLogin(memberId);
      return reset;
    },

    removeOtherHostPasskeys: (at) =>
      removeOtherHostPasskeys(options.database, options.appOrigin, at),
  };
  instances.set(made, auth);
  return made;
}
