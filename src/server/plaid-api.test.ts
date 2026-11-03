import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import { type PlaidKeys, type PlaidView, plaidSettings, readPlaidKeys } from "../bank/index.ts";
import { newPlaidKeys, StubPlaid } from "../bank/testing.ts";
import { addConnection, markSetupStep } from "../db/index.ts";
import { createLogger } from "../log.ts";
import { createApp } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// Settings → Banks' Plaid routes, through the app's HTTP interface, on a stubbed Plaid client with
// made-up keys (spec 02, Plaid keys and The 10 lifetime Items; spec 09, Signing in).

const APP_URL = "http://nas.local:8080";
const TOTP_STEP_MS = 30_000;

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-plaid-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the Plaid routes", () => {
  let test: TestAuth;
  let app: App;
  let stub: StubPlaid;
  let lines: string[];
  let alice: TestMember;
  let clients = 0;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    lines = [];
    const logger = createLogger((line) => lines.push(line), { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, logger);
    stub = new StubPlaid();
    app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger }),
      test.auth,
      test.database,
      {
        plaid: plaidSettings({
          database: test.database,
          secrets: test.secrets,
          makeClient: stub.makeClient,
          logger,
        }),
      },
    );
    alice = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
  });

  afterEach(() => {
    vi.useRealTimers();
    test.close();
  });

  // The first-run wizard's required steps after the first Member.
  async function finishWizard(): Promise<void> {
    await markSetupStep(test.database, "master key", "done");
    await markSetupStep(test.database, "household facts", "done");
  }

  // Signed in, with the clock moved on one TOTP step, so the next code is fresh.
  async function signedIn(): Promise<TestBrowser> {
    clients += 1;
    const tab = new TestBrowser(app, APP_URL, `192.168.1.${clients}`);
    await tab.signIn(alice);
    vi.setSystemTime(Date.now() + TOTP_STEP_MS);
    return tab;
  }

  const saveKeys = async (tab: TestBrowser, keys: PlaidKeys, code?: string) =>
    tab.post("/api/plaid/keys", { ...keys, code: code ?? (await alice.totpCode()) });

  const settings = async (tab: TestBrowser) =>
    ((await (await tab.get("/api/plaid/settings")).json()) as { plaid: PlaidView }).plaid;

  const savedKeys = () => readPlaidKeys(test.database, test.secrets);

  it("answers 401 to a browser with no session, on every route", async () => {
    await finishWizard();
    const tab = new TestBrowser(app, APP_URL, "192.168.1.200");
    const keys = newPlaidKeys();
    stub.accepted = keys;

    expect((await tab.get("/api/plaid/settings")).status).toBe(401);
    expect((await saveKeys(tab, keys)).status).toBe(401);
    expect((await tab.post("/api/plaid/items-used", { itemsUsed: 3 })).status).toBe(401);
    expect(stub.calls).toEqual([]);
    expect(await savedKeys()).toBeUndefined();
  });

  it("refuses to store the keys or change N until the wizard's required steps are done", async () => {
    const tab = await signedIn();
    const keys = newPlaidKeys();
    stub.accepted = keys;
    await markSetupStep(test.database, "master key", "done");

    const keysRes = await saveKeys(tab, keys);
    const itemsRes = await tab.post("/api/plaid/items-used", { itemsUsed: 3 });

    expect(keysRes.status).toBe(409);
    expect(itemsRes.status).toBe(409);
    expect(stub.calls).toEqual([]);
    expect(await savedKeys()).toBeUndefined();
    expect(await settings(tab)).toMatchObject({ secretSet: false, itemsUsed: 0 });
  });

  it("saves keys that work, then shows only that the secret is set", async () => {
    await finishWizard();
    const tab = await signedIn();
    const keys = newPlaidKeys();
    stub.accepted = keys;

    const res = await saveKeys(tab, keys);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(keys.secret);
    expect(JSON.parse(text)).toMatchObject({ keys: "saved", plaid: { secretSet: true } });
    const shown = await (await tab.get("/api/plaid/settings")).text();
    expect(shown).not.toContain(keys.secret);
    expect(JSON.parse(shown)).toEqual({
      plaid: {
        clientId: keys.clientId,
        secretSet: true,
        itemsUsed: 0,
        appItems: 0,
        itemLimit: 10,
      },
    });
    expect(await savedKeys()).toEqual(keys);
    expect(lines.join("")).not.toContain(keys.secret);
  });

  it("says so when Plaid refuses the keys, and saves nothing", async () => {
    await finishWizard();
    const tab = await signedIn();
    stub.accepted = newPlaidKeys();
    const keys = newPlaidKeys();

    const res = await saveKeys(tab, keys);

    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).not.toContain(keys.secret);
    expect(JSON.parse(text)).toMatchObject({ keys: "refused" });
    expect(await savedKeys()).toBeUndefined();
    expect(lines.join("")).not.toContain(keys.secret);
  });

  it("says so when Plaid does not answer, and saves nothing", async () => {
    await finishWizard();
    const tab = await signedIn();
    const keys = newPlaidKeys();
    stub.accepted = keys;
    stub.down = true;

    const res = await saveKeys(tab, keys);

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ keys: "no answer" });
    expect(await savedKeys()).toBeUndefined();
    expect(lines.join("")).not.toContain(keys.secret);
  });

  it("asks for a fresh TOTP code, or a backup code, each time the keys change", async () => {
    await finishWizard();
    const tab = await signedIn();
    const first = newPlaidKeys();
    stub.accepted = first;
    const code = await alice.totpCode();
    const wrong = code.replace(/\d/g, (digit) => String((Number(digit) + 1) % 10));

    expect((await tab.post("/api/plaid/keys", first)).status).toBe(400);
    expect((await saveKeys(tab, first, wrong)).status).toBe(401);
    expect(stub.calls).toEqual([]);
    expect(await savedKeys()).toBeUndefined();

    expect((await saveKeys(tab, first, code)).status).toBe(200);

    const second = newPlaidKeys();
    stub.accepted = second;
    expect((await saveKeys(tab, second, code)).status).toBe(401);
    expect(await savedKeys()).toEqual(first);
    expect((await saveKeys(tab, second, alice.backupCodes[0])).status).toBe(200);
    expect(await savedKeys()).toEqual(second);
  });

  it("refuses every code after 5 wrong ones in 15 minutes, with 429 and no error log line", async () => {
    await finishWizard();
    const tab = await signedIn();
    const keys = newPlaidKeys();
    stub.accepted = keys;
    const wrong = (await alice.totpCode()).replace(/\d/g, (digit) =>
      String((Number(digit) + 1) % 10),
    );

    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await saveKeys(tab, keys, wrong)).status);
    const refused = await saveKeys(tab, keys);

    expect(statuses).toEqual([401, 401, 401, 401, 401]);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: "Too many wrong codes. Wait 15 minutes, then try again.",
    });
    expect(stub.calls).toEqual([]);
    expect(await savedKeys()).toBeUndefined();
    expect(lines.filter((line) => JSON.parse(line).level === "error")).toEqual([]);
  });

  it("refuses keys that are not letters and digits, before it checks the code", async () => {
    await finishWizard();
    const tab = await signedIn();
    const keys = newPlaidKeys();

    const res = await saveKeys(tab, { clientId: keys.clientId, secret: "" });

    expect(res.status).toBe(400);
    expect(stub.calls).toEqual([]);
  });

  it("takes only a JSON body", async () => {
    await finishWizard();
    const tab = await signedIn();
    const keys = newPlaidKeys();
    stub.accepted = keys;
    const body = { ...keys, code: await alice.totpCode() };

    const res = await tab.send("POST", "/api/plaid/keys", body, { "content-type": "text/plain" });

    expect(res.status).toBe(415);
    expect(stub.calls).toEqual([]);
  });

  it("takes changes only from APP_URL's origin", async () => {
    await finishWizard();
    const tab = await signedIn();
    const keys = newPlaidKeys();
    stub.accepted = keys;
    const body = { ...keys, code: await alice.totpCode() };

    for (const origin of ["http://evil.example", `${APP_URL}.evil.example`, undefined]) {
      expect((await tab.send("POST", "/api/plaid/keys", body, { origin })).status).toBe(403);
      expect(
        (await tab.send("POST", "/api/plaid/items-used", { itemsUsed: 3 }, { origin })).status,
      ).toBe(403);
    }
    expect(stub.calls).toEqual([]);
  });

  it("shows N, lets a Member raise it, and never lets it fall below the app's own count", async () => {
    await finishWizard();
    const tab = await signedIn();
    for (const bankId of ["ins_1", "ins_2"]) {
      await addConnection(test.database, {
        provider: "plaid",
        bankId,
        bankName: `Bank ${bankId}`,
        origin: "linked",
        syncMinute: 7,
      });
    }
    expect(await settings(tab)).toMatchObject({ itemsUsed: 2, appItems: 2, itemLimit: 10 });

    const raised = await tab.post("/api/plaid/items-used", { itemsUsed: 5 });
    expect(raised.status).toBe(200);
    expect(await raised.json()).toMatchObject({ plaid: { itemsUsed: 5 } });

    const below = await tab.post("/api/plaid/items-used", { itemsUsed: 1 });
    expect(below.status).toBe(400);
    expect(await settings(tab)).toMatchObject({ itemsUsed: 5 });

    for (const itemsUsed of [11, -1, 2.5, "7"]) {
      expect((await tab.post("/api/plaid/items-used", { itemsUsed })).status).toBe(400);
    }
    expect(await settings(tab)).toMatchObject({ itemsUsed: 5 });
  });
});
