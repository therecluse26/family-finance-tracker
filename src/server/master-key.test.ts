import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import { markSetupStep } from "../db/index.ts";
import { createLogger } from "../log.ts";
import { newMasterKeyHex } from "../secrets/testing.ts";
import { createApp } from "./app.ts";
import { WRONG_MASTER_KEY_WINDOW_MS, WRONG_MASTER_KEYS_ALLOWED } from "./master-key.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// The wizard's step 3 and "Check my Master key", through the app's HTTP interface (spec 09, The
// Master key; spec 12, The first-run wizard). Step 3 shows the key until "I saved it", and asks for
// no paste-back. Each test gets a new app.db and Master key.

const APP_URL = "http://nas.local:8080";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-master-key-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

class Browser extends TestBrowser {
  shownKey = () => this.get("/api/setup/master-key");
  // Step 3's "I saved it", exactly as the wizard sends it: an empty JSON body.
  savedIt = (headers: Record<string, string | undefined> = {}) =>
    this.send("POST", "/api/setup/master-key", {}, headers);
  check = (masterKey: string) => this.post("/api/master-key/check", { masterKey });
  lastCheck = () => this.get("/api/master-key/check");

  async setupNext(): Promise<unknown> {
    return ((await (await this.get("/api/setup")).json()) as { next: unknown }).next;
  }
}

// The key as a person might paste it from a password manager: in capitals, in groups of 4, over
// two lines.
const asPasted = (key: string) =>
  `  ${key.toUpperCase().slice(0, 32).match(/.{4}/g)?.join(" ")}\r\n${key
    .toUpperCase()
    .slice(32)
    .match(/.{4}/g)
    ?.join(" ")}\n`;

describe("the Master key", () => {
  let test: TestAuth;
  let app: App;
  let lines: string[];
  let alice: TestMember;
  let bob: TestMember;
  let clients = 0;

  const browser = () => {
    clients += 1;
    return new Browser(app, APP_URL, `192.168.1.${clients}`);
  };

  const signedIn = async (member: TestMember) => {
    const tab = browser();
    await tab.signIn(member);
    return tab;
  };

  const shown = async (tab: Browser) => {
    const res = await tab.shownKey();
    expect(res.status).toBe(200);
    return ((await res.json()) as { masterKey: string }).masterKey;
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
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
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    test.close();
  });

  describe("the wizard's step 3", () => {
    it("shows the Master key on each visit, and never caches it", async () => {
      const tab = await signedIn(alice);

      const first = await tab.shownKey();
      const key = ((await first.json()) as { masterKey: string }).masterKey;

      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(test.secrets.checkMasterKey(key)).toBe(true);
      expect(await shown(await signedIn(bob))).toBe(key);
      expect(await shown(tab)).toBe(key);
    });

    it("takes I saved it, then never shows the key again", async () => {
      const tab = await signedIn(alice);
      const key = await shown(tab);
      expect(await tab.setupNext()).toBe("master key");

      const res = await tab.savedIt();

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ saved: true });
      expect(await tab.setupNext()).toBe("household facts");
      const after = await tab.shownKey();
      expect(after.status).toBe(410);
      expect(await after.text()).not.toContain(key);
      // A second press, such as from another tab, changes nothing.
      expect((await tab.savedIt()).status).toBe(200);
      expect(await tab.setupNext()).toBe("household facts");
    });

    it("changes nothing on I saved it after step 3 or after setup, from any Member", async () => {
      const masterKeyRow = async () =>
        (
          await test.database.$client.execute(
            "SELECT status, at FROM setup_steps WHERE step = 'master key'",
          )
        ).rows;
      const aliceTab = await signedIn(alice);
      expect((await aliceTab.savedIt()).status).toBe(200);
      const saved = await masterKeyRow();
      expect(saved).toEqual([expect.objectContaining({ status: "done" })]);

      // After step 3.
      vi.setSystemTime(Date.now() + 60_000);
      expect((await aliceTab.savedIt()).status).toBe(200);
      expect(await masterKeyRow()).toEqual(saved);

      // After setup, from the first Member and from another Member.
      await markSetupStep(test.database, "household facts", "done");
      await markSetupStep(test.database, "finish", "done");
      vi.setSystemTime(Date.now() + 60_000);
      for (const tab of [aliceTab, await signedIn(bob)]) {
        const res = await tab.savedIt();
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ saved: true });
      }
      expect(await masterKeyRow()).toEqual(saved);
      expect((await aliceTab.shownKey()).status).toBe(410);
    });

    it("asks for no paste-back: a body with a key is refused, and the step stays open", async () => {
      const tab = await signedIn(alice);
      const key = await shown(tab);

      for (const body of [{ masterKey: key }, { masterKey: asPasted(key) }, { saved: true }]) {
        const res = await tab.post("/api/setup/master-key", body);
        expect(res.status).toBe(400);
        expect(await res.text()).not.toContain(key);
      }
      expect(await tab.setupNext()).toBe("master key");
      expect(await shown(tab)).toBe(key);
      expect(
        ((await (await tab.lastCheck()).json()) as { lastCheck: unknown }).lastCheck,
      ).toBeNull();
    });

    it("refuses I saved it without JSON, and changes nothing", async () => {
      const tab = await signedIn(alice);

      for (const type of ["text/plain", "application/x-www-form-urlencoded", undefined]) {
        expect((await tab.savedIt({ "content-type": type })).status).toBe(415);
      }
      expect(await tab.setupNext()).toBe("master key");
    });

    it("refuses every API write but I saved it until step 3 is done", async () => {
      const tab = await signedIn(alice);

      // A route that would store a Master-key secret, such as the Plaid keys, comes later. The
      // refusal comes before any route, so it covers every one.
      for (const [method, path] of [
        ["POST", "/api/plaid-keys"],
        ["POST", "/api/plaid/keys"],
        ["PUT", "/api/ai/key"],
        ["DELETE", "/api/connections/c1"],
        ["POST", "/api/master-key/check"],
      ] as const) {
        const res = await tab.send(method, path, { secret: "fake-secret" });
        expect(res.status, `${method} ${path}`).toBe(409);
      }
      expect((await tab.get("/api/accounts")).status).toBe(200);

      expect((await tab.savedIt()).status).toBe(200);

      expect((await tab.post("/api/plaid-keys", {})).status).toBe(404);
      expect((await tab.check(newMasterKeyHex())).status).toBe(200);
    });
  });

  describe("Check my Master key", () => {
    beforeEach(async () => {
      await markSetupStep(test.database, "master key", "done");
    });

    it("tells any Member whether a pasted key matches, and shows who last checked and when", async () => {
      const key = test.secrets.showMasterKey();
      const bobTab = await signedIn(bob);
      const aliceTab = await signedIn(alice);
      expect(await (await bobTab.lastCheck()).json()).toEqual({ lastCheck: null });

      const checkedAt = new Date("2026-11-03T14:05:09.000Z");
      vi.setSystemTime(checkedAt);
      const right = await bobTab.check(asPasted(key));
      expect(await right.json()).toEqual({ matches: true });
      expect(await (await aliceTab.lastCheck()).json()).toEqual({
        lastCheck: { memberName: "Bob", at: checkedAt.toISOString(), matched: true },
      });

      const later = new Date("2026-11-20T09:00:00.000Z");
      vi.setSystemTime(later);
      const wrong = await aliceTab.check(newMasterKeyHex());
      expect(await wrong.json()).toEqual({ matches: false });
      expect(await (await bobTab.lastCheck()).json()).toEqual({
        lastCheck: { memberName: "Alice", at: later.toISOString(), matched: false },
      });
    });

    it(`refuses the ${WRONG_MASTER_KEYS_ALLOWED + 1}th wrong key in 15 minutes, per Member`, async () => {
      const key = test.secrets.showMasterKey();
      const aliceTab = await signedIn(alice);
      const bobTab = await signedIn(bob);

      for (let tries = 0; tries < WRONG_MASTER_KEYS_ALLOWED; tries += 1) {
        expect(await (await aliceTab.check(newMasterKeyHex())).json()).toEqual({ matches: false });
      }
      // The right key too, so a guess cannot go on.
      expect((await aliceTab.check(key)).status).toBe(429);
      expect(await (await bobTab.check(key)).json()).toEqual({ matches: true });

      vi.setSystemTime(Date.now() + WRONG_MASTER_KEY_WINDOW_MS + 1000);
      expect(await (await aliceTab.check(key)).json()).toEqual({ matches: true });
    });

    it("counts a matching key as no try", async () => {
      const key = test.secrets.showMasterKey();
      const tab = await signedIn(alice);

      for (let tries = 0; tries < WRONG_MASTER_KEYS_ALLOWED + 2; tries += 1) {
        expect(await (await tab.check(key)).json()).toEqual({ matches: true });
      }
      expect(await (await tab.check(newMasterKeyHex())).json()).toEqual({ matches: false });
    });
  });

  it("needs a session for every Master key route", async () => {
    const tab = browser();
    const key = test.secrets.showMasterKey();

    for (const res of [
      await tab.shownKey(),
      await tab.savedIt(),
      await tab.check(key),
      await tab.lastCheck(),
    ]) {
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain(key);
    }
    expect(await tab.setupNext()).toBe("master key");
  });

  it("refuses a write from any origin but APP_URL's before the step 3 refusal, and changes nothing", async () => {
    const tab = await signedIn(alice);
    const key = await shown(tab);

    for (const origin of ["http://nas.local:9090", "http://evil.example", "", undefined]) {
      for (const [path, body] of [
        ["/api/setup/master-key", {}],
        ["/api/master-key/check", { masterKey: key }],
        ["/api/notices/n1/close", {}],
        ["/api/review-list/r1/answer", { value: "yes" }],
      ] as const) {
        const res = await tab.send("POST", path, body, { origin });
        expect(res.status, `${path} from ${origin}`).toBe(403);
        expect(await res.text()).not.toContain(key);
      }
    }
    expect(await tab.setupNext()).toBe("master key");
    expect(((await (await tab.lastCheck()).json()) as { lastCheck: unknown }).lastCheck).toBeNull();
  });

  it("refuses a request with no pasted key", async () => {
    await markSetupStep(test.database, "master key", "done");
    const tab = await signedIn(alice);

    for (const body of [{}, { masterKey: 7 }, { masterKey: "a".repeat(1001) }]) {
      expect((await tab.post("/api/master-key/check", body)).status).toBe(400);
    }
  });

  it("never writes a pasted key to its log, its answers, or app.db", async () => {
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => stdout.push(String(chunk)) > 0);
    const key = test.secrets.showMasterKey();
    const wrongKey = newMasterKeyHex();
    const tab = await signedIn(alice);
    const answers: string[] = [];
    // A body that is not JSON: a JSON parse error would quote it.
    const cookie = [...tab.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    await markSetupStep(test.database, "master key", "done");
    const broken = await app.request(
      `${APP_URL}/api/master-key/check`,
      {
        method: "POST",
        headers: {
          host: "nas.local:8080",
          origin: APP_URL,
          "content-type": "application/json",
          cookie,
        },
        body: `{"masterKey": "${asPasted(key)}`,
      },
      { incoming: { socket: { remoteAddress: tab.client } } },
    );
    expect(broken.status).toBe(400);
    answers.push(await broken.text());

    answers.push(await (await tab.shownKey()).text());
    for (const pasted of [wrongKey, asPasted(wrongKey), asPasted(key)]) {
      answers.push(await (await tab.check(pasted)).text());
    }
    answers.push(await (await tab.lastCheck()).text());

    const tables = await test.database.$client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    const stored: unknown[] = [];
    for (const { name } of tables.rows) {
      stored.push((await test.database.$client.execute(`SELECT * FROM "${String(name)}"`)).rows);
    }
    const written = [...lines, ...stdout, ...answers, JSON.stringify(stored)].join("\n");
    const bare = (text: string) => text.replace(/\s/g, "");
    for (const form of [key, key.toUpperCase(), wrongKey, wrongKey.toUpperCase()]) {
      expect(bare(written).toLowerCase()).not.toContain(form.toLowerCase());
    }
  });
});
