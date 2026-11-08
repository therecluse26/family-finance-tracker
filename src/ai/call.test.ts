import { generateText, jsonSchema, stepCountIs, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as z from "zod";
import { addUnconnectedAccount, loginTables } from "../db/index.ts";
import { saveHouseholdFacts } from "../household/index.ts";
import { createLogger } from "../log.ts";
import type { AiProviderName, AiSettingsInput, AiTier } from "./ai-view.ts";
import { privateModels } from "./call.ts";
import { type AiCost, aiCost } from "./cost.ts";
import { householdAi } from "./household-ai.ts";
import type { OutboundCall } from "./outbound.ts";
import { memberPrice } from "./prices.ts";
import { type AiCall, type AiMessage, aiTool } from "./prompt.ts";
import { type AiModelMaker, makeFetchModels } from "./providers.ts";
import { aiSettings } from "./settings.ts";
import { CapturingFetch, newAiKey, newTestAi, StubModels, type TestAi } from "./testing.ts";
import { typedAmount, typedCount, typedDate, typedMonth } from "./typed.ts";
import { FIXED_RULES } from "./voice.ts";

// The one AI call path (spec 08, What the AI provider gets; Counting cost), on a fetch that
// captures each request as it leaves, and on AI SDK test models. No test calls an AI provider. The
// Household's names, addresses, numbers, and facts are made up. The AI provider gets them as the
// app builds them: no text is rewritten on its way out.

const QUIET = createLogger(() => {}, { throwOnSecretField: true });

const TASK = "You help Dana and Ravi. Never name a company.";
const SUMMARY = [
  "Household summary: Dana (dana.w@example.com) and Ravi, ages 41, 39 and 8, ZIP 10001.",
  "Ally savings 4821 (Rainy day fund) holds $12,400.50 on 2026-10-31.",
].join("\n");
const NOTE = "Note from Ravi: card XXXX7730 was replaced; new number 4111 1111 1111 1111.";

// A price for the made-up models: $1 and $2 per million tokens, in millionths of a dollar.
const PRICE = { input: 1_000_000, output: 2_000_000 };

// A tool-free reply from a test model, of 5 input tokens and 1 output token.
const REPLY = {
  content: [{ type: "text" as const, text: "Done" }],
  finishReason: { unified: "stop" as const, raw: "stop" },
  usage: {
    inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  warnings: [],
};

// Every text the request sends after the system prompt, in order: the summary, the task, then each
// change. Anthropic joins a call's user messages that come one after another into one message.
function sentTexts(body: Record<string, unknown> | undefined): string[] {
  return ((body?.messages ?? []) as { content: { type: string; text?: string }[] }[]).flatMap(
    (message) => message.content.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])),
  );
}

const CONNECTION = {
  provider: "anthropic" as const,
  baseUrl: null,
  gatewayToken: undefined,
};

describe("the one AI call path", () => {
  let test: TestAi;
  let capture: CapturingFetch;
  let cost: AiCost;
  let rainyDayFund: string;

  beforeEach(async () => {
    test = await newTestAi();
    capture = new CapturingFetch();
    cost = aiCost({ database: test.database });
    const joined = new Date("2026-01-02T00:00:00Z");
    await test.database.insert(loginTables.user).values([
      {
        id: "m2",
        name: "Ravi Okafor",
        email: "ravi@example.org",
        createdAt: new Date("2026-03-04T00:00:00Z"),
        updatedAt: joined,
      },
      {
        id: "m1",
        name: "Dana Whitfield",
        email: "dana.w@example.com",
        createdAt: joined,
        updatedAt: joined,
      },
    ]);
    const savings = { subtype: "savings", institutionName: "Ally" };
    rainyDayFund = await addUnconnectedAccount(test.database, {
      ...savings,
      name: "Rainy day fund",
      mask: "4821",
    });
    await addUnconnectedAccount(test.database, {
      ...savings,
      name: "Ally Online Savings",
      mask: "7730",
    });
    await saveHouseholdFacts(
      test.database,
      { zipCode: "10001", ages: [41, 39, 8], rentOrOwn: "own" },
      "m1",
    );
  });

  afterEach(() => {
    test.close();
  });

  const settingsFor = (provider: AiProviderName): AiSettingsInput => ({
    provider,
    apiKey: newAiKey(),
    baseUrl: null,
    quickModel: "quick-model",
    writerModel: "writer-model",
    prices: { quick: PRICE, writer: PRICE },
  });

  const options = (makeModels?: AiModelMaker) => ({
    database: test.database,
    secrets: test.secrets,
    makeModels,
    cost,
    logger: QUIET,
  });

  async function connect(provider: AiProviderName, makeModels = makeFetchModels(capture.fetch)) {
    const settings = aiSettings(options(makeModels));
    expect(await settings.save(settingsFor(provider))).toMatchObject({
      saved: true,
    });
    return householdAi(options(makeModels));
  }

  // The uses of the calls counted this month, oldest first.
  const counted = async () => (await cost.usage()).calls.map((call) => call.use).reverse();

  // A gate that notes each time it is asked, and lets every call through.
  function countedAs(events: string[]): (tier: AiTier) => OutboundCall {
    return (tier) => ({
      use: "chat",
      provider: "anthropic",
      model: `${tier}-model`,
      price: memberPrice(PRICE.input, PRICE.output),
      gate: async () => {
        events.push("gate");
        return undefined;
      },
      cost,
    });
  }

  const call: AiCall = {
    use: "chat",
    summary: SUMMARY,
    task: TASK,
    changes: [
      { role: "assistant" as const, text: "Dana spent less than Ravi in October." },
      { role: "user" as const, text: NOTE },
    ],
  };

  it("sends Anthropic every part of a call as the app built it", async () => {
    const ai = await connect("anthropic");

    await ai.generate(call);

    const sent = capture.requests.at(-1);
    expect(sent?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent?.body.system).toEqual([{ type: "text", text: FIXED_RULES }]);
    expect(sent?.body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: SUMMARY, cache_control: { type: "ephemeral", ttl: "5m" } },
          { type: "text", text: TASK },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Dana spent less than Ravi in October." }],
      },
      { role: "user", content: [{ type: "text", text: NOTE }] },
    ]);
  });

  it.each(["anthropic", "openai", "openrouter"] as const)(
    "sends %s the Members' names and the Accounts' last 4 as they are",
    async (provider) => {
      const ai = await connect(provider);

      expect(await ai.generate(call)).toEqual({ ready: true, text: "O" });

      // The two checks on save, then the call.
      expect(capture.requests).toHaveLength(3);
      const body = JSON.stringify(capture.requests.at(-1)?.body);
      for (const value of ["Dana", "Ravi", "4821", "Rainy day fund"]) expect(body).toContain(value);
      expect(body).not.toContain("[removed]");
      expect(body).not.toContain("Member A");
    },
  );

  it("sends every tool result back to the AI provider as the tool wrote it", async () => {
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        prompts.push(options.prompt);
        if (prompts.length === 1) {
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "payers",
                input: '{"month":"2026-10"}',
              },
            ],
            finishReason: { unified: "tool-calls", raw: "tool_use" },
            usage: {
              inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            warnings: [],
          };
        }
        return {
          content: [{ type: "text", text: "Done" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        };
      },
    });
    const models = privateModels(
      test.database,
      () => ({ quick: model, writer: model }),
      { ...CONNECTION, apiKey: newAiKey() },
      { quick: "q", writer: "w" },
      countedAs([]),
    );

    await generateText({
      model: models.writer,
      prompt: "Who paid?",
      stopWhen: stepCountIs(2),
      tools: {
        payers: tool({
          description: "Who paid what in a month",
          inputSchema: jsonSchema<{ month: string }>({
            type: "object",
            properties: { month: { type: "string" } },
          }),
          execute: async () => ({
            payers: [
              { who: "Ravi Okafor", memo: "Zelle from Jordan Pike, card ****7730", cents: 4821 },
              { who: "dana", memo: "ACH 12-34-56-78 to dana.w@example.com", cents: 1250 },
            ],
          }),
        }),
      },
    });

    expect(prompts).toHaveLength(2);
    const second = prompts[1] as { role: string; content: { type: string; output?: unknown }[] }[];
    const result = second.find((message) => message.role === "tool")?.content[0];
    expect(result).toMatchObject({
      type: "tool-result",
      output: {
        type: "json",
        value: {
          payers: [
            { who: "Ravi Okafor", memo: "Zelle from Jordan Pike, card ****7730", cents: 4821 },
            { who: "dana", memo: "ACH 12-34-56-78 to dana.w@example.com", cents: 1250 },
          ],
        },
      },
    });
  });

  it("passes a call through the cost gate, and counts it once", async () => {
    const events: string[] = [];
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (sent) => {
        events.push("sent");
        prompts.push(sent.prompt);
        return REPLY;
      },
    });
    const models = privateModels(
      test.database,
      () => ({ quick: model, writer: model }),
      { ...CONNECTION, apiKey: newAiKey() },
      { quick: "q", writer: "w" },
      countedAs(events),
    );

    await generateText({ model: models.writer, prompt: "How did Dana do?", maxRetries: 0 });

    expect(events).toEqual(["gate", "sent"]);
    expect(prompts).toEqual([
      [{ role: "user", content: [{ type: "text", text: "How did Dana do?" }] }],
    ]);
    expect((await cost.usage()).calls).toMatchObject([
      { use: "chat", model: "writer-model", noCacheTokens: 5, outputTokens: 1, costNanos: 7_000 },
    ]);
  });

  it("counts the check on save and each call once", async () => {
    const ai = await connect("anthropic");

    expect(await ai.generate(call)).toEqual({ ready: true, text: "O" });

    expect(await counted()).toEqual(["check on save", "check on save", "chat"]);
    expect(capture.requests).toHaveLength(3);
    expect(JSON.stringify(capture.requests.at(-1)?.body)).toContain("Dana");
  });

  it("sends a Chat with a year, then an amount", async () => {
    const ai = await connect("anthropic");
    const history = ["How much did we spend in 2025?", "$41,203 in total.", "And in 2024?"];

    expect(
      await ai.generate({
        use: "chat",
        summary: "Spending this month: $2,310.",
        task: "Answer the Member.",
        changes: history.map((text, index) => ({
          role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
          text,
        })),
      }),
    ).toEqual({ ready: true, text: "O" });
  });

  // A Quick batch row goes out as JSON, with a space for each control character in its text.
  it.each([
    ["Card 4111\n1111\t1111\u000B1111", "Card 4111 1111 1111 1111"],
    ["VENMO\nWHITFIELD", "VENMO WHITFIELD"],
    ["PAID Ravi\u000COkafor", "PAID Ravi Okafor"],
  ])("sends the batch field %j as %j", async (memo, sent) => {
    const ai = await connect("anthropic");

    await ai.generate({ use: "category fix", task: "Fix.", batch: [{ memo }] });

    expect(sentTexts(capture.requests.at(-1)?.body)).toEqual([
      "Fix.",
      JSON.stringify({ row: 1, memo: sent }),
    ]);
  });

  describe("Chat's tools", () => {
    // A lookup whose result holds a Member's name split by a newline, a last 4, and a card number
    // split by tabs.
    const payers = aiTool({
      description: "Who paid what in a month",
      input: z.object({ month: z.string() }),
      run: async ({ month }) => ({
        month,
        payers: [{ who: "Ravi\nOkafor", memo: "card 4111\t1111\t1111\t1111", amount: "12.50" }],
        last4: "4821",
      }),
    });

    // The tool results in each request the test models got, by round.
    const toolResults = (stub: StubModels) =>
      stub.prompts.map((messages) =>
        messages.flatMap((message) =>
          message.role === "tool" && typeof message.content !== "string"
            ? message.content.map((part) => part.output)
            : [],
        ),
      );

    // Test models that call `payers` until the request holds `rounds` tool results, then answer.
    const callingPayers = (rounds: number) => {
      const stub = new StubModels();
      stub.callTools = (messages) =>
        messages.filter((message) => message.role === "tool").length < rounds
          ? [{ toolName: "payers", input: { month: "2026-10" } }]
          : [];
      return stub;
    };

    it("runs a tool the AI calls, and sends its result back with a space for each control character", async () => {
      const stub = callingPayers(1);
      const ai = await connect("anthropic", stub.makeModels);

      expect(await ai.generate({ ...call, tools: { payers } })).toEqual({
        ready: true,
        text: "O",
        output: undefined,
      });

      const [result] = toolResults(stub).at(-1) ?? [];
      expect(result).toEqual({
        type: "json",
        value: {
          month: "2026-10",
          payers: [{ who: "Ravi Okafor", memo: "card 4111 1111 1111 1111", amount: "12.50" }],
          last4: "4821",
        },
      });
      expect(JSON.stringify(result)).not.toMatch(/\\[^\\"]/);
      expect(stub.offered.slice(2).map((each) => each.tools)).toEqual([["payers"], ["payers"]]);
      expect(await counted()).toEqual(["check on save", "check on save", "chat", "chat"]);
    });

    it("sends a Member's name and an Account's last 4 in a tool result and the summary as they are, and streams the AI's text as it wrote it", async () => {
      const stub = callingPayers(1);
      stub.reply = "Dana Whitfield paid 48.21 from Rainy day fund ending 4821.";
      stub.streamPiece = 4;
      const ai = await connect("anthropic", stub.makeModels);
      const names = await ai.accountNames();
      // A lookup as Chat's lookup tools answer, with the app's numbers. 4821 is a last 4.
      const named = aiTool({
        description: "Who paid what in a month",
        input: z.object({ month: z.string() }),
        run: async ({ month }) => ({
          month: typedMonth(month),
          count: typedCount(4821),
          total: typedAmount(-4821),
          payers: [
            {
              who: "Dana Whitfield",
              merchant: "BLUEBIRD BOOKS 4821",
              account: names.get(rainyDayFund) ?? "",
              date: typedDate("2026-10-31"),
              amount: typedAmount(482_100),
            },
          ],
        }),
      });

      const started = await ai.stream(
        { ...call, tools: { payers: named } },
        { ended: async () => undefined },
      );
      if (!started.ready) throw new Error(`Paused: ${started.pause}`);
      const body = await started.response.text();

      expect(toolResults(stub).at(-1)).toEqual([
        {
          type: "json",
          value: {
            month: "2026-10",
            count: 4821,
            total: "-48.21",
            payers: [
              {
                who: "Dana Whitfield",
                merchant: "BLUEBIRD BOOKS 4821",
                account: "Rainy day fund ending 4821",
                date: "2026-10-31",
                amount: "4821.00",
              },
            ],
          },
        },
      ]);
      expect(JSON.stringify(stub.prompts.at(-1))).toContain(JSON.stringify(SUMMARY).slice(1, -1));
      const streamed = body
        .split("\n\n")
        .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
        .map((line) => JSON.parse(line.slice("data: ".length)) as { type: string; delta?: string })
        .filter((part) => part.type === "text-delta")
        .map((part) => part.delta)
        .join("");
      expect(streamed).toBe("Dana Whitfield paid 48.21 from Rainy day fund ending 4821.");
    });

    it("runs at most 5 of the 10 tools the AI calls in one round, then offers none", async () => {
      const stub = new StubModels();
      stub.callTools = (messages) =>
        messages.some((message) => message.role === "tool")
          ? []
          : Array.from({ length: 10 }, (_, index) => ({
              toolName: "lookup",
              input: { month: `2026-0${index % 9}` },
            }));
      stub.reply = "Done";
      const ai = await connect("anthropic", stub.makeModels);
      let runs = 0;
      const lookup = aiTool({
        description: "Who paid what in a month",
        input: z.object({ month: z.string() }),
        run: async () => {
          runs += 1;
          return { paid: "12.50" };
        },
      });

      expect(await ai.generate({ ...call, tools: { lookup } })).toMatchObject({ text: "Done" });

      expect(runs).toBe(5);
      const results = toolResults(stub).at(-1) ?? [];
      expect(results).toHaveLength(10);
      expect(results.filter((result) => JSON.stringify(result).includes("12.50"))).toHaveLength(5);
      expect(results.slice(5)).toEqual(
        Array(5).fill({ type: "json", value: { error: "No more lookups for this question." } }),
      );
      expect(stub.offered.slice(2).map((each) => each.toolChoice)).toEqual(["auto", "none"]);
    });

    it("offers no tool after 5 calls in 5 rounds, so the AI answers with what it has", async () => {
      const stub = callingPayers(99);
      stub.reply = "Done";
      const ai = await connect("anthropic", stub.makeModels);

      expect(await ai.generate({ ...call, tools: { payers } })).toMatchObject({
        ready: true,
        text: "Done",
      });

      expect(stub.offered.slice(2).map((each) => each.toolChoice)).toEqual([
        "auto",
        "auto",
        "auto",
        "auto",
        "auto",
        "none",
      ]);
      expect(toolResults(stub).at(-1)).toHaveLength(5);
    });

    it("tells the AI only that a tool failed, never its error", async () => {
      const stub = callingPayers(1);
      const ai = await connect("anthropic", stub.makeModels);
      const failing = aiTool({
        description: "Who paid what in a month",
        input: z.object({ month: z.string() }),
        run: async () => {
          throw new Error("SELECT * FROM transactions WHERE memo = 'Dana Whitfield 4821'");
        },
      });

      await ai.generate({ ...call, tools: { payers: failing } });

      expect(toolResults(stub).at(-1)).toEqual([
        { type: "json", value: { error: "The lookup failed." } },
      ]);
    });

    it("refuses tools outside Chat, tools aiTool did not make, and an optional field, so none goes out", async () => {
      const ai = await connect("anthropic");
      const parameters = jsonSchema({ type: "object", properties: { name: { const: "Dana" } } });
      const optional = aiTool({
        description: "Who paid",
        input: z.object({ month: z.string().optional() }),
        run: async () => ({}),
      });

      await expect(
        ai.generate({ use: "reading a goal", task: "Read.", tools: { payers } }),
      ).rejects.toThrow("Only Chat takes tools.");
      await expect(
        // @ts-expect-error A call's tools are made by aiTool.
        ai.generate({ ...call, tools: { payers: tool({ inputSchema: parameters }) } }),
      ).rejects.toThrow(TypeError);
      await expect(ai.generate({ ...call, tools: { Payers: payers } })).rejects.toThrow(TypeError);
      await expect(ai.generate({ ...call, tools: { payers: optional } })).rejects.toThrow(
        TypeError,
      );
      await expect(
        // @ts-expect-error An AI call takes no response schema.
        ai.generate({ ...call, responseFormat: { type: "json", schema: parameters } }),
      ).rejects.toThrow(TypeError);
      await expect(
        ai.generate({
          ...call,
          // @ts-expect-error A message holds only its role and text.
          changes: [{ role: "user", text: "Hi", providerOptions: { anthropic: {} } }],
        }),
      ).rejects.toThrow(TypeError);
      // A change given as parts is the app's: from the user only, and each part text or a number.
      for (const change of [
        { role: "assistant", parts: ["Hi"] },
        { role: "user", parts: ["Hi"], typed: true },
        { role: "user", parts: ["Hi"], text: "Hi" },
        { role: "user", parts: [{ amount: 4821 }] },
        { role: "user", parts: "Hi" },
      ]) {
        await expect(
          ai.generate({ ...call, changes: [change as AiMessage] }),
          JSON.stringify(change),
        ).rejects.toThrow(TypeError);
      }

      // Only the two checks on save.
      expect(capture.requests).toHaveLength(2);
      expect(await counted()).toEqual(["check on save", "check on save"]);
    });
  });

  it("takes the no-AI path with no AI provider", async () => {
    const ai = householdAi(options(makeFetchModels(capture.fetch)));

    expect(await ai.generate(call)).toEqual({ ready: false, pause: "no AI provider" });
    expect(capture.requests).toEqual([]);
  });

  it("names each Account by its name and last 4, and keeps names in AI text for the screen", async () => {
    const ai = householdAi(options());

    expect(await ai.forScreen("Ravi spent less than Dana!")).toBe("Ravi spent less than Dana.");
    expect([...(await ai.accountNames()).values()].sort()).toEqual([
      "Ally Online Savings ending 7730",
      "Rainy day fund ending 4821",
    ]);
    expect([...(await ai.memberNames()).values()].sort()).toEqual([
      "Dana Whitfield",
      "Ravi Okafor",
    ]);
  });
});
