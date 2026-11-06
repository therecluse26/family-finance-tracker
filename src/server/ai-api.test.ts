import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type AiUsageView, type AiView, aiCost, aiSettings, onGateway } from "../ai/index.ts";
import { aiCalls } from "../ai/settings.ts";
import { newAiKey, StubModels } from "../ai/testing.ts";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import { markSetupStep } from "../db/index.ts";
import { createLogger } from "../log.ts";
import { createApp } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// Settings → AI's routes, through the app's HTTP interface, on AI SDK test models with made-up
// keys (spec 08, AI settings page; spec 09, Signing in).

const APP_URL = "http://nas.local:8080";
const GATEWAY = "https://gateway.ai.cloudflare.com/v1/account-id/gateway-id/openai";

// A local model's prices: $0.
const LOCAL = { quick: { input: 0, output: 0 }, writer: { input: 0, output: 0 } };

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-ai-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the AI routes", () => {
  let test: TestAuth;
  let app: App;
  let stub: StubModels;
  let lines: string[];
  let alice: TestMember;
  let clients = 0;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    lines = [];
    const logger = createLogger((line) => lines.push(line), { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, logger);
    stub = new StubModels();
    app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger }),
      test.auth,
      test.database,
      test.secrets,
      {
        ai: aiSettings({
          database: test.database,
          cost: aiCost({ database: test.database }),
          secrets: test.secrets,
          makeModels: stub.makeModels,
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

  async function finishWizard(): Promise<void> {
    await markSetupStep(test.database, "master key", "done");
    await markSetupStep(test.database, "household facts", "done");
  }

  async function signedIn(): Promise<TestBrowser> {
    clients += 1;
    const tab = new TestBrowser(app, APP_URL, `192.168.1.${clients}`);
    await tab.signIn(alice);
    return tab;
  }

  const openai = (more: Record<string, unknown> = {}) => ({
    provider: "openai",
    apiKey: newAiKey(),
    baseUrl: null,
    quickModel: "gpt-6-luna",
    writerModel: "gpt-6.1-terra",
    ...more,
  });

  const save = (tab: TestBrowser, body: Record<string, unknown>) =>
    tab.post("/api/ai/settings", body);

  const shown = async (tab: TestBrowser) =>
    ((await (await tab.get("/api/ai/settings")).json()) as { ai: AiView | null }).ai;

  // Whether an AI use, such as Chat, gets a model.
  const ready = async () =>
    (
      await aiCalls({
        database: test.database,
        cost: aiCost({ database: test.database }),
        secrets: test.secrets,
        makeModels: stub.makeModels,
      }).modelFor("chat")
    ).ready;

  it("answers 401 to a browser with no session, on every route", async () => {
    await finishWizard();
    const tab = new TestBrowser(app, APP_URL, "192.168.1.200");

    expect((await tab.get("/api/ai/settings")).status).toBe(401);
    expect((await save(tab, openai())).status).toBe(401);
    expect((await tab.post("/api/ai/remove", {})).status).toBe(401);
    expect((await tab.get("/api/ai/usage")).status).toBe(401);
    expect((await tab.send("PUT", "/api/ai/cost-cap", { capCents: 0 })).status).toBe(401);
    expect(stub.calls).toEqual([]);
  });

  it("refuses to store a key until the wizard's required steps are done", async () => {
    const tab = await signedIn();
    await markSetupStep(test.database, "master key", "done");

    expect((await save(tab, openai())).status).toBe(409);
    expect(stub.calls).toEqual([]);
    expect(await ready()).toBe(false);
  });

  it("checks both models on save, shows the result, and never shows the key again", async () => {
    await finishWizard();
    const tab = await signedIn();
    const gatewayToken = newAiKey();
    const body = openai({ baseUrl: GATEWAY, gatewayToken });

    const res = await save(tab, body);

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      check: { quick: "worked", writer: "worked" },
      ai: {
        provider: "openai",
        keySet: true,
        baseUrl: GATEWAY,
        gatewayTokenSet: true,
        quickModel: "gpt-6-luna",
        writerModel: "gpt-6.1-terra",
        prices: { quick: { source: "table" }, writer: { source: "table" } },
        status: { state: "on" },
      },
    });
    const later = JSON.stringify(await shown(tab));
    for (const secret of [body.apiKey, gatewayToken]) {
      expect(text).not.toContain(secret);
      expect(later).not.toContain(secret);
      expect(lines.join("")).not.toContain(secret);
    }
    expect(stub.connections).toEqual([
      {
        provider: "openai",
        apiKey: body.apiKey,
        baseUrl: GATEWAY,
        gatewayToken,
      },
    ]);
  });

  it("sets and changes the key with no code: TOTP is asked only at sign-in", async () => {
    await finishWizard();
    const tab = await signedIn();

    const first = openai();
    expect((await save(tab, first)).status).toBe(200);
    expect(stub.connections.at(-1)?.apiKey).toBe(first.apiKey);
    const second = openai();
    expect((await save(tab, second)).status).toBe(200);
    expect(stub.connections.at(-1)?.apiKey).toBe(second.apiKey);
  });

  it("changes the models with no code, and keeps the key", async () => {
    await finishWizard();
    const tab = await signedIn();
    const first = openai();
    await save(tab, first);
    const { apiKey: _key, ...kept } = first;

    const res = await tab.post("/api/ai/settings", {
      ...kept,
      writerModel: "gpt-6.1-sol",
      prices: { writer: { input: 2_000_000, output: 10_000_000 } },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ai: { writerModel: "gpt-6.1-sol", keySet: true } });
    expect(stub.connections.at(-1)?.apiKey).toBe(first.apiKey);
  });

  it("refuses fields that cannot be sent as written", async () => {
    await finishWizard();
    const tab = await signedIn();

    for (const body of [
      openai({ provider: "gemini" }),
      openai({ apiKey: "two words" }),
      openai({ apiKey: "line\nbreak" }),
      openai({ quickModel: "" }),
      openai({ baseUrl: "ftp://files.example/v1" }),
      openai({ baseUrl: "https://user:pass@proxy.example/v1" }),
      openai({ baseUrl: "https://proxy.example/v1?key=x" }),
      openai({ provider: "openai-compatible", baseUrl: null }),
      openai({ gatewayToken: newAiKey() }),
      openai({ baseUrl: "https://proxy.example/v1", gatewayToken: newAiKey() }),
    ]) {
      expect([body, (await save(tab, body)).status]).toEqual([body, 400]);
    }
    expect(stub.calls).toEqual([]);
  });

  it("sends a key over plain http only to this computer or a private network", async () => {
    await finishWizard();
    const tab = await signedIn();
    const compatible = (baseUrl: string) =>
      openai({ provider: "openai-compatible", baseUrl, apiKey: undefined, prices: LOCAL });

    for (const baseUrl of [
      "http://api.example.com/v1",
      "http://8.8.8.8/v1",
      "http://[2001:db8::1]/v1",
      "http://172.32.0.1/v1",
      "http://ollama.example/v1",
    ]) {
      const res = await save(tab, compatible(baseUrl));
      expect([baseUrl, res.status, await res.json()]).toEqual([
        baseUrl,
        400,
        {
          error:
            "Use https:// for this base URL. http:// works only for this computer or a private network.",
        },
      ]);
    }
    expect(stub.calls).toEqual([]);

    for (const baseUrl of [
      "http://localhost:11434/v1",
      "http://127.0.0.1:11434/v1",
      "http://[::1]:11434/v1",
      "http://10.0.0.5:11434/v1",
      "http://172.16.0.5:11434/v1",
      "http://192.168.1.20:11434/v1",
      "http://[fd12::5]:11434/v1",
      "http://ollama:11434/v1",
      "http://ollama.local:11434/v1",
      "http://host.docker.internal:11434/v1",
      "https://api.example.com/v1",
    ]) {
      expect([baseUrl, (await save(tab, compatible(baseUrl))).status]).toEqual([baseUrl, 200]);
    }
  });

  it("sends the gateway token only over https to Cloudflare AI Gateway", async () => {
    await finishWizard();
    const tab = await signedIn();
    const plain = GATEWAY.replace("https://", "http://");

    const res = await save(tab, openai({ baseUrl: plain, gatewayToken: newAiKey() }));

    expect(res.status).toBe(400);
    expect(onGateway(plain)).toBe(false);
    expect(onGateway(GATEWAY)).toBe(true);
    expect(onGateway(GATEWAY.replace("https://", "wss://"))).toBe(false);
    expect(stub.calls).toEqual([]);
  });

  it("never calls a link-local address, such as a cloud metadata address, as written", async () => {
    await finishWizard();
    const tab = await signedIn();

    for (const baseUrl of [
      "http://169.254.169.254/v1",
      "https://169.254.169.254/v1",
      "http://169.254.0.1:11434/v1",
      // Other ways to write 169.254.169.254, which the URL parser turns into it.
      "http://2852039166/v1",
      "http://0xa9.0xfe.0xa9.0xfe/v1",
      "http://169.254.169.254./v1",
      "http://[fe80::1]/v1",
      "https://[febf::1]/v1",
      "http://[::ffff:169.254.169.254]/v1",
      "https://[64:ff9b::169.254.169.254]/v1",
      "http://[fd00:ec2::254]/v1",
      "http://metadata.google.internal/v1",
      "http://metadata/v1",
    ]) {
      const res = await save(
        tab,
        openai({ provider: "openai-compatible", baseUrl, apiKey: undefined }),
      );
      expect([baseUrl, res.status, await res.json()]).toEqual([
        baseUrl,
        400,
        { error: "The app does not call a link-local address, such as a cloud metadata address." },
      ]);
    }
    expect(stub.calls).toEqual([]);
  });

  it("never calls an address whose destination it cannot judge", async () => {
    await finishWizard();
    const tab = await signedIn();

    for (const baseUrl of [
      "https://0.0.0.0/v1",
      "http://0.0.0.0:11434/v1",
      "https://0.1.2.3/v1",
      "https://[::]/v1",
      "https://[::ffff:0.0.0.0]/v1",
      // The local-use NAT64 prefix, which can map to any IPv4 address.
      "https://[64:ff9b:1::a9fe:a9fe]/v1",
      "https://[64:ff9b:1:ffff::1]/v1",
    ]) {
      const res = await save(
        tab,
        openai({ provider: "openai-compatible", baseUrl, apiKey: undefined }),
      );
      expect([baseUrl, res.status, await res.json()]).toEqual([
        baseUrl,
        400,
        {
          error:
            "The app does not call an address whose destination it cannot judge, such as 0.0.0.0.",
        },
      ]);
    }
    expect(stub.calls).toEqual([]);
  });

  it("treats a gateway host written with a final dot as the gateway", () => {
    const dotted = GATEWAY.replace("gateway.ai.cloudflare.com", "gateway.ai.cloudflare.com.");

    expect(onGateway(dotted)).toBe(true);
    expect(onGateway(dotted.replace(".com.", ".com.."))).toBe(false);
  });

  it("answers 409 and stores nothing when Remove AI provider comes during the check", async () => {
    await finishWizard();
    const tab = await signedIn();
    await save(tab, openai());
    const { apiKey: _key, ...kept } = openai();
    stub.beforeAnswer = async () => {
      stub.beforeAnswer = async () => {};
      expect((await tab.post("/api/ai/remove", {})).status).toBe(200);
    };

    const res = await tab.post("/api/ai/settings", {
      ...kept,
      writerModel: "gpt-6.1-sol",
      prices: LOCAL,
    });

    expect(res.status).toBe(409);
    expect(await shown(tab)).toBeNull();
    expect(await ready()).toBe(false);
  });

  it("asks for the key again, and takes a new one, when the stored key cannot be read", async () => {
    await finishWizard();
    const tab = await signedIn();
    const first = openai();
    await save(tab, first);
    await test.database.$client.execute("UPDATE ai_settings SET api_key = 'v1.not-a-ciphertext'");
    const { apiKey: _key, ...kept } = first;

    const again = await save(tab, kept);
    const fresh = openai();
    const replaced = await save(tab, fresh);

    expect([again.status, await again.json()]).toEqual([400, { error: "Enter the API key." }]);
    expect(replaced.status).toBe(200);
    expect(stub.connections.at(-1)).toMatchObject({ apiKey: fresh.apiKey });
  });

  it("takes only a JSON body, and changes only from APP_URL's origin", async () => {
    await finishWizard();
    const tab = await signedIn();
    const body = openai();

    const text = await tab.send("POST", "/api/ai/settings", body, { "content-type": "text/plain" });
    expect(text.status).toBe(415);
    for (const origin of ["http://evil.example", `${APP_URL}.evil.example`, undefined]) {
      expect((await tab.send("POST", "/api/ai/settings", body, { origin })).status).toBe(403);
      expect((await tab.send("POST", "/api/ai/remove", {}, { origin })).status).toBe(403);
    }
    expect(stub.calls).toEqual([]);
  });

  it("shows the AI usage page, with the check on save counted, and changes the AI cost cap", async () => {
    await finishWizard();
    const tab = await signedIn();
    await save(tab, openai());
    const usage = async (res: Response) => ((await res.json()) as { usage: AiUsageView }).usage;

    expect(await usage(await tab.get("/api/ai/usage"))).toMatchObject({
      capCents: 1000,
      pausedUntil: null,
      byUse: [{ use: "check on save", calls: 2 }],
    });
    for (const capCents of [-1, 1.5, 1_000_001, "10"]) {
      expect((await tab.send("PUT", "/api/ai/cost-cap", { capCents })).status).toBe(400);
    }
    const raised = await tab.send("PUT", "/api/ai/cost-cap", { capCents: 2500 });

    expect(raised.status).toBe(200);
    expect(await usage(raised)).toMatchObject({ capCents: 2500 });
    expect(
      (
        await tab.send(
          "PUT",
          "/api/ai/cost-cap",
          { capCents: 0 },
          { origin: "http://evil.example" },
        )
      ).status,
    ).toBe(403);
  });

  it("removes the AI provider, so every use takes its no-AI path", async () => {
    await finishWizard();
    const tab = await signedIn();
    await save(tab, openai());
    expect(await ready()).toBe(true);

    const res = await tab.post("/api/ai/remove", {});

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ai: null });
    expect(await shown(tab)).toBeNull();
    expect(await ready()).toBe(false);
  });

  describe("Test the key", () => {
    const testKey = (tab: TestBrowser, body: unknown = {}, headers = {}) =>
      tab.send("POST", "/api/ai/test", body, headers);

    // The key test's calls on the AI usage page.
    const keyTests = async () =>
      (await aiCost({ database: test.database }).usage()).byUse.find(
        ({ use }) => use === "key test",
      )?.calls ?? 0;

    // Moves the clock past the wait between tests.
    const later = () => vi.setSystemTime(new Date(Date.now() + 10_000));

    it("answers 401 to a browser with no session, and makes no call", async () => {
      await finishWizard();
      await save(await signedIn(), openai());
      stub.calls.length = 0;
      const tab = new TestBrowser(app, APP_URL, "192.168.1.200");

      expect((await testKey(tab)).status).toBe(401);
      expect(stub.calls).toEqual([]);
      expect(await keyTests()).toBe(0);
    });

    it("answers 403 to another site's Origin and to no Origin, and 415 to a body that is not JSON, with no call", async () => {
      await finishWizard();
      const tab = await signedIn();
      await save(tab, openai());
      stub.calls.length = 0;

      for (const origin of ["http://evil.example", `${APP_URL}.evil.example`, undefined]) {
        expect((await testKey(tab, {}, { origin })).status).toBe(403);
      }
      const text = await testKey(tab, {}, { "content-type": "text/plain" });
      expect(text.status).toBe(415);
      expect((await testKey(tab, { apiKey: newAiKey() })).status).toBe(400);
      expect(stub.calls).toEqual([]);
      expect(await keyTests()).toBe(0);

      // None of them took the test's place.
      const tested = await testKey(tab);
      expect(tested.status).toBe(200);
      expect(stub.calls).toHaveLength(1);
    });

    it("refuses until the wizard's required steps are done", async () => {
      const tab = await signedIn();

      expect((await testKey(tab)).status).toBe(409);
      expect(stub.calls).toEqual([]);
    });

    it("answers that no key is saved, with no call", async () => {
      await finishWizard();
      const tab = await signedIn();

      const res = await testKey(tab);

      expect([res.status, await res.json()]).toEqual([200, { result: "no key", ai: null }]);
      expect(stub.calls).toEqual([]);
    });

    it("answers each result with the AI settings after it, and never the key", async () => {
      await finishWizard();
      const tab = await signedIn();
      const body = openai();
      await save(tab, body);
      const answers: unknown[] = [];

      for (const [answer, result] of [
        ["work", "works"],
        ["rate limit", "rate limit"],
        ["fail", "no answer"],
        ["reject", "key rejected"],
      ] as const) {
        stub.answers.quick = answer;
        const res = await testKey(tab);
        const json = (await res.json()) as { result: string; ai: AiView };
        answers.push(json);
        expect([res.status, json.result]).toEqual([200, result]);
        later();
      }

      expect(answers.at(-1)).toMatchObject({ ai: { status: { state: "key rejected" } } });
      expect(await keyTests()).toBe(1);
      expect(JSON.stringify(answers)).not.toContain(body.apiKey);
      expect(lines.join("\n")).not.toContain(body.apiKey);
    });

    it("answers 429 with Retry-After within 10 seconds of the last test, and 409 while one runs", async () => {
      await finishWizard();
      const tab = await signedIn();
      await save(tab, openai());
      let release = () => {};
      stub.beforeAnswer = () => new Promise<void>((resolve) => (release = resolve));

      const first = testKey(tab);
      await vi.waitFor(() => expect(stub.calls).toHaveLength(3));
      const during = await testKey(tab);
      release();
      expect((await first).status).toBe(200);
      const soon = await testKey(tab);

      expect([during.status, await during.json()]).toEqual([
        409,
        { error: "A test of the key is running. Wait for its answer." },
      ]);
      expect([soon.status, soon.headers.get("retry-after"), await soon.json()]).toEqual([
        429,
        "10",
        { error: "Wait 10 seconds, then test the key again." },
      ]);
      expect(stub.calls).toHaveLength(3);
    });

    it("answers 409 when the stored key cannot be read", async () => {
      await finishWizard();
      const tab = await signedIn();
      await save(tab, openai());
      await test.database.$client.execute("UPDATE ai_settings SET api_key = 'v1.not-a-ciphertext'");

      const res = await testKey(tab);

      expect([res.status, await res.json()]).toEqual([
        409,
        { error: "The app cannot read the saved key. Enter it again, then save." },
      ]);
    });
  });
});
