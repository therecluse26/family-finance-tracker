import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hc } from "hono/client";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { BROWSER_NOTICES } from "../../scripts/browser-notices.ts";
import { createLogger } from "../log.ts";
import type { Api } from "./api.ts";
import { loadSecurity } from "./security-mode.ts";
import { type RunningServer, startServer } from "./server.ts";

const INDEX_HTML = "<!doctype html><title>Family Finance Tracker</title>";
const ASSET_JS = "console.log('asset');";
const NOTICES = "Third-party notices for the Family Finance Tracker web app\n";

// The tests stand where a trusted proxy would, on loopback, and mark each request as HTTPS.
const THROUGH_PROXY = { "x-forwarded-proto": "https" };

describe("the server", () => {
  let webRoot: string;
  let server: RunningServer;
  let base: string;

  const get = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { ...THROUGH_PROXY, ...init.headers } });

  beforeAll(async () => {
    webRoot = mkdtempSync(join(tmpdir(), "fft-web-"));
    writeFileSync(join(webRoot, "index.html"), INDEX_HTML);
    mkdirSync(join(webRoot, "assets"));
    writeFileSync(join(webRoot, "assets", "app.js"), ASSET_JS);
    writeFileSync(join(webRoot, BROWSER_NOTICES), NOTICES);
    const security = await loadSecurity(
      { APP_URL: "https://money.example.com", TRUSTED_PROXIES: "127.0.0.1" },
      { logger: createLogger(() => {}, { throwOnSecretField: true }) },
    );
    server = await startServer({ port: 0, webRoot, security });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
    rmSync(webRoot, { recursive: true, force: true });
  });

  it("answers GET /healthz with 200 and health only", async () => {
    const res = await fetch(`${base}/healthz`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("answers the sample route through the typed client", async () => {
    const client = hc<Api>(`${base}/api`, { headers: THROUGH_PROXY });
    const res = await client.ping.$get();
    const body = await res.json();

    expectTypeOf(body).toEqualTypeOf<{ ok: true }>();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("gives the web app the security mode through the typed client", async () => {
    const client = hc<Api>(`${base}/api`, { headers: THROUGH_PROXY });
    const res = await client["security-mode"].$get();
    const body = await res.json();

    expectTypeOf(body).toEqualTypeOf<{ mode: "https" | "http"; appUrl: string }>();
    expect(body).toEqual({ mode: "https", appUrl: "https://money.example.com" });
  });

  it("answers an unknown /api path with a JSON 404", async () => {
    const res = await get("/api/nothing-here");

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
