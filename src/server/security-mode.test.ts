import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { signedOutAuth } from "../auth/testing.ts";
import { createLogger } from "../log.ts";
import type { ServerEnv } from "./env.ts";
import { loadSecurity, type Security, securityCheck } from "./security-mode.ts";
import { type RunningServer, startServer } from "./server.ts";
import type { Lookup } from "./trusted-proxies.ts";

function captureLogger() {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line), { throwOnSecretField: true });
  return { logger, logged: () => lines.map((line) => JSON.parse(line)) };
}

const quiet = () => captureLogger().logger;

const fakeLookup =
  (records: Record<string, string[]>): Lookup =>
  async (name) => {
    const found = records[name];
    if (found === undefined) throw new Error(`${name} not found`);
    return found;
  };

function security(appUrl: string, trustedProxies?: string, lookup?: Lookup): Promise<Security> {
  return loadSecurity(
    { APP_URL: appUrl, TRUSTED_PROXIES: trustedProxies },
    { lookup, logger: quiet() },
  );
}

// One route behind the security check. It shows what the check set.
function echoApp(loaded: Security) {
  return new Hono<ServerEnv>()
    .use(securityCheck(loaded))
    .all("*", (c) => c.json({ mode: c.var.appUrl.mode, clientAddress: c.var.clientAddress }));
}

type Sent = {
  // The Host header, and the request URL's host unless url is given.
  host?: string;
  url?: string;
  // The socket's remote address. Null sends the request with no socket.
  source?: string | null;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
};

// Sends a request in process, as if it came from `source`.
function send(app: Hono<ServerEnv>, sent: Sent = {}) {
  const { host = "money.example.com", source = "203.0.113.9", headers = {}, method = "GET" } = sent;
  const url = sent.url ?? `http://${host}/`;
  const env = source === null ? undefined : { incoming: { socket: { remoteAddress: source } } };
  return app.request(url, { method, headers: { host, ...headers }, body: sent.body }, env);
}

const HTTPS = { "x-forwarded-proto": "https" };

// An app behind the check whose log a test can read.
async function loggedApp(appUrl: string, trustedProxies?: string) {
  const capture = captureLogger();
  const loaded = await loadSecurity(
    { APP_URL: appUrl, TRUSTED_PROXIES: trustedProxies },
    { logger: capture.logger },
  );
  const withMessage = (msg: string) => () => capture.logged().filter((line) => line.msg === msg);
  return {
    app: echoApp(loaded),
    loaded,
    refusals: withMessage("Refused a request"),
    summaries: withMessage("Held back refusal lines"),
    text: () => JSON.stringify(capture.logged()),
  };
}

// Fails the test if anything writes to stderr or console.error, as Hono's default error
// handler does with a stack trace.
function watchStderr() {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  const stderr = vi.spyOn(process.stderr, "write");
  return {
    written: () => [...consoleError.mock.calls, ...stderr.mock.calls],
    restore: () => {
      consoleError.mockRestore();
      stderr.mockRestore();
    },
  };
}

describe("HTTPS mode", () => {
  it("accepts a request from a trusted proxy that marks it as HTTPS", async () => {
    const app = echoApp(await security("https://money.example.com", "172.18.0.2"));
    const res = await send(app, { source: "172.18.0.2", headers: HTTPS });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "https", clientAddress: "172.18.0.2" });
  });

  it.each(["https", "HTTPS", " https ", "https, https"])(
    "accepts X-Forwarded-Proto %j from a trusted proxy",
    async (proto) => {
      const app = echoApp(await security("https://money.example.com", "172.18.0.2"));
      const res = await send(app, {
        source: "172.18.0.2",
        headers: { "x-forwarded-proto": proto },
      });

      expect(res.status).toBe(200);
    },
  );

  it.each([
    undefined,
    "",
    "http",
    "https, http",
    "http, https",
    "httpss",
    "https;",
    "wss",
    "https,",
  ])("refuses X-Forwarded-Proto %j from a trusted proxy", async (proto) => {
    const app = echoApp(await security("https://money.example.com", "172.18.0.2"));
    const headers: Record<string, string> =
      proto === undefined ? {} : { "x-forwarded-proto": proto };
    const res = await send(app, { source: "172.18.0.2", headers });

    expect(res.status).toBe(403);
  });

  it.each(["172.18.0.3", "127.0.0.1", "::1", "::ffff:127.0.0.1", "192.168.1.20", "203.0.113.9"])(
    "refuses a request marked as HTTPS from %s, which is not a trusted proxy",
    async (source) => {
      const app = echoApp(await security("https://money.example.com", "172.18.0.2"));
      const res = await send(app, { source, headers: HTTPS });

      expect(res.status).toBe(403);
    },
  );

  it.each<[string, string, string, Lookup?]>([
    ["an IP address", "172.18.0.2", "172.18.0.2"],
    ["an IPv6 address", "fd00::2", "fd00:0::2"],
    ["a CIDR range", "172.16.0.0/12", "172.31.0.7"],
    ["a service name", "caddy", "172.18.0.5", fakeLookup({ caddy: ["172.18.0.5"] })],
    ["*", "*", "198.51.100.23"],
  ])("trusts a proxy named by %s", async (_kind, trustedProxies, source, lookup) => {
    const app = echoApp(await security("https://money.example.com", trustedProxies, lookup));

    expect((await send(app, { source, headers: HTTPS })).status).toBe(200);
    expect((await send(app, { source: "203.0.113.9", headers: HTTPS })).status).toBe(
      trustedProxies === "*" ? 200 : 403,
    );
  });

  it("refuses a service name's old address after the name moves", async () => {
    const records = { caddy: ["172.18.0.5"] };
    const loaded = await security("https://money.example.com", "caddy", fakeLookup(records));
    const app = echoApp(loaded);
    records.caddy = ["172.18.0.6"];
    await loaded.proxies.refresh();

    expect((await send(app, { source: "172.18.0.5", headers: HTTPS })).status).toBe(403);
    expect((await send(app, { source: "172.18.0.6", headers: HTTPS })).status).toBe(200);
  });

  it("refuses every request when a service name does not resolve", async () => {
    const app = echoApp(await security("https://money.example.com", "caddy", fakeLookup({})));

    expect((await send(app, { source: "172.18.0.5", headers: HTTPS })).status).toBe(403);
  });

  it.each(["money.example.com", "evil.example", "127.0.0.1:3000", ""])(
    "does not check Host (%j) when a trusted proxy sends the request",
    async (host) => {
      const app = echoApp(await security("https://money.example.com", "172.18.0.2"));
      const res = await send(app, {
        host,
        url: "http://money.example.com/",
        source: "172.18.0.2",
        headers: HTTPS,
      });

      expect(res.status).toBe(200);
    },
  );

  it.each(["127.0.0.1", "::1", "172.17.0.1", "192.168.1.20", "203.0.113.9"])(
    "with an empty TRUSTED_PROXIES, refuses a request from %s",
    async (source) => {
      const app = echoApp(await security("https://money.example.com", ""));

      expect((await send(app, { source, headers: HTTPS })).status).toBe(403);
    },
  );

  it("refuses with a page that names no address and holds no form", async () => {
    const app = echoApp(await security("https://money.example.com", "172.18.0.2"));
    const res = await send(app, { source: "203.0.113.9", headers: HTTPS });
    const body = await res.text();

    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(body).toContain("trusted proxy");
    expect(body).not.toContain("money.example.com");
    expect(body).not.toMatch(/<form|<input|<script/i);
  });

  it("refuses a request whose source is unknown", async () => {
    const app = echoApp(await security("https://money.example.com", "*"));

    expect((await send(app, { source: null, headers: HTTPS })).status).toBe(400);
  });
});

describe("plain-HTTP mode", () => {
  it.each(["nas.local:8080", "NAS.LOCAL:8080", "Nas.Local:8080"])(
    "accepts Host %s, which matches APP_URL",
    async (host) => {
      const app = echoApp(await security("http://nas.local:8080"));
      const res = await send(app, { host, url: "http://nas.local:8080/" });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ mode: "http", clientAddress: "203.0.113.9" });
    },
  );

  it.each([
    "nas.local",
    "nas.local:80",
    "nas.local:8081",
    "nas.local:08080",
    "nas.local.:8080",
    "evil.example",
    "evil.example:8080",
    "192.168.1.20:8080",
    "127.0.0.1:8080",
    "localhost:8080",
    "nas.local:8080.evil.example",
    "evil.example/nas.local:8080",
    "user@nas.local:8080",
    "nas.local:8080, evil.example",
    "evil.example, nas.local:8080",
    "",
  ])("refuses Host %j, which does not match APP_URL", async (host) => {
    const app = echoApp(await security("http://nas.local:8080"));
    const res = await send(app, { host, url: "http://nas.local:8080/" });

    expect(res.status).toBe(421);
  });

  it("refuses a request with no Host", async () => {
    const app = echoApp(await security("http://nas.local:8080"));
    const res = await app.request(
      "http://nas.local:8080/",
      {},
      { incoming: { socket: { remoteAddress: "192.168.1.30" } } },
    );

    expect(res.status).toBe(421);
  });

  it("refuses a request whose target names another host, even with the right Host", async () => {
    const app = echoApp(await security("http://nas.local:8080"));
    const res = await send(app, { host: "nas.local:8080", url: "http://evil.example/" });

    expect(res.status).toBe(421);
  });

  it("accepts Host with or without the default port when APP_URL has none", async () => {
    const app = echoApp(await security("http://192.168.1.20"));
    const status = async (host: string) =>
      (await send(app, { host, url: "http://192.168.1.20/" })).status;

    expect(await status("192.168.1.20")).toBe(200);
    expect(await status("192.168.1.20:80")).toBe(200);
    expect(await status("192.168.1.20:3000")).toBe(421);
  });

  it("matches an IPv6 APP_URL host", async () => {
    const app = echoApp(await security("http://[fd00::1]:3000"));
    const status = async (host: string) =>
      (await send(app, { host, url: "http://[fd00::1]:3000/" })).status;

    expect(await status("[fd00::1]:3000")).toBe(200);
    expect(await status("[FD00::1]:3000")).toBe(200);
    expect(await status("[fd00::2]:3000")).toBe(421);
    expect(await status("fd00::1:3000")).toBe(421);
  });

  it("lets Host decide, never the source address", async () => {
    const app = echoApp(await security("http://nas.local:8080"));

    expect((await send(app, { host: "evil.example", source: "127.0.0.1" })).status).toBe(421);
    expect((await send(app, { host: "evil.example", source: "192.168.1.30" })).status).toBe(421);
    expect((await send(app, { host: "nas.local:8080", source: "203.0.113.9" })).status).toBe(200);
  });

  it.each(["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"])(
    "refuses %s with the wrong Host",
    async (method) => {
      const app = echoApp(await security("http://nas.local:8080"));

      expect((await send(app, { host: "evil.example", method })).status).toBe(421);
    },
  );

  it("answers the wrong Host with a page that names APP_URL and holds no sign-in form", async () => {
    const app = echoApp(await security("http://nas.local:8080"));
    const res = await send(app, { host: "money.example.com" });
    const body = await res.text();

    expect(res.status).toBe(421);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(body).toContain('<a href="http://nas.local:8080/">http://nas.local:8080</a>');
    expect(body).not.toContain("money.example.com");
    expect(body).not.toMatch(/<form|<input|<script|<link|<button/i);
  });
});

describe("the refusal log", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs the reason, the source, and the Host", async () => {
    const { app, refusals } = await loggedApp("http://nas.local:8080");
    await send(app, { host: "evil.example", source: "::ffff:192.168.1.30" });

    expect(refusals()).toEqual([
      expect.objectContaining({
        level: "warn",
        reason: "wrong-host",
        source: "192.168.1.30",
        host: "evil.example",
        skippedInLastWindow: 0,
      }),
    ]);
  });

  it("logs a Host without the name and password before its @", async () => {
    const { app, refusals, text } = await loggedApp("http://nas.local:8080");
    await send(app, {
      host: "probe-name:probe-word@evil.example",
      url: "http://evil.example/",
      source: "192.168.1.30",
    });

    expect(refusals()).toEqual([expect.objectContaining({ host: "evil.example" })]);
    expect(text()).not.toMatch(/probe-name|probe-word/);
  });

  it("does not let one noisy source hide another source's refusal", async () => {
    const { app, refusals } = await loggedApp("http://nas.local:8080");
    for (let i = 0; i < 20; i += 1) await send(app, { host: "evil.example", source: "10.0.0.66" });
    await send(app, { host: "evil.example", source: "192.168.1.31" });

    expect(refusals().map((line) => line.source)).toEqual(["10.0.0.66", "192.168.1.31"]);
  });

  it("logs each reason from one source on its own", async () => {
    const { app, refusals } = await loggedApp("https://money.example.com", "10.0.0.2");
    await send(app, { source: "10.0.0.2" });
    await send(app, { source: "10.0.0.2", headers: { ...HTTPS, "x-forwarded-for": "unknown" } });

    expect(refusals().map((line) => line.reason)).toEqual([
      "not-from-trusted-proxy",
      "unclear-source",
    ]);
  });

  it("logs a source again after a minute, with the count it left out", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { app, refusals } = await loggedApp("http://nas.local:8080");
    for (let i = 0; i < 4; i += 1) await send(app, { host: "evil.example", source: "10.0.0.66" });
    vi.advanceTimersByTime(60_000);
    await send(app, { host: "evil.example", source: "10.0.0.66" });

    expect(refusals().map((line) => line.skippedInLastWindow)).toEqual([0, 3]);
  });

  it("writes at most 100 lines a minute across every source, then one summary line", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    const { app, refusals, summaries } = await loggedApp("http://nas.local:8080");
    for (let i = 0; i < 150; i += 1) {
      await send(app, { host: "evil.example", source: `10.1.0.${i}` });
    }

    expect(refusals()).toHaveLength(100);
    expect(summaries()).toEqual([]);

    vi.advanceTimersByTime(60_000);
    await send(app, { host: "evil.example", source: "10.2.0.1" });

    expect(summaries()).toEqual([
      expect.objectContaining({ level: "warn", linesHeldBack: 50, refusalsNotLogged: 50 }),
    ]);
    expect(refusals()).toHaveLength(101);
  });

  it("counts in the summary the refusals a held-back line would have counted", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    const { app, summaries } = await loggedApp("http://nas.local:8080");
    for (let i = 0; i < 5; i += 1) await send(app, { host: "evil.example", source: "10.0.0.66" });
    vi.advanceTimersByTime(60_000);
    for (let i = 0; i < 100; i += 1) {
      await send(app, { host: "evil.example", source: `10.1.0.${i}` });
    }
    await send(app, { host: "evil.example", source: "10.0.0.66" });
    vi.advanceTimersByTime(60_000);

    expect(summaries()).toEqual([
      expect.objectContaining({ linesHeldBack: 1, refusalsNotLogged: 5 }),
    ]);
  });

  it("keeps at most 1,000 sources, and a dropped source's left-out count goes in the summary", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    const { app, refusals, summaries } = await loggedApp("http://nas.local:8080");
    for (let i = 0; i < 30; i += 1) await send(app, { host: "evil.example", source: "10.0.0.1" });
    for (let i = 0; i < 1_000; i += 1) {
      if (i % 100 === 0) vi.advanceTimersByTime(60_000);
      await send(app, { host: "evil.example", source: `10.1.${i >> 8}.${i & 255}` });
    }
    vi.advanceTimersByTime(60_000);
    await send(app, { host: "evil.example", source: "10.0.0.1" });

    expect(summaries()).toEqual([
      expect.objectContaining({ linesHeldBack: 0, refusalsNotLogged: 29 }),
    ]);
    expect(refusals()).toHaveLength(1_002);
    expect(refusals().at(-1)).toMatchObject({ source: "10.0.0.1", skippedInLastWindow: 0 });
  });
});

// As node-server hands over a request whose method the Fetch API refuses: it builds a GET,
// then reports the method the client sent.
function withMethod(method: string, host = "nas.local:8080") {
  const request = new Request(`http://${host}/`, { headers: { host } });
  Object.defineProperty(request, "method", { get: () => method });
  return request;
}

const fromLan = () => ({ incoming: { socket: { remoteAddress: "192.168.1.30" } } });

describe("a request the check cannot rebuild", () => {
  it.each(["CONNECT", "TRACE", "TRACK", "trace"])(
    "gets 405 for %s once it passes the check",
    async (method) => {
      const { app, refusals } = await loggedApp("http://nas.local:8080");
      const res = await app.request(withMethod(method), undefined, fromLan());

      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD, POST, PUT, PATCH, DELETE");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(refusals()).toEqual([expect.objectContaining({ reason: "unsupported-method" })]);
    },
  );

  it("still refuses one that fails the check for that reason", async () => {
    const app = echoApp(await security("http://nas.local:8080"));
    const res = await app.request(withMethod("TRACE", "evil.example"), undefined, fromLan());

    expect(res.status).toBe(421);
  });

  it.each([
    ["the body", "body"],
    ["the headers", "headers"],
  ])("gets 400 and one log line, never 500, when reading %s fails", async (_part, property) => {
    const stderr = watchStderr();
    try {
      const { app, refusals, text } = await loggedApp("http://nas.local:8080");
      const request = new Request("http://nas.local:8080/", {
        headers: { host: "nas.local:8080" },
      });
      Object.defineProperty(request, property, {
        get() {
          throw new TypeError("http://probe-name:probe-word@nas.local:8080/ cannot be read");
        },
      });
      const res = await app.request(request, undefined, fromLan());

      expect(res.status).toBe(400);
      expect(refusals()).toEqual([
        expect.objectContaining({ reason: "unclear-request", error: "TypeError" }),
      ]);
      expect(text()).not.toMatch(/probe-name|probe-word/);
      expect(stderr.written()).toEqual([]);
    } finally {
      stderr.restore();
    }
  });
});

describe("forwarded headers", () => {
  it("ignores X-Forwarded-For from a source that is not a trusted proxy", async () => {
    const app = echoApp(await security("http://nas.local:8080", "10.0.0.2"));
    const res = await send(app, {
      host: "nas.local:8080",
      source: "192.168.1.30",
      headers: { "x-forwarded-for": "198.51.100.1" },
    });

    expect(await res.json()).toMatchObject({ clientAddress: "192.168.1.30" });
  });

  it("ignores forwarded headers from an untrusted source even when they are not valid", async () => {
    const app = echoApp(await security("http://nas.local:8080"));
    const res = await send(app, {
      host: "nas.local:8080",
      source: "::ffff:192.168.1.30",
      headers: { "x-forwarded-for": "garbage", "x-forwarded-proto": "nonsense" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ clientAddress: "192.168.1.30" });
  });

  it("ignores X-Forwarded-Proto from an untrusted source in plain-HTTP mode", async () => {
    const app = echoApp(await security("http://nas.local:8080"));
    const res = await send(app, { host: "nas.local:8080", headers: HTTPS });

    expect(await res.json()).toMatchObject({ mode: "http" });
  });

  it("reads the client from a trusted proxy's X-Forwarded-For", async () => {
    const app = echoApp(await security("https://money.example.com", "10.0.0.0/8"));
    const res = await send(app, {
      source: "10.0.0.2",
      headers: { ...HTTPS, "x-forwarded-for": "198.51.100.1, 203.0.113.7, 10.0.0.9" },
    });

    expect(await res.json()).toMatchObject({ clientAddress: "203.0.113.7" });
  });

  it("refuses a request whose trusted proxy names a hop that is not an IP address", async () => {
    const app = echoApp(await security("https://money.example.com", "10.0.0.2"));
    const res = await send(app, {
      source: "10.0.0.2",
      headers: { ...HTTPS, "x-forwarded-for": "unknown" },
    });

    expect(res.status).toBe(400);
  });
});

describe("a link-local source with a zone", () => {
  it("is accepted, and its address loses the zone", async () => {
    const app = echoApp(await security("http://nas.local:8080"));
    const res = await send(app, { host: "nas.local:8080", source: "fe80::1%eth0" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ clientAddress: "fe80::1" });
  });

  it("is trusted by a range that holds its address", async () => {
    const app = echoApp(await security("https://money.example.com", "fe80::/10"));
    const res = await send(app, { source: "fe80::1%eth0", headers: HTTPS });

    expect(res.status).toBe(200);
  });

  it("is still refused as an X-Forwarded-For hop", async () => {
    const app = echoApp(await security("https://money.example.com", "10.0.0.2"));
    const res = await send(app, {
      source: "10.0.0.2",
      headers: { ...HTTPS, "x-forwarded-for": "fe80::1%eth0" },
    });

    expect(res.status).toBe(400);
  });
});

// Headers a client could use to name its own address, host, scheme, or path.
const SPOOFED = {
  "x-forwarded-for": "6.6.6.6",
  "x-forwarded-proto": "https",
  "x-forwarded-host": "evil.example",
  "x-forwarded-port": "443",
  "x-forwarded-ssl": "on",
  "x-forwarded-scheme": "https",
  "x-forwarded-protocol": "https",
  "x-forwarded-server": "evil.example",
  "x-forwarded-prefix": "/evil",
  "x-forwarded": "for=6.6.6.6",
  forwarded: "for=6.6.6.9;proto=https;host=evil.example",
  "forwarded-for": "6.6.6.6",
  "x-original-forwarded-for": "6.6.6.6",
  "x-original-host": "evil.example",
  "x-original-url": "/evil",
  "x-rewrite-url": "/evil",
  "x-real-ip": "6.6.6.7",
  "x-client-ip": "6.6.6.8",
  "x-cluster-client-ip": "6.6.6.8",
  "true-client-ip": "6.6.6.11",
  "fastly-client-ip": "6.6.6.8",
  "fly-client-ip": "6.6.6.12",
  "cf-connecting-ip": "6.6.6.10",
  "cf-pseudo-ipv4": "6.6.6.10",
  "x-appengine-user-ip": "6.6.6.8",
  "x-vercel-forwarded-for": "6.6.6.8",
  "x-envoy-external-address": "6.6.6.8",
  "x-host": "evil.example",
  "x-url-scheme": "https",
  "front-end-https": "on",
};

// One route behind the check. It shows the URL and every header it sees.
function seenApp(loaded: Security) {
  return new Hono<ServerEnv>().use(securityCheck(loaded)).all("*", async (c) => {
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, name) => {
      headers[name] = value;
    });
    return c.json({
      url: c.req.url,
      host: c.req.header("host"),
      forwardedFor: c.req.header("x-forwarded-for"),
      headers,
      body: c.req.method === "POST" ? await c.req.text() : null,
    });
  });
}

type Seen = {
  url: string;
  host: string;
  forwardedFor: string;
  headers: Record<string, string>;
  body: string | null;
};

const seenBy = async (res: Response) => (await res.json()) as Seen;

const vouched = (headers: Record<string, string>) =>
  Object.keys(headers).filter((name) => name in SPOOFED);

describe("what a route sees after the check", () => {
  it("from an untrusted source: only the source as X-Forwarded-For", async () => {
    const app = seenApp(await security("http://nas.local:8080", "10.0.0.2"));
    const res = await send(app, {
      host: "nas.local:8080",
      source: "192.168.1.30",
      headers: SPOOFED,
    });
    const seen = await seenBy(res);

    expect(seen.forwardedFor).toBe("192.168.1.30");
    expect(seen.headers["x-forwarded-proto"]).toBe("http");
    expect(vouched(seen.headers).sort()).toEqual(["x-forwarded-for", "x-forwarded-proto"]);
  });

  it("through a trusted proxy: only the checked client as X-Forwarded-For", async () => {
    const app = seenApp(await security("https://money.example.com", "10.0.0.0/8"));
    const res = await send(app, {
      source: "10.0.0.2",
      headers: { ...SPOOFED, "x-forwarded-for": "6.6.6.6, 203.0.113.7, 10.0.0.9" },
    });
    const seen = await seenBy(res);

    expect(seen.forwardedFor).toBe("203.0.113.7");
    expect(seen.headers["x-forwarded-proto"]).toBe("https");
    expect(vouched(seen.headers).sort()).toEqual(["x-forwarded-for", "x-forwarded-proto"]);
  });

  it("with *: only the last hop as X-Forwarded-For", async () => {
    const app = seenApp(await security("https://money.example.com", "*"));
    const res = await send(app, {
      source: "10.0.0.2",
      headers: { ...SPOOFED, "x-forwarded-for": "6.6.6.6, 203.0.113.7" },
    });

    expect((await seenBy(res)).forwardedFor).toBe("203.0.113.7");
  });

  it.each([
    ["0.0.0.0/0", "10.0.0.2", "6.6.6.6, 203.0.113.7", "203.0.113.7"],
    ["0.0.0.0/1, 128.0.0.0/1", "10.0.0.2", "6.6.6.6, 203.0.113.7", "203.0.113.7"],
    ["::/0", "2001:db8::2", "2001:db8::6, 2001:db8::7", "2001:db8::7"],
    ["10.0.0.0/8", "10.0.0.2", "10.9.9.9, 10.0.0.5", "10.0.0.5"],
  ])(
    "with %s: only the last hop when every hop is trusted",
    async (trustedProxies, source, forwardedFor, client) => {
      const app = seenApp(await security("https://money.example.com", trustedProxies));
      const res = await send(app, {
        source,
        headers: { ...SPOOFED, "x-forwarded-for": forwardedFor },
      });

      expect((await seenBy(res)).forwardedFor).toBe(client);
    },
  );

  it("in HTTPS mode: APP_URL's scheme and host, whatever Host the client sent", async () => {
    const app = seenApp(await security("https://money.example.com", "10.0.0.2"));
    const res = await send(app, {
      host: "evil.example",
      url: "http://evil.example/api/thing?next=%2Fsettings",
      source: "10.0.0.2",
      headers: HTTPS,
    });
    const seen = await seenBy(res);

    expect(seen.url).toBe("https://money.example.com/api/thing?next=%2Fsettings");
    expect(seen.host).toBe("money.example.com");
  });

  it.each([
    ["http://nas.local:8080", "NAS.LOCAL:8080", "http://nas.local:8080/a?b=1"],
    ["http://192.168.1.20", "192.168.1.20:80", "http://192.168.1.20/a?b=1"],
    ["http://[fd00::1]:3000", "[FD00::1]:3000", "http://[fd00::1]:3000/a?b=1"],
  ])("in plain-HTTP mode with APP_URL %s and Host %s: %s", async (appUrl, host, expected) => {
    const app = seenApp(await security(appUrl));
    const res = await send(app, { host, url: `${new URL(appUrl).origin}/a?b=1` });
    const seen = await seenBy(res);

    expect(seen.url).toBe(expected);
    expect(seen.host).toBe(new URL(appUrl).host);
  });

  it("keeps the method and the body", async () => {
    const app = seenApp(await security("http://nas.local:8080"));
    const res = await send(app, {
      host: "nas.local:8080",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"amount":12}',
    });
    const seen = await seenBy(res);

    expect(seen.body).toBe('{"amount":12}');
    expect(seen.headers["content-type"]).toBe("application/json");
  });

  it("through the Node server, as a package reading the raw request would", async () => {
    const loaded = await security("https://money.example.com", "127.0.0.1");
    const running = serve({ fetch: seenApp(loaded).fetch, port: 0 });
    await new Promise((done) => running.once("listening", done));
    const { port } = running.address() as AddressInfo;
    try {
      const spoofed = { ...SPOOFED, "x-forwarded-for": "6.6.6.6, 203.0.113.7" };
      const res = await rawRequest(
        port,
        [
          "POST /api/auth/sign-in?x=1 HTTP/1.1",
          "Host: evil.example",
          ...Object.entries(spoofed).map(([name, value]) => `${name}: ${value}`),
          "Content-Type: application/json",
          "Content-Length: 13",
        ],
        '{"amount":12}',
      );
      const seen = JSON.parse(res.body) as Seen;

      expect(res.status).toBe(200);
      expect(seen.url).toBe("https://money.example.com/api/auth/sign-in?x=1");
      expect(seen.host).toBe("money.example.com");
      expect(seen.forwardedFor).toBe("203.0.113.7");
      expect(vouched(seen.headers).sort()).toEqual(["x-forwarded-for", "x-forwarded-proto"]);
      expect(seen.body).toBe('{"amount":12}');
    } finally {
      await new Promise((done) => running.close(done));
    }
  });

  it("through the Node server, the raw Node request holds the same path and headers", async () => {
    const loaded = await security("https://money.example.com", "127.0.0.1");
    const app = new Hono<ServerEnv>().use(securityCheck(loaded)).all("*", (c) => {
      const { url, headers, headersDistinct, rawHeaders } = (c.env as { incoming: IncomingMessage })
        .incoming;
      return c.json({ url, headers, headersDistinct, rawHeaders });
    });
    const running = serve({ fetch: app.fetch, port: 0 });
    await new Promise((done) => running.once("listening", done));
    const { port } = running.address() as AddressInfo;
    try {
      const spoofed = { ...SPOOFED, "x-forwarded-for": "6.6.6.6, 203.0.113.7" };
      const res = await rawRequest(port, [
        "GET http://evil.example/api/thing?x=1 HTTP/1.1",
        "Host: evil.example",
        // Names in the case a client chose, and one header twice.
        ...Object.entries(spoofed).map(([name, value]) => `${name.toUpperCase()}: ${value}`),
        "X-Real-IP: 6.6.6.13",
        "X-Request-Id: probe-1",
        "User-Agent: probe-agent/1.0",
      ]);
      const seen = JSON.parse(res.body) as Pick<
        IncomingMessage,
        "url" | "headers" | "headersDistinct" | "rawHeaders"
      >;
      const rawNames = seen.rawHeaders.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase());
      const checked = { host: "money.example.com", "x-forwarded-for": "203.0.113.7" };

      expect(res.status).toBe(200);
      expect(seen.url).toBe("/api/thing?x=1");
      expect(seen.headers).toMatchObject({ ...checked, "x-forwarded-proto": "https" });
      expect(seen.headers["user-agent"]).toBe("probe-agent/1.0");
      expect(seen.headers["x-request-id"]).toBeUndefined();
      expect(seen.headersDistinct).toMatchObject({ "x-forwarded-for": ["203.0.113.7"] });
      for (const names of [
        Object.keys(seen.headers),
        Object.keys(seen.headersDistinct),
        rawNames,
      ]) {
        expect(names.filter((name) => name in SPOOFED).sort()).toEqual([
          "x-forwarded-for",
          "x-forwarded-proto",
        ]);
        expect(names.filter((name) => name === "host")).toEqual(["host"]);
      }
      expect(seen.rawHeaders).toEqual(expect.arrayContaining(["User-Agent", "probe-agent/1.0"]));
      expect(JSON.stringify(seen)).not.toMatch(/6\.6\.6\.|evil\.example|probe-1/);
    } finally {
      await new Promise((done) => running.close(done));
    }
  });
});

describe("the header allow list, through the Node server", () => {
  // Headers outside the list, under names no rule written for forwarded headers would guess.
  const UNLISTED = { "Client-IP": "6.6.6.6", "X-Originating-IP": "6.6.6.7", "X-Foo-Ip": "6.6.6.8" };
  // Each allowed header, with a value a test can find.
  const ALLOWED = {
    "Content-Type": "application/json",
    Cookie: "session=probe",
    Origin: "https://money.example.com",
    Range: "bytes=0-1",
    Referer: "https://money.example.com/settings",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": "probe-agent/1.0",
  };
  const BODY = '{"amount":12}';
  const names = [...Object.keys(UNLISTED), ...Object.keys(ALLOWED), "Content-Length"];

  type Echo = {
    body: string;
    byHeader: Record<string, string | null>;
    raw: Record<string, string>;
    headers: Record<string, string>;
    rawHeaders: string[];
    trailers: Record<string, string>;
    trailersDistinct: Record<string, string[]>;
    rawTrailers: string[];
  };

  // A route that reads the body, then shows every header and trailer it can reach.
  async function serveEcho(loaded: Security) {
    const app = new Hono<ServerEnv>().use(securityCheck(loaded)).all("*", async (c) => {
      const body = await c.req.text();
      const { headers, rawHeaders, trailers, trailersDistinct, rawTrailers } = (
        c.env as { incoming: IncomingMessage }
      ).incoming;
      return c.json({
        body,
        byHeader: Object.fromEntries(names.map((name) => [name, c.req.header(name) ?? null])),
        raw: Object.fromEntries(c.req.raw.headers),
        headers,
        rawHeaders,
        trailers,
        trailersDistinct,
        rawTrailers,
      });
    });
    const running = serve({ fetch: app.fetch, port: 0 });
    await new Promise((done) => running.once("listening", done));
    const { port } = running.address() as AddressInfo;
    return {
      send: async (lines: string[], body: string) => {
        const res = await rawRequest(port, lines, body);
        return { status: res.status, echo: JSON.parse(res.body) as Echo };
      },
      close: () => new Promise((done) => running.close(done)),
    };
  }

  const MODES = [
    ["plain-HTTP mode", "http://nas.local:8080", "", ["Host: nas.local:8080"]],
    [
      "HTTPS mode, through a trusted proxy",
      "https://money.example.com",
      "127.0.0.1",
      ["Host: money.example.com", "X-Forwarded-Proto: https"],
    ],
  ] as const;

  it.each(MODES)(
    "in %s, a route sees only the allowed headers and the three the check sets",
    async (_mode, appUrl, trustedProxies, hostLines) => {
      const loaded = await security(appUrl, trustedProxies);
      const server = await serveEcho(loaded);
      try {
        const { status, echo } = await server.send(
          [
            "POST /api/thing HTTP/1.1",
            ...hostLines,
            ...Object.entries({ ...UNLISTED, ...ALLOWED }).map(([n, v]) => `${n}: ${v}`),
            `Content-Length: ${BODY.length}`,
          ],
          BODY,
        );
        const rawNames = echo.rawHeaders.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase());
        const expectedNames = [
          ...Object.keys(ALLOWED).map((name) => name.toLowerCase()),
          "content-length",
          "host",
          "x-forwarded-for",
          "x-forwarded-proto",
        ].sort();

        expect(status).toBe(200);
        expect(echo.body).toBe(BODY);
        for (const name of Object.keys(UNLISTED)) {
          expect(echo.byHeader[name]).toBeNull();
        }
        for (const [name, value] of Object.entries(ALLOWED)) {
          expect(echo.byHeader[name]).toBe(value);
          expect(echo.raw[name.toLowerCase()]).toBe(value);
          expect(echo.headers[name.toLowerCase()]).toBe(value);
          expect(echo.rawHeaders).toEqual(expect.arrayContaining([name, value]));
        }
        expect(echo.byHeader["Content-Length"]).toBe(String(BODY.length));
        expect(Object.keys(echo.raw).sort()).toEqual(expectedNames);
        expect(Object.keys(echo.headers).sort()).toEqual(expectedNames);
        expect(rawNames.sort()).toEqual(expectedNames);
        expect(JSON.stringify(echo)).not.toMatch(/6\.6\.6\./);
      } finally {
        await server.close();
      }
    },
  );

  it.each(MODES)(
    "in %s, request trailers reach neither c.req.raw nor the raw Node request",
    async (_mode, appUrl, trustedProxies, hostLines) => {
      const loaded = await security(appUrl, trustedProxies);
      const server = await serveEcho(loaded);
      try {
        const { status, echo } = await server.send(
          [
            "POST /api/thing HTTP/1.1",
            ...hostLines,
            "Content-Type: application/json",
            "Transfer-Encoding: chunked",
            "Trailer: X-Forwarded-For, Client-IP, Host",
          ],
          [
            BODY.length.toString(16),
            BODY,
            "0",
            "X-Forwarded-For: 6.6.6.6",
            "Client-IP: 6.6.6.7",
            "Host: evil.example",
            "",
            "",
          ].join("\r\n"),
        );

        expect(status).toBe(200);
        expect(echo.body).toBe(BODY);
        expect(echo.trailers).toEqual({});
        expect(echo.trailersDistinct).toEqual({});
        expect(echo.rawTrailers).toEqual([]);
        expect(JSON.stringify(echo)).not.toMatch(/6\.6\.6\.|evil\.example/);
      } finally {
        await server.close();
      }
    },
  );

  // A route that never reads the body. It reads the trailers when it starts, waits until Node
  // has parsed the whole request, trailers included, and reads them again.
  async function serveTrailerReader(loaded: Security) {
    const app = new Hono<ServerEnv>().use(securityCheck(loaded)).all("*", async (c) => {
      const incoming = (c.env as { incoming: IncomingMessage }).incoming;
      const atStart = { trailers: incoming.trailers, rawTrailers: incoming.rawTrailers };
      for (let waited = 0; !incoming.complete && waited < 2_000; waited += 10) {
        await new Promise((done) => setTimeout(done, 10));
      }
      const { complete, trailers, rawTrailers } = incoming;
      return c.json({ complete, atStart, trailers, rawTrailers });
    });
    const running = serve({ fetch: app.fetch, port: 0 });
    await new Promise((done) => running.once("listening", done));
    const { port } = running.address() as AddressInfo;
    return { port, close: () => new Promise((done) => running.close(done)) };
  }

  const TRAILERS = ["0", "X-Forwarded-For: 6.6.6.6", "Client-IP: 6.6.6.7", "Host: evil.example"];
  const LONG_BODY = "x".repeat(100_000);

  it.each([
    ["a chunked GET", "GET", ["5", "hello", ...TRAILERS, "", ""].join("\r\n")],
    [
      "a 100,000-byte chunked POST",
      "POST",
      [LONG_BODY.length.toString(16), LONG_BODY, ...TRAILERS, "", ""].join("\r\n"),
    ],
  ])(
    "a route that reads the trailers of %s without reading the body finds none",
    async (_case, method, body) => {
      const server = await serveTrailerReader(await security("http://nas.local:8080"));
      try {
        const res = await rawRequest(
          server.port,
          [`${method} /anything HTTP/1.1`, "Host: nas.local:8080", "Transfer-Encoding: chunked"],
          body,
        );
        type Trailers = Pick<IncomingMessage, "trailers" | "rawTrailers">;
        const seen = JSON.parse(res.body) as Trailers & { complete: boolean; atStart: Trailers };

        expect(res.status).toBe(200);
        expect(seen.complete).toBe(true);
        for (const read of [seen.atStart, seen]) {
          expect(read.trailers).toEqual({});
          expect(read.rawTrailers).toEqual([]);
        }
      } finally {
        await server.close();
      }
    },
  );
});

describe("loadSecurity", () => {
  it("logs the mode at start", async () => {
    const { logger, logged } = captureLogger();
    await loadSecurity({ APP_URL: "http://nas.local:8080", TRUSTED_PROXIES: "" }, { logger });

    expect(logged()).toEqual([
      expect.objectContaining({
        level: "info",
        msg: "Security mode",
        mode: "http",
        appUrl: "http://nas.local:8080",
        trustedProxies: [],
      }),
    ]);
  });

  it("in HTTPS mode with an empty TRUSTED_PROXIES, logs that it will refuse every request", async () => {
    const { logger, logged } = captureLogger();
    await loadSecurity({ APP_URL: "https://money.example.com", TRUSTED_PROXIES: " " }, { logger });

    expect(logged()).toContainEqual(
      expect.objectContaining({
        level: "warn",
        msg: expect.stringMatching(
          /^TRUSTED_PROXIES is empty, so the app will refuse every request/,
        ),
      }),
    );
  });

  it("resolves service names before it returns", async () => {
    const loaded = await security(
      "https://money.example.com",
      "caddy",
      fakeLookup({ caddy: ["172.18.0.5"] }),
    );

    expect(loaded.proxies.trusts("172.18.0.5")).toBe(true);
  });

  it.each([
    [{}, /^APP_URL is missing/],
    [{ APP_URL: "ftp://nas.local" }, /^APP_URL must start with https:\/\/ or http:\/\//],
    [{ APP_URL: "http://money.example.com" }, /^APP_URL is http:\/\/, so its host must be a local/],
    [
      { APP_URL: "https://money.example.com", TRUSTED_PROXIES: "caddy:443" },
      /^TRUSTED_PROXIES holds/,
    ],
    [{ APP_URL: "http://nas.local:8080", TRUSTED_PROXIES: "*" }, /^TRUSTED_PROXIES=\* is only/],
    [
      { APP_URL: "http://nas.local:8080", TRUSTED_PROXIES: "10.0.0.2, *" },
      /^TRUSTED_PROXIES=\* is only/,
    ],
  ])("refuses to start with %j", async (env, reason) => {
    await expect(loadSecurity(env, { logger: quiet() })).rejects.toThrow(reason);
  });

  it("names the fix when TRUSTED_PROXIES=* comes with an http:// APP_URL", async () => {
    await expect(
      loadSecurity({ APP_URL: "http://nas.local:8080", TRUSTED_PROXIES: "*" }, { logger: quiet() }),
    ).rejects.toThrow("list the proxy's own address instead");
  });

  it("accepts TRUSTED_PROXIES=* with an https:// APP_URL", async () => {
    const loaded = await security("https://money.example.com", "*");

    expect(loaded.proxies.trusts("203.0.113.7")).toBe(true);
  });

  it.each(["0.0.0.0/0", "::/0", "::ffff:0:0/96", "0.0.0.0/1, 128.0.0.0/1", "10.0.0.2, ::/0"])(
    "refuses to start with TRUSTED_PROXIES=%s and an http:// APP_URL, as with *",
    async (trustedProxies) => {
      await expect(
        loadSecurity(
          { APP_URL: "http://nas.local:8080", TRUSTED_PROXIES: trustedProxies },
          { logger: quiet() },
        ),
      ).rejects.toThrow(
        /^TRUSTED_PROXIES covers every IPv4 or every IPv6 address, so it trusts every source, as \* does\. .*list the proxy's own address instead/,
      );
    },
  );

  it.each(["10.0.0.0/8", "0.0.0.0/1", "192.168.0.0/16, fd00::/8, ::/1"])(
    "starts with TRUSTED_PROXIES=%s and an http:// APP_URL",
    async (trustedProxies) => {
      const loaded = await security("http://nas.local:8080", trustedProxies);

      expect(loaded.proxies.coversEveryAddress).toBe(false);
    },
  );

  it("accepts a range that covers every address with an https:// APP_URL, as it accepts *", async () => {
    const loaded = await security("https://money.example.com", "0.0.0.0/0");

    expect(loaded.proxies.trusts("203.0.113.7")).toBe(true);
  });
});

const INDEX_HTML = "<!doctype html><title>Family Finance Tracker</title><form></form>";

type RawResponse = { status: number; headers: string; body: string };

// Writes one HTTP/1.1 request on a socket, so a test controls every byte, Host included.
function rawRequest(port: number, lines: string[], body = ""): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    // Write, not end: a half-closed socket can stop the server before a streamed body.
    const socket = connect(port, "127.0.0.1", () => {
      socket.write([...lines, "Connection: close", "", body].join("\r\n"));
    });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const [head = "", ...body] = response.split("\r\n\r\n");
      resolve({ status: Number(head.split(" ")[1]), headers: head, body: body.join("\r\n\r\n") });
    });
  });
}

describe("the server", () => {
  let webRoot: string;
  const servers: RunningServer[] = [];

  const startLogged = async (appUrl: string, trustedProxies?: string) => {
    const { loaded, refusals, text } = await loggedApp(appUrl, trustedProxies);
    const server = await startServer({ port: 0, webRoot, security: loaded, auth: signedOutAuth });
    servers.push(server);
    return { port: server.port, refusals, text };
  };

  const start = async (appUrl: string, trustedProxies?: string) =>
    (await startLogged(appUrl, trustedProxies)).port;

  beforeAll(() => {
    webRoot = mkdtempSync(join(tmpdir(), "fft-web-"));
    writeFileSync(join(webRoot, "index.html"), INDEX_HTML);
    mkdirSync(join(webRoot, "assets"));
    writeFileSync(join(webRoot, "assets", "app.js"), "console.log('asset');");
  });

  afterAll(async () => {
    await Promise.all(servers.map((server) => server.close()));
    rmSync(webRoot, { recursive: true, force: true });
  });

  it.each([
    ["HTTPS mode with no trusted proxy", "https://money.example.com", ""],
    ["HTTPS mode with a trusted proxy elsewhere", "https://money.example.com", "10.9.9.9"],
    ["plain-HTTP mode", "http://nas.local:8080", ""],
  ])(
    "answers GET and HEAD /healthz from any source and any Host in %s",
    async (_mode, appUrl, trusted) => {
      const port = await start(appUrl, trusted);

      for (const host of ["evil.example", "nas.local:8080", "127.0.0.1"]) {
        const res = await rawRequest(port, ["GET /healthz HTTP/1.1", `Host: ${host}`]);
        expect(res.status).toBe(200);
        expect(res.body).toBe('{"status":"ok"}');
      }
      const head = await rawRequest(port, ["HEAD /healthz HTTP/1.1", "Host: evil.example"]);
      expect(head.status).toBe(200);
    },
  );

  it.each([
    "GET /",
    "GET /transactions",
    "GET /assets/app.js",
    "GET /api/ping",
    "GET /api/security-mode",
    "GET /api/nothing-here",
    "POST /api/ping",
    "POST /healthz",
    "GET /healthz/",
    "GET /HEALTHZ",
    "GET //healthz",
  ])("runs the check before %s", async (route) => {
    const plain = await start("http://nas.local:8080");
    const https = await start("https://money.example.com", "");

    const wrongHost = await rawRequest(plain, [`${route} HTTP/1.1`, "Host: evil.example"]);
    const noProxy = await rawRequest(https, [
      `${route} HTTP/1.1`,
      "Host: money.example.com",
      "X-Forwarded-Proto: https",
    ]);

    expect(wrongHost.status).toBe(421);
    expect(wrongHost.body).toContain("http://nas.local:8080");
    expect(wrongHost.body).not.toContain("<form");
    expect(noProxy.status).toBe(403);
  });

  it("serves the app at the APP_URL Host, where the API asks for a session", async () => {
    const port = await start("http://nas.local:8080");

    const page = await rawRequest(port, ["GET /transactions HTTP/1.1", "Host: nas.local:8080"]);
    const mode = await rawRequest(port, [
      "GET /api/security-mode HTTP/1.1",
      "Host: nas.local:8080",
    ]);

    expect(page.status).toBe(200);
    expect(page.body).toBe(INDEX_HTML);
    expect(mode.status).toBe(401);
    expect(JSON.parse(mode.body)).toEqual({ error: "Sign in first" });
  });

  it("refuses an absolute request target for another host, even with the right Host", async () => {
    const port = await start("http://nas.local:8080");
    const res = await rawRequest(port, [
      "GET http://evil.example/ HTTP/1.1",
      "Host: nas.local:8080",
    ]);

    expect(res.status).toBe(421);
  });

  it("refuses a request with two Host headers", async () => {
    const port = await start("http://nas.local:8080");

    for (const hosts of [
      ["nas.local:8080", "evil.example"],
      ["evil.example", "nas.local:8080"],
    ]) {
      const res = await rawRequest(port, [
        "GET / HTTP/1.1",
        ...hosts.map((host) => `Host: ${host}`),
      ]);
      expect(res.status).toBe(421);
    }
  });

  it("reads the real socket address: a loopback source is trusted only when listed", async () => {
    const trusted = await start("https://money.example.com", "127.0.0.1");
    const untrusted = await start("https://money.example.com", "10.9.9.9");
    const request = ["GET / HTTP/1.1", "Host: money.example.com", "X-Forwarded-Proto: https"];

    expect((await rawRequest(trusted, request)).status).toBe(200);
    expect((await rawRequest(untrusted, request)).status).toBe(403);
  });

  it("answers TRACE with 405 once it passes the check, and writes nothing outside the logger", async () => {
    const stderr = watchStderr();
    try {
      const plain = await startLogged("http://nas.local:8080");
      const https = await startLogged("https://money.example.com", "127.0.0.1");

      const trace = await rawRequest(plain.port, [
        "TRACE /api/ping HTTP/1.1",
        "Host: nas.local:8080",
      ]);
      const wrongHost = await rawRequest(plain.port, ["TRACE / HTTP/1.1", "Host: evil.example"]);
      const proxied = await rawRequest(https.port, [
        "TRACE / HTTP/1.1",
        "Host: money.example.com",
        "X-Forwarded-Proto: https",
      ]);

      expect(trace.status).toBe(405);
      expect(trace.headers).toMatch(/^allow: GET, HEAD, POST, PUT, PATCH, DELETE$/im);
      expect(wrongHost.status).toBe(421);
      expect(proxied.status).toBe(405);
      expect(plain.refusals().map((line) => line.reason)).toEqual([
        "unsupported-method",
        "wrong-host",
      ]);
      expect(https.refusals().map((line) => line.reason)).toEqual(["unsupported-method"]);
      expect(stderr.written()).toEqual([]);
    } finally {
      stderr.restore();
    }
  });

  it("never lets CONNECT or TRACK reach a route: Node closes the one and refuses the other", async () => {
    const stderr = watchStderr();
    try {
      const { port, refusals } = await startLogged("http://nas.local:8080");

      const tunnel = await rawRequest(port, [
        "CONNECT nas.local:8080 HTTP/1.1",
        "Host: nas.local:8080",
      ]);
      const track = await rawRequest(port, ["TRACK / HTTP/1.1", "Host: nas.local:8080"]);

      expect(tunnel.headers).toBe("");
      expect(track.status).toBe(400);
      expect(refusals()).toEqual([]);
      expect(stderr.written()).toEqual([]);
    } finally {
      stderr.restore();
    }
  });

  it.each([
    [
      "with the right Host",
      "http://nas.local:8080",
      "",
      ["GET http://probe-name:probe-word@nas.local:8080/api/ping HTTP/1.1", "Host: nas.local:8080"],
      "",
    ],
    [
      "with a name and no password",
      "http://nas.local:8080",
      "",
      ["GET http://probe-name@nas.local:8080/ HTTP/1.1", "Host: nas.local:8080"],
      "",
    ],
    [
      "with a body",
      "http://nas.local:8080",
      "",
      [
        "POST http://probe-name:probe-word@nas.local:8080/api/ping HTTP/1.1",
        "Host: nas.local:8080",
        "Content-Length: 2",
      ],
      "{}",
    ],
    [
      "from a trusted proxy in HTTPS mode",
      "https://money.example.com",
      "127.0.0.1",
      [
        "GET http://probe-name:probe-word@money.example.com/api/ping HTTP/1.1",
        "Host: money.example.com",
        "X-Forwarded-Proto: https",
      ],
      "",
    ],
  ])(
    "refuses with 400 an absolute target that holds a name, %s, and logs no name or password",
    async (_case, appUrl, trustedProxies, lines, body) => {
      const stderr = watchStderr();
      try {
        const { port, refusals, text } = await startLogged(appUrl, trustedProxies);
        const res = await rawRequest(port, lines, body);

        expect(res.status).toBe(400);
        expect(res.body).toContain("The app could not read this request.");
        expect(refusals()).toEqual([expect.objectContaining({ reason: "unclear-request" })]);
        expect(text()).not.toMatch(/probe-name|probe-word/);
        expect(stderr.written()).toEqual([]);
      } finally {
        stderr.restore();
      }
    },
  );
});

const SRC = fileURLToPath(new URL("..", import.meta.url));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
  });
}

const filesMatching = (pattern: RegExp) =>
  sourceFiles(SRC)
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => relative(ROOT, file).split(sep).join("/"));

// A header name in quotes that names a client's address, host, scheme, or path.
const FORWARDED_HEADER =
  /["'`](?:forwarded[a-z-]*|x-forwarded[a-z-]*|x-original-[a-z-]+|x-real-[a-z-]+|x-rewrite-[a-z-]+|[a-z-]+-(?:client|connecting|user)-ip|x-host|x-url-scheme|front-end-https|cf-pseudo-ipv4|x-envoy-external-address)["'`]/i;

it("only the security check names forwarded headers", () => {
  expect(filesMatching(FORWARDED_HEADER)).toEqual(["src/server/security-mode.ts"]);
});

// Code that reads the raw Node request: c.env.incoming, incoming taken out of env, or
// node-server's getConnInfo, which reads it too.
const RAW_NODE_REQUEST =
  /\benv\s*(?:\?\.|\.|\[\s*["'`])\s*incoming\b|\{[^}]*\bincoming\b[^}]*\}\s*=\s*[\w.?]*\benv\b|\bgetConnInfo\b|node-server\/conninfo/;

it.each([
  "c.env.incoming.headers",
  "c.env?.incoming",
  'c.env["incoming"]',
  "const { incoming } = c.env;",
  "const { outgoing, incoming: request } = c.env;",
  "getConnInfo(c)",
  'import { getConnInfo } from "@hono/node-server/conninfo";',
])("the raw-request guard catches %s", (code) => {
  expect(RAW_NODE_REQUEST.test(code)).toBe(true);
});

it.each(["const incoming = transfers.filter((t) => t.amount > 0);", "c.env.APP_URL"])(
  "the raw-request guard passes %s",
  (code) => {
    expect(RAW_NODE_REQUEST.test(code)).toBe(false);
  },
);

it("only the security check reads the raw Node request", () => {
  expect(filesMatching(RAW_NODE_REQUEST)).toEqual(["src/server/security-mode.ts"]);
});
