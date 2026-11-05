import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import { markSetupStep, VAPID_KEYS_ROW } from "../db/index.ts";
import { createLogger } from "../log.ts";
import { createApp } from "../server/app.ts";
import { loadSecurity } from "../server/security-mode.ts";
import { type App, TestBrowser } from "../server/testing.ts";
import { pushSettings } from "./index.ts";
import type { PushView } from "./push-view.ts";
import { newSubscription } from "./testing.ts";

// Settings → Alerts: push on this device (spec 06, Recipients and channels; spec 09, Security mode;
// Encryption at rest), through the app's HTTP interface. The test browser speaks plain HTTP, so
// HTTPS mode is the push settings the server makes in that mode (src/server/start.ts); plain-HTTP
// mode hides push. No test reaches a push service.

const APP_URL = "http://nas.local:8080";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-push-web-"));
  // The built page, as vite-plugin-pwa writes it, with the manifest and the service worker.
  writeFileSync(
    join(webRoot, "index.html"),
    '<!doctype html><head><link rel="icon" href="/icon.svg"><link rel="manifest" href="/manifest.webmanifest"></head>',
  );
  writeFileSync(join(webRoot, "manifest.webmanifest"), '{"name":"Family Finance Tracker"}');
  writeFileSync(join(webRoot, "sw.js"), "self.addEventListener('push', () => {});");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("Settings → Alerts: push on this device", () => {
  let test: TestAuth;
  let app: App;
  let lines: string[];
  let alice: TestMember;
  let bob: TestMember;
  let clients = 0;

  const query = async (sql: string) => (await test.database.$client.execute(sql)).rows;
  const devices = async () =>
    (await query("SELECT member_id, endpoint FROM push_devices ORDER BY id")).map((row) => ({
      memberId: row.member_id,
      endpoint: row.endpoint,
    }));
  const viewOf = async (tab: TestBrowser) =>
    ((await (await tab.get("/api/push")).json()) as { push: PushView }).push;

  async function start(mode: "https" | "http"): Promise<void> {
    lines = [];
    const logger = createLogger((line) => lines.push(line), { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, logger);
    const security = await loadSecurity({ APP_URL }, { logger });
    app = createApp(webRoot, security, test.auth, test.database, test.secrets, {
      push: pushSettings({
        database: test.database,
        secrets: test.secrets,
        available: mode === "https",
        logger,
      }),
    });
    alice = await addMember(test.auth, { name: "Alice", email: "alice@example.test" });
    bob = await addMember(test.auth, { name: "Bob", email: "bob@example.test" });
  }

  async function signedIn(member: TestMember): Promise<TestBrowser> {
    clients += 1;
    const tab = new TestBrowser(app, APP_URL, `192.168.1.${clients}`);
    await tab.signIn(member);
    return tab;
  }

  async function finishWizard(): Promise<void> {
    await markSetupStep(test.database, "master key", "done");
    await markSetupStep(test.database, "household facts", "done");
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    test.close();
  });

  describe("in HTTPS mode", () => {
    beforeEach(async () => {
      await start("https");
    });

    it("makes the VAPID keys once step 3 is done, stores both encrypted, and shows only the public key", async () => {
      const tab = await signedIn(alice);
      // Before step 3 the app makes no keys, even on a GET, which the wizard's 409 does not cover.
      expect(await viewOf(tab)).toEqual({ available: false, why: "setup not done" });
      expect(await query("SELECT * FROM vapid_keys")).toEqual([]);

      await finishWizard();
      const view = await viewOf(tab);
      expect(view).toEqual({ available: true, publicKey: expect.stringMatching(/^[\w-]{87}$/) });
      expect(await viewOf(await signedIn(bob))).toEqual(view);

      const rows = await query("SELECT id, public_key, private_key FROM vapid_keys");
      expect(rows).toHaveLength(1);
      const privateKey = test.secrets.decrypt(String(rows[0]?.private_key), {
        rowId: VAPID_KEYS_ROW,
        column: "vapid_keys.private_key",
      });
      const publicKey = (view as { publicKey: string }).publicKey;
      expect(String(rows[0]?.public_key)).not.toContain(publicKey);
      expect(String(rows[0]?.private_key)).not.toContain(privateKey);
      const answer = await (await tab.get("/api/push")).text();
      expect(answer).not.toContain(privateKey);
      expect(lines.join("")).not.toContain(privateKey);
      expect(lines.join("")).toContain("Made the VAPID keys");
    });

    it("turns Alerts on for the signed-in Member's device, and off only for their own", async () => {
      await finishWizard();
      const aliceTab = await signedIn(alice);
      const bobTab = await signedIn(bob);
      const phone = newSubscription();
      const laptop = newSubscription("https://updates.push.services.mozilla.com/wpush/v2/");

      expect((await aliceTab.post("/api/push/devices", phone)).status).toBe(200);
      expect((await aliceTab.post("/api/push/devices", laptop)).status).toBe(200);
      expect(await devices()).toEqual([
        { memberId: alice.id, endpoint: phone.endpoint },
        { memberId: alice.id, endpoint: laptop.endpoint },
      ]);

      // Bob cannot turn off Alice's device: nothing changes.
      const refused = await bobTab.send("DELETE", "/api/push/devices", {
        endpoint: phone.endpoint,
      });
      expect(refused.status).toBe(200);
      expect(await refused.json()).toEqual({ removed: false });
      expect(await devices()).toHaveLength(2);

      const removed = await aliceTab.send("DELETE", "/api/push/devices", {
        endpoint: phone.endpoint,
      });
      expect(await removed.json()).toEqual({ removed: true });
      expect(await devices()).toEqual([{ memberId: alice.id, endpoint: laptop.endpoint }]);
      // No log line names an endpoint or a key.
      for (const value of [phone.endpoint, laptop.endpoint, phone.keys.auth, laptop.keys.p256dh]) {
        expect(lines.join("")).not.toContain(value);
      }
    });

    it("refuses a subscription at an unknown push service, or with malformed keys, and stores nothing", async () => {
      await finishWizard();
      const tab = await signedIn(alice);
      const good = newSubscription();
      const refused = [
        { ...good, endpoint: "https://push.example.test/send/abc" },
        { ...good, endpoint: "http://fcm.googleapis.com/fcm/send/abc" },
        { ...good, endpoint: "https://fcm.googleapis.com:8443/fcm/send/abc" },
        { ...good, endpoint: "https://user@fcm.googleapis.com/fcm/send/abc" },
        { ...good, endpoint: "https://fcm.googleapis.com.example.test/fcm/send/abc" },
        // Each of these names a push service to the URL parser, but web-push's older parser
        // (url.parse) would send it to another host.
        { ...good, endpoint: "https://169.254.169.254;x.push.apple.com/latest/meta-data" },
        { ...good, endpoint: "https://internal-nas%2ex.push.apple.com/admin" },
        { ...good, endpoint: "https://evil.test{.fcm.notify.windows.com/x" },
        { ...good, endpoint: "https://nas.local;.fcm.googleapis.com/x" },
        { ...good, endpoint: "https://nas{.web.push.apple.com/x" },
        { ...good, endpoint: "https://nas%2eweb.push.apple.com/x" },
        // Forms the URL parser folds into a push service's name: a full-width dot, a tab, a
        // leading space, upper case.
        { ...good, endpoint: "https://fcm．googleapis.com/fcm/send/abc" },
        { ...good, endpoint: "https://fcm.google\tapis.com/fcm/send/abc" },
        { ...good, endpoint: ` ${good.endpoint}` },
        { ...good, endpoint: "https://FCM.googleapis.com/fcm/send/abc" },
      ];
      for (const subscription of refused) {
        const res = await tab.post("/api/push/devices", subscription);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          error: "This browser's push service is not one the app sends to.",
        });
      }
      const malformed = [
        { ...good, keys: { ...good.keys, p256dh: good.keys.auth } },
        { ...good, keys: { ...good.keys, auth: good.keys.p256dh } },
        { ...good, keys: { ...good.keys, auth: "not base64url!" } },
        { ...good, expirationTime: null },
        { endpoint: good.endpoint },
      ];
      for (const subscription of malformed) {
        expect((await tab.post("/api/push/devices", subscription)).status).toBe(400);
      }
      expect(await devices()).toEqual([]);
    });

    it("never moves another Member's device to the Member who posts its endpoint", async () => {
      await finishWizard();
      const aliceTab = await signedIn(alice);
      const bobTab = await signedIn(bob);
      const phone = newSubscription();
      expect((await aliceTab.post("/api/push/devices", phone)).status).toBe(200);
      const before = await query("SELECT * FROM push_devices");

      const taken = newSubscription();
      const res = await bobTab.post("/api/push/devices", { ...taken, endpoint: phone.endpoint });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error:
          "Alerts are on for another Member in this browser. They turn them off first, in Settings, Alerts.",
      });
      expect(await query("SELECT * FROM push_devices")).toEqual(before);
      // Alice's own browser still takes its new keys.
      vi.setSystemTime(Date.now() + 1000);
      expect(
        (await aliceTab.post("/api/push/devices", { ...taken, endpoint: phone.endpoint })).status,
      ).toBe(200);
      expect(await query("SELECT member_id, p256dh, auth FROM push_devices")).toEqual([
        { member_id: alice.id, p256dh: taken.keys.p256dh, auth: taken.keys.auth },
      ]);
    });

    it("needs a session, the app's own Origin, and JSON; each refusal changes nothing", async () => {
      await finishWizard();
      const tab = await signedIn(alice);
      const subscription = newSubscription();
      expect((await tab.post("/api/push/devices", subscription)).status).toBe(200);
      const other = newSubscription();

      const stranger = new TestBrowser(app, APP_URL, "192.168.1.200");
      expect((await stranger.get("/api/push")).status).toBe(401);
      expect((await stranger.post("/api/push/devices", other)).status).toBe(401);
      const endpoint = { endpoint: subscription.endpoint };
      expect((await stranger.send("DELETE", "/api/push/devices", endpoint)).status).toBe(401);

      for (const origin of ["http://evil.example", undefined]) {
        expect((await tab.send("POST", "/api/push/devices", other, { origin })).status).toBe(403);
        expect((await tab.send("DELETE", "/api/push/devices", endpoint, { origin })).status).toBe(
          403,
        );
      }
      const form = { "content-type": "application/x-www-form-urlencoded" };
      expect((await tab.send("POST", "/api/push/devices", other, form)).status).toBe(415);
      expect((await tab.send("DELETE", "/api/push/devices", endpoint, form)).status).toBe(415);

      expect(await devices()).toEqual([{ memberId: alice.id, endpoint: subscription.endpoint }]);
    });

    it("refuses a device before the first-run wizard is done", async () => {
      const tab = await signedIn(alice);
      const res = await tab.post("/api/push/devices", newSubscription());
      expect(res.status).toBe(409);
      expect(await devices()).toEqual([]);
      expect(await query("SELECT * FROM vapid_keys")).toEqual([]);
    });
  });

  describe("in plain-HTTP mode", () => {
    beforeEach(async () => {
      await start("http");
      await finishWizard();
    });

    it("hides push, says why, makes no keys, and turns no device on", async () => {
      const tab = await signedIn(alice);
      expect(await viewOf(tab)).toEqual({ available: false, why: "plain HTTP" });

      const res = await tab.post("/api/push/devices", newSubscription());
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "Push needs HTTPS. In plain-HTTP mode, Alerts come by email only.",
      });
      expect(await devices()).toEqual([]);
      expect(await query("SELECT * FROM vapid_keys")).toEqual([]);
    });

    it("serves a page that names no manifest, and neither the manifest nor the service worker", async () => {
      const tab = await signedIn(alice);
      for (const path of ["/", "/index.html", "/settings/alerts"]) {
        const res = await tab.get(path);
        expect(res.status).toBe(200);
        const page = await res.text();
        expect(page).toContain('<link rel="icon" href="/icon.svg">');
        expect(page).not.toContain("manifest");
        expect(res.headers.get("content-length")).toBeNull();
      }
      for (const path of ["/manifest.webmanifest", "/sw.js"]) {
        expect((await tab.get(path)).status).toBe(404);
      }
    });
  });
});
