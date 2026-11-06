import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMember,
  newPassword,
  newTestAuth,
  type TestAuth,
  type TestMember,
  totpCodeFromURI,
} from "../auth/testing.ts";
import { markSetupStep } from "../db/index.ts";
import { readEveryTable } from "../db/testing.ts";
import { createLogger } from "../log.ts";
import { newMasterKeyHex } from "../secrets/testing.ts";
import { createApp } from "../server/app.ts";
import { loadSecurity } from "../server/security-mode.ts";
import { type App, TestBrowser } from "../server/testing.ts";
import { runFft } from "./fft.ts";

// `fft reset-login <email>` (spec 12, The `fft` command), run against the app.db of an app that is
// running, as the self-hoster runs it beside the app. Each test gets a new app.db and Master key.

const APP_URL = "http://192.168.1.20:3000";
const SHIPPED_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const LINK = /^ {2}(http:\/\/192\.168\.1\.20:3000\/reset#token=([A-Za-z0-9_-]{43}))$/m;
const TOTP_STEP_MS = 30_000;

describe("fft reset-login", () => {
  let test: TestAuth;
  let app: App;
  let lines: string[];
  let dir: string;
  let bob: TestMember;
  let bobTab: TestBrowser;
  let out: string;
  let err: string;
  let clients = 0;

  const browser = () => {
    clients += 1;
    return new TestBrowser(app, APP_URL, `192.168.1.${100 + clients}`);
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T15:00:00.000Z"));
    lines = [];
    const logger = createLogger((line) => lines.push(line), { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, logger);
    app = createApp(
      webRoot(),
      await loadSecurity({ APP_URL }, { logger }),
      test.auth,
      test.database,
      test.secrets,
    );
    await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    bob = await addMember(test.auth, { name: "Bob", email: "bob@example.com" });
    await markSetupStep(test.database, "master key", "done");
    vi.setSystemTime(Date.now() + TOTP_STEP_MS);
    bobTab = browser();
    await bobTab.signIn(bob);
    out = "";
    err = "";
  });

  afterEach(() => {
    test.close();
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function webRoot(): string {
    dir = mkdtempSync(join(tmpdir(), "fft-reset-login-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html>");
    return dir;
  }

  // The Master key comes from FFT_MASTER_KEY, as on a platform service; no key file exists.
  function fft(args: string[], env: Record<string, string | undefined> = {}) {
    return runFft(args, {
      env: {
        APP_URL,
        FFT_MASTER_KEY_FILE: join(dir, "secrets", "master.key"),
        FFT_MASTER_KEY: test.secrets.showMasterKey(),
        ...env,
      },
      databaseFile: test.path,
      migrationsFolder: SHIPPED_FOLDER,
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    });
  }

  async function lasting() {
    const tables = await readEveryTable(test.database);
    return {
      accounts: tables.accounts,
      two_factors: tables.two_factors,
      login_resets: tables.login_resets,
      sessions: (tables.sessions as { id: string }[]).map((session) => session.id),
    };
  }

  it("with a known email, in any letter case, prints a reset link that the running app takes once", async () => {
    expect(await fft(["reset-login", "Bob@Example.com"])).toBe(0);

    const [, link = "", token = ""] = LINK.exec(out) ?? [];
    expect(link).not.toBe("");
    expect(err).toBe("");
    // The running app sees the reset at once.
    expect(await bobTab.isSignedIn()).toBe(false);
    await expect(browser().signIn(bob)).rejects.toThrow("The password step answered 401");

    const tab = browser();
    expect((await tab.post("/api/auth/login-reset/check", { token })).status).toBe(200);
    const totp = await tab.post("/api/auth/login-reset/new-totp", { token });
    const { totpURI } = (await totp.json()) as { totpURI: string };
    const login = { token, password: newPassword(), totpCode: await totpCodeFromURI(totpURI) };
    expect((await tab.post("/api/auth/login-reset/finish", login)).status).toBe(200);
    expect(await tab.isSignedIn()).toBe(true);
    expect((await browser().post("/api/auth/login-reset/check", { token })).status).toBe(403);

    for (const logged of [lines.join("\n"), err]) expect(logged).not.toContain(token);
  });

  it("with an unknown email, prints an error, exits nonzero, and changes nothing", async () => {
    const before = await lasting();

    const code = await fft(["reset-login", "carol@example.com"]);

    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe("No Member has this email address.\n");
    expect(await lasting()).toEqual(before);
    expect(await bobTab.isSignedIn()).toBe(true);
  });

  it("with a Master key that is not the app's, stops and changes nothing", async () => {
    const before = await lasting();

    expect(await fft(["reset-login", bob.email], { FFT_MASTER_KEY: newMasterKeyHex() })).toBe(1);

    expect(out).toBe("");
    expect(err).toContain("The Master key cannot decrypt the data key in app.db");
    expect(await lasting()).toEqual(before);
  });

  it("stops without APP_URL, and without an email, changing nothing", async () => {
    const before = await lasting();

    expect(await fft(["reset-login", bob.email], { APP_URL: undefined })).toBe(1);
    expect(err).toContain("APP_URL is not set.");
    expect(await fft(["reset-login"])).toBe(2);
    expect(await fft(["reset-login", bob.email, "extra"])).toBe(2);
    expect(err).toContain("Usage: fft reset-login <email>");

    expect(out).toBe("");
    expect(await lasting()).toEqual(before);
  });
});
