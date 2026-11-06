import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addConnection } from "../db/index.ts";
import { createLogger, holdsSecretValue } from "../log.ts";
import { SecretDecryptError } from "../secrets/index.ts";
import type { AiSettings, AiSettingsInput } from "./ai-view.ts";
import { aiCost } from "./cost.ts";
import { makeFetchModels } from "./providers.ts";
import { type AiGates, aiCalls, aiSettings, defaultGates } from "./settings.ts";
import { CapturingFetch, newAiKey, newTestAi, StubModels, type TestAi } from "./testing.ts";

// Settings → AI behind its routes (spec 08, AI settings page), on AI SDK test models and a fetch
// that captures each request, with made-up keys.

const GATEWAY = "https://gateway.ai.cloudflare.com/v1/account-id/gateway-id/anthropic";

const anthropic = (more: Partial<AiSettingsInput> = {}): AiSettingsInput => ({
  provider: "anthropic",
  apiKey: newAiKey(),
  baseUrl: null,
  quickModel: "claude-haiku-5-5",
  writerModel: "claude-sonnet-5-5",
  // Used only for a model not in the price table, such as a made-up one.
  prices: { quick: { input: 0, output: 0 }, writer: { input: 0, output: 0 } },
  ...more,
});

describe("the AI settings", () => {
  let test: TestAi;
  let stub: StubModels;
  let lines: string[];
  let gates: AiGates;
  let ai: AiSettings;

  beforeEach(async () => {
    test = await newTestAi();
    stub = new StubModels();
    lines = [];
    gates = { historyLoaded: async () => true, costCapPausedUntil: async () => undefined };
    ai = aiSettings({
      database: test.database,
      cost: aiCost({ database: test.database }),
      secrets: test.secrets,
      makeModels: stub.makeModels,
      gates: {
        historyLoaded: () => gates.historyLoaded(),
        costCapPausedUntil: () => gates.costCapPausedUntil(),
      },
      logger: createLogger((line) => lines.push(line), { throwOnSecretField: true }),
    });
  });

  afterEach(() => {
    test.close();
  });

  const chatReady = async () =>
    (
      await aiCalls({
        database: test.database,
        cost: aiCost({ database: test.database }),
        secrets: test.secrets,
        makeModels: stub.makeModels,
        gates,
      }).modelFor("chat")
    ).ready;

  const storedRow = async () =>
    (await test.database.$client.execute("SELECT * FROM ai_settings")).rows;

  it("makes one call to each model with a 1-token reply on save, and shows that each worked", async () => {
    const input = anthropic();

    const saved = await ai.save(input);

    expect(stub.calls).toEqual([
      { tier: "quick", modelId: "claude-haiku-5-5", maxOutputTokens: 1 },
      { tier: "writer", modelId: "claude-sonnet-5-5", maxOutputTokens: 1 },
    ]);
    expect(saved).toEqual({
      saved: true,
      check: { quick: "worked", writer: "worked" },
      ai: {
        provider: "anthropic",
        keySet: true,
        baseUrl: null,
        gatewayTokenSet: false,
        quickModel: "claude-haiku-5-5",
        writerModel: "claude-sonnet-5-5",
        prices: { quick: { source: "table" }, writer: { source: "table" } },
        status: { state: "on" },
      },
    });
    expect(JSON.stringify(saved)).not.toContain(input.apiKey);
  });

  it("checks through the real provider instance, with max_tokens 1 in each request", async () => {
    const capture = new CapturingFetch();
    const real = aiSettings({
      database: test.database,
      cost: aiCost({ database: test.database }),
      secrets: test.secrets,
      makeModels: makeFetchModels(capture.fetch),
      gates,
    });

    const saved = await real.save({
      ...anthropic(),
      provider: "openai",
      quickModel: "gpt-6-luna",
      writerModel: "gpt-6.1-terra",
    });

    expect(saved).toMatchObject({ check: { quick: "worked", writer: "worked" } });
    expect(
      capture.requests.map(({ body }) => [
        body.model,
        body.max_completion_tokens ?? body.max_tokens,
      ]),
    ).toEqual([
      ["gpt-6-luna", 1],
      ["gpt-6.1-terra", 1],
    ]);
  });

  it("saves the key and the gateway token encrypted, each bound to its row and column", async () => {
    const input = anthropic({ baseUrl: GATEWAY, gatewayToken: newAiKey() });
    await ai.save(input);
    const [row] = await storedRow();
    const key = String(row?.api_key);
    const token = String(row?.gateway_token);

    expect(JSON.stringify(row)).not.toContain(input.apiKey);
    expect(JSON.stringify(row)).not.toContain(input.gatewayToken);
    expect(test.secrets.decrypt(key, { rowId: 1, column: "ai_settings.api_key" })).toBe(
      input.apiKey,
    );
    expect(test.secrets.decrypt(token, { rowId: 1, column: "ai_settings.gateway_token" })).toBe(
      input.gatewayToken,
    );
    expect(() =>
      test.secrets.decrypt(key, { rowId: 1, column: "ai_settings.gateway_token" }),
    ).toThrow(SecretDecryptError);
    expect(() => test.secrets.decrypt(key, { rowId: 2, column: "ai_settings.api_key" })).toThrow(
      SecretDecryptError,
    );
    expect(await ai.view()).toMatchObject({ keySet: true, gatewayTokenSet: true });
  });

  it("changes the models, and keeps the key", async () => {
    const first = anthropic();
    await ai.save(first);
    const { apiKey: _key, ...kept } = first;

    const saved = await ai.save({ ...kept, quickModel: "claude-haiku-5-5-other" });

    expect(saved).toMatchObject({ saved: true, ai: { quickModel: "claude-haiku-5-5-other" } });
    expect(stub.connections.at(-1)?.apiKey).toBe(first.apiKey);
  });

  it("never sends a stored key to another AI provider or base URL", async () => {
    await ai.save(anthropic());

    const moved = await ai.save({
      provider: "anthropic",
      baseUrl: GATEWAY,
      quickModel: "claude-haiku-5-5",
      writerModel: "claude-sonnet-5-5",
    });

    expect(moved).toEqual({ saved: false, refusal: "key needed" });
    expect(stub.connections).toHaveLength(1);
  });

  it("needs a key for every AI provider but an OpenAI-compatible endpoint", async () => {
    for (const provider of ["anthropic", "openai", "openrouter"] as const) {
      expect(await ai.save({ ...anthropic(), provider, apiKey: undefined })).toEqual({
        saved: false,
        refusal: "key needed",
      });
    }

    const saved = await ai.save({
      provider: "openai-compatible",
      baseUrl: "http://ollama.local:11434/v1",
      quickModel: "llama-small",
      writerModel: "llama-large",
      prices: { quick: { input: 0, output: 0 }, writer: { input: 0, output: 0 } },
    });

    expect(saved).toMatchObject({ saved: true, ai: { keySet: false } });
  });

  it("removes the gateway token, and drops it when the base URL leaves the gateway", async () => {
    const first = anthropic({ baseUrl: GATEWAY, gatewayToken: newAiKey() });
    await ai.save(first);
    const { apiKey: _key, gatewayToken: _token, ...kept } = first;

    expect(await ai.save({ ...kept, gatewayToken: null })).toMatchObject({
      ai: { gatewayTokenSet: false },
    });
    expect(stub.connections.at(-1)?.gatewayToken).toBeUndefined();
  });

  it("keeps one AI provider at a time", async () => {
    await ai.save(anthropic());
    const openrouter = { ...anthropic(), provider: "openrouter" as const };

    await ai.save(openrouter);

    expect(await storedRow()).toHaveLength(1);
    expect(await ai.view()).toMatchObject({ provider: "openrouter" });
  });

  it("saves, and shows that the AI provider rejected the key, when a call answers 401", async () => {
    stub.answers = { quick: "work", writer: "reject" };

    const saved = await ai.save(anthropic());

    expect(saved).toMatchObject({
      saved: true,
      check: { quick: "worked", writer: "key rejected" },
      ai: { status: { state: "key rejected" } },
    });

    stub.answers = { quick: "work", writer: "work" };
    const { apiKey: _key, ...kept } = anthropic();
    expect(await ai.save(kept)).toMatchObject({ ai: { status: { state: "on" } } });
  });

  it("keeps the key out of every log line and answer when the AI provider's error holds it", async () => {
    const input = anthropic({ baseUrl: GATEWAY, gatewayToken: newAiKey() });
    stub.answers = { quick: "fail", writer: "throw" };

    const saved = await ai.save(input);

    expect(saved).toMatchObject({ check: { quick: "failed", writer: "failed" } });
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        msg: "The AI provider did not answer the check on save",
        status: 500,
      }),
      expect.objectContaining({
        msg: "The AI provider did not answer the check on save",
        status: null,
      }),
    ]);
    for (const secret of [input.apiKey, input.gatewayToken]) {
      expect(lines.join("")).not.toContain(secret);
      expect(JSON.stringify(saved)).not.toContain(secret);
    }
  });

  it("makes the logger refuse the key and the token as soon as they are given", async () => {
    const input = anthropic({ baseUrl: GATEWAY, gatewayToken: newAiKey() });
    stub.answers = { quick: "reject", writer: "reject" };

    await ai.save(input);

    expect(holdsSecretValue(`said ${input.apiKey}`)).toBe(true);
    expect(holdsSecretValue(`said ${input.gatewayToken}`)).toBe(true);
  });

  it("shows each status line", async () => {
    await ai.save(anthropic());
    expect(await ai.view()).toMatchObject({ status: { state: "on" } });

    gates.historyLoaded = async () => false;
    expect(await ai.view()).toMatchObject({ status: { state: "waits for history" } });

    gates.costCapPausedUntil = async () => "2026-12-01";
    expect(await ai.view()).toMatchObject({ status: { state: "cost cap", until: "2026-12-01" } });
  });

  it("removes the AI provider and its key, so every use takes its no-AI path", async () => {
    await ai.save(anthropic({ baseUrl: GATEWAY, gatewayToken: newAiKey() }));
    expect(await chatReady()).toBe(true);

    await ai.remove();

    expect(await storedRow()).toEqual([
      expect.objectContaining({ provider: null, api_key: null, gateway_token: null }),
    ]);
    expect(await ai.view()).toBeUndefined();
    expect(await chatReady()).toBe(false);
  });

  it("never writes the settings back over a Remove AI provider or a save that came during its check", async () => {
    const first = anthropic();
    await ai.save(first);
    const { apiKey: _key, ...kept } = first;
    stub.beforeAnswer = async () => {
      stub.beforeAnswer = async () => {};
      await ai.remove();
    };

    const late = await ai.save({ ...kept, writerModel: "claude-sonnet-5-5-other" });

    expect(late).toEqual({ saved: false, refusal: "changed" });
    expect(await ai.view()).toBeUndefined();
    expect(await storedRow()).toEqual([
      expect.objectContaining({ provider: null, api_key: null, gateway_token: null }),
    ]);

    // A first save after Remove AI provider works, and one that loses to another save stores nothing.
    const next = anthropic({ quickModel: "claude-haiku-5-5-next" });
    stub.beforeAnswer = async () => {
      stub.beforeAnswer = async () => {};
      expect(await ai.save(next)).toMatchObject({ saved: true });
    };
    expect(await ai.save(anthropic())).toEqual({ saved: false, refusal: "changed" });
    expect(await ai.view()).toMatchObject({ quickModel: "claude-haiku-5-5-next" });
  });

  it("takes a new key when the stored key or gateway token cannot be read", async () => {
    const first = anthropic({ baseUrl: GATEWAY, gatewayToken: newAiKey() });
    await ai.save(first);
    // Each ciphertext now sits in the other's column, where it does not decrypt.
    await test.database.$client.execute(
      "UPDATE ai_settings SET api_key = gateway_token, gateway_token = api_key",
    );
    const { apiKey: _key, gatewayToken: _token, ...kept } = first;
    const key = newAiKey();
    const token = newAiKey();

    expect(await ai.save(kept)).toEqual({ saved: false, refusal: "key needed" });
    expect(await ai.save({ ...kept, apiKey: key })).toEqual({
      saved: false,
      refusal: "token needed",
    });
    expect(stub.calls).toHaveLength(2);

    const saved = await ai.save({ ...kept, apiKey: key, gatewayToken: token });

    expect(saved).toMatchObject({ saved: true, check: { quick: "worked", writer: "worked" } });
    expect(stub.connections.at(-1)).toMatchObject({ apiKey: key, gatewayToken: token });
    expect(lines.join("\n")).not.toContain(key);
  });

  it("builds every later use's models from the saved settings", async () => {
    const input = anthropic();
    await ai.save(input);

    expect(await chatReady()).toBe(true);
    expect(stub.connections.at(-1)).toEqual({
      provider: "anthropic",
      apiKey: input.apiKey,
      baseUrl: null,
      gatewayToken: undefined,
    });
  });
});

describe("the gate on loaded history, until T20", () => {
  let test: TestAi;

  beforeEach(async () => {
    test = await newTestAi();
  });

  afterEach(() => {
    test.close();
  });

  it("holds AI back while any Connection's history is loading", async () => {
    const gates = defaultGates(test.database, aiCost({ database: test.database }));
    expect(await gates.historyLoaded()).toBe(true);

    const id = await addConnection(test.database, {
      provider: "fake",
      bankId: "fake-bank",
      bankName: "Fake bank",
      origin: "linked",
      syncMinute: 7,
    });
    expect(await gates.historyLoaded()).toBe(false);

    await test.database.$client.execute({
      sql: "UPDATE connections SET history_loaded = 1 WHERE id = ?",
      args: [id],
    });
    expect(await gates.historyLoaded()).toBe(true);
    expect(await gates.costCapPausedUntil()).toBeUndefined();
  });

  it("lets AI run once a loading Connection was made 24 hours ago", async () => {
    const gates = defaultGates(test.database, aiCost({ database: test.database }));
    const connection = {
      provider: "fake",
      bankId: "fake-bank",
      bankName: "Fake bank",
      origin: "linked",
      syncMinute: 7,
    } as const;
    await addConnection(test.database, connection, new Date(Date.now() - 25 * 60 * 60 * 1000));
    expect(await gates.historyLoaded()).toBe(true);

    await addConnection(test.database, { ...connection, bankId: "fake-new" });
    expect(await gates.historyLoaded()).toBe(false);
  });
});
