import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import { markSetupStep } from "../db/index.ts";
import { createLogger } from "../log.ts";
import { createApp } from "./app.ts";
import type { DeviceView } from "./devices-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// Settings, My login, Signed-in devices (spec 09), through the app's HTTP interface: the list of a
// Member's own sessions, "Sign out" on one, and "Sign out everywhere else". Each test gets a new
// app.db and Master key, and every password and TOTP secret is made when the test runs.

const APP_URL = "http://nas.local:8080";
const NOW = new Date("2026-11-06T14:30:00.000Z");
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const TOTP_STEP_MS = 30_000;

const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MARKUP = '<script>alert("x")</script><img src=x onerror=alert(1)>';

const WRONG_ORIGINS = [
  "http://nas.local:9090",
  "http://evil.example",
  `${APP_URL}.evil.example`,
  "",
  undefined,
];

const ALREADY = { error: "That device is already signed out." };

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-devices-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("Settings, My login, Signed-in devices", () => {
  let test: TestAuth;
  let app: App;
  let lines: string[];
  let alice: TestMember;
  let bob: TestMember;
  let clients = 0;

  const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
  const query = async (sql: string, args: (string | number)[] = []) =>
    (await test.database.$client.execute({ sql, args })).rows;

  // A browser whose every request sends this user agent, as a real one does. Better Auth keeps the
  // user agent of the request that makes the session: the TOTP step.
  class Browser extends TestBrowser {
    readonly userAgent: string | undefined;
    constructor(userAgent: string | undefined) {
      clients += 1;
      super(app, APP_URL, `192.168.1.${clients}`);
      this.userAgent = userAgent;
    }
    override send(
      method: string,
      path: string,
      body?: unknown,
      headers: Record<string, string | undefined> = {},
    ) {
      return super.send(method, path, body, { "user-agent": this.userAgent, ...headers });
    }
  }

  // Each TOTP code works once, so each sign-in takes its own step.
  async function signedIn(member: TestMember, userAgent?: string): Promise<Browser> {
    later(TOTP_STEP_MS);
    const tab = new Browser(userAgent);
    await tab.signIn(member);
    later(MINUTE_MS);
    return tab;
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    lines = [];
    const logger = createLogger((line) => lines.push(line), { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, logger);
    app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger }),
      test.auth,
      test.database,
      test.secrets,
    );
    alice = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    bob = await addMember(test.auth, { name: "Bob", email: "bob@example.com" });
    await markSetupStep(test.database, "master key", "done");
    await markSetupStep(test.database, "household facts", "done");
  });

  afterEach(() => {
    test.close();
    vi.useRealTimers();
  });

  async function devices(tab: Browser): Promise<DeviceView[]> {
    const res = await tab.get("/api/my-login/devices");
    expect(res.status).toBe(200);
    return ((await res.json()) as { devices: DeviceView[] }).devices;
  }

  // The exact requests the page sends: each with an empty JSON body.
  const signOut = (tab: Browser, id: string, headers: Record<string, string | undefined> = {}) =>
    tab.send("POST", `/api/my-login/devices/${id}/sign-out`, {}, headers);
  const signOutOthers = (tab: Browser, headers: Record<string, string | undefined> = {}) =>
    tab.send("POST", "/api/my-login/sign-out-other-devices", {}, headers);

  // Every session row, by ID and Member, without the times each request renews.
  const sessionRows = () => query("SELECT id, member_id FROM sessions ORDER BY id");

  const idOf = (list: DeviceView[], name: string) =>
    list.find((device) => device.name === name)?.id ?? "";

  describe("the list", () => {
    it("lists the Member's own sessions, this device first and then the newest, with a short name and the sign-in time", async () => {
      const phone = await signedIn(alice, SAFARI_IPHONE);
      const laptop = await signedIn(alice, FIREFOX_LINUX);
      later(DAY_MS);
      const desktop = await signedIn(alice, CHROME_WINDOWS);
      await signedIn(bob, FIREFOX_LINUX);
      const created = await query(
        "SELECT user_agent, created_at FROM sessions WHERE member_id = ?",
        [alice.id],
      );
      const signInOf = (agent: string) =>
        String(created.find((row) => row.user_agent === agent)?.created_at);

      const list = await devices(laptop);

      expect(list.map(({ id: _, ...device }) => device)).toEqual([
        { name: "Firefox on Linux", signedInAt: signInOf(FIREFOX_LINUX), thisDevice: true },
        { name: "Chrome on Windows", signedInAt: signInOf(CHROME_WINDOWS), thisDevice: false },
        { name: "Safari on iPhone", signedInAt: signInOf(SAFARI_IPHONE), thisDevice: false },
      ]);
      expect(new Set(list.map((device) => device.id)).size).toBe(3);
      expect((await devices(phone))[0]).toMatchObject({
        name: "Safari on iPhone",
        thisDevice: true,
      });
      expect((await devices(desktop)).filter((device) => device.thisDevice)).toHaveLength(1);
    });

    it("never sends another Member's sessions, a token, an IP address, or the user agent", async () => {
      const tab = await signedIn(alice, FIREFOX_LINUX);
      await signedIn(alice, SAFARI_IPHONE);
      const bobTab = await signedIn(bob, CHROME_WINDOWS);
      const rows = await query("SELECT id, token, member_id, ip_address FROM sessions");
      const bobIds = (await devices(bobTab)).map((device) => device.id);

      const res = await tab.get("/api/my-login/devices");
      const text = await res.text();

      expect(Object.keys(JSON.parse(text))).toEqual(["devices"]);
      for (const device of (JSON.parse(text) as { devices: DeviceView[] }).devices) {
        expect(Object.keys(device).sort()).toEqual(["id", "name", "signedInAt", "thisDevice"]);
      }
      for (const row of rows) expect(text).not.toContain(String(row.token));
      for (const id of bobIds) expect(text).not.toContain(id);
      for (const row of rows) expect(text).not.toContain(String(row.ip_address));
      expect(text).not.toMatch(/192\.168\.|Mozilla|Gecko|AppleWebKit/);
      expect(rows.filter((row) => row.member_id === bob.id).map((row) => row.id)).toEqual(bobIds);
    });

    it("leaves out a session that has expired", async () => {
      const tab = await signedIn(alice, FIREFOX_LINUX);
      const phone = await signedIn(alice, SAFARI_IPHONE);
      const phoneId = idOf(await devices(tab), "Safari on iPhone");
      await query("UPDATE sessions SET expires_at = ? WHERE id = ?", [NOW.toISOString(), phoneId]);

      expect((await devices(tab)).map((device) => device.name)).toEqual(["Firefox on Linux"]);
      expect(await phone.isSignedIn()).toBe(false);
    });

    it("names a session with no user agent, or one it cannot read, Unknown browser, and sends none of it", async () => {
      const tab = await signedIn(alice, undefined);
      await signedIn(alice, MARKUP);
      await signedIn(alice, `Firefox/1.0 \t\u00e9\u00ff ${"x".repeat(50_000)}`);

      const text = await (await tab.get("/api/my-login/devices")).text();
      const names = (JSON.parse(text) as { devices: DeviceView[] }).devices.map((d) => d.name);

      expect(names).toEqual(["Unknown browser", "Firefox", "Unknown browser"]);
      expect(text).not.toMatch(/script|onerror|xxxx|\u00e9/);
    });

    it("answers 401 with no session", async () => {
      const stranger = new Browser(FIREFOX_LINUX);

      expect((await stranger.get("/api/my-login/devices")).status).toBe(401);
    });
  });

  describe("Sign out on a device", () => {
    it("ends that one session, and this device and the others stay signed in", async () => {
      const tab = await signedIn(alice, FIREFOX_LINUX);
      const phone = await signedIn(alice, SAFARI_IPHONE);
      const desktop = await signedIn(alice, CHROME_WINDOWS);
      const bobTab = await signedIn(bob, SAFARI_IPHONE);

      const res = await signOut(tab, idOf(await devices(tab), "Safari on iPhone"));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ signedOut: true });
      expect(await phone.isSignedIn()).toBe(false);
      expect(await tab.isSignedIn()).toBe(true);
      expect(await desktop.isSignedIn()).toBe(true);
      expect(await bobTab.isSignedIn()).toBe(true);
      expect((await devices(tab)).map((device) => device.name)).toEqual([
        "Firefox on Linux",
        "Chrome on Windows",
      ]);
    });

    it("changes nothing for another Member's session, and answers as for an ID no session has", async () => {
      const tab = await signedIn(alice, FIREFOX_LINUX);
      const bobTab = await signedIn(bob, SAFARI_IPHONE);
      const [bobDevice] = await devices(bobTab);
      const before = await sessionRows();

      const theirs = await signOut(tab, bobDevice?.id ?? "");
      const unknown = await signOut(tab, "no-such-session");

      expect([theirs.status, unknown.status]).toEqual([404, 404]);
      expect(await theirs.json()).toEqual(ALREADY);
      expect(await unknown.json()).toEqual(ALREADY);
      expect(await bobTab.isSignedIn()).toBe(true);
      expect(await sessionRows()).toEqual(before);
    });

    it("changes nothing for an expired session, and answers as for an ID no session has", async () => {
      const tab = await signedIn(alice, FIREFOX_LINUX);
      await signedIn(alice, SAFARI_IPHONE);
      const phoneId = idOf(await devices(tab), "Safari on iPhone");
      await query("UPDATE sessions SET expires_at = ? WHERE id = ?", [NOW.toISOString(), phoneId]);
      const before = await sessionRows();

      const res = await signOut(tab, phoneId);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(ALREADY);
      expect(await sessionRows()).toEqual(before);
      expect(before.map((row) => row.id)).toContain(phoneId);
    });

    it("answers 404 to a device it already signed out", async () => {
      const tab = await signedIn(alice, FIREFOX_LINUX);
      await signedIn(alice, SAFARI_IPHONE);
      const phoneId = idOf(await devices(tab), "Safari on iPhone");

      expect((await signOut(tab, phoneId)).status).toBe(200);
      const again = await signOut(tab, phoneId);

      expect(again.status).toBe(404);
      expect(await again.json()).toEqual(ALREADY);
    });

    it("refuses this device, which signs out with Sign out, and keeps it signed in", async () => {
      const tab = await signedIn(alice, FIREFOX_LINUX);
      const [self] = await devices(tab);

      const res = await signOut(tab, self?.id ?? "");

      expect(res.status).toBe(409);
      expect(await tab.isSignedIn()).toBe(true);
    });

    it("answers 401 with no session, 403 from another origin or none, 415 to a body that is not JSON, and 400 to a bad body, and ends no session", async () => {
      const tab = await signedIn(alice, FIREFOX_LINUX);
      const phone = await signedIn(alice, SAFARI_IPHONE);
      const phoneId = idOf(await devices(tab), "Safari on iPhone");
      const stranger = new Browser(FIREFOX_LINUX);
      const before = await sessionRows();

      expect((await signOut(stranger, phoneId)).status).toBe(401);
      expect((await signOutOthers(stranger)).status).toBe(401);
      for (const origin of WRONG_ORIGINS) {
        expect((await signOut(tab, phoneId, { origin })).status, `${origin}`).toBe(403);
        expect((await signOutOthers(tab, { origin })).status, `${origin}`).toBe(403);
      }
      for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
        expect((await signOut(tab, phoneId, { "content-type": type })).status).toBe(415);
        expect((await signOutOthers(tab, { "content-type": type })).status).toBe(415);
      }
      for (const body of [{ id: phoneId }, [], null, "now"]) {
        const path = `/api/my-login/devices/${phoneId}/sign-out`;
        expect((await tab.send("POST", path, body)).status).toBe(400);
        expect((await tab.send("POST", "/api/my-login/sign-out-other-devices", body)).status).toBe(
          400,
        );
      }

      expect(await sessionRows()).toEqual(before);
      expect(await phone.isSignedIn()).toBe(true);
    });
  });

  describe("Sign out everywhere else", () => {
    it("ends the Member's other sessions and their sign-ins that wait for a code, and keeps this one and other Members'", async () => {
      const tab = await signedIn(alice, FIREFOX_LINUX);
      const phone = await signedIn(alice, SAFARI_IPHONE);
      const desktop = await signedIn(alice, CHROME_WINDOWS);
      const bobTab = await signedIn(bob, SAFARI_IPHONE);
      later(TOTP_STEP_MS);
      const waiting = new Browser(SAFARI_IPHONE);
      const password = await waiting.post("/api/auth/sign-in/email", {
        email: alice.email,
        password: alice.password,
      });
      expect(password.status).toBe(200);

      const res = await signOutOthers(tab);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ signedOut: true });
      expect(await phone.isSignedIn()).toBe(false);
      expect(await desktop.isSignedIn()).toBe(false);
      expect(await tab.isSignedIn()).toBe(true);
      expect(await bobTab.isSignedIn()).toBe(true);
      const code = await waiting.post("/api/auth/two-factor/verify-totp", {
        code: await alice.totpCode(),
      });
      expect(code.status).not.toBe(200);
      expect(await waiting.isSignedIn()).toBe(false);
      expect((await devices(tab)).map((device) => device.name)).toEqual(["Firefox on Linux"]);
    });
  });

  it("writes no token, IP address, or user agent to the log", async () => {
    const tab = await signedIn(alice, FIREFOX_LINUX);
    await signedIn(alice, SAFARI_IPHONE);
    await signedIn(bob, CHROME_WINDOWS);
    await signOut(tab, idOf(await devices(tab), "Safari on iPhone"));
    await signOut(tab, "no-such-session");
    await signOutOthers(tab);
    const tokens = await query("SELECT token FROM sessions");

    const log = lines.join("\n");
    for (const row of tokens) expect(log).not.toContain(String(row.token));
    expect(log).not.toMatch(/192\.168\.|Mozilla/);
  });
});
