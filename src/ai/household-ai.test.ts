import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { readAiRedo, readAiRetry } from "../db/index.ts";
import { createLogger } from "../log.ts";
import type { AiProviderName, AiSettingsInput } from "./ai-view.ts";
import { type AiCost, aiCost } from "./cost.ts";
import { BAD_REPLIES_IN_A_ROW, generateBatch, householdAi } from "./household-ai.ts";
import { MEMBER_TYPED } from "./privacy.ts";
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

  const settingsFor = (provider: AiProviderName): AiSettingsInput => ({
    provider,
    apiKey: newAiKey(),
    baseUrl: null,
    quickModel: "quick-model",
    writerModel: "writer-model",
    prices: { quick: PRICE, writer: PRICE },
  });

  async function connect(
    provider: AiProviderName = "anthropic",
    makeModels: AiModelMaker = stub.makeModels,
  ) {
    const settings = aiSettings(options(makeModels));
    expect(await settings.save(settingsFor(provider))).toMatchObject({
      saved: true,
    });
    return { ai: householdAi(options(makeModels)), settings };
  }

  const categoryFix = (batch: AiCall["batch"] = [{ merchant: "Bluebird Books", amount: -12.5 }]) =>
    ({ use: "category fix", task: TASK, batch }) satisfies AiCall;
  const readingAGoal: AiCall = { use: "reading a goal", task: "Read this Goal." };

  // The calls the test models were given, after the two checks on save.
  const modelCalls = () => stub.calls.slice(2);

  describe("prompt order and cache marks", () => {
    it("sends the fixed rules, then the summary, the task, and the changes, with Chat's mark after the summary", async () => {
      const { ai } = await connect("anthropic", makeFetchModels(capture.fetch));

      await ai.generate({
        use: "chat",
        summary: SUMMARY,
        task: "Answer the Member's question.",
        changes: [
          { role: "user", text: "How much did we spend on groceries?", typed: true },
          { role: "assistant", text: "$412 in October." },
          { role: "user", text: "And in September?", typed: true },
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
        { use: "chat", summary: [SUMMARY, 2310 as never], task: "Answer." },
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
    const typedMark = Object.keys(MEMBER_TYPED)[0] ?? "";
    const marked = (built: ReturnType<typeof buildPrompt>) =>
      built.messages.map((message) => typedMark in (message.providerOptions ?? {}));

    it("marks only the changes a Member typed as typed: never the summary, task, or batch", () => {
      const changes = [
        { role: "user" as const, text: "Typed by a Member.", typed: true },
        { role: "assistant" as const, text: "Built by the app." },
        { role: "user" as const, text: "Also built by the app.", typed: false },
      ];

      const chat = buildPrompt({ use: "chat", summary: SUMMARY, task: "Answer.", changes });
      expect(marked(chat)).toEqual([false, false, true, false, false]);

      const batch = buildPrompt({ ...categoryFix(), changes });
      expect(marked(batch)).toEqual([false, false, true, false, false]);

      const advice = buildPrompt({ use: "alert advice", task: "Advise.", alerts: 2, changes });
      expect(marked(advice)).toEqual([false, true, false, false]);
    });

    it("sends an app-built message given as parts as one user message, with each typed value marked for the filter", () => {
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

      expect(marked(built)).toEqual([false, false]);
      const content = built.messages[1]?.content;
      if (!Array.isArray(content)) throw new Error("Expected the message's text parts.");
      expect(content.map((part) => (part.type === "text" ? part.text : ""))).toEqual([
        "Lunch: $",
        "49.99",
        " on ",
        "2026-11-09",
      ]);
      expect(
        content.map(
          (part) => part.type === "text" && part.providerOptions?.privacyFilter !== undefined,
        ),
      ).toEqual([false, true, false, true]);
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

  describe("reply limits", () => {
    it.each([
      [{ use: "category fix", task: TASK, batch: [{ amount: 1 }] }, 6_000],
      [{ use: "merchant cleanup", task: TASK, batch: [{ amount: 1 }] }, 6_000],
      [{ use: "reading a goal", task: "Read." }, 300],
      [{ use: "alert advice", task: "Advise.", alerts: 1 }, 300],
      [{ use: "alert advice", task: "Advise.", alerts: 3 }, 900],
      [{ use: "alert advice", task: "Advise.", alerts: 4 }, 1_200],
      [{ use: "alert advice", task: "Advise.", alerts: 9 }, 1_200],
      [{ use: "insight cards", summary: SUMMARY, task: "Cards." }, 1_000],
      [{ use: "monthly review", summary: SUMMARY, task: "Review." }, 4_000],
      [{ use: "budget tailoring", summary: SUMMARY, task: "Tailor." }, 1_500],
      [{ use: "chat", summary: SUMMARY, task: "Answer." }, 1_500],
    ] as [AiCall, number][])("gives %j a limit of %i reply tokens", async (call, limit) => {
      const { ai } = await connect();

      expect(await ai.generate(call)).toMatchObject({ ready: true });

      expect(modelCalls().map((made) => made.maxOutputTokens)).toEqual([limit]);
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
    const batchCalls = () => stub.prompts.slice(2).map(rowsOf);
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
      stub.answers.writer = "hang";
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
      stub.answers = { quick: "fail", writer: "fail" };

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
      stub.answers = { quick: "fail", writer: "rate limit" };
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
      ["chat", "writer"],
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
        stub.answers = { quick: "work", writer: "work" };
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
      stub.answers = { quick: "throw", writer: "throw" };
      expect(await settings.save(settingsFor("anthropic"))).toMatchObject({
        saved: true,
        check: { quick: "failed", writer: "failed" },
        ai: { status: { state: "key rejected" } },
      });
      expect(await storedKey()).not.toEqual(before);
      expect(ended).toEqual([]);
      expect(await ai.generate(readingAGoal)).toEqual({ ready: false, pause: "key rejected" });
      expect(modelCalls()).toHaveLength(1 + 2);

      // One tier's check works: the key works, and the notice ends.
      stub.answers = { quick: "work", writer: "throw" };
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

    it("shows each Member's name in place of their label, in the plain voice", async () => {
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
