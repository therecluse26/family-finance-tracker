import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAiKeyRejected, readAiSettingsVersion } from "../db/index.ts";
import { createLogger, holdsSecretValue } from "../log.ts";
import type { AiSettings, AiSettingsInput } from "./ai-view.ts";
import { aiCost } from "./cost.ts";
import { makeFetchModels } from "./providers.ts";
import { type AiGates, aiCalls, aiSettings, KEY_REJECTED_CONDITION } from "./settings.ts";
import { CapturingFetch, newAiKey, newTestAi, StubModels, type TestAi } from "./testing.ts";

// "Test the key" in Settings → AI (spec 08, Test the key), on AI SDK test models and a fetch that
// captures each request, with made-up keys.

const GATEWAY = "https://gateway.ai.cloudflare.com/v1/account-id/gateway-id/anthropic";

const START = new Date("2026-11-06T15:00:00.000Z");

const anthropic = (more: Partial<AiSettingsInput> = {}): AiSettingsInput => ({
  provider: "anthropic",
  apiKey: newAiKey(),
  baseUrl: null,
  quickModel: "claude-haiku-5-5",
  writerModel: "claude-sonnet-5-5",
  ...more,
});

describe("Test the key", () => {
  let test: TestAi;
  let stub: StubModels;
  let lines: string[];
  let gates: AiGates;
  let raised: string[];
  let ended: string[];
  let changes: number;
  let ai: AiSettings;

  const settingsWith = (makeModels = stub.makeModels) =>
    aiSettings({
      database: test.database,
      cost: aiCost({ database: test.database }),
      secrets: test.secrets,
      makeModels,
      gates: {
        historyLoaded: () => gates.historyLoaded(),
        costCapPausedUntil: () => gates.costCapPausedUntil(),
      },
      logger: createLogger((line) => lines.push(line), { throwOnSecretField: true }),
      notices: {
        raise: async (notice: { condition?: string; text: string }) => {
          raised.push(notice.condition ?? notice.text);
        },
        end: async (condition) => {
          ended.push(condition);
        },
      },
      afterChange: async () => {
        changes += 1;
      },
    });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
    test = await newTestAi();
    stub = new StubModels();
    lines = [];
    raised = [];
    ended = [];
    changes = 0;
    gates = { historyLoaded: async () => true, costCapPausedUntil: async () => undefined };
    ai = settingsWith();
  });

  afterEach(() => {
    vi.useRealTimers();
    test.close();
  });

  // Moves the clock past the wait between tests.
  const later = (ms = 10_000) => vi.setSystemTime(new Date(Date.now() + ms));

  // A saved AI provider, with the check on save's two calls and changes left out of the counts.
  async function saved(input = anthropic()): Promise<AiSettingsInput> {
    await ai.save(input);
    stub.calls.length = 0;
    stub.prompts.length = 0;
    changes = 0;
    return input;
  }

  const usesCounted = async () =>
    (await aiCost({ database: test.database }).usage()).byUse.map(({ use, calls }) => [use, calls]);

  const status = async () => (await ai.view())?.status.state;

  it("makes one call to the saved Quick model, with the fixed prompt and a 1-token reply", async () => {
    const input = await saved();

    const tested = await ai.testKey();

    expect(tested).toMatchObject({
      tested: true,
      result: "works",
      ai: { status: { state: "on" } },
    });
    expect(stub.calls).toEqual([
      { tier: "quick", modelId: "claude-haiku-5-5", maxOutputTokens: 1 },
    ]);
    expect(stub.prompts).toEqual([
      [{ role: "user", content: [{ type: "text", text: "Reply with OK." }] }],
    ]);
    expect(stub.connections.at(-1)).toEqual({
      provider: "anthropic",
      apiKey: input.apiKey,
      baseUrl: null,
      gatewayToken: undefined,
    });
    expect(JSON.stringify(tested)).not.toContain(input.apiKey);
  });

  it("sends only the fixed prompt through the real provider instance, with max_tokens 1", async () => {
    const capture = new CapturingFetch();
    const real = settingsWith(makeFetchModels(capture.fetch));
    await real.save({
      ...anthropic(),
      provider: "openai",
      quickModel: "gpt-6-luna",
      writerModel: "gpt-6.1-terra",
    });
    capture.requests.length = 0;

    expect(await real.testKey()).toMatchObject({ tested: true, result: "works" });
    expect(capture.requests).toHaveLength(1);
    const [request] = capture.requests;
    expect(request?.body.model).toBe("gpt-6-luna");
    expect(request?.body.max_completion_tokens ?? request?.body.max_tokens).toBe(1);
    expect(JSON.stringify(request?.body.messages ?? request?.body.input)).toContain(
      "Reply with OK.",
    );
    expect(JSON.stringify(request?.body)).not.toMatch(/Household|Member|Account/);
  });

  it("counts the call toward the month's cost under the use Key test", async () => {
    await saved();

    await ai.testKey();

    expect(await usesCounted()).toEqual([
      ["check on save", 2],
      ["key test", 1],
    ]);
  });

  it("says no key is saved with no AI provider, makes no call, and gives its place back", async () => {
    expect(await ai.testKey()).toEqual({ tested: true, result: "no key", ai: null });
    expect(await ai.testKey()).toEqual({ tested: true, result: "no key", ai: null });
    expect(stub.calls).toEqual([]);
    expect(await usesCounted()).toEqual([]);
  });

  it("runs at the AI cost cap, while history loads, and while the key is marked as rejected", async () => {
    await saved();
    gates.costCapPausedUntil = async () => "2026-12-01";
    gates.historyLoaded = async () => false;

    expect(await ai.testKey()).toMatchObject({ tested: true, result: "works" });

    gates = { historyLoaded: async () => true, costCapPausedUntil: async () => undefined };
    stub.answers.quick = "reject";
    later();
    expect(await ai.testKey()).toMatchObject({ result: "key rejected" });
    stub.answers.quick = "work";
    later();
    expect(await ai.testKey()).toMatchObject({ result: "works" });
    expect(stub.calls).toHaveLength(3);
  });

  it("marks the key as rejected on a 401, pauses AI, and raises the System notice once", async () => {
    await saved();
    stub.answers.quick = "reject";

    const tested = await ai.testKey();
    later();
    await ai.testKey();

    expect(tested).toMatchObject({
      tested: true,
      result: "key rejected",
      ai: { status: { state: "key rejected" } },
    });
    expect(raised).toEqual([KEY_REJECTED_CONDITION]);
    expect(ended).toEqual([]);
    expect(await status()).toBe("key rejected");
    const chat = await aiCalls({
      database: test.database,
      cost: aiCost({ database: test.database }),
      secrets: test.secrets,
      makeModels: stub.makeModels,
      gates,
    }).modelFor("chat");
    expect(chat).toEqual({ ready: false, pause: "key rejected" });
  });

  it("clears the rejected key mark when the key works, ends the notice, and lets AI come back", async () => {
    await saved();
    stub.answers.quick = "reject";
    await ai.testKey();
    stub.answers.quick = "work";
    later();

    const tested = await ai.testKey();

    expect(tested).toMatchObject({ result: "works", ai: { status: { state: "on" } } });
    expect(ended).toEqual([KEY_REJECTED_CONDITION]);
    expect(changes).toBe(1);
  });

  it("ends no notice and starts nothing when the key works and was not marked", async () => {
    await saved();

    await ai.testKey();

    expect(ended).toEqual([]);
    expect(changes).toBe(0);
  });

  it("shows a rate limit as its own result, and changes nothing", async () => {
    await saved();
    stub.answers.quick = "rate limit";

    expect(await ai.testKey()).toMatchObject({
      tested: true,
      result: "rate limit",
      ai: { status: { state: "on" } },
    });
    expect(raised).toEqual([]);
  });

  it("names the Quick model when the AI provider answers 404, and changes nothing", async () => {
    await saved();
    stub.answers.quick = "unknown model";

    expect(await ai.testKey()).toMatchObject({
      tested: true,
      result: "model unknown",
      ai: { status: { state: "on" } },
    });
    expect(raised).toEqual([]);
    expect(lines.map((line) => JSON.parse(line))).toContainEqual(
      expect.objectContaining({ msg: "The key test failed", failure: "model unknown" }),
    );
  });

  it("says the AI provider did not answer on a server error", async () => {
    await saved();
    stub.answers.quick = "fail";

    expect(await ai.testKey()).toMatchObject({ tested: true, result: "no answer" });
    expect(await status()).toBe("on");
    expect(raised).toEqual([]);
  });

  it("throws a plain error, never the AI SDK's, for a failure that is not the AI provider's", async () => {
    const input = await saved();
    lines.length = 0;
    stub.answers.quick = "throw";

    const failed = await ai.testKey().catch((error: unknown) => error);

    expect(failed).toEqual(new Error("The key test failed in the app."));
    expect(JSON.stringify(failed)).not.toContain(input.apiKey);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ msg: "The key test failed in the app", error: "Error" }),
    ]);
    expect(await status()).toBe("on");
  });

  it("says the AI provider did not answer when no reply comes within 120 seconds", async () => {
    await saved();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date(Date.now() + 60_000));
    stub.answers.quick = "hang";

    const testing = ai.testKey();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(await testing).toMatchObject({ tested: true, result: "no answer" });
  });

  it("keeps the key and the gateway token out of every log line and answer", async () => {
    const input = await saved(anthropic({ baseUrl: GATEWAY, gatewayToken: newAiKey() }));
    lines.length = 0;
    const answers: unknown[] = [];
    for (const answer of ["reject", "rate limit", "fail"] as const) {
      stub.answers.quick = answer;
      answers.push(await ai.testKey());
      later();
    }

    expect(lines.length).toBeGreaterThan(0);
    for (const secret of [input.apiKey, input.gatewayToken]) {
      expect(lines.join("\n")).not.toContain(secret);
      expect(JSON.stringify(answers)).not.toContain(secret);
      expect(holdsSecretValue(`said ${secret}`)).toBe(true);
    }
    expect(lines.map((line) => JSON.parse(line).failure)).toEqual([
      "key rejected",
      "rate limit",
      "server error",
    ]);
  });

  it("runs one test at a time: tests sent together make one call", async () => {
    await saved();

    const answers = await Promise.all([ai.testKey(), ai.testKey(), ai.testKey()]);

    expect(answers.filter((answer) => answer.tested)).toHaveLength(1);
    expect(answers.filter((answer) => !answer.tested)).toEqual([
      { tested: false, refusal: "busy" },
      { tested: false, refusal: "busy" },
    ]);
    expect(stub.calls).toHaveLength(1);
  });

  it("refuses a test that starts less than 10 seconds after the last one, with the wait left", async () => {
    await saved();
    await ai.testKey();

    later(5_500);
    expect(await ai.testKey()).toEqual({ tested: false, refusal: "too soon", waitSeconds: 5 });
    later(4_499);
    expect(await ai.testKey()).toEqual({ tested: false, refusal: "too soon", waitSeconds: 1 });
    later(1);
    expect(await ai.testKey()).toMatchObject({ tested: true, result: "works" });
    expect(stub.calls).toHaveLength(2);
  });

  it("refuses with no call when the stored key or gateway token cannot be read, and gives its place back", async () => {
    await saved(anthropic({ baseUrl: GATEWAY, gatewayToken: newAiKey() }));
    await test.database.$client.execute("UPDATE ai_settings SET api_key = 'v1.not-a-ciphertext'");

    expect(await ai.testKey()).toEqual({ tested: false, refusal: "key unreadable" });

    const input = anthropic({ baseUrl: GATEWAY, gatewayToken: newAiKey() });
    await saved(input);
    await test.database.$client.execute(
      "UPDATE ai_settings SET gateway_token = 'v1.not-a-ciphertext'",
    );
    expect(await ai.testKey()).toEqual({ tested: false, refusal: "token unreadable" });
    expect(stub.calls).toEqual([]);
    expect(lines.join("\n")).not.toContain(input.apiKey);
  });

  it("refuses with no call when the Quick model has no price, and gives its place back", async () => {
    await saved(
      anthropic({
        quickModel: "made-up-model",
        prices: { quick: { input: 1, output: 1 } },
      }),
    );
    await test.database.$client.execute("DELETE FROM ai_model_prices");

    expect(await ai.testKey()).toEqual({ tested: false, refusal: "price needed" });
    expect(await ai.testKey()).toEqual({ tested: false, refusal: "price needed" });
    expect(stub.calls).toEqual([]);
  });

  it("changes no status when a save or Remove AI provider came during the test", async () => {
    await saved();
    stub.beforeAnswer = async () => {
      stub.beforeAnswer = async () => {};
      await ai.remove();
    };

    expect(await ai.testKey()).toEqual({ tested: false, refusal: "changed", ai: null });
    expect(raised).toEqual([]);
    expect(await usesCounted()).toEqual([
      ["check on save", 2],
      ["key test", 1],
    ]);
  });

  it("clears the rejected key mark only at the generation the test read", async () => {
    await saved();
    stub.answers.quick = "reject";
    await ai.testKey();
    const { generation } = await readAiSettingsVersion(test.database);

    expect(await clearAiKeyRejected(test.database, generation - 1)).toBe(false);
    expect(await status()).toBe("key rejected");
    expect(await clearAiKeyRejected(test.database, generation)).toBe(true);
    expect(await clearAiKeyRejected(test.database, generation)).toBe(false);
    expect(await status()).toBe("on");
  });
});
