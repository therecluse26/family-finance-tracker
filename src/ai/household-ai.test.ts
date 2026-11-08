import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { readAiRedo, readAiRetry } from "../db/index.ts";
import { createLogger } from "../log.ts";
import {
  type AiProviderName,
  type AiSettingsInput,
  DEFAULT_MODELS,
  type TierModels,
  USE_TIERS,
} from "./ai-view.ts";
import { type AiCost, aiCost } from "./cost.ts";
import { BAD_REPLIES_IN_A_ROW, generateBatch, householdAi } from "./household-ai.ts";
import { type AiCall, batchReply, buildPrompt } from "./prompt.ts";
import { type AiModelMaker, makeFetchModels } from "./providers.ts";
import { RETRY_DELAYS_MS, runAiRetries, startAiRetries } from "./retries.ts";
import { aiSettings, KEY_REJECTED_CONDITION } from "./settings.ts";
import {
  CapturingFetch,
  newAiKey,
  newTestAi,
  type StubMessage,
  StubModels,
  type TestAi,
} from "./testing.ts";
import { typedAmount, typedDate } from "./typed.ts";
import { FIXED_RULES, plainVoice } from "./voice.ts";

// The shape of every AI call (spec 08, Prompt order and caching; Limits on each call; Failures;
// Writing for the Household): the one prompt order, the reply limits, the cache marks, structured
// replies, and what an AI error does. On AI SDK test models and a fetch that captures each request,
// with a fake clock. No test calls an AI provider.

const PRICE = { input: 1_000_000, output: 2_000_000 };
const SUMMARY = "Household summary: 2 Members. Spending this month: $2,310.";
const TASK = "Suggest a Category for each Transaction, from this list: Groceries, Dining out.";
const MINUTE = 60_000;

describe("an AI call", () => {
  let test: TestAi;
  let cost: AiCost;
  let stub: StubModels;
  let capture: CapturingFetch;
  let lines: string[];
  let raised: string[];
  let ended: string[];

  beforeEach(async () => {
    test = await newTestAi();
    cost = aiCost({ database: test.database });
    stub = new StubModels();
    capture = new CapturingFetch();
    lines = [];
    raised = [];
    ended = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    test.close();
  });

  const options = (makeModels: AiModelMaker) => ({
    database: test.database,
    secrets: test.secrets,
    makeModels,
    cost,
    logger: createLogger((line) => lines.push(line), { throwOnSecretField: true }),
    notices: {
      raise: async (notice: { condition?: string; text: string }) => {
        raised.push(notice.condition ?? notice.text);
      },
      end: async (condition: string) => {
        ended.push(condition);
      },
    },
  });

  const settingsFor = (
    provider: AiProviderName,
    models: TierModels = { quick: "quick-model", writer: "writer-model", chat: "chat-model" },
  ): AiSettingsInput => ({
    provider,
    apiKey: newAiKey(),
    baseUrl: provider === "openai-compatible" ? "http://ollama.local:11434/v1" : null,
    quickModel: models.quick,
    writerModel: models.writer,
    chatModel: models.chat,
    prices: { quick: PRICE, writer: PRICE, chat: PRICE },
  });

  async function connect(
    provider: AiProviderName = "anthropic",
    makeModels: AiModelMaker = stub.makeModels,
    models?: TierModels,
  ) {
    const settings = aiSettings(options(makeModels));
    expect(await settings.save(settingsFor(provider, models))).toMatchObject({
      saved: true,
    });
    return { ai: householdAi(options(makeModels)), settings };
  }

  const categoryFix = (batch: AiCall["batch"] = [{ merchant: "Bluebird Books", amount: -12.5 }]) =>
    ({ use: "category fix", task: TASK, batch }) satisfies AiCall;
  const readingAGoal: AiCall = { use: "reading a goal", task: "Read this Goal." };

  // The calls the test models were given, after the three checks on save.
  const modelCalls = () => stub.calls.slice(3);

  describe("prompt order and cache marks", () => {
    it("sends the fixed rules, then the summary, the task, and the changes, with Chat's mark after the summary", async () => {
      const { ai } = await connect("anthropic", makeFetchModels(capture.fetch));

      await ai.generate({
        use: "chat",
        summary: SUMMARY,
        task: "Answer the Member's question.",
        changes: [
          { role: "user", text: "How much did we spend on groceries?" },
          { role: "assistant", text: "$412 in October." },
          { role: "user", text: "And in September?" },
        ],
      });

      const body = capture.requests.at(-1)?.body;
      expect(body?.system).toEqual([{ type: "text", text: FIXED_RULES }]);
      expect(body?.messages).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: SUMMARY, cache_control: { type: "ephemeral", ttl: "5m" } },
            { type: "text", text: "Answer the Member's question." },
            { type: "text", text: "How much did we spend on groceries?" },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "$412 in October." }] },
        { role: "user", content: [{ type: "text", text: "And in September?" }] },
      ]);
    });

    it("sends a summary given as text and typed parts as one text, with Chat's mark after it", async () => {
      const { ai } = await connect("anthropic", makeFetchModels(capture.fetch));

      await ai.generate({
        use: "chat",
        summary: [
          "Household summary. Spending on ",
          typedDate("2026-10-31"),
          ": ",
          typedAmount(231_000),
          ".",
        ],
        task: "Answer the Member's question.",
      });

      expect(capture.requests.at(-1)?.body?.messages).toEqual([
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Household summary. Spending on 2026-10-31: 2310.00.",
              cache_control: { type: "ephemeral", ttl: "5m" },
            },
            { type: "text", text: "Answer the Member's question." },
          ],
        },
      ]);
    });

    it("sends a Quick batch's task with the mark, then each Transaction as its own text, by row number", async () => {
      const { ai } = await connect("anthropic", makeFetchModels(capture.fetch));

      await ai.generate(
        categoryFix([
          { merchant: "Bluebird Books", amount: -12.5, note: "line one\nline two" },
          { merchant: "Corner Market", amount: -40, pending: false },
        ]),
      );

      const body = capture.requests.at(-1)?.body;
      expect(body?.system).toEqual([{ type: "text", text: FIXED_RULES }]);
      expect(body?.messages).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: TASK, cache_control: { type: "ephemeral", ttl: "5m" } },
            {
              type: "text",
              text: '{"row":1,"merchant":"Bluebird Books","amount":-12.5,"note":"line one line two"}',
            },
            {
              type: "text",
              text: '{"row":2,"merchant":"Corner Market","amount":-40,"pending":false}',
            },
          ],
        },
      ]);
    });

    it.each(["insight cards", "monthly review", "budget tailoring"] as const)(
      "marks no cache for %s, and turns off OpenAI's automatic cache",
      async (use) => {
        const anthropic = await connect("anthropic", makeFetchModels(capture.fetch));
        await anthropic.ai.generate({ use, summary: SUMMARY, task: "Write it." });
        expect(JSON.stringify(capture.requests.at(-1)?.body)).not.toContain("cache_control");

        const openai = await connect("openai", makeFetchModels(capture.fetch));
        await openai.ai.generate({ use, summary: SUMMARY, task: "Write it." });
        expect(capture.requests.at(-1)?.body).toMatchObject({
          prompt_cache_options: { mode: "explicit" },
        });
      },
    );

    it("leaves OpenAI's cache on for Chat and Quick batches", async () => {
      const { ai } = await connect("openai", makeFetchModels(capture.fetch));

      await ai.generate({ use: "chat", summary: SUMMARY, task: "Answer." });
      expect(capture.requests.at(-1)?.body).not.toHaveProperty("prompt_cache_options");
      await ai.generate(categoryFix());
      expect(capture.requests.at(-1)?.body).not.toHaveProperty("prompt_cache_options");
    });

    it("refuses a call whose parts do not fit its use, and sends nothing", async () => {
      const { ai } = await connect();
      const refused: AiCall<unknown>[] = [
        { use: "monthly review", task: "No summary." },
        { use: "category fix", summary: SUMMARY, task: TASK },
        { use: "insight cards", summary: SUMMARY, task: "Cards.", batch: [{ merchant: "A" }] },
        categoryFix([]),
        categoryFix(Array.from({ length: 101 }, (_, index) => ({ amount: index }))),
        categoryFix([{ transactionId: "t1", amount: -1 }]),
        categoryFix([{ id: "t1", amount: -1 }]),
        categoryFix([{ transaction_id: "t1", amount: -1 }]),
        categoryFix([{ uuid: "u1", amount: -1 }]),
        categoryFix([{ transactionUuid: "u1", amount: -1 }]),
        categoryFix([{ account_guid: "g1", amount: -1 }]),
        categoryFix([{ row: 2, amount: -1 }]),
        { use: "alert advice", task: "Advise." },
        { use: "alert advice", task: "Advise.", alerts: 0 },
        // An app-built message as parts: only a user message, only text and typed values.
        {
          use: "alert advice",
          task: "Advise.",
          alerts: 1,
          changes: [{ role: "assistant", parts: ["Alerts."] } as never],
        },
        {
          use: "alert advice",
          task: "Advise.",
          alerts: 1,
          changes: [{ role: "user", parts: ["Lunch: $", { amount: "49.99" } as never] }],
        },
        {
          use: "alert advice",
          task: "Advise.",
          alerts: 1,
          changes: [{ role: "user", parts: ["Alerts."], typed: true } as never],
        },
        { use: "chat", summary: SUMMARY, task: "Answer.", alerts: 1 },
        { use: "chat", summary: ["Spending: ", { amount: "2310.00" } as never], task: "Answer." },
        {
          use: "reading a goal",
          task: "Read.",
          output: z.object({ amount: z.number().optional() }),
        },
        {
          use: "reading a goal",
          task: "Read.",
          output: z.object({ goal: z.object({ note: z.string().optional() }) }),
        },
      ];

      for (const call of refused) await expect(ai.generate(call)).rejects.toThrow(TypeError);
      expect(modelCalls()).toEqual([]);
    });
  });

  describe("app-built text", () => {
    it("sends an app-built message given as parts as one user text, each number as its text", () => {
      const built = buildPrompt({
        use: "alert advice",
        task: "Advise.",
        alerts: 1,
        changes: [
          {
            role: "user",
            parts: ["Lunch: $", typedAmount(4_999), " on ", typedDate("2026-11-09")],
          },
        ],
      });

      expect(built.messages[1]).toEqual({ role: "user", content: "Lunch: $49.99 on 2026-11-09" });
    });

    it("sends each batch row as JSON with no escape the AI would read as other characters", () => {
      const controls = [
        ...Array.from({ length: 0x20 }, (_, code) => code),
        ...Array.from({ length: 0x21 }, (_, code) => 0x7f + code),
        0x2028,
        0x2029,
      ].map((code) => String.fromCharCode(code));
      const hostile = [
        controls.join(""),
        `4111${controls.join("1111")}`,
        "\uD800 lone \uDC00 halves \uDBFF",
        'quotes " and \\ backslashes \\n \\" \\\\t',
        "\u{1F600} é ​ ﻿",
      ];
      const built = buildPrompt(
        categoryFix(hostile.map((memo, index) => ({ memo, [`note\t${index}`]: memo }))),
      );

      const rows = built.messages[1]?.content;
      if (!Array.isArray(rows)) throw new Error("Expected the batch's text parts.");
      expect(rows).toHaveLength(hostile.length);
      for (const part of rows) {
        if (part.type !== "text") throw new Error("Expected a text part.");
        // Only \" and \\ remain: no backslash before a letter or a digit.
        expect(part.text.replace(/\\[\\"]/g, "")).not.toContain("\\");
        expect(JSON.parse(part.text)).toMatchObject({ row: expect.any(Number) });
      }
    });
  });

  describe("model tiers", () => {
    // Spec 08, Model tiers (D44): Chat has its own tier beside Quick and Writer.
    it("puts Chat on the Chat tier, and the other uses that write on the Writer tier", () => {
      expect(USE_TIERS.chat).toBe("chat");
      for (const use of ["insight cards", "monthly review", "budget tailoring"] as const) {
        expect([use, USE_TIERS[use]]).toEqual([use, "writer"]);
      }
      expect(Object.values(USE_TIERS).filter((tier) => tier !== "quick")).toHaveLength(4);
    });

    it("starts each AI provider on its default models", () => {
      expect(DEFAULT_MODELS).toEqual({
        anthropic: {
          quick: "claude-haiku-5-5",
          writer: "claude-opus-5-5",
          chat: "claude-sonnet-5-5",
        },
        openai: { quick: "gpt-6-luna", writer: "gpt-6.1-terra", chat: "gpt-6.1-terra" },
        openrouter: {
          quick: "anthropic/claude-haiku-5.5",
          writer: "anthropic/claude-opus-5.5",
          chat: "anthropic/claude-sonnet-5.5",
        },
        "openai-compatible": undefined,
      });
    });

    it("sends a Chat call to the Chat model, and an Insight cards call to the Writer model", async () => {
      const { ai } = await connect("anthropic");

      await ai.generate({ use: "chat", summary: SUMMARY, task: "Answer." });
      await ai.generate({ use: "insight cards", summary: SUMMARY, task: "Cards." });
      await ai.generate({ use: "reading a goal", task: "Read." });

      expect(modelCalls().map(({ tier, modelId }) => [tier, modelId])).toEqual([
        ["chat", "chat-model"],
        ["writer", "writer-model"],
        ["quick", "quick-model"],
      ]);
    });
  });

  describe("reply limits and effort", () => {
    // Spec 08, Limits on each call and Effort. Quick batches and the Merchant lookup send no effort.
    // The models are in the app's price table, so each use that has an effort sends it.
    it.each([
      [{ use: "category fix", task: TASK, batch: [{ amount: 1 }] }, 12_000, undefined],
      [{ use: "merchant cleanup", task: TASK, batch: [{ amount: 1 }] }, 12_000, undefined],
      [{ use: "unclear transfer", task: TASK, batch: [{ amount: 1 }] }, 12_000, undefined],
      [{ use: "reimbursement linking", task: TASK, batch: [{ amount: 1 }] }, 12_000, undefined],
      [{ use: "merchant lookup", task: "Look up." }, 2_000, undefined],
      [{ use: "reading a goal", task: "Read." }, 2_000, "low"],
      [{ use: "alert advice", task: "Advise.", alerts: 1 }, 1_000, "low"],
      [{ use: "alert advice", task: "Advise.", alerts: 3 }, 3_000, "low"],
      [{ use: "alert advice", task: "Advise.", alerts: 4 }, 4_000, "low"],
      [{ use: "alert advice", task: "Advise.", alerts: 9 }, 4_000, "low"],
      [{ use: "insight cards", summary: SUMMARY, task: "Cards." }, 8_000, "medium"],
      [{ use: "monthly review", summary: SUMMARY, task: "Review." }, 16_000, "medium"],
      [{ use: "budget tailoring", summary: SUMMARY, task: "Tailor." }, 8_000, "medium"],
      [{ use: "chat", summary: SUMMARY, task: "Answer." }, 8_000, "low"],
    ] as [AiCall, number, string | undefined][])(
      "gives %j a limit of %i reply tokens and effort %s",
      async (call, limit, effort) => {
        const { ai } = await connect("anthropic", stub.makeModels, DEFAULT_MODELS.anthropic);

        expect(await ai.generate(call)).toMatchObject({ ready: true });

        expect(
          modelCalls().map(({ maxOutputTokens, effort }) => ({ maxOutputTokens, effort })),
        ).toEqual([{ maxOutputTokens: limit, effort }]);
      },
    );

    // What leaves the app for each AI provider: its own package's option, and no other's.
    const EFFORT_FIELDS = ["output_config", "reasoning_effort", "reasoning", "effort"];
    const effortFields = (body: Record<string, unknown> | undefined) =>
      Object.fromEntries(
        EFFORT_FIELDS.filter((field) => body?.[field] !== undefined).map((field) => [
          field,
          body?.[field],
        ]),
      );

    it.each([
      ["anthropic", { output_config: { effort: "medium" } }],
      ["openai", { reasoning_effort: "medium" }],
      ["openrouter", { reasoning: { effort: "medium" } }],
      ["openai-compatible", {}],
    ] as [AiProviderName, Record<string, unknown>][])(
      "sends %s the effort under its own option name only",
      async (provider, sent) => {
        const { ai } = await connect(
          provider,
          makeFetchModels(capture.fetch),
          DEFAULT_MODELS[provider],
        );

        await ai.generate({ use: "insight cards", summary: SUMMARY, task: "Cards." });
        expect(effortFields(capture.requests.at(-1)?.body)).toEqual(sent);
        // A Quick batch sends none, on every AI provider.
        await ai.generate(categoryFix());
        expect(effortFields(capture.requests.at(-1)?.body)).toEqual({});
      },
    );

    // A model with only a Member's price may refuse the option, and its AI provider the whole call.
    it.each([
      [
        "anthropic",
        { quick: "claude-haiku-4-5", writer: "claude-sonnet-4-5", chat: "claude-opus-4-1" },
      ],
      ["openai", { quick: "gpt-4.1-mini", writer: "gpt-4o", chat: "gpt-4.1" }],
      [
        "openrouter",
        { quick: "openai/gpt-4.1-mini", writer: "openai/gpt-4o", chat: "openai/gpt-4.1" },
      ],
    ] as [AiProviderName, TierModels][])(
      "sends %s no effort for a model with only a Member's price",
      async (provider, models) => {
        const { ai } = await connect(provider, makeFetchModels(capture.fetch), models);

        for (const [call, model] of [
          [{ use: "insight cards", summary: SUMMARY, task: "Cards." }, models.writer],
          [{ use: "chat", summary: SUMMARY, task: "Answer." }, models.chat],
          [{ use: "reading a goal", task: "Read." }, models.quick],
        ] satisfies [AiCall, string][]) {
          expect(await ai.generate(call)).toMatchObject({ ready: true });
          expect(capture.requests.at(-1)?.body).toMatchObject({ model });
          expect(effortFields(capture.requests.at(-1)?.body)).toEqual({});
        }
      },
    );

    it("keeps OpenAI's explicit cache mode beside the effort on a one-shot prompt", async () => {
      const { ai } = await connect("openai", makeFetchModels(capture.fetch), DEFAULT_MODELS.openai);

      await ai.generate({ use: "monthly review", summary: SUMMARY, task: "Review." });

      expect(capture.requests.at(-1)?.body).toMatchObject({
        reasoning_effort: "medium",
        prompt_cache_options: { mode: "explicit" },
      });
    });
  });

  describe("structured replies", () => {
    const cards = z.object({
      cards: z
        .array(z.object({ title: z.string(), goal: z.string().nullable() }))
        .min(4)
        .max(7),
    });
    const card = (title: string) => ({ title, goal: null });

    it("returns a reply that passes its schema", async () => {
      const { ai } = await connect();
      stub.reply = JSON.stringify({ cards: ["A", "B", "C", "D"].map(card) });

      expect(
        await ai.generate({
          use: "insight cards",
          summary: SUMMARY,
          task: "Cards.",
          output: cards,
        }),
      ).toMatchObject({ ready: true, output: { cards: ["A", "B", "C", "D"].map(card) } });
    });

    it.each([
      ["too few cards", JSON.stringify({ cards: ["A", "B", "C"].map(card) })],
      [
        "a missing field",
        JSON.stringify({ cards: [{ title: "A" }, card("B"), card("C"), card("D")] }),
      ],
      ["no JSON", "Here are your cards!"],
    ])("treats a reply with %s as an AI error", async (_, reply) => {
      const { ai } = await connect();
      stub.reply = reply;
      const now = new Date();

      const background = await ai.generate({
        use: "insight cards",
        summary: SUMMARY,
        task: "Cards.",
        output: cards,
      });
      expect(background).toEqual({ ready: false, retryAt: expect.any(Date) });
      if (!("retryAt" in background)) throw new Error("Expected a retry time.");
      expect(background.retryAt.getTime() - now.getTime()).toBeGreaterThanOrEqual(MINUTE);

      expect(
        await ai.generate({
          use: "reading a goal",
          task: "Read.",
          output: z.object({ amount: z.number().nullable() }),
        }),
      ).toEqual({ ready: false, failed: "bad reply" });
    });

    it("checks a Quick batch answers each row once", async () => {
      const { ai } = await connect();
      const batch = [{ merchant: "Bluebird Books" }, { merchant: "Corner Market" }];
      const output = batchReply(z.object({ category: z.string() }), batch.length);
      const answer = (row: number) => ({ row, category: "Groceries" });

      for (const answers of [[answer(1)], [answer(1), answer(1)], [answer(1), answer(3)]]) {
        expect(output.safeParse({ answers }).success).toBe(false);
      }
      expect(output.safeParse({ answers: [answer(2), answer(1)] }).success).toBe(true);

      // The call path keeps each good row: a repeated row and one outside the batch have none.
      stub.reply = JSON.stringify({ answers: [answer(1), answer(3)] });
      expect(await ai.generate({ ...categoryFix(batch), output })).toMatchObject({
        ready: true,
        output: { answers: [answer(1)] },
      });
      stub.reply = JSON.stringify({ answers: [answer(1), answer(1)] });
      expect(await ai.generate({ ...categoryFix(batch), output })).toEqual({
        ready: false,
        failed: "bad reply",
        badReply: true,
      });
      expect(await readAiRetry(test.database, "category fix")).toBeUndefined();
    });
  });

  // Spec 08, Limits on each call and Failures: a Quick batch keeps each good row, sends the rest
  // once more in batches of half the size, and a bad reply is not an outage.
  describe("Quick batches, row by row", () => {
    const ROW_ANSWER = z.object({ category: z.enum(["Groceries", "Dining out"]) });
    const shops = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ merchant: `Shop ${index + 1}` }));
    // The batch rows each call's model read, as JSON objects.
    const rowsOf = (prompt: StubMessage[]) =>
      prompt.flatMap((message) =>
        typeof message.content === "string"
          ? []
          : message.content.flatMap((part) =>
              part.text?.startsWith('{"row":') === true
                ? [JSON.parse(part.text) as { row: number; merchant: string }]
                : [],
            ),
      );
    const batchCalls = () => stub.prompts.slice(3).map(rowsOf);
    const askAll = (ai: ReturnType<typeof householdAi>, items: { merchant: string }[]) =>
      generateBatch(ai, items, (asked) => ({
        use: "category fix",
        task: TASK,
        batch: asked,
        output: batchReply(ROW_ANSWER, asked.length),
      }));
    // Each row answered Groceries, unless `change` changes the answers of the call.
    const answering = (
      change: (answers: Record<string, unknown>[], call: number) => unknown[] = (answers) =>
        answers,
    ) => {
      let call = 0;
      stub.replyTo = (messages) => {
        const answers = rowsOf(messages as StubMessage[]).map(({ row }) => ({
          row,
          category: "Groceries",
        }));
        call += 1;
        return JSON.stringify({ answers: change(answers, call) });
      };
    };

    it.each([
      ["missing", (answers: Record<string, unknown>[]) => answers.filter(({ row }) => row !== 37)],
      [
        "repeated",
        (answers: Record<string, unknown>[]) => [...answers, { row: 37, category: "Groceries" }],
      ],
      [
        "outside the batch",
        (answers: Record<string, unknown>[]) =>
          answers.map((each) => (each.row === 37 ? { ...each, row: 101 } : each)),
      ],
      [
        "failing its schema",
        (answers: Record<string, unknown>[]) =>
          answers.map((each) => (each.row === 37 ? { ...each, category: "Snacks" } : each)),
      ],
    ])(
      "keeps 99 answers of 100 when one row is %s, and asks that row again alone",
      async (_, bad) => {
        const { ai } = await connect();
        answering((answers, call) => (call === 1 ? bad(answers) : answers));
        const items = shops(100);

        const reply = await askAll(ai, items);

        if (!reply.ready) throw new Error("Expected answers.");
        expect(reply.output.answers.map(({ row }) => row).sort((a, b) => a - b)).toEqual(
          items.map((_, index) => index + 1),
        );
        const [first, again] = batchCalls();
        expect(first).toHaveLength(100);
        // The one row goes alone, through the same call path: the same row, renumbered.
        expect(again).toEqual([{ row: 1, merchant: "Shop 37" }]);
        expect(batchCalls()).toHaveLength(2);
        expect(await readAiRetry(test.database, "category fix")).toBeUndefined();
      },
    );

    it("leaves a row still bad after its second try with no answer, and makes no third", async () => {
      const { ai } = await connect();
      answering((answers) =>
        answers.map((each) =>
          rowsOf(stub.prompts.at(-1) ?? []).find(({ row }) => row === each.row)?.merchant ===
          "Shop 37"
            ? { ...each, category: "Snacks" }
            : each,
        ),
      );

      const reply = await askAll(ai, shops(100));

      if (!reply.ready) throw new Error("Expected answers.");
      expect(reply.output.answers).toHaveLength(99);
      expect(reply.output.answers.some(({ row }) => row === 37)).toBe(false);
      expect(batchCalls().map((rows) => rows.length)).toEqual([100, 1]);
      expect(await readAiRedo(test.database)).toMatchObject({ awayAt: null });
    });

    it("sends a reply cut off at its limit again as two halves, and logs why it ended", async () => {
      const { ai } = await connect();
      // A cut-off reply gives nothing usable, even rows that parse.
      answering((answers, call) => {
        stub.finishReason = call === 1 ? "length" : "stop";
        return call === 1 ? answers.slice(0, 60) : answers;
      });

      const reply = await askAll(ai, shops(100));

      if (!reply.ready) throw new Error("Expected answers.");
      expect(reply.output.answers).toHaveLength(100);
      expect(batchCalls().map((rows) => rows.length)).toEqual([100, 50, 50]);
      expect(batchCalls()[1]?.[0]).toEqual({ row: 1, merchant: "Shop 1" });
      expect(batchCalls()[2]?.[0]).toEqual({ row: 1, merchant: "Shop 51" });
      const failed = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.msg === "An AI call failed");
      expect(failed).toEqual([
        expect.objectContaining({
          use: "category fix",
          failure: "bad reply",
          status: null,
          finishReason: "length",
        }),
      ]);
      // Never the prompt or the reply.
      expect(lines.join("\n")).not.toMatch(/Shop|Groceries/);
    });

    it("counts a bad reply as no outage until the third in a row, which is an AI error", async () => {
      const { ai } = await connect();
      stub.reply = "Here are your answers!";
      const call = () => ai.generate({ ...categoryFix(), output: batchReply(ROW_ANSWER, 1) });
      const bad = { ready: false, failed: "bad reply", badReply: true };

      for (let inARow = 1; inARow < BAD_REPLIES_IN_A_ROW; inARow += 1) {
        expect(await call()).toEqual(bad);
      }
      expect(await readAiRetry(test.database, "category fix")).toBeUndefined();
      expect(await readAiRedo(test.database)).toMatchObject({ awayAt: null });
      // A reply that works ends the row.
      stub.reply = JSON.stringify({ answers: [{ row: 1, category: "Groceries" }] });
      expect(await call()).toMatchObject({ ready: true });
      stub.reply = "Here are your answers!";
      for (let inARow = 1; inARow < BAD_REPLIES_IN_A_ROW; inARow += 1) {
        expect(await call()).toEqual(bad);
      }
      expect(await call()).toEqual({ ready: false, retryAt: expect.any(Date) });
      expect(await readAiRetry(test.database, "category fix")).toMatchObject({ failures: 1 });
      expect(await readAiRedo(test.database)).toMatchObject({ awayReason: "outage" });
      // A use that does not run in Quick batches keeps its retries for a bad reply.
      expect(
        await ai.generate({
          use: "insight cards",
          summary: SUMMARY,
          task: "Cards.",
          output: z.object({ cards: z.array(z.string()) }),
        }),
      ).toEqual({ ready: false, retryAt: expect.any(Date) });
    });

    it("stops a batch to a model that always answers badly after three calls, on the retry path", async () => {
      const { ai } = await connect();
      stub.reply = "Here are your answers!";

      expect(await askAll(ai, shops(100))).toEqual({ ready: false, retryAt: expect.any(Date) });
      expect(batchCalls().map((rows) => rows.length)).toEqual([100, 50, 50]);
      // Until the retry, the use makes no call.
      expect(await askAll(ai, shops(100))).toEqual({ ready: false, retryAt: expect.any(Date) });
      expect(batchCalls()).toHaveLength(3);
    });
  });

  describe("AI errors", () => {
    it("ends a call with no reply after 120 seconds as a timeout", async () => {
      const { ai } = await connect();
      stub.answers.chat = "hang";
      let answering = () => {};
      const called = new Promise<void>((resolve) => {
        answering = resolve;
      });
      stub.beforeAnswer = async () => answering();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      let reply: unknown;
      const call = ai.generate({ use: "chat", summary: SUMMARY, task: "Answer." }).then((made) => {
        reply = made;
      });
      await called;
      await vi.advanceTimersByTimeAsync(119_999);
      expect(reply).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      await call;
      expect(reply).toEqual({ ready: false, failed: "timeout" });
    });

    it.each([
      ["rate limit", "rate limit", 429],
      // Only Test the key names a 404 (spec 08, Test the key).
      ["unknown model", "server error", 404],
      ["fail", "server error", 500],
    ] as const)("treats a %s answer as a %s", async (answer, failure, status) => {
      const { ai } = await connect();
      stub.answers.quick = answer;

      expect(await ai.generate(readingAGoal)).toEqual({ ready: false, failed: failure });
      expect(lines.map((line) => JSON.parse(line))).toContainEqual(
        expect.objectContaining({
          msg: "An AI call failed",
          use: "reading a goal",
          failure,
          status,
        }),
      );
    });

    it("treats a 408 as a timeout", async () => {
      const { ai } = await connect("anthropic", makeFetchModels(capture.fetch));
      capture.status = 408;

      expect(await ai.generate(readingAGoal)).toEqual({ ready: false, failed: "timeout" });
    });

    it("treats a fetch that fails to connect as a network failure", async () => {
      let refuse = false;
      const fetchOrFail: typeof fetch = async (input, init) => {
        if (!refuse) return capture.fetch(input, init);
        throw Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
        });
      };
      const { ai } = await connect("anthropic", makeFetchModels(fetchOrFail));
      refuse = true;

      expect(await ai.generate(readingAGoal)).toEqual({ ready: false, failed: "network" });
    });

    it("never retries Chat or reading a Goal by itself", async () => {
      const { ai } = await connect();
      stub.answers = { quick: "fail", writer: "fail", chat: "fail" };

      expect(await ai.generate(readingAGoal)).toEqual({ ready: false, failed: "server error" });
      expect(await ai.generate({ use: "chat", summary: SUMMARY, task: "Answer." })).toEqual({
        ready: false,
        failed: "server error",
      });
      // "Try again" calls at once.
      expect(await ai.generate(readingAGoal)).toEqual({ ready: false, failed: "server error" });

      expect(modelCalls()).toHaveLength(3);
      expect(await readAiRetry(test.database, "chat")).toBeUndefined();
      expect(await readAiRetry(test.database, "reading a goal")).toBeUndefined();
    });

    it("logs no prompt or reply text", async () => {
      const { ai } = await connect();
      stub.reply = "Your secret reply text.";
      await ai.generate({ use: "chat", summary: SUMMARY, task: "Answer the private question." });
      stub.answers = { quick: "fail", writer: "rate limit", chat: "rate limit" };
      await ai.generate({ use: "chat", summary: SUMMARY, task: "Answer the private question." });
      await ai.generate(categoryFix());

      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        for (const text of [SUMMARY, "private question", "secret reply", "Bluebird", FIXED_RULES]) {
          expect(line).not.toContain(text);
        }
      }
    });
  });

  describe("background retries", () => {
    it("tries again after 1, 5, and 30 minutes, then takes the no-AI path", async () => {
      const { ai } = await connect();
      stub.answers.quick = "rate limit";
      const start = new Date("2026-11-04T15:00:00Z").getTime();
      vi.useFakeTimers({ toFake: ["Date"], now: start });
      const at = (ms: number) => vi.setSystemTime(start + ms);

      expect(await ai.generate(categoryFix())).toEqual({
        ready: false,
        retryAt: new Date(start + MINUTE),
      });
      expect(modelCalls()).toHaveLength(1);

      // Not due yet: the step finds its own retry time and makes no call.
      at(59_999);
      expect(await ai.generate(categoryFix())).toEqual({
        ready: false,
        retryAt: new Date(start + MINUTE),
      });
      expect(modelCalls()).toHaveLength(1);

      at(MINUTE);
      expect(await ai.generate(categoryFix())).toEqual({
        ready: false,
        retryAt: new Date(start + 6 * MINUTE),
      });
      at(6 * MINUTE);
      expect(await ai.generate(categoryFix())).toEqual({
        ready: false,
        retryAt: new Date(start + 36 * MINUTE),
      });
      at(36 * MINUTE);
      expect(await ai.generate(categoryFix())).toEqual({ ready: false, failed: "rate limit" });
      expect(modelCalls()).toHaveLength(4);
      expect(await readAiRetry(test.database, "category fix")).toBeUndefined();
      expect(RETRY_DELAYS_MS).toEqual([MINUTE, 5 * MINUTE, 30 * MINUTE]);

      // A later call starts a new round.
      expect(await ai.generate(categoryFix())).toEqual({
        ready: false,
        retryAt: new Date(start + 37 * MINUTE),
      });
    });

    it("waits for no retry after a call that works", async () => {
      const { ai } = await connect();
      stub.answers.quick = "fail";
      const start = Date.now();
      vi.useFakeTimers({ toFake: ["Date"], now: start });

      await ai.generate(categoryFix());
      vi.setSystemTime(start + MINUTE);
      stub.answers.quick = "work";
      expect(await ai.generate(categoryFix())).toMatchObject({ ready: true });

      expect(await readAiRetry(test.database, "category fix")).toBeUndefined();
      stub.answers.quick = "fail";
      expect(await ai.generate(categoryFix())).toEqual({
        ready: false,
        retryAt: new Date(start + 2 * MINUTE),
      });
    });

    it("keeps each use's retry time apart", async () => {
      const { ai } = await connect();
      stub.answers.quick = "fail";

      await ai.generate(categoryFix());
      stub.answers.quick = "work";

      expect(
        await ai.generate({ use: "merchant cleanup", task: TASK, batch: [{ amount: 1 }] }),
      ).toMatchObject({ ready: true });
    });

    it("asks for each use's work once for each retry time, including one missed while the app was down", async () => {
      const { ai } = await connect();
      stub.answers.quick = "fail";
      const asked: string[] = [];
      const retries = startAiRetries({
        database: test.database,
        runners: {
          "category fix": async () => {
            asked.push("category fix");
          },
        },
      });
      try {
        const start = Date.now();
        vi.useFakeTimers({ toFake: ["Date"], now: start });
        await ai.generate(categoryFix());

        expect(await runAiRetries(new Date(start + MINUTE - 1))).toEqual([]);
        // The app was down at the retry time: the tick at start runs it.
        const started = new Date(start + 45 * MINUTE);
        expect(await runAiRetries(started)).toEqual(["category fix"]);
        expect(await runAiRetries(started)).toEqual([]);
        expect(await runAiRetries(new Date(start + 46 * MINUTE))).toEqual([]);
        expect(asked).toEqual(["category fix"]);

        // The next failure has its own retry time, asked for once.
        vi.setSystemTime(started);
        expect(await ai.generate(categoryFix())).toEqual({
          ready: false,
          retryAt: new Date(started.getTime() + 5 * MINUTE),
        });
        expect(await runAiRetries(new Date(started.getTime() + 5 * MINUTE))).toEqual([
          "category fix",
        ]);
        expect(asked).toEqual(["category fix", "category fix"]);
      } finally {
        retries.stop();
      }
    });

    it("asks once when two ticks find the same retry due", async () => {
      const { ai } = await connect();
      stub.answers.quick = "fail";
      let asked = 0;
      const retries = startAiRetries({
        database: test.database,
        runners: {
          "category fix": async () => {
            asked += 1;
          },
        },
      });
      try {
        const start = Date.now();
        vi.useFakeTimers({ toFake: ["Date"], now: start });
        await ai.generate(categoryFix());

        const due = new Date(start + MINUTE);
        const started = await Promise.all([runAiRetries(due), runAiRetries(due)]);

        expect(started.flat()).toEqual(["category fix"]);
        expect(asked).toBe(1);
      } finally {
        retries.stop();
      }
    });

    it("asks once even when the work fails to start", async () => {
      const { ai } = await connect();
      stub.answers.quick = "fail";
      let tries = 0;
      const retries = startAiRetries({
        database: test.database,
        runners: {
          "category fix": async () => {
            tries += 1;
            throw new Error("The jobs database is closed.");
          },
        },
      });
      try {
        const start = Date.now();
        vi.useFakeTimers({ toFake: ["Date"], now: start });
        await ai.generate(categoryFix());

        expect(await runAiRetries(new Date(start + MINUTE))).toEqual([]);
        expect(await runAiRetries(new Date(start + 2 * MINUTE))).toEqual([]);
        expect(tries).toBe(1);
      } finally {
        retries.stop();
      }
    });
  });

  describe("a rejected key", () => {
    it.each([
      ["category fix", "quick"],
      ["chat", "chat"],
    ] as const)(
      "pauses AI after a 401 for %s, with one System notice and no retry",
      async (use, tier) => {
        const { ai, settings } = await connect();
        stub.answers[tier] = "reject";
        const call: AiCall =
          use === "chat" ? { use, summary: SUMMARY, task: "Answer." } : categoryFix();

        expect(await ai.generate(call)).toEqual({ ready: false, pause: "key rejected" });
        expect(await settings.view()).toMatchObject({ status: { state: "key rejected" } });
        expect(raised).toEqual([KEY_REJECTED_CONDITION]);
        expect(await readAiRetry(test.database, use)).toBeUndefined();

        // Paused: no call goes out, for any use, and no second notice.
        expect(await ai.generate(categoryFix())).toEqual({ ready: false, pause: "key rejected" });
        expect(await ai.generate(readingAGoal)).toEqual({ ready: false, pause: "key rejected" });
        expect(modelCalls()).toHaveLength(1);
        expect(raised).toHaveLength(1);

        // A Member saves a key that works: the notice ends, and AI calls again.
        stub.answers = { quick: "work", writer: "work", chat: "work" };
        expect(await settings.save(settingsFor("anthropic"))).toMatchObject({
          saved: true,
        });
        expect(ended).toEqual([KEY_REJECTED_CONDITION]);
        expect(await ai.generate(readingAGoal)).toMatchObject({ ready: true });
      },
    );

    it("keeps AI paused, with its System notice, after a save whose check only failed, until a key that works is saved", async () => {
      const { ai, settings } = await connect();
      stub.answers.quick = "reject";
      expect(await ai.generate(categoryFix())).toEqual({ ready: false, pause: "key rejected" });
      expect(raised).toEqual([KEY_REJECTED_CONDITION]);
      const storedKey = async () =>
        (await test.database.$client.execute("SELECT api_key FROM ai_settings")).rows[0]?.api_key;
      const before = await storedKey();

      // A network error on each check says nothing about the key.
      stub.answers = { quick: "throw", writer: "throw", chat: "throw" };
      expect(await settings.save(settingsFor("anthropic"))).toMatchObject({
        saved: true,
        check: { quick: "failed", writer: "failed", chat: "failed" },
        ai: { status: { state: "key rejected" } },
      });
      expect(await storedKey()).not.toEqual(before);
      expect(ended).toEqual([]);
      expect(await ai.generate(readingAGoal)).toEqual({ ready: false, pause: "key rejected" });
      expect(modelCalls()).toHaveLength(1 + 3);

      // One tier's check works: the key works, and the notice ends.
      stub.answers = { quick: "work", writer: "throw", chat: "throw" };
      expect(await settings.save(settingsFor("anthropic"))).toMatchObject({
        saved: true,
        ai: { status: { state: "on" } },
      });
      expect(ended).toEqual([KEY_REJECTED_CONDITION]);
      expect(await ai.generate(readingAGoal)).toMatchObject({ ready: true });
    });

    it("raises one System notice when two calls fail with a rejected key at once", async () => {
      const { ai } = await connect();
      stub.answers.quick = "reject";
      let arrived = 0;
      let bothIn = () => {};
      const both = new Promise<void>((resolve) => {
        bothIn = resolve;
      });
      stub.beforeAnswer = async () => {
        arrived += 1;
        if (arrived === 2) bothIn();
        await both;
      };

      const replies = await Promise.all([
        ai.generate(categoryFix()),
        ai.generate({ use: "merchant cleanup", task: TASK, batch: [{ amount: 1 }] }),
      ]);

      expect(replies).toEqual([
        { ready: false, pause: "key rejected" },
        { ready: false, pause: "key rejected" },
      ]);
      expect(raised).toEqual([KEY_REJECTED_CONDITION]);
    });

    it("treats a 403 as a rejected key", async () => {
      const { ai, settings } = await connect("anthropic", makeFetchModels(capture.fetch));
      capture.status = 403;

      expect(await ai.generate(readingAGoal)).toEqual({ ready: false, pause: "key rejected" });
      expect(await settings.view()).toMatchObject({ status: { state: "key rejected" } });
    });

    it("never marks a key a Member saved while the call that failed was out", async () => {
      const { ai, settings } = await connect();
      stub.answers.quick = "reject";
      let saving = false;
      stub.beforeAnswer = async () => {
        if (saving) return;
        saving = true;
        stub.answers.quick = "work";
        await settings.save(settingsFor("anthropic"));
        stub.answers.quick = "reject";
      };

      expect(await ai.generate(categoryFix())).toEqual({ ready: false, pause: "key rejected" });

      expect(await settings.view()).toMatchObject({ status: { state: "on" } });
      expect(raised).toEqual([]);
    });

    it("ends the notice when a Member removes the AI provider", async () => {
      const { ai, settings } = await connect();
      stub.answers.quick = "reject";
      await ai.generate(readingAGoal);

      await settings.remove();

      expect(ended).toEqual([KEY_REJECTED_CONDITION]);
    });
  });

  describe("text for the screen", () => {
    it.each([
      ["Great job! You saved $40!", "Great job. You saved $40."],
      ["Wow!!! 🎉 Dining out fell 12%. 👍🏽", "Wow. Dining out fell 12%."],
      ["Really?! Groceries rose 8% 🛒.", "Really? Groceries rose 8%."],
      ["Family 👨‍👩‍👧 spending: $2,310 🇺🇸", "Family spending: $2,310"],
      ["Keycap 1️⃣ first: pay the card", "Keycap first: pay the card"],
      ["  - Rent: $1,800 ✅\n  - Dining out: $310 ❗", "  - Rent: $1,800\n  - Dining out: $310"],
      ["Wide ！ mark", "Wide . mark"],
      ["Plain text, $1.50, stays.", "Plain text, $1.50, stays."],
    ])("turns %j into %j", (written, shown) => {
      expect(plainVoice(written)).toBe(shown);
    });

    it("shows AI text in the plain voice", async () => {
      const { ai } = await connect();

      expect(await ai.forScreen("Nice! 🎉 Spending fell 4%.")).toBe("Nice. Spending fell 4%.");
    });
  });

  it("carries the plain voice in the fixed rules, with no tone or length setting", () => {
    for (const rule of [
      /facts? first/i,
      /number or an action/i,
      /moraliz/i,
      /Not a problem/,
      /active Goal/,
      /Catch:/,
      /assumed/i,
    ]) {
      expect(FIXED_RULES).toMatch(rule);
    }
  });
});
