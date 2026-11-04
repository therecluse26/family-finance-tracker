import { generateText, type LanguageModel, streamText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listOpenNotices } from "../db/index.ts";
import { createLogger } from "../log.ts";
import { startNotify } from "../notify/index.ts";
import type { AiSettings, AiSettingsInput, AiUsageView } from "./ai-view.ts";
import { type AiCost, aiCost } from "./cost.ts";
import { AiPausedError } from "./outbound.ts";
import { costOf, PRICE_TABLE, perMillion, tablePrice } from "./prices.ts";
import { type AiCalls, aiCalls, aiSettings } from "./settings.ts";
import { newAiKey, newTestAi, StubModels, type TestAi } from "./testing.ts";
import { callCost, capLine } from "./usage-view.ts";

// Counting AI cost and the AI cost cap (spec 08, Counting cost, The AI cost cap, and AI usage
// page), on AI SDK test models with set usage and made-up keys. Months are in New York.

const FRESH = { freshCode: true };

const anthropic = (more: Partial<AiSettingsInput> = {}): AiSettingsInput => ({
  provider: "anthropic",
  apiKey: newAiKey(),
  baseUrl: null,
  quickModel: "claude-haiku-5-5",
  writerModel: "claude-sonnet-5-5",
  ...more,
});

// The check on save's two calls, of 5 input tokens and 1 output token each: Haiku 5.5's $0.000001
// and Sonnet 5.5's $0.00002.
const CHECK_COST = 1_000 + 20_000;

// Sonnet 5.5's output price is $10 per million tokens: 1,000 output tokens cost 1 cent.
const CENT_OF_OUTPUT = { noCache: 0, cacheRead: 0, cacheWrite: 0, output: 1000 };

// A model's own stream call, as Chat's tool loop makes it, read part by part.
type Streaming = {
  doStream(options: { prompt: unknown[] }): Promise<{ stream: ReadableStream<unknown> }>;
};
const PROMPT = [{ role: "user", content: [{ type: "text", text: "Hello there, how are you?" }] }];
const startStream = async (model: LanguageModel) =>
  (await (model as unknown as Streaming).doStream({ prompt: PROMPT })).stream.getReader();

describe("counting AI cost", () => {
  let test: TestAi;
  let stub: StubModels;
  let cost: AiCost;
  let settings: AiSettings;
  let calls: AiCalls;
  let stopNotify: () => void;
  let historyLoaded: boolean;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T15:00:00Z"));
    test = await newTestAi();
    stub = new StubModels();
    stopNotify = startNotify({ database: test.database }).stop;
    historyLoaded = true;
    cost = aiCost({ database: test.database, timeZone: async () => "America/New_York" });
    const gates = {
      historyLoaded: async () => historyLoaded,
      costCapPausedUntil: () => cost.pausedUntil(),
    };
    const options = {
      database: test.database,
      secrets: test.secrets,
      makeModels: stub.makeModels,
      cost,
      gates,
    };
    settings = aiSettings(options);
    calls = aiCalls(options);
  });

  afterEach(() => {
    stopNotify();
    vi.useRealTimers();
    test.close();
  });

  async function modelFor(...args: Parameters<AiCalls["modelFor"]>) {
    const found = await calls.modelFor(...args);
    if (!found.ready) throw new Error(`No model: ${found.pause}`);
    return found.model;
  }

  // One call with this usage. Later calls go back to the stub's usage.
  async function call(use: Parameters<AiCalls["modelFor"]>[0], usage = stub.usage) {
    const usual = stub.usage;
    stub.usage = usage;
    try {
      return await generateText({ model: await modelFor(use), prompt: "Hello", maxRetries: 0 });
    } finally {
      stub.usage = usual;
    }
  }

  const noticeTexts = async () =>
    (await listOpenNotices(test.database)).map((notice) => notice.text).sort();

  it("holds the spec's prices, with cache writes at 1.25× input", () => {
    const { anthropic: claude, openai } = PRICE_TABLE;

    expect(claude["claude-haiku-5-5"]).toEqual({
      input: perMillion(0.1),
      output: perMillion(0.5),
      cacheRead: perMillion(0.01),
      cacheWrite: perMillion(0.125),
    });
    expect(claude["claude-sonnet-5-5"]).toMatchObject({ input: 2_000_000, output: 10_000_000 });
    expect(openai["gpt-6-luna"]).toMatchObject({ input: 100_000, output: 500_000 });
    expect(openai["gpt-6.1-terra"]).toMatchObject({
      input: 1_000_000,
      output: 5_000_000,
      cacheWrite: 1_250_000,
    });
    expect(PRICE_TABLE["openai-compatible"]).toEqual({});
  });

  it("multiplies input without cache, cache reads, cache writes, and output tokens by their prices", async () => {
    await settings.save(anthropic(), FRESH);
    const usage = { noCache: 1000, cacheRead: 2000, cacheWrite: 400, output: 300 };

    await call("category fix", usage);
    await call("insight cards", usage);

    // Haiku 5.5: 1,000 × $0.10 + 2,000 × $0.01 + 400 × $0.125 + 300 × $0.50, per million.
    const haiku = tablePrice("anthropic", "claude-haiku-5-5");
    expect(haiku).toBeDefined();
    const tokens = { noCacheTokens: 1000, cacheReadTokens: 2000, cacheWriteTokens: 400 };
    expect(haiku && costOf({ ...tokens, outputTokens: 300 }, haiku)).toBe(320_000);
    const page = await settings.usage();
    expect(page.calls.slice(0, 2)).toEqual([
      {
        id: expect.any(Number),
        use: "insight cards",
        model: "claude-sonnet-5-5",
        noCacheTokens: 1000,
        cacheReadTokens: 2000,
        cacheWriteTokens: 400,
        outputTokens: 300,
        // 1,000 × $2 + 2,000 × $0.10 + 400 × $2.50 + 300 × $10, per million: $0.0062.
        costNanos: 6_200_000,
        at: "2026-11-10T15:00:00.000Z",
      },
      expect.objectContaining({ use: "category fix", costNanos: 320_000 }),
    ]);
    expect(page.totalNanos).toBe(CHECK_COST + 320_000 + 6_200_000);
    expect(callCost(6_200_000)).toBe("$0.0062");
    expect(callCost(1_000)).toBe("under $0.0001");
  });

  it("counts the check on save's two calls, even when only the models change", async () => {
    const first = anthropic();
    await settings.save(first, FRESH);
    const { apiKey: _key, ...kept } = first;

    await settings.save({ ...kept, writerModel: "claude-sonnet-5-5" }, { freshCode: false });

    const page = await settings.usage();
    expect(page.byUse).toEqual([{ use: "check on save", calls: 4, costNanos: 2 * CHECK_COST }]);
  });

  it("takes OpenRouter's own usage.cost in place of the price table", async () => {
    await settings.save(
      anthropic({
        provider: "openrouter",
        quickModel: "anthropic/claude-haiku-5.5",
        writerModel: "anthropic/claude-sonnet-5.5",
      }),
      FRESH,
    );
    stub.providerMetadata = { openrouter: { usage: { cost: 0.0123 } } };

    await call("alert advice");

    expect((await settings.usage()).calls[0]).toMatchObject({
      use: "alert advice",
      model: "anthropic/claude-haiku-5.5",
      costNanos: 12_300_000,
    });
  });

  it("counts a streamed reply, such as Chat's", async () => {
    await settings.save(anthropic(), FRESH);
    stub.usage = CENT_OF_OUTPUT;
    const result = streamText({ model: await modelFor("chat"), prompt: "Hello" });
    await result.consumeStream();

    expect((await settings.usage()).calls[0]).toMatchObject({ use: "chat", costNanos: 10_000_000 });
  });

  it("checks the gate before each streamed call, so a model handed out earlier starts no stream at the cap", async () => {
    await settings.save(anthropic(), FRESH);
    const early = await modelFor("insight cards");
    await settings.setCostCap(0);
    const before = stub.calls.length;

    await expect(startStream(early)).rejects.toThrow(AiPausedError);
    expect(stub.calls).toHaveLength(before);
  });

  it("counts a streamed call that fails or is closed before it finishes", async () => {
    await settings.save(anthropic(), FRESH);
    const rough = Math.ceil(JSON.stringify(PROMPT).length / 4);
    stub.reply = "12345678";

    stub.streamFails = true;
    const failing = await startStream(await modelFor("chat"));
    await failing.read();
    await expect(failing.read()).rejects.toThrow("The connection dropped.");
    stub.streamFails = false;
    const closed = await startStream(await modelFor("reading a goal"));
    await closed.read();
    await closed.cancel();

    // The usage never came: the prompt's rough input tokens, and the output so far.
    expect((await settings.usage()).calls.slice(0, 2)).toMatchObject([
      { use: "reading a goal", noCacheTokens: rough, outputTokens: 0 },
      { use: "chat", noCacheTokens: rough, outputTokens: 2 },
    ]);
    expect(rough).toBeGreaterThan(0);
  });

  it("logs a cap notice that fails, and lets the check on save's own result stand", async () => {
    const lines: string[] = [];
    const failing = aiCost({
      database: test.database,
      raiseNotice: async () => {
        throw new Error("The notify module is not running.");
      },
      logger: createLogger((line) => lines.push(line), { throwOnSecretField: true }),
    });
    const options = {
      database: test.database,
      secrets: test.secrets,
      makeModels: stub.makeModels,
      cost: failing,
    };
    await failing.setCap(1);
    // The check on save's calls reach the 1-cent cap, so counting them raises the 100% notice.
    stub.usage = CENT_OF_OUTPUT;

    const saved = await aiSettings(options).save(anthropic(), FRESH);

    expect(saved).toMatchObject({ saved: true, check: { quick: "worked", writer: "worked" } });
    expect(await failing.pausedUntil()).toBe("2026-12-01");
    expect((await failing.usage()).calls).toHaveLength(2);
    expect(await noticeTexts()).toEqual([]);
    expect(lines.join("\n")).toContain("An AI cost cap System notice could not be raised");
  });

  it("makes no call with a model that has no price, and takes a Member's prices for one", async () => {
    const custom = anthropic({ quickModel: "claude-haiku-9" });

    expect(await settings.save(custom, FRESH)).toEqual({
      saved: false,
      refusal: "price needed",
      tier: "quick",
    });
    expect(stub.calls).toEqual([]);

    const priced = { ...custom, prices: { quick: { input: 300_000, output: 600_000 } } };
    expect(await settings.save(priced, FRESH)).toMatchObject({
      saved: true,
      ai: { prices: { quick: { source: "member", input: 300_000 }, writer: { source: "table" } } },
    });
    await call("category fix", { noCache: 10, cacheRead: 20, cacheWrite: 30, output: 40 });
    // Cache reads and writes count at the input price: 60 × $0.30 + 40 × $0.60, per million.
    expect((await settings.usage()).calls[0]).toMatchObject({ costNanos: 42_000 });

    await test.database.$client.execute("UPDATE ai_settings SET quick_model = 'claude-haiku-10'");
    const before = stub.calls.length;
    expect(await calls.modelFor("category fix")).toEqual({ ready: false, pause: "no price" });
    expect(stub.calls).toHaveLength(before);
  });

  it("checks the AI status before every use", async () => {
    expect(await calls.modelFor("chat")).toEqual({ ready: false, pause: "no AI provider" });
    await settings.save(anthropic(), FRESH);

    historyLoaded = false;
    expect(await calls.modelFor("chat")).toEqual({ ready: false, pause: "waits for history" });
    historyLoaded = true;

    await test.database.$client.execute(
      "UPDATE ai_settings SET key_rejected_at = '2026-11-10T15:00:00.000Z'",
    );
    expect(await calls.modelFor("monthly review")).toEqual({ ready: false, pause: "key rejected" });
  });

  it("sends the 80% and the 100% System notices once each, and stops background AI at the cap", async () => {
    await settings.save(anthropic(), FRESH);
    await settings.setCostCap(1);
    const early = await modelFor("insight cards");

    await call("insight cards", { ...CENT_OF_OUTPUT, output: 800 });
    await call("insight cards", { ...CENT_OF_OUTPUT, output: 1 });
    expect(await noticeTexts()).toEqual([
      "AI cost this month is $0.01 of $0.01, 80% of the AI cost cap. At the cap, background AI pauses until the 1st.",
    ]);

    await call("insight cards", { ...CENT_OF_OUTPUT, output: 200 });
    const page = await settings.usage();

    expect(page.pausedUntil).toBe("2026-12-01");
    expect(capLine(page.totalNanos, page.capCents)).toBe("$0.01 of $0.01");
    expect(await settings.view()).toMatchObject({
      status: { state: "cost cap", until: "2026-12-01" },
    });
    expect(await noticeTexts()).toEqual([
      "AI cost cap reached: $0.01 of $0.01 this month. Background AI is paused until Dec 1. Chat and Goals ask before each call.",
      "AI cost this month is $0.01 of $0.01, 80% of the AI cost cap. At the cap, background AI pauses until the 1st.",
    ]);

    // Before each background call: no new model, and a model handed out earlier starts no call.
    const before = stub.calls.length;
    expect(await calls.modelFor("category fix")).toEqual({ ready: false, pause: "cost cap" });
    expect(await calls.modelFor("monthly review")).toEqual({ ready: false, pause: "cost cap" });
    await expect(generateText({ model: early, prompt: "Hello", maxRetries: 0 })).rejects.toThrow(
      AiPausedError,
    );
    expect(stub.calls).toHaveLength(before);

    // Chat and reading a Goal ask "Send anyway?", and send when the Member says yes.
    expect(await calls.modelFor("chat")).toEqual({ ready: false, pause: "send anyway?" });
    expect(await calls.modelFor("reading a goal")).toEqual({
      ready: false,
      pause: "send anyway?",
    });
    const anyway = await modelFor("chat", { sendAnyway: true });
    await generateText({ model: anyway, prompt: "Hello", maxRetries: 0 });
    expect(stub.calls).toHaveLength(before + 1);
    expect(await noticeTexts()).toHaveLength(2);
  });

  it("lets a call already running finish, so the total can pass the cap by one call", async () => {
    await settings.save(anthropic(), FRESH);
    await settings.setCostCap(1);
    stub.beforeAnswer = async () => {
      stub.beforeAnswer = async () => {};
      // Another call reaches the cap while this one waits for its reply.
      await call("insight cards", { ...CENT_OF_OUTPUT, output: 1500 });
    };

    await call("category fix", CENT_OF_OUTPUT);

    expect((await settings.usage()).calls.map((row) => row.use)).toEqual([
      "category fix",
      "insight cards",
      "check on save",
      "check on save",
    ]);
  });

  it("starts background AI again at once when a Member raises the cap above the month's total", async () => {
    await settings.save(anthropic(), FRESH);
    await settings.setCostCap(1);
    await call("insight cards", { ...CENT_OF_OUTPUT, output: 1200 });
    expect(await calls.modelFor("category fix")).toMatchObject({ pause: "cost cap" });

    const page: AiUsageView = await settings.setCostCap(1000);

    expect(page).toMatchObject({ capCents: 1000, pausedUntil: null });
    expect(capLine(page.totalNanos, page.capCents)).toBe("$0.01 of $10.00");
    expect(await calls.modelFor("category fix")).toMatchObject({ ready: true });
    expect(await settings.view()).toMatchObject({ status: { state: "on" } });
  });

  it("starts at a $10 cap, and lists each use's total for the month", async () => {
    await settings.save(anthropic(), FRESH);
    await call("category fix", CENT_OF_OUTPUT);
    await call("monthly review", CENT_OF_OUTPUT);
    await call("monthly review", CENT_OF_OUTPUT);

    const page = await settings.usage();

    expect(page).toMatchObject({ month: "2026-11", capCents: 1000, pausedUntil: null });
    expect(page.byUse).toEqual([
      { use: "monthly review", calls: 2, costNanos: 20_000_000 },
      // Haiku 5.5's output is $0.50 per million tokens.
      { use: "category fix", calls: 1, costNanos: 500_000 },
      { use: "check on save", calls: 2, costNanos: CHECK_COST },
    ]);
  });

  it("counts a month in the Household time zone, and keeps the total when the AI provider changes", async () => {
    await settings.save(anthropic(), FRESH);
    // 10 PM on Nov 30 in New York is already Dec 1 in UTC.
    vi.setSystemTime(new Date("2026-12-01T03:00:00Z"));
    await call("insight cards", CENT_OF_OUTPUT);
    await settings.save(
      anthropic({ provider: "openai", quickModel: "gpt-6-luna", writerModel: "gpt-6.1-terra" }),
      FRESH,
    );

    const november = await settings.usage();
    expect(november.month).toBe("2026-11");
    // Two checks on Anthropic, the call, and two checks on OpenAI: 5 × $0.10 + $0.50 and 5 × $1 +
    // $5, per million.
    expect(november.totalNanos).toBe(CHECK_COST + 10_000_000 + 1_000 + 10_000);

    vi.setSystemTime(new Date("2026-12-01T05:30:00Z"));
    expect(await settings.usage()).toMatchObject({ month: "2026-12", totalNanos: 0, calls: [] });
  });

  it("starts background AI again on the 1st", async () => {
    await settings.save(anthropic(), FRESH);
    await settings.setCostCap(1);
    await call("insight cards", { ...CENT_OF_OUTPUT, output: 1200 });
    expect(await cost.pausedUntil()).toBe("2026-12-01");

    vi.setSystemTime(new Date("2026-12-01T05:00:00Z"));

    expect(await cost.pausedUntil()).toBeUndefined();
    expect(await calls.modelFor("category fix")).toMatchObject({ ready: true });
  });

  it("stores metadata only, never prompt text or reply text", async () => {
    await settings.save(anthropic(), FRESH);
    const prompt = `Prompt ${crypto.randomUUID()}`;
    stub.reply = `Reply ${crypto.randomUUID()}`;

    const { text } = await generateText({ model: await modelFor("chat"), prompt });
    const streamed = streamText({ model: await modelFor("chat"), prompt });
    await streamed.consumeStream();

    expect(text).toBe(stub.reply);
    const tables = await test.database.$client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    let stored = "";
    for (const { name } of tables.rows) {
      const rows = await test.database.$client.execute(`SELECT * FROM "${String(name)}"`);
      stored += JSON.stringify(rows.rows);
    }
    expect(stored).toContain("chat");
    expect(stored).not.toContain(prompt);
    expect(stored).not.toContain(stub.reply);
    expect(JSON.stringify(await settings.usage())).not.toContain(stub.reply);
  });
});
