import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AI_REQUEST_LOG_CLEANUP_CAP,
  AI_REQUEST_LOG_MAX_BYTES,
  AI_REQUEST_LOG_PAGE,
  type AiRequestLogPage,
  aiRequestLogRoutes,
} from "../ai/index.ts";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import { addAiRequestLogEntry, markSetupStep, readAiRequestLogSettings } from "../db/index.ts";
import { createApp } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// Settings → AI usage: the AI request log's switch, kept days, and kept text (spec 08, AI request
// log), through the app's HTTP interface. No test makes an AI call: entries go straight to
// app.db.

const APP_URL = "http://nas.local:8080";
const TOTP_STEP_MS = 30_000;
const SETTINGS = "/api/ai-request-log/settings";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-ai-request-log-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the AI request log routes", () => {
  let test: TestAuth;
  let app: App;
  let alice: TestMember;
  let clients = 0;
  const notices: string[] = [];

  const settingsRow = async () =>
    (
      await test.database.$client.execute(
        `SELECT "on", keep_days AS keepDays, cleanup_failures AS cleanupFailures FROM ai_request_log_settings`,
      )
    ).rows.map((row) => ({ ...row }));
  const entryCount = async () =>
    Number(
      (await test.database.$client.execute("SELECT count(*) AS n FROM ai_request_log")).rows[0]?.n,
    );
  const pageOf = async (tab: TestBrowser, query = "") =>
    ((await (await tab.get(`/api/ai-request-log${query}`)).json()) as { log: AiRequestLogPage })
      .log;
  const keep = async (at: Date, request = "the request") =>
    addAiRequestLogEntry(
      test.database,
      {
        at,
        aiCallId: null,
        chatThreadId: null,
        use: "category fix",
        model: "test-model",
        request,
        requestCut: false,
        response: "the reply",
        responseCut: false,
        failure: "rate limit",
        failureStatus: 429,
      },
      {
        cleanupCap: AI_REQUEST_LOG_CLEANUP_CAP,
        switchOffs: (await readAiRequestLogSettings(test.database)).switchOffs,
        maxBytes: AI_REQUEST_LOG_MAX_BYTES,
      },
    );

  async function signedIn(member: TestMember): Promise<TestBrowser> {
    clients += 1;
    const tab = new TestBrowser(app, APP_URL, `192.168.1.${clients}`);
    await tab.signIn(member);
    vi.setSystemTime(Date.now() + TOTP_STEP_MS);
    return tab;
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-06T15:00:00.000Z"));
    notices.length = 0;
    test = await newTestAuth(APP_URL);
    const security = await loadSecurity({ APP_URL });
    const aiRequestLog = aiRequestLogRoutes({
      database: test.database,
      notices: {
        raise: async (notice) => {
          notices.push(notice.kind === "condition" ? notice.condition : notice.kind);
        },
        end: async () => {},
      },
    });
    app = createApp(webRoot, security, test.auth, test.database, test.secrets, { aiRequestLog });
    alice = await addMember(test.auth, { name: "Alice", email: "alice@example.test" });
    await markSetupStep(test.database, "master key", "done");
    await markSetupStep(test.database, "household facts", "done");
  });

  afterEach(() => {
    vi.useRealTimers();
    test.close();
  });

  it("is off and keeps 30 days at first, keeps text while on, and deletes it all when turned off", async () => {
    const tab = await signedIn(alice);
    expect(await pageOf(tab)).toEqual({
      settings: { on: false, keepDays: 30, stopped: false },
      entries: [],
      older: null,
    });
    // Off keeps nothing.
    expect(await keep(new Date())).toBe(false);

    const on = await tab.send("PUT", SETTINGS, { on: true, keepDays: 7 });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ settings: { on: true, keepDays: 7, stopped: false } });
    expect(await keep(new Date())).toBe(true);

    const page = await pageOf(tab);
    expect(page.entries).toEqual([
      {
        id: expect.any(Number),
        at: "2026-11-06T15:00:30.000Z",
        use: "category fix",
        model: "test-model",
        failure: "rate limit",
        failureStatus: 429,
        usage: null,
      },
    ]);
    const id = page.entries[0]?.id;
    const read = await tab.get(`/api/ai-request-log/${id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({
      entry: { id, request: "the request", requestCut: false, response: "the reply" },
    });

    const off = await tab.send("PUT", SETTINGS, { on: false, keepDays: 7 });
    expect(off.status).toBe(200);
    expect(await entryCount()).toBe(0);
    // The AI usage page reads the switch and the kept days alone.
    const settings = await tab.get(SETTINGS);
    expect(settings.status).toBe(200);
    expect(await settings.json()).toEqual({
      settings: { on: false, keepDays: 7, stopped: false },
    });
    expect((await tab.get(`/api/ai-request-log/${id}`)).status).toBe(404);
    expect(await settingsRow()).toEqual([{ on: 0, keepDays: 7, cleanupFailures: 0 }]);
  });

  it("deletes text older than fewer kept days at once, and keeps the newer text", async () => {
    const tab = await signedIn(alice);
    expect((await tab.send("PUT", SETTINGS, { on: true, keepDays: 90 })).status).toBe(200);
    const now = Date.now();
    expect(await keep(new Date(now - 40 * 24 * 60 * 60 * 1000), "forty days")).toBe(true);
    expect(await keep(new Date(now - 10 * 24 * 60 * 60 * 1000), "ten days")).toBe(true);
    expect(await keep(new Date(now - 60 * 60 * 1000), "an hour")).toBe(true);

    expect((await tab.send("PUT", SETTINGS, { on: true, keepDays: 30 })).status).toBe(200);
    expect(await entryCount()).toBe(2);
    expect((await tab.send("PUT", SETTINGS, { on: true, keepDays: 7 })).status).toBe(200);
    const left = await test.database.$client.execute("SELECT request FROM ai_request_log");
    expect(left.rows.map((row) => row.request)).toEqual(["an hour"]);
    // More kept days leaves the text as it is.
    expect((await tab.send("PUT", SETTINGS, { on: true, keepDays: 90 })).status).toBe(200);
    expect(await entryCount()).toBe(1);
    expect(notices).toEqual([]);
  });

  it("pages newest first with a keyset cursor, and refuses a cursor that is not an ID", async () => {
    const tab = await signedIn(alice);
    expect((await tab.send("PUT", SETTINGS, { on: true, keepDays: 30 })).status).toBe(200);
    const kept = AI_REQUEST_LOG_PAGE + 3;
    for (let each = 0; each < kept; each += 1) {
      expect(await keep(new Date(Date.now() + each * 1000), `call ${each}`)).toBe(true);
    }
    const first = await pageOf(tab);
    expect(first.entries).toHaveLength(AI_REQUEST_LOG_PAGE);
    expect(first.older).toBe(first.entries.at(-1)?.id);
    const ids = first.entries.map((entry) => entry.id);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    const second = await pageOf(tab, `?before=${first.older}`);
    expect(second.entries).toHaveLength(3);
    expect(second.older).toBeNull();
    expect(Math.max(...second.entries.map((entry) => entry.id))).toBeLessThan(Math.min(...ids));

    for (const before of ["0", "-1", "1.5", "abc", "1e3", "", "9".repeat(16)]) {
      const res = await tab.get(`/api/ai-request-log?before=${encodeURIComponent(before)}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Ask for the page before a kept call's ID." });
    }
    for (const id of ["0", "abc", "1.0", "9".repeat(16), "999999"]) {
      const res = await tab.get(`/api/ai-request-log/${id}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "No kept AI request has this ID." });
    }
  });

  it("refuses a body that is not a switch and 7, 30, or 90 days, and changes nothing", async () => {
    const tab = await signedIn(alice);
    expect((await tab.send("PUT", SETTINGS, { on: true, keepDays: 30 })).status).toBe(200);
    expect(await keep(new Date())).toBe(true);
    for (const body of [
      {},
      { on: true },
      { keepDays: 7 },
      { on: "no", keepDays: 7 },
      { on: false, keepDays: 14 },
      { on: false, keepDays: "7" },
      { on: false, keepDays: 7, cleanupFailures: 0 },
    ]) {
      const res = await tab.send("PUT", SETTINGS, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "Turn the AI request log on or off, and keep 7, 30, or 90 days.",
      });
    }
    expect(await settingsRow()).toEqual([{ on: 1, keepDays: 30, cleanupFailures: 0 }]);
    expect(await entryCount()).toBe(1);
  });

  it("answers 401 with no session, 403 to another site or no Origin, and 415 to a body that is not JSON, and changes nothing", async () => {
    const tab = await signedIn(alice);
    expect((await tab.send("PUT", SETTINGS, { on: true, keepDays: 30 })).status).toBe(200);
    expect(await keep(new Date())).toBe(true);
    const id = (await pageOf(tab)).entries[0]?.id;
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.250");
    const body = { on: false, keepDays: 7 };
    expect((await signedOut.send("PUT", SETTINGS, body)).status).toBe(401);
    expect(
      (await tab.send("PUT", SETTINGS, body, { origin: "http://evil.example.test" })).status,
    ).toBe(403);
    expect((await tab.send("PUT", SETTINGS, body, { origin: undefined })).status).toBe(403);
    expect((await tab.send("PUT", SETTINGS, body, { "content-type": "text/plain" })).status).toBe(
      415,
    );
    expect((await signedOut.get("/api/ai-request-log")).status).toBe(401);
    expect((await signedOut.get(SETTINGS)).status).toBe(401);
    expect((await signedOut.get(`/api/ai-request-log/${id}`)).status).toBe(401);
    expect(await settingsRow()).toEqual([{ on: 1, keepDays: 30, cleanupFailures: 0 }]);
    expect(await entryCount()).toBe(1);
  });
});
