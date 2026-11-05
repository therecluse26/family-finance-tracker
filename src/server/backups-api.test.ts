import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { startBackups } from "../backups/index.ts";
import { markSetupStep } from "../db/index.ts";
import { createLogger } from "../log.ts";
import { startNotify } from "../notify/index.ts";
import { createApp } from "./app.ts";
import type { BackupsView } from "./backups-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// The Settings, Backups and data routes, through the app's HTTP interface, with the backup folder
// in a temporary folder.

const APP_URL = "http://nas.local:8080";

const WRONG_ORIGINS = [
  "http://nas.local:9090",
  "http://evil.example",
  `${APP_URL}.evil.example`,
  "",
  undefined,
];

const NOW = new Date("2026-11-02T15:30:00.000Z");

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-backups-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the Settings, Backups and data routes", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;
  let folder: string;
  let checkPasses: boolean;
  let stops: (() => void)[];

  beforeEach(async () => {
    const quiet = createLogger(() => {}, { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, quiet);
    folder = mkdtempSync(join(tmpdir(), "fft-backups-api-"));
    checkPasses = true;
    stops = [
      startNotify({ database: test.database }).stop,
      startBackups({
        database: test.database,
        folder,
        timeZone: async () => undefined,
        now: () => NOW,
        checkCopy: async () => checkPasses,
      }).stop,
    ];
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
    for (const stop of stops) stop();
    test.close();
    rmSync(folder, { recursive: true, force: true });
  });

  const status = async () =>
    ((await (await browser.get("/api/backups")).json()) as { backups: BackupsView }).backups;
  // The exact request the page sends: POST with an empty JSON body.
  const backUpNow = (headers: Record<string, string | undefined> = {}, body: unknown = {}) =>
    browser.send("POST", "/api/backups/now", body, headers);

  it("shows the folder in use, and no backup yet", async () => {
    expect(await status()).toEqual({
      folder,
      readable: true,
      lastBackupAt: null,
      files: 0,
      bytes: 0,
    });
  });

  it("lets any Member back up now, and answers with the result and the new totals", async () => {
    const res = await backUpNow();

    expect(res.status).toBe(200);
    const answer = (await res.json()) as {
      backup: { file: string; at: string };
      backups: BackupsView;
    };
    expect(answer.backup).toEqual({
      file: "app-20261102T153000Z-manual.db.gz",
      at: "2026-11-02T15:30:00.000Z",
    });
    expect(answer.backups).toMatchObject({
      folder,
      lastBackupAt: "2026-11-02T15:30:00.000Z",
      files: 1,
    });
    expect(answer.backups.bytes).toBeGreaterThan(0);
    expect(readdirSync(folder)).toEqual(["app-20261102T153000Z-manual.db.gz"]);
    expect(await status()).toEqual(answer.backups);
  });

  it("answers, and backs up, with a file in the folder whose name holds no real time", async () => {
    writeFileSync(join(folder, "app-99999999T999999Z-daily.db.gz"), "not a backup");

    const view = await browser.get("/api/backups");
    expect(view.status).toBe(200);
    expect(((await view.json()) as { backups: BackupsView }).backups).toMatchObject({
      lastBackupAt: null,
      files: 0,
    });
    expect((await backUpNow()).status).toBe(200);
    expect(readdirSync(folder).sort()).toEqual([
      "app-20261102T153000Z-manual.db.gz",
      "app-99999999T999999Z-daily.db.gz",
    ]);
  });

  it("says why a backup failed, and leaves no file", async () => {
    checkPasses = false;

    const res = await backUpNow();

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error:
        "The backup failed: the copy did not pass its integrity check, so the app deleted it. Try again.",
      backups: { folder, readable: true, lastBackupAt: null, files: 0, bytes: 0 },
    });
    expect(readdirSync(folder)).toEqual([]);
  });

  it("answers 401 with no session, 403 from another origin or none, 415 to a body that is not JSON, and 400 to a bad body, and makes no backup", async () => {
    const stranger = new TestBrowser(app, APP_URL, "192.168.1.21");
    expect((await stranger.get("/api/backups")).status).toBe(401);
    expect((await stranger.send("POST", "/api/backups/now", {})).status).toBe(401);

    for (const origin of WRONG_ORIGINS) {
      expect((await backUpNow({ origin })).status, `${origin}`).toBe(403);
    }
    expect((await backUpNow({ "content-type": "text/plain" })).status).toBe(415);
    expect((await backUpNow({ "content-type": "application/x-www-form-urlencoded" })).status).toBe(
      415,
    );
    for (const body of [{ kind: "daily" }, [], null, "now"]) {
      expect((await backUpNow({}, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(readdirSync(folder)).toEqual([]);
  });
});
