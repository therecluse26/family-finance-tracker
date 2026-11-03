import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hc } from "hono/client";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import type { Api } from "./api.ts";
import { type RunningServer, startServer } from "./server.ts";

const INDEX_HTML = "<!doctype html><title>Family Finance Tracker</title>";
const ASSET_JS = "console.log('asset');";

describe("the server", () => {
  let webRoot: string;
  let server: RunningServer;
  let base: string;

  beforeAll(async () => {
    webRoot = mkdtempSync(join(tmpdir(), "fft-web-"));
    writeFileSync(join(webRoot, "index.html"), INDEX_HTML);
    mkdirSync(join(webRoot, "assets"));
    writeFileSync(join(webRoot, "assets", "app.js"), ASSET_JS);
    server = await startServer({ port: 0, webRoot });
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
    const client = hc<Api>(`${base}/api`);
    const res = await client.ping.$get();
    const body = await res.json();

    expectTypeOf(body).toEqualTypeOf<{ ok: true }>();
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });

  it("answers an unknown /api path with a JSON 404", async () => {
    const res = await fetch(`${base}/api/nothing-here`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("serves the web app's files", async () => {
    const res = await fetch(`${base}/assets/app.js`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(await res.text()).toBe(ASSET_JS);
  });

  it.each(["/", "/transactions", "/settings/backups"])(
    "serves index.html for GET %s",
    async (path) => {
      const res = await fetch(`${base}${path}`);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/html/);
      expect(await res.text()).toBe(INDEX_HTML);
    },
  );

  it("does not serve index.html for other methods", async () => {
    const res = await fetch(`${base}/transactions`, { method: "POST" });

    expect(res.status).toBe(404);
  });
});
