import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { betterAuthOf } from "../auth/auth.ts";
import {
  addMember,
  newTestAuth,
  type TestAuth,
  type TestMember,
  totpCodeFromURI,
} from "../auth/testing.ts";
import { closeDatabase, openDatabase } from "../db/index.ts";
import { createLogger } from "../log.ts";
import { createApp } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";

// Members sign in through the app's HTTP interface, as a browser does: the security check, then
// Better Auth under /api/auth/. Each test gets a new app.db and Master key.

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;
const SESSION_SECONDS = 30 * 24 * 60 * 60;
// One TOTP time step. A code can be used once, so a test that needs a second code moves on one step.
const TOTP_STEP_MS = 30 * SECOND_MS;
// Better Auth's own limit allows 3 sign-in tries per 10 seconds from one address.
const BURST_WINDOW_MS = 10 * SECOND_MS;

type Mode = {
  name: string;
  appUrl: string;
  trustedProxies: string;
  // The socket address and headers a request comes with, for a client at this address.
  from(client: string): { source: string; headers: Record<string, string> };
  sessionCookie: string;
};

const PLAIN: Mode = {
  name: "plain-HTTP mode",
  appUrl: "http://nas.local:8080",
  trustedProxies: "",
  from: (client) => ({ source: client, headers: {} }),
  sessionCookie: "fft.session_token",
};

const HTTPS: Mode = {
  name: "HTTPS mode",
  appUrl: "https://money.example.com",
  trustedProxies: "10.0.0.2",
  from: (client) => ({
    source: "10.0.0.2",
    headers: { "x-forwarded-proto": "https", "x-forwarded-for": client },
  }),
  sessionCookie: "__Secure-fft.session_token",
};

type App = ReturnType<typeof createApp>;

// One browser: its own cookies, at one client address.
class Browser {
  readonly cookies = new Map<string, string>();
  readonly setCookies: string[] = [];

  private readonly app: App;
  private readonly mode: Mode;
  readonly client: string;

  constructor(app: App, mode: Mode, client: string) {
    this.app = app;
    this.mode = mode;
    this.client = client;
  }

  // A header given as "" is left out.
  async send(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const { source, headers: fromClient } = this.mode.from(this.client);
    const url = new URL(this.mode.appUrl);
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const all: Record<string, string> = {
      host: url.host,
      origin: url.origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie === "" ? {} : { cookie }),
      ...fromClient,
      ...headers,
    };
    const res = await this.app.request(
      `${this.mode.appUrl}${path}`,
      {
        method,
        headers: Object.fromEntries(Object.entries(all).filter(([, value]) => value !== "")),
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      { incoming: { socket: { remoteAddress: source } } },
    );
    for (const line of res.headers.getSetCookie()) {
      this.setCookies.push(line);
      const [pair = ""] = line.split(";");
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (/max-age=0/i.test(line) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  post = (path: string, body: unknown = {}, headers?: Record<string, string>) =>
    this.send("POST", path, body, headers);

  get = (path: string) => this.send("GET", path);

  // The password step. A Member with TOTP then waits for a code.
  password = (member: TestMember, password = member.password) =>
    this.post("/api/auth/sign-in/email", { email: member.email, password });

  totp = (code: string) => this.post("/api/auth/two-factor/verify-totp", { code });

  backupCode = (code: string) => this.post("/api/auth/two-factor/verify-backup-code", { code });

  async signIn(member: TestMember, password = member.password): Promise<void> {
    expect((await this.password(member, password)).status).toBe(200);
    expect((await this.totp(await member.totpCode())).status).toBe(200);
  }

  // Whether a route that needs a session lets this browser in.
  async isSignedIn(): Promise<boolean> {
    const res = await this.get("/api/ping");
    if (res.status !== 200 && res.status !== 401)
      throw new Error(`/api/ping answered ${res.status}`);
    return res.status === 200;
  }
}

// A code that is not this one: each digit moved by one.
const wrong = (code: string) => code.replace(/\d/g, (digit) => String((Number(digit) + 1) % 10));

async function tooManyFailed(res: Response): Promise<void> {
  expect(res.status).toBe(429);
  expect(await res.json()).toEqual(expect.objectContaining({ code: "TOO_MANY_FAILED_SIGN_INS" }));
}

// Moves the clock that the app, Better Auth, and TOTP codes read.
function later(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

// A cookie Better Auth would accept, if `secret` were its signing secret.
async function signedCookie(token: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(token));
  return encodeURIComponent(`${token}.${Buffer.from(signature).toString("base64")}`);
}

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-login-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe.each([PLAIN, HTTPS])("signing in, in $name", (mode) => {
  let test: TestAuth;
  let app: App;
  let lines: string[];
  let alice: TestMember;
  let bob: TestMember;
  let clients = 0;

  // A browser at a new client address.
  const browser = (client?: string) => {
    clients += 1;
    return new Browser(app, mode, client ?? `192.168.1.${clients}`);
  };

  const query = async (sql: string, args: (string | number)[] = []) =>
    (await test.database.$client.execute({ sql, args })).rows;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    lines = [];
    const logger = createLogger((line) => lines.push(line), { throwOnSecretField: true });
    test = await newTestAuth(new URL(mode.appUrl).origin, logger);
    const security = await loadSecurity(
      { APP_URL: mode.appUrl, TRUSTED_PROXIES: mode.trustedProxies },
      { logger },
    );
    app = createApp(webRoot, security, test.auth, test.database, test.secrets);
    alice = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    bob = await addMember(test.auth, { name: "Bob", email: "bob@example.com" });
  });

  afterEach(() => {
    vi.useRealTimers();
    test.close();
  });

  // Tests whose result does not depend on the security mode run once, in plain-HTTP mode.
  const once = (name: string, tests: () => void) => {
    if (mode === PLAIN) describe(name, tests);
  };

  describe("sign-in", () => {
    it("takes the password, then a TOTP code, and only then makes a session", async () => {
      const tab = browser();

      const first = await tab.password(alice);
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual(expect.objectContaining({ twoFactorRedirect: true }));
      expect(await tab.isSignedIn()).toBe(false);

      expect((await tab.totp(await alice.totpCode())).status).toBe(200);
      expect(await tab.isSignedIn()).toBe(true);
      const session = (await (await tab.get("/api/auth/get-session")).json()) as { user: unknown };
      expect(session.user).toEqual(expect.objectContaining({ id: alice.id, email: alice.email }));
    });
  });

  once("sign-in rules", () => {
    it("refuses a wrong password, and makes no session", async () => {
      const tab = browser();

      const res = await tab.password(alice, `${alice.password}x`);

      expect(res.status).toBe(401);
      expect((await tab.totp(await alice.totpCode())).status).toBe(401);
      expect(await tab.isSignedIn()).toBe(false);
    });

    it("refuses a wrong TOTP code, and makes no session", async () => {
      const tab = browser();
      await tab.password(alice);

      const res = await tab.totp(wrong(await alice.totpCode()));

      expect(res.status).toBe(401);
      expect(await tab.isSignedIn()).toBe(false);
    });

    it("accepts the TOTP code of the 30 seconds before or after, and no other", async () => {
      const tab = browser();
      await tab.password(alice);
      later(-90 * SECOND_MS);
      const old = await alice.totpCode();
      later(60 * SECOND_MS);
      const previous = await alice.totpCode();
      later(30 * SECOND_MS);

      expect((await tab.totp(old)).status).toBe(401);
      expect((await tab.totp(previous)).status).toBe(200);
    });

    it("accepts a backup code in place of a TOTP code, once", async () => {
      const [code = ""] = alice.backupCodes;
      const first = browser();
      const second = browser();

      await first.password(alice);
      expect((await first.backupCode(code)).status).toBe(200);
      expect(await first.isSignedIn()).toBe(true);

      await second.password(alice);
      expect((await second.backupCode(code)).status).toBe(401);
      expect(await second.isSignedIn()).toBe(false);
    });

    // 10 password sign-ins, each a slow hash on purpose, so a busy host gets more than 5 seconds.
    it("gives each Member 10 backup codes, each of which works", { timeout: 30_000 }, async () => {
      expect(alice.backupCodes).toHaveLength(10);

      for (const code of alice.backupCodes) {
        later(BURST_WINDOW_MS);
        const tab = browser();
        await tab.password(alice);
        expect((await tab.backupCode(code)).status, code).toBe(200);
      }
    });

    it("refuses a Member who has no TOTP, so there is no password-only sign-in", async () => {
      const carol = await addMember(test.auth, {
        name: "Carol",
        email: "carol@example.com",
        withTotp: false,
      });
      const tab = browser();

      const res = await tab.password(carol);

      expect(res.status).toBe(403);
      expect(await tab.isSignedIn()).toBe(false);
      expect(await query("SELECT id FROM sessions WHERE member_id = ?", [carol.id])).toEqual([]);
    });

    it("refuses to trust a device, so each sign-in asks for a code", async () => {
      const tab = browser();
      await tab.password(alice);

      const res = await tab.post("/api/auth/two-factor/verify-totp", {
        code: await alice.totpCode(),
        trustDevice: true,
      });

      expect(res.status).toBe(400);
      expect(await tab.isSignedIn()).toBe(false);
    });

    it("refuses a session shorter than 30 days", async () => {
      const tab = browser();

      const res = await tab.post("/api/auth/sign-in/email", {
        email: alice.email,
        password: alice.password,
        rememberMe: false,
      });

      expect(res.status).toBe(400);
    });

    it("finds the Member by email in any letter case, and no two Members share one", async () => {
      const tab = browser();
      expect((await tab.password({ ...alice, email: "ALICE@Example.com" })).status).toBe(200);

      await expect(
        addMember(test.auth, { name: "Other Alice", email: "Alice@example.com" }),
      ).rejects.toThrow();
    });

    it("signs a Member out", async () => {
      const tab = browser();
      await tab.signIn(alice);

      expect((await tab.post("/api/auth/sign-out")).status).toBe(200);

      expect(await tab.isSignedIn()).toBe(false);
    });

    it.each([
      ["POST", "/api/auth/sign-up/email"],
      ["POST", "/api/auth/two-factor/enable"],
      ["POST", "/api/auth/two-factor/disable"],
      ["POST", "/api/auth/two-factor/get-totp-uri"],
      ["POST", "/api/auth/two-factor/generate-backup-codes"],
      ["POST", "/api/auth/two-factor/send-otp"],
      ["POST", "/api/auth/change-password"],
      ["POST", "/api/auth/change-email"],
      ["POST", "/api/auth/update-user"],
      ["POST", "/api/auth/delete-user"],
      ["POST", "/api/auth/request-password-reset"],
      ["GET", "/api/auth/list-sessions"],
      ["GET", "/api/auth/sign-in/email"],
    ])("answers %s %s with 404, even with a session", async (method, path) => {
      const tab = browser();
      await tab.signIn(alice);

      const res = await tab.send(method, path, method === "POST" ? {} : undefined);

      expect(res.status).toBe(404);
    });
  });

  once("passwords", () => {
    it("stores only a hash", async () => {
      const rows = await query("SELECT password FROM accounts WHERE member_id = ?", [alice.id]);

      expect(rows).toHaveLength(1);
      expect(String(rows[0]?.password)).not.toContain(alice.password);
      expect(readFileSync(test.path, "latin1")).not.toContain(alice.password);
    });
  });

  describe("sessions", () => {
    it("sets the session cookie HttpOnly and SameSite=Lax, Secure only in HTTPS mode, for 30 days", async () => {
      const tab = browser();
      await tab.signIn(alice);

      const cookie = tab.setCookies.find(
        (line) => line.startsWith(`${mode.sessionCookie}=`) && !line.includes("=;"),
      );
      expect(cookie).toBeDefined();
      const attributes = (cookie ?? "").split(/;\s*/).map((part) => part.toLowerCase());
      expect(attributes).toContain("httponly");
      expect(attributes).toContain("samesite=lax");
      expect(attributes).toContain("path=/");
      expect(attributes).toContain(`max-age=${SESSION_SECONDS}`);
      expect(attributes.includes("secure")).toBe(mode === HTTPS);
      for (const line of tab.setCookies) {
        expect(line.toLowerCase()).toContain("httponly");
        expect(line.toLowerCase()).toContain("samesite=lax");
        expect(line.toLowerCase().includes("; secure")).toBe(mode === HTTPS);
      }
    });

    it("cannot be forged from a copy of app.db without the Master key", async () => {
      const tab = browser();
      await tab.signIn(alice);
      // The attacker's copy: app.db and its write-ahead log, as a backup or a stolen disk holds them.
      const copy = join(mkdtempSync(join(tmpdir(), "fft-copy-")), "app.db");
      copyFileSync(test.path, copy);
      if (existsSync(`${test.path}-wal`)) copyFileSync(`${test.path}-wal`, `${copy}-wal`);
      const copied = await openDatabase(`file:${copy}`);
      const [row] = (await copied.$client.execute("SELECT token FROM sessions")).rows;
      closeDatabase(copied);
      const token = String(row?.token);
      const files = [copy, `${copy}-wal`].filter((file) => existsSync(file));
      const bytes = files.map((file) => readFileSync(file, "latin1")).join("");
      const signingSecret = test.secrets.derive("login signing secret");
      const attacker = browser();
      const tryCookie = async (value: string) => {
        attacker.cookies.clear();
        attacker.cookies.set(mode.sessionCookie, value);
        return attacker.isSignedIn();
      };

      for (const form of ["hex", "base64", "base64url"] as const) {
        expect(bytes).not.toContain(signingSecret.toString(form));
      }
      expect(await tryCookie(token)).toBe(false);
      expect(await tryCookie(`${token}.`)).toBe(false);
      expect(await tryCookie(await signedCookie(token, crypto.randomUUID()))).toBe(false);
      // The same cookie signed with the signing secret, which only the Master key gives, works.
      expect(await tryCookie(await signedCookie(token, signingSecret.toString("hex")))).toBe(true);
    });
  });

  once("session lifetime and the API", () => {
    it("lasts 30 days, and renews each time the Member uses the app", async () => {
      const tab = browser();
      await tab.signIn(alice);
      const expiry = async () =>
        new Date(
          String(
            (await query("SELECT expires_at FROM sessions WHERE member_id = ?", [alice.id]))[0]
              ?.expires_at,
          ),
        ).getTime();

      expect(await expiry()).toBe(Date.now() + SESSION_SECONDS * SECOND_MS);
      later(MINUTE_MS);
      expect(await tab.isSignedIn()).toBe(true);
      expect(await expiry()).toBe(Date.now() + SESSION_SECONDS * SECOND_MS);
      later(29 * DAY_MS);
      tab.setCookies.length = 0;
      expect(await tab.isSignedIn()).toBe(true);
      expect(await expiry()).toBe(Date.now() + SESSION_SECONDS * SECOND_MS);
      expect(tab.setCookies.find((line) => line.startsWith(`${mode.sessionCookie}=`))).toMatch(
        new RegExp(`Max-Age=${SESSION_SECONDS}`),
      );

      later(29 * DAY_MS);
      expect(await tab.isSignedIn()).toBe(true);

      later(30 * DAY_MS + SECOND_MS);
      expect(await tab.isSignedIn()).toBe(false);
    });

    it.each(["/api/ping", "/api/security-mode", "/api/nothing-here"])(
      "answers %s with 401 and no data without a session",
      async (path) => {
        const res = await browser().get(path);

        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "Sign in first" });
      },
    );

    it("answers an unknown /api path with 404 once signed in", async () => {
      const tab = browser();
      await tab.signIn(alice);

      expect((await tab.get("/api/nothing-here")).status).toBe(404);
    });
  });

  once("TOTP secrets and backup codes in app.db", () => {
    it("are encrypted, and appear nowhere in app.db", async () => {
      const tab = browser();
      await tab.signIn(alice);
      const bytes = [test.path, `${test.path}-wal`]
        .filter((file) => existsSync(file))
        .map((file) => readFileSync(file, "latin1"))
        .join("");

      for (const value of [alice.totpSecret, bob.totpSecret, ...alice.backupCodes]) {
        expect(bytes).not.toContain(value);
      }
    });

    it("are bound to their row, so a TOTP secret moved to another Member does not work", async () => {
      const [aliceRow] = await query("SELECT secret FROM two_factors WHERE member_id = ?", [
        alice.id,
      ]);
      await query("UPDATE two_factors SET secret = ? WHERE member_id = ?", [
        String(aliceRow?.secret),
        bob.id,
      ]);
      const tab = browser();
      await tab.password(bob);

      const res = await tab.totp(await alice.totpCode());

      expect(res.status).not.toBe(200);
      expect(await tab.isSignedIn()).toBe(false);
    });
  });

  describe("failed sign-ins by IP address", () => {
    it("allows 5 per 15 minutes from an IP address, then refuses any Member's right password there", async () => {
      const members = [alice, bob];
      const tab = browser("203.0.113.7");
      for (let i = 0; i < 5; i += 1) {
        later(BURST_WINDOW_MS);
        const member = members[i % 2] ?? alice;
        expect((await tab.password(member, `wrong password ${i}`)).status).toBe(401);
      }

      later(BURST_WINDOW_MS);
      await tooManyFailed(await tab.password(bob));
      expect((await browser("203.0.113.8").password(bob)).status).toBe(200);

      later(15 * MINUTE_MS);
      expect((await tab.password(bob)).status).toBe(200);
    });

    it("counts every IPv6 address in one /64 network as one address", async () => {
      const members = [alice, bob];
      for (let i = 0; i < 5; i += 1) {
        later(BURST_WINDOW_MS);
        const member = members[i % 2] ?? alice;
        const tab = browser(`2001:db8:1:2::${i + 1}`);
        expect((await tab.password(member, `wrong password ${i}`)).status).toBe(401);
      }

      later(BURST_WINDOW_MS);
      await tooManyFailed(await browser("2001:db8:1:2:ffff:ffff:ffff:fff6").password(bob));
      expect((await browser("2001:db8:1:3::6").password(bob)).status).toBe(200);
    });

    it("uses the client address from the security check, not a header the client sent", async () => {
      const tab = browser("198.51.100.4");
      for (let i = 0; i < 5; i += 1) {
        later(BURST_WINDOW_MS);
        const spoofed = { "x-fft-client-address": `203.0.113.${i}`, "x-real-ip": `203.0.113.${i}` };
        await tab.post(
          "/api/auth/sign-in/email",
          { email: `nobody${i}@example.com`, password: "x".repeat(12) },
          spoofed,
        );
      }

      later(BURST_WINDOW_MS);
      await tooManyFailed(
        await tab.post(
          "/api/auth/sign-in/email",
          { email: bob.email, password: bob.password },
          {
            "x-fft-client-address": "203.0.113.99",
          },
        ),
      );
      later(BURST_WINDOW_MS);
      const other = browser("198.51.100.5");
      await other.signIn(bob);
      const rows = await query("SELECT ip_address FROM sessions WHERE member_id = ?", [bob.id]);
      expect(rows.map((row) => row.ip_address)).toEqual(["198.51.100.5"]);
    });
  });

  once("failed sign-ins by Member", () => {
    it("allows 5 per 15 minutes for a Member, then refuses the right password without checking it", async () => {
      for (let i = 0; i < 5; i += 1) {
        expect((await browser().password(alice, `wrong password ${i}`)).status).toBe(401);
      }

      await tooManyFailed(await browser().password(alice));
      expect((await browser().password(bob)).status).toBe(200);

      later(15 * MINUTE_MS + SECOND_MS);
      const tab = browser();
      await tab.signIn(alice);
      expect(await tab.isSignedIn()).toBe(true);
    });

    it("counts wrong TOTP and backup codes with wrong passwords", async () => {
      const tab = browser();
      await tab.password(alice, "wrong password");
      await tab.password(alice);
      for (const code of [wrong(await alice.totpCode()), "aaaaa-aaaaa", "000000"]) {
        later(BURST_WINDOW_MS);
        const check = code.includes("-") ? tab.backupCode(code) : tab.totp(code);
        expect((await check).status).toBe(401);
      }
      later(BURST_WINDOW_MS);
      expect((await tab.totp(wrong(await alice.totpCode()))).status).toBe(401);

      later(BURST_WINDOW_MS);
      await tooManyFailed(await tab.totp(await alice.totpCode()));
      await tooManyFailed(await browser().password(alice));
      expect(await tab.isSignedIn()).toBe(false);
    });

    it("checks at most 5 of many tries at the same time", async () => {
      const tries = Array.from({ length: 12 }, (_, i) =>
        browser().password(alice, `wrong password ${i}`),
      );

      const statuses = (await Promise.all(tries)).map((res) => res.status).sort();

      expect(statuses).toEqual([...Array(5).fill(401), ...Array(7).fill(429)]);
    });

    it("does not count a right password, or a refused try", async () => {
      for (let i = 0; i < 4; i += 1) await browser().password(alice, `wrong password ${i}`);
      for (let i = 0; i < 3; i += 1) expect((await browser().password(alice)).status).toBe(200);
      await browser().password(alice, "wrong password 5");
      await tooManyFailed(await browser().password(alice));
      await tooManyFailed(await browser().password(alice));

      // The 5th failure ages out first, 15 minutes after it.
      later(15 * MINUTE_MS + SECOND_MS);
      expect((await browser().password(alice)).status).toBe(200);
    });
  });

  describe("Better Auth's own rate limit", () => {
    it("allows 3 sign-in requests per 10 seconds from one address, right or wrong", async () => {
      const tab = browser();
      for (let i = 0; i < 3; i += 1) expect((await tab.password(alice)).status).toBe(200);

      const res = await tab.password(alice);

      expect(res.status).toBe(429);
      expect((await browser().password(alice)).status).toBe(200);
      later(BURST_WINDOW_MS);
      expect((await tab.password(alice)).status).toBe(200);
    });
  });

  describe("cross-site requests", () => {
    it("refuses a sign-in posted from another origin", async () => {
      const res = await browser().post(
        "/api/auth/sign-in/email",
        { email: alice.email, password: alice.password },
        { origin: "https://evil.example" },
      );

      expect(res.status).toBe(403);
    });

    it("refuses a sign-in form that another site navigates to, by its Fetch Metadata", async () => {
      const res = await browser().post(
        "/api/auth/sign-in/email",
        { email: alice.email, password: alice.password },
        {
          origin: "",
          "sec-fetch-site": "cross-site",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        },
      );

      expect(res.status).toBe(403);
    });

    it("refuses a request with a session cookie and no Origin or Referer", async () => {
      const tab = browser();
      await tab.signIn(alice);

      const res = await tab.post("/api/auth/sign-out", {}, { origin: "" });

      expect(res.status).toBe(403);
      expect(await tab.isSignedIn()).toBe(true);
    });
  });

  once("used TOTP codes", () => {
    const changePassword = (tab: Browser, newPassword: string, code: string) =>
      tab.post("/api/auth/my-login/change-password", { newPassword, code });

    it("refuse a code used to sign in at a second sign-in, as a failed sign-in", async () => {
      const code = await alice.totpCode();
      const first = browser();
      await first.password(alice);
      expect((await first.totp(code)).status).toBe(200);

      const second = browser();
      await second.password(alice);
      const res = await second.totp(code);

      expect(res.status).toBe(401);
      expect(await second.isSignedIn()).toBe(false);
      const tries = await query("SELECT id FROM sign_in_tries WHERE key = ?", [
        `member:${alice.id}`,
      ]);
      expect(tries).toHaveLength(1);
    });

    it("refuse a code from an earlier step than one already used", async () => {
      const earlier = await alice.totpCode();
      later(TOTP_STEP_MS);
      const tab = browser();
      await tab.signIn(alice);

      const other = browser();
      await other.password(alice);

      expect((await other.totp(earlier)).status).toBe(401);
    });

    it("let one code pass only one sensitive action", async () => {
      const tab = browser();
      await tab.signIn(alice);
      later(TOTP_STEP_MS);
      const code = await alice.totpCode();

      expect((await changePassword(tab, "a new password here", code)).status).toBe(200);
      expect((await tab.post("/api/auth/my-login/new-backup-codes", { code })).status).toBe(401);
      expect((await tab.post("/api/auth/my-login/new-totp", { code })).status).toBe(401);
      expect((await changePassword(tab, "another new password", code)).status).toBe(401);
    });

    it("let one of two sign-ins with the same code through, when they run at the same time", async () => {
      const code = await alice.totpCode();
      const tabs = [browser(), browser()];
      for (const tab of tabs) await tab.password(alice);

      const statuses = (await Promise.all(tabs.map((tab) => tab.totp(code)))).map(
        (res) => res.status,
      );

      expect(statuses.sort()).toEqual([200, 401]);
    });

    it("let one of two sensitive actions with the same code through, when they run at the same time", async () => {
      const tab = browser();
      await tab.signIn(alice);
      later(TOTP_STEP_MS);
      const code = await alice.totpCode();

      const statuses = (
        await Promise.all([
          changePassword(tab, "a new password here", code),
          tab.post("/api/auth/my-login/new-backup-codes", { code }),
        ])
      ).map((res) => res.status);

      expect(statuses.sort()).toEqual([200, 401]);
    });

    it("take the code of the next step", async () => {
      const tab = browser();
      await tab.signIn(alice);
      later(TOTP_STEP_MS);
      expect(
        (await changePassword(tab, "a new password here", await alice.totpCode())).status,
      ).toBe(200);
      later(TOTP_STEP_MS);
      expect(
        (await tab.post("/api/auth/my-login/new-backup-codes", { code: await alice.totpCode() }))
          .status,
      ).toBe(200);
    });
  });

  once("sensitive actions", () => {
    const changePassword = (tab: Browser, newPassword: string, code?: string) =>
      tab.post("/api/auth/my-login/change-password", { newPassword, code });

    it("change the password only with a fresh TOTP code", async () => {
      const tab = browser();
      await tab.signIn(alice);
      const newPassword = "a new password with spaces";
      later(TOTP_STEP_MS);

      expect((await changePassword(tab, newPassword)).status).toBe(400);
      expect((await changePassword(tab, newPassword, wrong(await alice.totpCode()))).status).toBe(
        401,
      );
      later(BURST_WINDOW_MS);
      expect((await browser().password(alice)).status).toBe(200);

      expect((await changePassword(tab, newPassword, await alice.totpCode())).status).toBe(200);

      later(TOTP_STEP_MS);
      expect((await browser().password(alice)).status).toBe(401);
      await browser().signIn(alice, newPassword);
    });

    it("refuse every code after 5 wrong ones in 15 minutes, with 429", async () => {
      const tab = browser();
      await tab.signIn(alice);
      later(TOTP_STEP_MS);
      const code = await alice.totpCode();
      const actions = [
        (c: string) => changePassword(tab, "a new password here", c),
        (c: string) => tab.post("/api/auth/my-login/new-totp", { code: c }),
        (c: string) => tab.post("/api/auth/my-login/new-backup-codes", { code: c }),
      ];

      for (const action of [...actions, ...actions].slice(0, 5)) {
        expect((await action(wrong(code))).status).toBe(401);
      }

      for (const action of actions) await tooManyFailed(await action(code));
    });

    it("take a backup code once in place of a TOTP code", async () => {
      const tab = browser();
      await tab.signIn(alice);
      const [code = ""] = alice.backupCodes;

      expect((await changePassword(tab, "first new password", code)).status).toBe(200);
      expect((await changePassword(tab, "second new password", code)).status).toBe(401);
    });

    it("refuse a password shorter than 12 characters, and take one of 12", async () => {
      const tab = browser();
      await tab.signIn(alice);
      later(TOTP_STEP_MS);

      expect((await changePassword(tab, "elevenchars", await alice.totpCode())).status).toBe(400);
      expect((await changePassword(tab, "twelve chars", await alice.totpCode())).status).toBe(200);
    });

    it("need a session", async () => {
      const tab = browser();
      await tab.password(alice);

      expect(
        (await changePassword(tab, "a new password here", await alice.totpCode())).status,
      ).toBe(401);
    });

    it("count wrong codes as failed sign-ins", async () => {
      const tab = browser();
      await tab.signIn(alice);
      for (let i = 0; i < 5; i += 1) {
        later(BURST_WINDOW_MS);
        expect(
          (await changePassword(tab, "a new password here", wrong(await alice.totpCode()))).status,
        ).toBe(401);
      }

      later(TOTP_STEP_MS);
      const res = await changePassword(tab, "a new password here", await alice.totpCode());

      await tooManyFailed(res);
    });

    it("change TOTP with a fresh code, then a code from the new secret", async () => {
      const tab = browser();
      await tab.signIn(alice);
      later(TOTP_STEP_MS);

      expect((await tab.post("/api/auth/my-login/confirm-totp", { code: "123456" })).status).toBe(
        400,
      );
      expect(
        (await tab.post("/api/auth/my-login/new-totp", { code: wrong(await alice.totpCode()) }))
          .status,
      ).toBe(401);
      const started = await tab.post("/api/auth/my-login/new-totp", {
        code: await alice.totpCode(),
      });
      expect(started.status).toBe(200);
      expect(started.headers.get("cache-control")).toBe("no-store");
      const { totpURI } = (await started.json()) as { totpURI: string };
      expect(totpURI).toMatch(/^otpauth:\/\/totp\//);
      const confirm = async (code: string) =>
        (await tab.post("/api/auth/my-login/confirm-totp", { code })).status;
      expect(await confirm(wrong(await totpCodeFromURI(totpURI)))).toBe(401);
      // The fresh code used this time step, so the new secret's code for it is refused too.
      expect(await confirm(await totpCodeFromURI(totpURI))).toBe(401);
      later(TOTP_STEP_MS);
      const confirmed = await totpCodeFromURI(totpURI);
      expect(await confirm(confirmed)).toBe(200);

      const old = browser();
      await old.password(alice);
      expect((await old.totp(await alice.totpCode())).status).toBe(401);
      later(BURST_WINDOW_MS);
      const replay = browser();
      await replay.password(alice);
      expect((await replay.totp(confirmed)).status).toBe(401);
      later(TOTP_STEP_MS);
      const fresh = browser();
      await fresh.password(alice);
      expect((await fresh.totp(await totpCodeFromURI(totpURI))).status).toBe(200);
      expect(lines.join("")).not.toContain(new URL(totpURI).searchParams.get("secret"));
    });

    it.each(["password", "TOTP", "backup codes"] as const)(
      "a change of %s ends the Member's other sessions and waiting sign-ins at once, and keeps this one",
      async (change) => {
        const thief = browser();
        await thief.signIn(alice);
        const bobTab = browser();
        await bobTab.signIn(bob);
        const waiting = browser();
        expect((await waiting.password(alice)).status).toBe(200);
        const bobWaiting = browser();
        expect((await bobWaiting.password(bob)).status).toBe(200);
        later(TOTP_STEP_MS);
        const tab = browser();
        await tab.signIn(alice);
        later(TOTP_STEP_MS);
        // A row of another kind that holds the Member's ID, which is not a waiting sign-in.
        const { internalAdapter } = await betterAuthOf(test.auth).$context;
        await internalAdapter.createVerificationValue({
          identifier: "another-kind-of-row",
          value: alice.id,
          expiresAt: new Date(Date.now() + DAY_MS),
        });

        let codeNow = () => alice.totpCode();
        if (change === "password") {
          const res = await changePassword(tab, "another new password", await alice.totpCode());
          expect(res.status).toBe(200);
        } else if (change === "backup codes") {
          const res = await tab.post("/api/auth/my-login/new-backup-codes", {
            code: await alice.totpCode(),
          });
          expect(res.status).toBe(200);
        } else {
          const started = await tab.post("/api/auth/my-login/new-totp", {
            code: await alice.totpCode(),
          });
          const { totpURI } = (await started.json()) as { totpURI: string };
          later(TOTP_STEP_MS);
          const res = await tab.post("/api/auth/my-login/confirm-totp", {
            code: await totpCodeFromURI(totpURI),
          });
          expect(res.status).toBe(200);
          codeNow = () => totpCodeFromURI(totpURI);
        }

        expect(await thief.isSignedIn()).toBe(false);
        expect(await tab.isSignedIn()).toBe(true);
        expect(await bobTab.isSignedIn()).toBe(true);
        later(TOTP_STEP_MS);
        expect((await waiting.totp(await codeNow())).status).toBe(401);
        expect(await waiting.isSignedIn()).toBe(false);
        // Another Member's sign-in that waits for its code goes on.
        expect((await bobWaiting.totp(await bob.totpCode())).status).toBe(200);
        expect(
          await query("SELECT value FROM verifications WHERE identifier = ?", [
            "another-kind-of-row",
          ]),
        ).toEqual([expect.objectContaining({ value: alice.id })]);
      },
    );

    it("keep the old TOTP until the new one is confirmed", async () => {
      const tab = browser();
      await tab.signIn(alice);
      later(TOTP_STEP_MS);
      await tab.post("/api/auth/my-login/new-totp", { code: await alice.totpCode() });

      later(TOTP_STEP_MS);
      await browser().signIn(alice);
    });

    it("give new backup codes with a fresh code, and the old ones stop working", async () => {
      const tab = browser();
      await tab.signIn(alice);
      later(TOTP_STEP_MS);

      expect((await tab.post("/api/auth/my-login/new-backup-codes", {})).status).toBe(400);
      const res = await tab.post("/api/auth/my-login/new-backup-codes", {
        code: await alice.totpCode(),
      });
      expect(res.status).toBe(200);
      const { backupCodes } = (await res.json()) as { backupCodes: string[] };
      expect(backupCodes).toHaveLength(10);
      expect(new Set(backupCodes).size).toBe(10);
      for (const code of backupCodes) expect(code).toMatch(/^[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}$/);

      const old = browser();
      await old.password(alice);
      expect((await old.backupCode(alice.backupCodes[1] ?? "")).status).toBe(401);
      later(BURST_WINDOW_MS);
      const fresh = browser();
      await fresh.password(alice);
      expect((await fresh.backupCode(backupCodes[0] ?? "")).status).toBe(200);
    });
  });

  once("the log", () => {
    it("never holds a password, a TOTP secret or link, or a backup code", async () => {
      const tab = browser();
      await tab.password(alice, `${alice.password}x`);
      await tab.signIn(alice);
      later(TOTP_STEP_MS);
      const started = await tab.post("/api/auth/my-login/new-totp", {
        code: await alice.totpCode(),
      });
      const { totpURI } = (await started.json()) as { totpURI: string };
      const codes = await tab.post("/api/auth/my-login/new-backup-codes", {
        code: alice.backupCodes[0],
      });
      const { backupCodes } = (await codes.json()) as { backupCodes: string[] };
      await browser().post(
        "/api/auth/sign-in/email",
        { email: alice.email, password: alice.password },
        { origin: "https://evil.example" },
      );
      const text = lines.join("");

      for (const value of [
        alice.password,
        alice.totpSecret,
        totpURI,
        ...alice.backupCodes,
        ...backupCodes,
      ]) {
        expect(text).not.toContain(value);
      }
      expect(text).not.toContain(new URL(totpURI).searchParams.get("secret"));
    });

    it("writes a refused request through the logger, with its status and code only, and nothing to stderr", async () => {
      const stderr: unknown[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => stderr.push(chunk) > 0);
      for (const level of ["error", "warn", "log", "info"] as const) {
        vi.spyOn(console, level).mockImplementation((...args) => stderr.push(args));
      }
      const tab = browser();
      await tab.signIn(alice);
      try {
        // A Content-Type the client wrote, which Better Auth's message repeats.
        await browser().send(
          "POST",
          "/api/auth/sign-in/email",
          { email: bob.email, password: bob.password },
          { "content-type": "text/plain;probe=echoed" },
        );
        // A session cookie with no Origin.
        await tab.send("POST", "/api/auth/sign-out", {}, { origin: "" });
        // The 6th wrong password for a Member.
        for (let i = 0; i < 6; i++) await browser().password(bob, `${bob.password}x`);
      } finally {
        vi.restoreAllMocks();
      }

      expect(stderr).toEqual([]);
      const refusals = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.msg === "Better Auth refused a request");
      expect(refusals.map((line) => line.code)).toEqual([
        "UNSUPPORTED_MEDIA_TYPE",
        expect.stringMatching(/ORIGIN/),
        "TOO_MANY_FAILED_SIGN_INS",
      ]);
      for (const line of refusals) {
        expect(Object.keys(line).sort()).toEqual(["code", "level", "msg", "status", "time"]);
      }
      expect(lines.join("")).not.toContain("probe=echoed");
    });
  });
});
