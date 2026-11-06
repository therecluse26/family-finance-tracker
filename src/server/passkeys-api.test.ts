import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMember,
  type CreationOptionsJSON,
  newTestAuth,
  type RequestOptionsJSON,
  type TestAuth,
  TestAuthenticator,
  type TestMember,
} from "../auth/testing.ts";
import { markSetupStep } from "../db/index.ts";
import { readEveryTable } from "../db/testing.ts";
import { createLogger } from "../log.ts";
import { createApp } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// Passkeys (spec 09, Signing in), through the app's HTTP interface: Settings, My login adds and
// deletes them, and the sign-in page signs in with one. A software authenticator stands in for the
// device, with keys made when the test runs. Each test gets a new app.db and Master key.

const HTTPS_URL = "https://money.example.com";
const PROXY = "10.0.0.2";
const PLAIN_URL = "http://nas.local:8080";
const NOW = new Date("2026-11-05T15:00:00.000Z");
const TOTP_STEP_MS = 30_000;

const WRONG_ORIGINS = [
  "https://money.example.com:8443",
  "https://evil.example",
  `${HTTPS_URL}.evil.example`,
  "",
  undefined,
];

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-passkeys-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("passkeys", () => {
  let test: TestAuth;
  let app: App;
  let lines: string[];
  let alice: TestMember;
  let bob: TestMember;
  let clients = 0;

  const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

  async function startApp(appUrl: string) {
    lines = [];
    const logger = createLogger((line) => lines.push(line), { throwOnSecretField: true });
    test = await newTestAuth(appUrl, logger);
    const https = appUrl.startsWith("https://");
    app = createApp(
      webRoot,
      await loadSecurity({ APP_URL: appUrl, TRUSTED_PROXIES: https ? PROXY : "" }, { logger }),
      test.auth,
      test.database,
      test.secrets,
    );
    alice = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    bob = await addMember(test.auth, { name: "Bob", email: "bob@example.com" });
    await markSetupStep(test.database, "master key", "done");
  }

  const browser = (appUrl = HTTPS_URL) => {
    clients += 1;
    const client = `192.168.1.${clients}`;
    const proxy = {
      source: PROXY,
      headers: { "x-forwarded-proto": "https", "x-forwarded-for": client },
    };
    return new TestBrowser(app, appUrl, client, appUrl.startsWith("https://") ? proxy : undefined);
  };

  // Each TOTP code works once, so each sign-in takes its own step.
  async function signedIn(member: TestMember, appUrl = HTTPS_URL): Promise<TestBrowser> {
    later(TOTP_STEP_MS);
    const tab = browser(appUrl);
    await tab.signIn(member);
    later(TOTP_STEP_MS);
    return tab;
  }

  // Settings, My login's "Add a passkey": the options, the device, then the check with the
  // Member's current password.
  async function addPasskey(
    tab: TestBrowser,
    member: TestMember,
    device: TestAuthenticator,
    body: Record<string, unknown> = {},
  ): Promise<Response> {
    const options = await tab.get("/api/auth/passkey/generate-register-options");
    if (options.status !== 200) return options;
    const response = await device.create((await options.json()) as CreationOptionsJSON);
    return tab.post("/api/auth/passkey/verify-registration", {
      response,
      currentPassword: member.password,
      ...body,
    });
  }

  // The sign-in page's "Sign in with a passkey", in a new browser.
  async function passkeySignIn(device: TestAuthenticator, tab = browser()): Promise<Response> {
    const options = await tab.get("/api/auth/passkey/generate-authenticate-options");
    if (options.status !== 200) return options;
    const response = await device.get((await options.json()) as RequestOptionsJSON);
    return tab.post("/api/auth/passkey/verify-authentication", { response });
  }

  const passkeyRows = async () =>
    ((await readEveryTable(test.database)).passkeys ?? []) as {
      id: string;
      member_id: string;
      app_host: string;
      name: string | null;
    }[];

  async function listed(tab: TestBrowser): Promise<{ id: string; name?: string | null }[]> {
    const res = await tab.get("/api/auth/passkey/list-user-passkeys");
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; name?: string | null }[];
  }

  // The rows a refused request must leave as they were. Sessions renew on each use, so they are
  // compared by ID.
  async function lasting() {
    const tables = await readEveryTable(test.database);
    return {
      passkeys: tables.passkeys,
      sessions: (tables.sessions as { id: string }[]).map((session) => session.id),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    test.close();
    vi.useRealTimers();
  });

  describe("in HTTPS mode", () => {
    let aliceTab: TestBrowser;
    let device: TestAuthenticator;

    beforeEach(async () => {
      await startApp(HTTPS_URL);
      aliceTab = await signedIn(alice);
      device = new TestAuthenticator(HTTPS_URL);
    });

    it("adds a passkey with the current password and no code, tied to APP_URL's host, and lists it", async () => {
      const res = await addPasskey(aliceTab, alice, device, { name: "Alice's phone" });

      expect(res.status).toBe(200);
      const rows = await passkeyRows();
      expect(rows).toEqual([
        expect.objectContaining({
          member_id: alice.id,
          app_host: "money.example.com",
          name: "Alice's phone",
        }),
      ]);
      expect(await listed(aliceTab)).toEqual([
        expect.objectContaining({ id: rows[0]?.id, name: "Alice's phone" }),
      ]);
    });

    it("lets a Member add several passkeys, and lists only their own", async () => {
      const bobTab = await signedIn(bob);
      expect((await addPasskey(aliceTab, alice, device)).status).toBe(200);
      expect((await addPasskey(aliceTab, alice, new TestAuthenticator(HTTPS_URL))).status).toBe(
        200,
      );
      expect((await addPasskey(bobTab, bob, new TestAuthenticator(HTTPS_URL))).status).toBe(200);

      expect(await listed(aliceTab)).toHaveLength(2);
      expect(await listed(bobTab)).toHaveLength(1);
    });

    it("signs a Member in with a passkey alone, with no TOTP code", async () => {
      await addPasskey(aliceTab, alice, device);
      const tab = browser();

      const res = await passkeySignIn(device, tab);

      expect(res.status).toBe(200);
      expect(await tab.isSignedIn()).toBe(true);
      const { members } = (await (await tab.get("/api/members")).json()) as {
        members: { id: string; you: boolean }[];
      };
      expect(members.find((member) => member.you)?.id).toBe(alice.id);
    });

    it("asks for the current password to add a passkey, counts a wrong one as a failed sign-in, and stores nothing", async () => {
      const before = await lasting();
      const wrong = `${alice.password}x`;
      for (const currentPassword of [wrong, "", undefined, 123456, alice.password.toUpperCase()]) {
        const res = await addPasskey(aliceTab, alice, device, { currentPassword });
        expect(res.status, String(currentPassword)).toBe(401);
      }
      // Past 5 failed sign-ins, even the right password is refused unchecked.
      expect((await addPasskey(aliceTab, alice, device)).status).toBe(429);
      expect(await lasting()).toEqual(before);
    });

    it("counts no refusal but a wrong password: 5 names too long, then the right password and a short name add the passkey", async () => {
      // One character over the 60 a passkey's name may have.
      const tooLong = "x".repeat(61);
      for (let i = 0; i < 5; i++) {
        const res = await addPasskey(aliceTab, alice, device, { name: tooLong });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { code?: string }).code).toBe("PASSKEY_NAME_LENGTH");
      }
      expect(await passkeyRows()).toEqual([]);

      expect((await addPasskey(aliceTab, alice, device, { name: "Alice's phone" })).status).toBe(
        200,
      );
      expect(await passkeyRows()).toHaveLength(1);
      // Another browser still signs Alice in with her password and TOTP.
      expect(await (await signedIn(alice)).isSignedIn()).toBe(true);
    });

    it("refuses a passkey that does not verify the Member, to add or to sign in", async () => {
      const presenceOnly = new TestAuthenticator(HTTPS_URL, { verifiesMember: false });
      expect((await addPasskey(aliceTab, alice, presenceOnly)).status).toBe(401);
      expect(await passkeyRows()).toEqual([]);

      expect((await addPasskey(aliceTab, alice, device)).status).toBe(200);
      device.verifiesMember = false;
      const tab = browser();
      expect((await passkeySignIn(device, tab)).status).toBe(401);
      expect(await tab.isSignedIn()).toBe(false);
    });

    it("checks the origin and RP ID against APP_URL, never the request's", async () => {
      const elsewhere = [
        "https://money.example.com:8443",
        "https://evil.example",
        "http://money.example.com",
      ];
      for (const origin of elsewhere) {
        device.origin = origin;
        expect((await addPasskey(aliceTab, alice, device)).status, origin).toBe(400);
      }
      expect(await passkeyRows()).toEqual([]);

      device.origin = HTTPS_URL;
      expect((await addPasskey(aliceTab, alice, device)).status).toBe(200);
      for (const origin of elsewhere) {
        device.origin = origin;
        const tab = browser();
        expect((await passkeySignIn(device, tab)).status, origin).toBe(400);
        expect(await tab.isSignedIn()).toBe(false);
      }

      // A passkey made for another RP ID, such as a parent domain.
      device.origin = HTTPS_URL;
      const options = await aliceTab.get("/api/auth/passkey/generate-register-options");
      const json = (await options.json()) as CreationOptionsJSON;
      const response = await device.create({ ...json, rp: { id: "example.com" } });
      const res = await aliceTab.post("/api/auth/passkey/verify-registration", {
        response,
        currentPassword: alice.password,
      });
      expect(res.status).toBe(400);
      expect(await passkeyRows()).toHaveLength(1);
    });

    it("deletes a Member's passkey, which then signs no one in", async () => {
      await addPasskey(aliceTab, alice, device);
      const [row] = await passkeyRows();

      const res = await aliceTab.post("/api/auth/passkey/delete-passkey", { id: row?.id });

      expect(res.status).toBe(200);
      expect(await passkeyRows()).toEqual([]);
      expect(await listed(aliceTab)).toEqual([]);
      const tab = browser();
      expect((await passkeySignIn(device, tab)).status).toBe(401);
      expect(await tab.isSignedIn()).toBe(false);
    });

    it("never deletes another Member's passkey", async () => {
      const bobTab = await signedIn(bob);
      await addPasskey(aliceTab, alice, device);
      const before = await lasting();
      const [row] = await passkeyRows();

      const res = await bobTab.post("/api/auth/passkey/delete-passkey", { id: row?.id });

      expect(res.status).toBe(401);
      expect(await lasting()).toEqual(before);
      expect((await passkeySignIn(device)).status).toBe(200);
    });

    it("refuses each passkey write with no session, and changes nothing", async () => {
      await addPasskey(aliceTab, alice, device);
      const [row] = await passkeyRows();
      const before = await lasting();
      const signedOut = browser();

      expect(
        (await signedOut.post("/api/auth/passkey/delete-passkey", { id: row?.id })).status,
      ).toBe(401);
      expect((await signedOut.get("/api/auth/passkey/generate-register-options")).status).toBe(401);
      const response = await device.create({
        challenge: "AAAA",
        rp: { id: "money.example.com" },
        user: { id: "AAAA" },
      });
      expect(
        (
          await signedOut.post("/api/auth/passkey/verify-registration", {
            response,
            currentPassword: alice.password,
          })
        ).status,
      ).toBe(401);
      expect(await lasting()).toEqual(before);
    });

    it("refuses each passkey write from another site, or with no Origin, and changes nothing", async () => {
      await addPasskey(aliceTab, alice, device);
      const [row] = await passkeyRows();
      const before = await lasting();

      for (const origin of WRONG_ORIGINS) {
        const remove = await aliceTab.send(
          "POST",
          "/api/auth/passkey/delete-passkey",
          { id: row?.id },
          { origin },
        );
        expect(remove.status, String(origin)).toBe(403);

        const options = await aliceTab.get("/api/auth/passkey/generate-register-options");
        const response = await new TestAuthenticator(HTTPS_URL).create(
          (await options.json()) as CreationOptionsJSON,
        );
        const add = await aliceTab.send(
          "POST",
          "/api/auth/passkey/verify-registration",
          { response, currentPassword: alice.password },
          { origin },
        );
        expect(add.status, String(origin)).toBe(403);

        const tab = browser();
        const signIn = await tab.get("/api/auth/passkey/generate-authenticate-options");
        const answer = await device.get((await signIn.json()) as RequestOptionsJSON);
        const verify = await tab.send(
          "POST",
          "/api/auth/passkey/verify-authentication",
          { response: answer },
          { origin },
        );
        expect(verify.status, String(origin)).toBe(403);
        expect(await tab.isSignedIn()).toBe(false);

        // A sign-in from a browser with no cookie at all, which Better Auth's own check lets by.
        const bare = await browser().send(
          "POST",
          "/api/auth/passkey/verify-authentication",
          { response: answer },
          { origin },
        );
        expect(bare.status, String(origin)).toBe(403);
      }
      const after = await lasting();
      expect(after.passkeys).toEqual(before.passkeys);
    });

    it("takes only JSON on each passkey write", async () => {
      await addPasskey(aliceTab, alice, device);
      const [row] = await passkeyRows();
      const before = await lasting();
      const form = { "content-type": "application/x-www-form-urlencoded" };

      for (const path of [
        "/api/auth/passkey/delete-passkey",
        "/api/auth/passkey/verify-registration",
        "/api/auth/passkey/verify-authentication",
      ]) {
        const res = await aliceTab.send("POST", path, { id: row?.id }, form);
        expect(res.status, path).toBe(415);
        expect((await browser().send("POST", path, { id: row?.id }, form)).status, path).toBe(415);
      }
      expect((await lasting()).passkeys).toEqual(before.passkeys);
    });

    it("deletes a removed Member's passkeys, which then sign no one in", async () => {
      const bobDevice = new TestAuthenticator(HTTPS_URL);
      await addPasskey(aliceTab, alice, device);
      await addPasskey(await signedIn(bob), bob, bobDevice);

      const res = await aliceTab.post(`/api/members/${bob.id}/remove`, {});

      expect(res.status).toBe(200);
      expect((await passkeyRows()).map((row) => row.member_id)).toEqual([alice.id]);
      expect((await passkeySignIn(bobDevice)).status).toBe(401);
    });

    it("deletes the Member's passkeys at a login reset, so the old one signs no one in", async () => {
      const bobDevice = new TestAuthenticator(HTTPS_URL);
      await addPasskey(aliceTab, alice, device);
      await addPasskey(await signedIn(bob), bob, bobDevice);
      expect((await passkeySignIn(bobDevice)).status).toBe(200);

      const res = await aliceTab.post(`/api/members/${bob.id}/reset-login`, {});

      expect(res.status).toBe(200);
      expect((await passkeyRows()).map((row) => row.member_id)).toEqual([alice.id]);
      const tab = browser();
      expect((await passkeySignIn(bobDevice, tab)).status).toBe(401);
      expect(await tab.isSignedIn()).toBe(false);
    });
  });

  describe("in plain-HTTP mode", () => {
    it("refuses every passkey route, with the reason, and stores nothing", async () => {
      await startApp(PLAIN_URL);
      const tab = await signedIn(alice, PLAIN_URL);
      const device = new TestAuthenticator(PLAIN_URL);
      const response = await device.create({
        challenge: "AAAA",
        rp: { id: "nas.local" },
        user: { id: "AAAA" },
      });
      const before = await lasting();

      const answers = [
        await tab.get("/api/auth/passkey/generate-register-options"),
        await tab.post("/api/auth/passkey/verify-registration", {
          response,
          currentPassword: alice.password,
        }),
        await tab.get("/api/auth/passkey/list-user-passkeys"),
        await tab.post("/api/auth/passkey/delete-passkey", { id: "any" }),
        await browser(PLAIN_URL).get("/api/auth/passkey/generate-authenticate-options"),
        await browser(PLAIN_URL).post("/api/auth/passkey/verify-authentication", { response }),
      ];

      for (const res of answers) {
        expect(res.status, res.url).toBe(403);
        expect(((await res.json()) as { message: string }).message).toMatch(/^Passkeys need HTTPS/);
      }
      expect(await lasting()).toEqual(before);

      // A refusal for plain-HTTP mode is no failed sign-in: past 5 of them, the Member still signs in.
      for (let i = 0; i < 5; i++) {
        const res = await tab.post("/api/auth/passkey/verify-registration", {
          response,
          currentPassword: alice.password,
        });
        expect(res.status).toBe(403);
      }
      expect(await (await signedIn(alice, PLAIN_URL)).isSignedIn()).toBe(true);
    });
  });

  it("answers 404 to Better Auth's passkey routes the app does not use", async () => {
    await startApp(HTTPS_URL);
    const tab = await signedIn(alice);

    const res = await tab.post("/api/auth/passkey/update-passkey", { id: "any", name: "x" });

    expect(res.status).toBe(404);
  });
});
