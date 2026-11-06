import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { markCpiFetched, markSetupStep, readUpdateCheck } from "../db/index.ts";
import { createLogger } from "../log.ts";
import type { AboutView } from "./about-views.ts";
import { createApp } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// The Settings, About routes, through the app's HTTP interface.

const APP_URL = "http://nas.local:8080";

const WRONG_ORIGINS = [
  "http://nas.local:9090",
  "http://evil.example",
  `${APP_URL}.evil.example`,
  "",
  undefined,
];

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-about-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the Settings, About routes", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;

  beforeEach(async () => {
    const quiet = createLogger(() => {}, { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, quiet);
    app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger: quiet }),
      test.auth,
      test.database,
      test.secrets,
    );
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);
    await markSetupStep(test.database, "master key", "done");
  });

  afterEach(() => {
    test.close();
  });

  const about = async (tab = browser) => (await (await tab.get("/api/about")).json()) as AboutView;
  const switchCheck = (body: unknown, headers: Record<string, string | undefined> = {}) =>
    browser.send("PUT", "/api/about/update-check", body, headers);
  const isOn = async () => (await readUpdateCheck(test.database)).enabled;

  it("shows the version, the Source code link, the notices, the Update check, and the Data sources page's parts", async () => {
    // The release's own version, written out: each release changes it (docs/releasing.md).
    expect(await about()).toEqual({
      version: "1.0.0",
      sourceCode: "https://github.com/therecluse26/family-finance-tracker/tree/v1.0.0",
      thirdPartyNotices: "/third-party-notices.txt",
      updateCheck: { on: true, checkedAt: null, update: null, lastFailure: null },
      dataSources: { cpiFetchedAt: null, benchmarkNotice: "Sample numbers, not real data" },
    });
  });

  it("shows the date the app last fetched the CPI", async () => {
    await markCpiFetched(test.database, "2026-11", new Date("2026-11-20T11:00:00.000Z"));

    expect((await about()).dataSources.cpiFetchedAt).toBe("2026-11-20T11:00:00.000Z");
  });

  it("lets any Member turn the Update check off and on", async () => {
    const off = await switchCheck({ on: false });

    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({
      updateCheck: { on: false, checkedAt: null, update: null, lastFailure: null },
    });
    expect((await about()).updateCheck.on).toBe(false);
    expect(await isOn()).toBe(false);

    expect((await switchCheck({ on: true })).status).toBe(200);
    expect(await isOn()).toBe(true);
  });

  it("answers 401 with no session, 403 from another origin or none, 415 to a body that is not JSON, and 400 to a bad body, and changes nothing", async () => {
    const stranger = new TestBrowser(app, APP_URL, "192.168.1.21");
    expect((await stranger.get("/api/about")).status).toBe(401);
    expect((await stranger.send("PUT", "/api/about/update-check", { on: false })).status).toBe(401);

    for (const origin of WRONG_ORIGINS) {
      expect((await switchCheck({ on: false }, { origin })).status, `${origin}`).toBe(403);
    }
    expect((await switchCheck({ on: false }, { "content-type": "text/plain" })).status).toBe(415);
    for (const body of [{}, { on: "no" }, { on: 0 }, { on: false, extra: 1 }, null]) {
      expect((await switchCheck(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await isOn()).toBe(true);
  });
});
