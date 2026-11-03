import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hc } from "hono/client";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { BROWSER_NOTICES } from "../../scripts/browser-notices.ts";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { createLogger } from "../log.ts";
import type { Api } from "./api.ts";
import { loadSecurity } from "./security-mode.ts";
import { type RunningServer, startServer } from "./server.ts";

const INDEX_HTML = "<!doctype html><title>Family Finance Tracker</title>";
const ASSET_JS = "console.log('asset');";
const NOTICES = "Third-party notices for the Family Finance Tracker web app\n";

const APP_URL = "https://money.example.com";

// The tests stand where a trusted proxy would, on loopback, and mark each request as HTTPS.
const THROUGH_PROXY = { "x-forwarded-proto": "https" };

// The name and value of each cookie a response sets.
const cookiesFrom = (res: Response) => res.headers.getSetCookie().map((line) => line.split(";")[0]);

describe("the server", () => {
  let webRoot: string;
  let server: RunningServer;
  let base: string;
  let login: TestAuth;
  // The request headers of a signed-in Member's browser.
  let signedIn: Record<string, string>;

  const get = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { ...THROUGH_PROXY, ...init.headers } });

  beforeAll(async () => {
    webRoot = mkdtempSync(join(tmpdir(), "fft-web-"));
    writeFileSync(join(webRoot, "index.html"), INDEX_HTML);
    mkdirSync(join(webRoot, "assets"));
    writeFileSync(join(webRoot, "assets", "app.js"), ASSET_JS);
    writeFileSync(join(webRoot, BROWSER_NOTICES), NOTICES);
    const security = await loadSecurity(
      { APP_URL, TRUSTED_PROXIES: "127.0.0.1" },
      { logger: createLogger(() => {}, { throwOnSecretField: true }) },
    );
    login = await newTestAuth(APP_URL);
    server = await startServer({
      port: 0,
      webRoot,
      security,
      auth: login.auth,
      database: login.database,
      secrets: login.secrets,
    });
    base = `http://127.0.0.1:${server.port}`;
    signedIn = await signIn();
  });

  afterAll(async () => {
    await server.close();
    login.close();
    rmSync(webRoot, { recursive: true, force: true });
  });

  // Signs a new Member in through the server, with the password and then a TOTP code.
  async function signIn(): Promise<Record<string, string>> {
    const member = await addMember(login.auth, { name: "Alice", email: "alice@example.com" });
    const post = (path: string, body: unknown, cookie = "") =>
      fetch(`${base}/api/auth${path}`, {
        method: "POST",
        headers: { ...THROUGH_PROXY, origin: APP_URL, "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      });
    const waiting = await post("/sign-in/email", {
      email: member.email,
      password: member.password,
    });
    const done = await post(
      "/two-factor/verify-totp",
      { code: await member.totpCode() },
      cookiesFrom(waiting).join("; "),
    );
    expect(done.status).toBe(200);
    return { ...THROUGH_PROXY, cookie: cookiesFrom(done).join("; ") };
  }

  it("answers GET /healthz with 200 and health only", async () => {
    const res = await fetch(`${base}/healthz`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("answers the typed client with 401 without a session", async () => {
    const client = hc<Api>(`${base}/api`, { headers: THROUGH_PROXY });
    const res = await client.ping.$get();

    expect(res.status).toBe(401);
  });

  it("answers the sample route through the typed client", async () => {
    const client = hc<Api>(`${base}/api`, { headers: signedIn });
    const res = await client.ping.$get();
    const body = await res.json();

    expectTypeOf(body).toEqualTypeOf<{ ok: true }>();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("gives the web app the security mode through the typed client", async () => {
    const client = hc<Api>(`${base}/api`, { headers: signedIn });
    const res = await client["security-mode"].$get();
    const body = await res.json();

    expectTypeOf(body).toEqualTypeOf<{ mode: "https" | "http"; appUrl: string }>();
    expect(body).toEqual({ mode: "https", appUrl: "https://money.example.com" });
  });

  it("answers an unknown /api path with a JSON 404", async () => {
    const res = await get("/api/nothing-here", { headers: signedIn });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("serves the web app's files", async () => {
    const res = await get("/assets/app.js");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(await res.text()).toBe(ASSET_JS);
  });

  it("serves the browser bundle's notices at /third-party-notices.txt as plain text", async () => {
    const res = await get("/third-party-notices.txt");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res.text()).toBe(NOTICES);
  });

  it.each(["/", "/transactions", "/settings/backups"])(
    "serves index.html for GET %s",
    async (path) => {
      const res = await get(path);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(await res.text()).toBe(INDEX_HTML);
    },
  );

  it("does not serve index.html for other methods", async () => {
    const res = await get("/transactions", { method: "POST" });

    expect(res.status).toBe(404);
  });

  it("refuses a request that does not come through the proxy as HTTPS", async () => {
    const res = await fetch(`${base}/`);

    expect(res.status).toBe(403);
  });
});
