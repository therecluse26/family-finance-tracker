import { type BetterAuthOptions, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { isAPIError } from "better-auth/api";
import { twoFactor } from "better-auth/plugins/two-factor";
import { type Database, loginTables } from "../db/index.ts";
import { type Logger, log } from "../log.ts";
import type { Secrets } from "../secrets/index.ts";
import { firstMember } from "./first-member.ts";
import { invites, makeInvite } from "./invites.ts";
import {
  APP_NAME,
  BACKUP_CODE_COUNT,
  myLogin,
  newTotpIdentifier,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
} from "./my-login.ts";
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
]);

// A TOTP code is 6 digits. A backup code is two groups of 5 letters and digits.
const TOTP_CODE = /^\d{6}$/;

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
  // The sensitive-action helper: "fresh" only for a fresh TOTP or backup code from the Member
  // signed in on this request. A wrong code counts as a failed sign-in, and a backup code is used
  // up. Past the failed sign-in limit, every code is "too many tries" without being checked.
  checkFreshCode(request: Request, clientAddress: string, code: string): Promise<FreshCode>;
  // A new invite link's token, made by this Member, and when it stops working (spec 09, Invites).
  // The app keeps only its hash, so this is the one time anyone sees it.
  makeInvite(madeBy: string, at: Date): Promise<{ token: string; expiresAt: Date }>;
  // The one credential-removal hook, as a Member is removed (spec 09, Members): ends every session
  // of the Member at once, and deletes their password, TOTP, backup codes, and a TOTP secret waiting
  // for its first code. It runs after the Member's row is deleted, whose foreign keys already took
  // most of these, and is safe to run again. Passkeys (T97) join here.
  removeLogin(memberId: string): Promise<void>;
};

export type FreshCode = "fresh" | "wrong" | "too many tries";

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

function buildBetterAuth(options: AuthOptions) {
  const { database, secrets, appOrigin } = options;
  // The login signing secret signs session cookies and encrypts TOTP secrets and backup codes.
  const signingSecret = secrets.derive("login signing secret").toString("hex");
  const fresh = { check: async (_headers: Headers, _code: string) => false };

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
    plugins: [
      myLogin({ database, secrets, freshCode: (headers, code) => fresh.check(headers, code) }),
      firstMember({ database, secrets }),
      invites({ database, secrets }),
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
    ],
  });

  fresh.check = async (headers, code) => {
    if (!(await auth.api.getSession({ headers }))) return false;
    try {
      if (TOTP_CODE.test(code)) await auth.api.verifyTOTP({ headers, body: { code } });
      else await auth.api.verifyBackupCode({ headers, body: { code, disableSession: true } });
      return true;
    } catch (error) {
      if (isAPIError(error) && error.status === "UNAUTHORIZED") return false;
      throw error;
    }
  };

  return { auth, checkFreshCode: fresh.check };
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
  const { auth, checkFreshCode } = buildBetterAuth(options);

  const made: Auth = {
    async handle(request, clientAddress) {
      const path = new URL(request.url).pathname.slice(AUTH_BASE_PATH.length);
      if (!ROUTES.has(`${request.method} ${path}`)) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      const headers = withClientAddress(request.headers, clientAddress);
      return auth.handler(new Request(request, { headers, duplex: "half" } as RequestInit));
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

    async checkFreshCode(request, clientAddress, code) {
      try {
        const headers = withClientAddress(request.headers, clientAddress);
        return (await checkFreshCode(headers, code)) ? "fresh" : "wrong";
      } catch (error) {
        // The sign-in limit's refusal. Better Auth's own routes answer it as 429 by themselves.
        if (isAPIError(error) && error.status === "TOO_MANY_REQUESTS") return "too many tries";
        throw error;
      }
    },

    makeInvite: (madeBy, at) => makeInvite(options.database, madeBy, at),

    async removeLogin(memberId) {
      const context = await auth.$context;
      await context.internalAdapter.deleteUserSessions(memberId);
      await context.internalAdapter.deleteAccounts(memberId);
      await context.adapter.deleteMany({
        model: "twoFactor",
        where: [{ field: "userId", value: memberId }],
      });
      await context.internalAdapter.deleteVerificationByIdentifier(newTotpIdentifier(memberId));
    },
  };
  instances.set(made, auth);
  return made;
}
