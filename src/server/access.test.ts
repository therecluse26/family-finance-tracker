import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import { markSetupStep } from "../db/index.ts";
import { readEveryTable } from "../db/testing.ts";
import { createLogger } from "../log.ts";
import { api } from "./api.ts";
import { createApp, MAX_REQUEST_BODY_BYTES } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// What every route of the app does with a request it must refuse, in both Security modes, through
// the app's HTTP interface (spec 09, Access; Security mode): the browser rules on every answer,
// the body limit, and the sign-in and cross-site rules on every route in the route list.

type Mode = {
  name: string;
  appUrl: string;
  trustedProxies: string;
  // The trusted proxy a client's request comes through, in HTTPS mode.
  proxy?: (client: string) => { source: string; headers: Record<string, string> };
};

const MODES: Mode[] = [
  { name: "plain-HTTP mode", appUrl: "http://nas.local:8080", trustedProxies: "" },
  {
    name: "HTTPS mode",
    appUrl: "https://money.example.com",
    trustedProxies: "10.0.0.2",
    proxy: (client) => ({
      source: "10.0.0.2",
      headers: { "x-forwarded-proto": "https", "x-forwarded-for": client },
    }),
  },
];

// The only routes that answer with no session, as the app's route list names them. A path ending
// in /* covers every path under it. Every other route answers 401 with no session, or serves the
// web app's page.
const PUBLIC_ROUTES = ["GET /healthz", "GET /api/setup", "ALL /api/auth/*"];

function isPublic(method: string, path: string): boolean {
  return PUBLIC_ROUTES.some((entry) => {
    const [publicMethod = "", publicPath = ""] = entry.split(" ");
    const sameMethod = publicMethod === "ALL" || publicMethod === method;
    const samePath = publicPath.endsWith("/*")
      ? path.startsWith(publicPath.slice(0, -1))
      : path === publicPath;
    return sameMethod && samePath;
  });
}

// A request for each entry of a route list: each path parameter and wildcard filled in, and ALL
// sent as GET and as POST. `wildcard` marks a path that came from a *, where nothing may be found.
function requestsFor(routes: { method: string; path: string }[]) {
  const seen = new Set<string>();
  return routes.flatMap(({ method, path }) =>
    (method === "ALL" ? ["GET", "POST"] : [method]).flatMap((sent) => {
      const filled = path.replace(/:[A-Za-z]+(?:\{[^}]*\})?/g, "x1").replace(/\*$/, "x1");
      const key = `${sent} ${filled}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ method: sent, path: filled, wildcard: path.endsWith("*") }];
    }),
  );
}

// The Origin of a page on another site, of a request with none, and of a sandboxed page.
const CROSS_SITE_ORIGINS = ["https://evil.example", undefined, "null"];

const MIB = 1024 * 1024;

// The web app's page, which the app serves for any path it has no route for.
const PAGE = "<!doctype html><title>app</title>";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-access-web-"));
  writeFileSync(join(webRoot, "index.html"), PAGE);
  mkdirSync(join(webRoot, "assets"));
  writeFileSync(join(webRoot, "assets", "app.js"), "export {};");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe.each(MODES)("in $name", (mode) => {
  let test: TestAuth;
  let app: App;
  let alice: TestMember;
  let clients = 0;

  const browser = () => {
    clients += 1;
    const client = `192.168.1.${clients}`;
    return new TestBrowser(app, mode.appUrl, client, mode.proxy?.(client));
  };

  // The rows a refused request must leave as they were. Sessions renew on each use.
  async function lasting() {
    const { sessions: _, ...tables } = await readEveryTable(test.database);
    return tables;
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const logger = createLogger(() => {}, { throwOnSecretField: true });
    test = await newTestAuth(new URL(mode.appUrl).origin, logger);
    const security = await loadSecurity(
      { APP_URL: mode.appUrl, TRUSTED_PROXIES: mode.trustedProxies },
      { logger },
    );
    app = createApp(webRoot, security, test.auth, test.database, test.secrets);
    alice = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    await markSetupStep(test.database, "household facts", "done");
  });

  afterEach(() => {
    vi.useRealTimers();
    test.close();
  });

  describe("the browser rules", () => {
    function expectRules(res: Response, answer: string) {
      const policy = res.headers.get("content-security-policy") ?? "";
      expect(policy, answer).toContain("frame-ancestors 'none'");
      expect(policy, answer).not.toContain("unsafe-inline");
      expect(res.headers.get("x-frame-options"), answer).toBe("DENY");
      expect(res.headers.get("x-content-type-options"), answer).toBe("nosniff");
      expect(res.headers.get("referrer-policy"), answer).toBe("no-referrer");
    }

    it("are on every kind of answer", async () => {
      // A route that fails, for the 500 answer. Only this test has it, so the route walk below
      // sees the app's own routes alone.
      app.post("/fail", () => {
        throw new Error("A route failed.");
      });
      const stranger = browser();
      const tab = browser();
      await tab.signIn(alice);
      const host = new URL(mode.appUrl).host;
      const healthz = (sentHost: string) =>
        app.request(
          `http://${sentHost}/healthz`,
          { headers: { host: sentHost } },
          {
            incoming: { socket: { remoteAddress: "172.17.0.1" } },
          },
        );

      const answers: [string, Response, number][] = [
        ["page", await stranger.get("/"), 200],
        ["static file", await stranger.get("/assets/app.js"), 200],
        ["SPA fallback", await stranger.get("/settings/banks"), 200],
        ["API JSON", await stranger.get("/api/setup"), 200],
        ["401", await stranger.get("/api/members"), 401],
        ["API 404", await tab.get("/api/no-such-route"), 404],
        ["Better Auth 404", await stranger.get("/api/auth/sign-up/email"), 404],
        ["404", await stranger.send("POST", "/no-such-page", {}), 404],
        ["403", await tab.send("POST", "/api/invites", { code: "1" }, { origin: undefined }), 403],
        ["413", await stranger.post("/api/auth/sign-in/email", { email: "x".repeat(MIB) }), 413],
        ["500", await stranger.send("POST", "/fail", {}), 500],
        ["/healthz", await healthz(host), 200],
        ["/healthz at another Host", await healthz("127.0.0.1:3000"), 200],
        ["refusal page", await stranger.send("GET", "/", undefined, { host: "evil.example" }), 421],
      ];

      for (const [answer, res, status] of answers) {
        expect(res.status, answer).toBe(status);
        expectRules(res, answer);
      }
    });

    it("let the page load only its own scripts and styles, and Plaid Link from Plaid's CDN", async () => {
      const policy = (await browser().get("/")).headers.get("content-security-policy") ?? "";
      const directive = (name: string) =>
        policy
          .split(";")
          .map((part) => part.trim().split(/\s+/))
          .find(([first]) => first === name)
          ?.slice(1);

      expect(directive("default-src")).toEqual(["'self'"]);
      expect(directive("script-src")).toEqual(["'self'", "https://cdn.plaid.com"]);
      expect(directive("frame-src")).toEqual(["https://cdn.plaid.com"]);
      expect(directive("object-src")).toEqual(["'none'"]);
      expect(directive("base-uri")).toEqual(["'none'"]);
      expect(directive("frame-ancestors")).toEqual(["'none'"]);
    });

    if (mode.proxy !== undefined) {
      it("are on the refusal page for a request that skips the trusted proxy", async () => {
        const host = new URL(mode.appUrl).host;
        const res = await app.request(
          `${mode.appUrl}/`,
          { headers: { host, "x-forwarded-proto": "https" } },
          { incoming: { socket: { remoteAddress: "203.0.113.9" } } },
        );

        expect(res.status).toBe(403);
        expectRules(res, "refusal page");
      });
    }
  });

  describe("the body limit", () => {
    const tries = async () => (await readEveryTable(test.database)).sign_in_tries;

    it("refuses a 1 MiB sign-in with 413 before Better Auth reads it, with or without its length", async () => {
      const body = JSON.stringify({ email: alice.email, password: "x".repeat(MIB) });
      const stranger = browser();

      const sent = await stranger.post("/api/auth/sign-in/email", JSON.parse(body));
      const told = await stranger.send("POST", "/api/auth/sign-in/email", JSON.parse(body), {
        "content-length": String(Buffer.byteLength(body)),
      });

      expect(sent.status).toBe(413);
      expect(told.status).toBe(413);
      expect(await tries()).toEqual([]);
    });

    it("refuses a 1 MiB write of a signed-in Member with 413, and changes nothing", async () => {
      const tab = browser();
      await tab.signIn(alice);
      const before = await lasting();

      const res = await tab.post("/api/invites", { code: "1".repeat(MIB) });

      expect(res.status).toBe(413);
      expect(await lasting()).toEqual(before);
    });

    it("takes the largest body a route needs: a 20,000-character Chat message in 3-byte characters", async () => {
      const tab = browser();
      await tab.signIn(alice);
      const message = { text: "語".repeat(20_000), note: null, sendAnyway: false };
      expect(Buffer.byteLength(JSON.stringify(message))).toBeGreaterThan(60_000);

      const res = await tab.post("/api/chat/threads", message);

      expect(res.status).not.toBe(413);
      expect(MAX_REQUEST_BODY_BYTES).toBeLessThanOrEqual(128 * 1024);
    });
  });

  // The app's own route list, with every route and middleware createApp mounts, api.ts included.
  const routeList = () => requestsFor(app.routes);
  const writes = () =>
    routeList().filter(({ method, wildcard }) => !wildcard && !["GET", "HEAD"].includes(method));

  describe("the route list", () => {
    it("holds every route of api.ts, and every public route", () => {
      const listed = new Set(app.routes.map(({ method, path }) => `${method} ${path}`));

      expect(routeList().length).toBeGreaterThan(100);
      expect(writes().length).toBeGreaterThan(50);
      for (const { method, path } of api.routes) {
        expect(listed, `${method} /api${path}`).toContain(`${method} /api${path}`);
      }
      for (const entry of PUBLIC_ROUTES) expect(listed, entry).toContain(entry);
    });

    it("answers 401 on every route with no session unless it is public, and changes nothing", async () => {
      const stranger = browser();
      const before = await lasting();
      const answered: string[] = [];

      for (const { method, path, wildcard } of routeList()) {
        if (isPublic(method, path)) continue;
        const res = await stranger.send(method, path, method === "GET" ? undefined : {});
        const body = await res.text();
        const refused = res.status === 401 || (wildcard && res.status === 404);
        if (!refused && body !== PAGE) answered.push(`${method} ${path} -> ${res.status}`);
      }

      expect(answered).toEqual([]);
      expect(await lasting()).toEqual(before);
    });

    it.each([
      "/api//members",
      "/%61pi/members",
      "/api/%6dembers",
      "/api/auth/%2e%2e/members",
      "/api/setup%2f..%2fmembers",
      "/api/members;x",
      "/api/members%00",
    ])("gives no data at the odd spelling %s with no session", async (path) => {
      const res = await browser().get(path);
      const body = await res.text();

      expect([401, 404].includes(res.status) || body.startsWith("<!doctype html>")).toBe(true);
      expect(body).not.toContain("alice@example.com");
    });

    it("answers the public routes with no session", async () => {
      const stranger = browser();

      expect((await stranger.get("/healthz")).status).toBe(200);
      expect((await stranger.get("/api/setup")).status).toBe(200);
    });

    it("answers 403 on every write from another site, with no Origin, or with Origin null, and changes nothing", async () => {
      const tab = browser();
      await tab.signIn(alice);
      const before = await lasting();
      const answered: string[] = [];

      for (const { method, path } of writes()) {
        for (const origin of CROSS_SITE_ORIGINS) {
          const res = await tab.send(method, path, {}, { origin });
          if (res.status !== 403) answered.push(`${method} ${path} ${origin} -> ${res.status}`);
        }
      }

      expect(answered).toEqual([]);
      expect(await lasting()).toEqual(before);
      expect(await tab.isSignedIn()).toBe(true);
    });
  });
});

// The built page runs no inline script and no inline style, which the policy refuses.
describe("the web app's page", () => {
  it("names its script by file, with no inline script, style, or event handler", () => {
    const page = readFileSync(fileURLToPath(new URL("../web/index.html", import.meta.url)), "utf8");

    expect(page).toMatch(/<script type="module" src="[^"]+"><\/script>/);
    expect(page.match(/<script\b[^>]*>/g)?.every((tag) => / src="/.test(tag))).toBe(true);
    expect(page).not.toMatch(/<style\b|\sstyle="|\son[a-z]+=/i);
  });
});
