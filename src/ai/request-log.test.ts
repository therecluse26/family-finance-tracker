import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as z from "zod";
import {
  addAiRequestLogEntry,
  addUnconnectedAccount,
  deleteChatThread,
  deleteRemovedConnection,
  loginTables,
  readAiRequestLogSettings,
  storeChatThread,
} from "../db/index.ts";
import {
  AI_REQUEST_LOG_KEEP_DAYS as STORED_DAYS,
  AI_REQUEST_FAILURES as STORED_FAILURES,
} from "../db/schema.ts";
import { saveHouseholdFacts } from "../household/index.ts";
import { scheduledTasks } from "../jobs/list.ts";
import { createLogger } from "../log.ts";
import type { AiProviderName } from "./ai-view.ts";
import { type AiCost, aiCost } from "./cost.ts";
import { householdAi } from "./household-ai.ts";
import { type AiCall, aiTool } from "./prompt.ts";
import { type AiModelMaker, makeFetchModels } from "./providers.ts";
import {
  AI_REQUEST_LOG_CLEANUP_BATCH,
  AI_REQUEST_LOG_CLEANUP_CAP,
  AI_REQUEST_LOG_CLEANUP_STOPPED,
  AI_REQUEST_LOG_MAX_BYTES,
  AI_REQUEST_LOG_PAGE,
  AiRequestLogCleanupJob,
  aiRequestLogRoutes,
  CUT_AT_LIMIT,
  cleanUpAiRequestLog,
  cutText,
  HIDDEN_REASONING,
  replyText,
  startAiRequestLogCleanup,
} from "./request-log.ts";
import {
  AI_REQUEST_FAILURES,
  AI_REQUEST_LOG_KEEP_DAYS,
  AI_REQUEST_TEXT_LIMIT_BYTES,
  type AiRequestLogKeepDays,
} from "./request-log-view.ts";
import { aiSettings } from "./settings.ts";
import { CapturingFetch, newAiKey, newTestAi, StubModels, type TestAi } from "./testing.ts";

// The AI request log (spec 08, AI request log), through the one AI call path, on AI SDK test models
// and a fetch that captures each request. No test calls an AI provider. Names, numbers, and keys
// are made up; each key is made when the test runs.

const PRICE = { input: 1_000_000, output: 2_000_000 };
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-06T15:00:00.000Z");

type Row = Record<string, unknown>;

describe("the AI request log", () => {
  let test: TestAi;
  let cost: AiCost;
  let stub: StubModels;
  let apiKey: string;
  let lines: string[];
  let raised: string[];
  let ended: string[];
  let clock: Date;

  beforeEach(async () => {
    test = await newTestAi();
    cost = aiCost({ database: test.database });
    stub = new StubModels();
    apiKey = newAiKey();
    lines = [];
    raised = [];
    ended = [];
    clock = NOW;
    const joined = new Date("2026-01-02T00:00:00Z");
    await test.database.insert(loginTables.user).values({
      id: "m1",
      name: "Dana Whitfield",
      email: "dana.w@example.com",
      createdAt: joined,
      updatedAt: joined,
    });
    await addUnconnectedAccount(test.database, {
      subtype: "savings",
      institutionName: "Ally",
      name: "Rainy day fund",
      mask: "4821",
    });
    await saveHouseholdFacts(
      test.database,
      { zipCode: "10001", ages: [41, 8], rentOrOwn: "own" },
      "m1",
    );
  });

  afterEach(() => {
    test.close();
  });

  const logger = () => createLogger((line) => lines.push(line), { throwOnSecretField: true });
  const notices = {
    raise: async (notice: { condition?: string; text: string }) => {
      raised.push(notice.condition ?? notice.text);
    },
    end: async (condition: string) => {
      ended.push(condition);
    },
  };
  const routes = () =>
    aiRequestLogRoutes({ database: test.database, now: () => clock, notices, logger: logger() });
  const turn = (on: boolean, keepDays: AiRequestLogKeepDays = 30) => routes().set({ on, keepDays });

  const options = (makeModels: AiModelMaker) => ({
    database: test.database,
    secrets: test.secrets,
    makeModels,
    cost,
    logger: logger(),
    notices,
  });

  async function connect(
    provider: AiProviderName = "anthropic",
    makeModels: AiModelMaker = stub.makeModels,
  ) {
    expect(
      await aiSettings(options(makeModels)).save({
        provider,
        apiKey,
        baseUrl: null,
        quickModel: "quick-model",
        writerModel: "writer-model",
        prices: { quick: PRICE, writer: PRICE },
      }),
    ).toMatchObject({ saved: true });
    return householdAi(options(makeModels));
  }

  const categoryFix: AiCall = {
    use: "category fix",
    task: "Suggest a Category for each Transaction.",
    batch: [
      { merchant: "Bluebird Books", amount: -12.5 },
      { merchant: "VENMO *DANA WHITFIELD", account: "Ally XXXX4821", amount: -40 },
    ],
  };

  const rows = async (): Promise<Row[]> =>
    (await test.database.$client.execute("SELECT * FROM ai_request_log ORDER BY id")).rows.map(
      (row) => ({ ...row }),
    );
  const aiCallCount = async () =>
    Number(
      (await test.database.$client.execute("SELECT count(*) AS n FROM ai_calls")).rows[0]?.n ?? 0,
    );
  const onlyEntry = async () => {
    const page = await routes().page({});
    expect(page.entries).toHaveLength(1);
    const entry = await routes().entry(page.entries[0]?.id ?? 0);
    if (entry === undefined) throw new Error("No kept call.");
    return entry;
  };

  // What a call that starts now notes: the cap, the switch-offs so far, and the size cap.
  const keeping = async (maxBytes = AI_REQUEST_LOG_MAX_BYTES) => ({
    cleanupCap: AI_REQUEST_LOG_CLEANUP_CAP,
    switchOffs: (await readAiRequestLogSettings(test.database)).switchOffs,
    maxBytes,
  });

  // A kept call, written straight to app.db, at `at`.
  async function keep(
    at: Date,
    extra: { chatThreadId?: string; request?: string; maxBytes?: number } = {},
  ): Promise<boolean> {
    return addAiRequestLogEntry(
      test.database,
      {
        at,
        aiCallId: null,
        chatThreadId: extra.chatThreadId ?? null,
        use: "category fix",
        model: "quick-model",
        request: extra.request ?? "{}",
        requestCut: false,
        response: "Groceries",
        responseCut: false,
        failure: null,
        failureStatus: null,
      },
      await keeping(extra.maxBytes),
    );
  }

  // `count` kept calls in one statement, one a minute back from `newest`.
  async function keepMany(count: number, newest: Date): Promise<void> {
    await test.database.$client.execute({
      sql: `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?)
        INSERT INTO ai_request_log (at, use, model, bytes, request, request_cut, response, response_cut)
        SELECT strftime('%Y-%m-%dT%H:%M:%fZ', ?, '-' || i || ' minutes'), 'category fix',
          'quick-model', 11, '{}', 0, 'Groceries', 0
        FROM n ORDER BY i DESC`,
      args: [count, newest.toISOString()],
    });
  }

  it("names the same kept days and failures as app.db", () => {
    expect([...AI_REQUEST_LOG_KEEP_DAYS]).toEqual([...STORED_DAYS]);
    expect([...AI_REQUEST_FAILURES]).toEqual([...STORED_FAILURES]);
  });

  it("is off for 30 days by default, keeps nothing while off, and leaves the AI usage page as it was", async () => {
    const ai = await connect();
    expect((await routes().page({})).settings).toEqual({ on: false, keepDays: 30, stopped: false });

    expect(await ai.generate(categoryFix)).toMatchObject({ ready: true });

    expect(await rows()).toEqual([]);
    const usage = await cost.usage();
    expect(usage.calls).toHaveLength(3);
    for (const call of usage.calls) expect(call).not.toHaveProperty("logEntryId");
  });

  it("keeps the request as the AI provider got it and the reply, linked to the call's AI usage row", async () => {
    stub.reply = "Dana bought books: Books and magazines.";
    const ai = await connect();
    await turn(true);

    expect(await ai.generate(categoryFix)).toMatchObject({ ready: true });

    const entry = await onlyEntry();
    expect(entry).toMatchObject({
      use: "category fix",
      model: "quick-model",
      failure: null,
      failureStatus: null,
      requestCut: false,
      response: "Dana bought books: Books and magazines.",
      responseCut: false,
      usage: { noCacheTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1 },
    });
    // The request is the one the AI provider got, as JSON: the name and last 4 as they are.
    const request = JSON.parse(entry.request) as { prompt: unknown[] };
    expect(request.prompt.length).toBeGreaterThan(1);
    expect(entry.request).toContain("VENMO *DANA WHITFIELD");
    expect(entry.request).toContain("Ally XXXX4821");
    expect(entry.request).toContain("Bluebird Books");
    // Compact JSON: the page indents it for reading.
    expect(entry.request).toBe(JSON.stringify(request));
    for (const hidden of ["10001", apiKey]) {
      expect(entry.request).not.toContain(hidden);
    }
    // The AI usage page links the call to its text.
    const usage = await cost.usage();
    expect(usage.calls[0]).toMatchObject({ use: "category fix", logEntryId: entry.id });
    // No log line holds the text.
    expect(lines.join("\n")).not.toContain("bought books");
    expect(lines.join("\n")).not.toContain("Bluebird");
  });

  it("says when the AI provider hid the reasoning, and when a reply ended at its reply limit", async () => {
    // Thinking that used the whole limit before any answer text: the reply fails its schema.
    stub.hiddenReasoning = true;
    stub.finishReason = "length";
    stub.reply = '{"cards":[';
    const ai = await connect();
    await turn(true);

    expect(
      await ai.generate({
        use: "insight cards",
        summary: "Household summary.",
        task: "Write the cards.",
        output: z.object({ cards: z.array(z.object({ title: z.string() })) }),
      }),
    ).toMatchObject({ ready: false, retryAt: expect.any(Date) });

    // Still the same AI failure on the call path: a bad reply that ended at its limit.
    expect(
      lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.msg === "An AI call failed"),
    ).toEqual([
      expect.objectContaining({
        use: "insight cards",
        failure: "bad reply",
        finishReason: "length",
      }),
    ]);
    expect((await onlyEntry()).response).toBe(
      'Reasoning: (hidden by the AI provider)\n\n{"cards":[\n\n(Cut off at the reply limit.)',
    );
  });

  it("writes reasoning with text under its heading, and no cut line for a reply that ended by itself", () => {
    expect(
      replyText([
        { type: "reasoning", text: "Dana's restaurants rose." },
        { type: "text", text: "Restaurants rose." },
      ]),
    ).toBe("Reasoning:\nDana's restaurants rose.\n\nRestaurants rose.");
    expect(replyText([{ type: "text", text: "Done." }], false)).toBe("Done.");
    expect(replyText([{ type: "text", text: "Do" }], true)).toBe(`Do\n\n${CUT_AT_LIMIT}`);
    expect(replyText([{ type: "reasoning", text: "" }])).toBe(HIDDEN_REASONING);
  });

  it("keeps the exact text the AI provider got, and never the key, the headers, or the base URL", async () => {
    const capture = new CapturingFetch();
    const ai = await connect("anthropic", makeFetchModels(capture.fetch));
    await turn(true);
    const call: AiCall = {
      ...categoryFix,
      batch: [{ merchant: 'Line one\nline\ttwo "quoted" \\ back', amount: -3 }],
    };

    expect(await ai.generate(call)).toMatchObject({ ready: true });

    const entry = await onlyEntry();
    const sent = capture.requests.at(-1);
    if (sent === undefined) throw new Error("No request went out.");
    // Every text the AI provider got is in the kept request, written as the request writes it.
    const texts: string[] = [];
    const collect = (value: unknown, field?: string): void => {
      if (typeof value === "string" && field === "text") texts.push(value);
      else if (Array.isArray(value)) for (const item of value) collect(item);
      else if (typeof value === "object" && value !== null) {
        for (const [name, item] of Object.entries(value)) collect(item, name);
      }
    };
    collect([sent.body.system, sent.body.messages]);
    expect(texts.length).toBeGreaterThan(2);
    for (const text of texts) expect(entry.request).toContain(JSON.stringify(text));
    const everything = JSON.stringify(await rows());
    for (const secret of [apiKey, "x-api-key", "authorization", "api.anthropic.com", "headers"]) {
      expect(everything).not.toContain(secret);
    }
  });

  it("keeps a failed call's request and what went wrong, never the error's text", async () => {
    const ai = await connect();
    await turn(true);
    stub.answers.quick = "rate limit";

    expect(await ai.generate(categoryFix)).toMatchObject({ ready: false });
    stub.answers.quick = "fail";
    expect(await ai.generate({ ...categoryFix, use: "merchant cleanup" })).toMatchObject({
      ready: false,
    });

    const kept = await rows();
    expect(kept.map((row) => [row.use, row.failure, row.failure_status, row.ai_call_id])).toEqual([
      ["category fix", "rate limit", 429, null],
      ["merchant cleanup", "server error", 500, null],
    ]);
    for (const row of kept) {
      expect(row.response).toBe("");
      expect(String(row.request)).toContain("Bluebird Books");
    }
    // The stub's errors hold the key and the token in their text and headers.
    const everything = JSON.stringify(kept);
    for (const secret of [apiKey, "Refused the key", "Bearer"]) {
      expect(everything).not.toContain(secret);
    }
    const page = await routes().page({});
    expect(page.entries.map((each) => each.usage)).toEqual([null, null]);
  });

  describe("a streamed Chat answer", () => {
    const chatCall: AiCall = {
      use: "chat",
      summary: "Household summary.",
      task: "Answer the Member's question.",
      changes: [{ role: "user", text: "How much went to Restaurants?" }],
    };

    async function answer(
      ai: Awaited<ReturnType<typeof connect>>,
      threadId: string,
      call: AiCall = chatCall,
    ) {
      const started = await ai.stream(call, {
        chatThreadId: threadId,
        ended: async () => undefined,
      });
      if (!started.ready) throw new Error(`Paused: ${started.pause}`);
      return started.response.text();
    }

    async function thread(): Promise<string> {
      const { threadId } = await storeChatThread(
        test.database,
        { title: "Restaurants", note: null },
        { author: "Member", memberId: "m1", memberName: "Dana Whitfield", text: "How much?" },
        NOW,
      );
      return threadId;
    }

    it("keeps the whole answer once it ends, and each round of a tool loop, linked to the thread", async () => {
      stub.reply = "Dana spent $480 on Restaurants.";
      stub.streamPiece = 3;
      stub.callTools = (messages) =>
        messages.some((each) => each.role === "tool")
          ? []
          : [{ toolName: "look_up", input: { month: "2026-10" } }];
      const ai = await connect();
      await turn(true);
      const threadId = await thread();
      const lookUp = aiTool({
        description: "Look up a month.",
        input: z.object({ month: z.string() }),
        run: async () => ({ total: 480 }),
      });

      await answer(ai, threadId, { ...chatCall, tools: { look_up: lookUp } });

      const kept = await rows();
      expect(kept.map((row) => [row.use, row.chat_thread_id, row.response])).toEqual([
        ["chat", threadId, 'Tool call: look_up {"month":"2026-10"}'],
        ["chat", threadId, "Dana spent $480 on Restaurants."],
      ]);
      expect(kept.every((row) => typeof row.ai_call_id === "number")).toBe(true);
      expect(String(kept[1]?.request)).toContain('"total":480');
    });

    it("goes with its thread: deleting the thread deletes its kept text and keeps the AI usage rows", async () => {
      const ai = await connect();
      await turn(true);
      const threadId = await thread();
      const other = await thread();
      await answer(ai, threadId);
      await answer(ai, other);
      expect(await rows()).toHaveLength(2);
      const counted = await aiCallCount();

      expect(await deleteChatThread(test.database, threadId)).toBe(true);

      expect((await rows()).map((row) => row.chat_thread_id)).toEqual([other]);
      expect(await aiCallCount()).toBe(counted);
    });

    it("keeps nothing when the thread is deleted while the answer runs, and the answer still ends", async () => {
      stub.reply = "Dana spent $480.";
      const ai = await connect();
      await turn(true);
      const threadId = await thread();
      stub.beforeAnswer = async () => {
        await deleteChatThread(test.database, threadId);
      };

      expect(await answer(ai, threadId)).toContain('{"type":"finish"}');

      expect(await rows()).toEqual([]);
      expect(lines.join("\n")).not.toContain("could not keep");
    });

    it("says when the AI provider hid the reasoning, and when the answer ended at its reply limit", async () => {
      stub.hiddenReasoning = true;
      stub.finishReason = "length";
      stub.reply = "Dana spent $480 on";
      stub.streamPiece = 4;
      const ai = await connect();
      await turn(true);

      await answer(ai, await thread());

      const [row] = await rows();
      expect(row).toMatchObject({
        response: `${HIDDEN_REASONING}\n\nDana spent $480 on\n\n${CUT_AT_LIMIT}`,
        failure: null,
      });
    });

    it("keeps the reply so far when the stream fails, with the call's AI usage row", async () => {
      stub.reply = "Dana spent";
      stub.streamFails = true;
      const ai = await connect();
      await turn(true);

      await answer(ai, await thread());

      const [row] = await rows();
      expect(row).toMatchObject({ response: "Dana spent", failure: "app error" });
      expect(typeof row?.ai_call_id).toBe("number");
    });
  });

  describe("what the write checks", () => {
    it("keeps nothing when a Member turns the log off while the call runs", async () => {
      const ai = await connect();
      await turn(true);
      stub.beforeAnswer = async () => {
        await turn(false);
      };

      expect(await ai.generate(categoryFix)).toMatchObject({ ready: true });

      expect(await rows()).toEqual([]);
    });

    it("keeps nothing when a Member turns the log off and on again while the call runs", async () => {
      const ai = await connect();
      await turn(true);
      stub.beforeAnswer = async () => {
        await turn(false);
        await turn(true);
      };

      expect(await ai.generate(categoryFix)).toMatchObject({ ready: true });
      expect(await rows()).toEqual([]);

      // The next call, which starts with the log on, keeps its text.
      stub.beforeAnswer = async () => {};
      await ai.generate(categoryFix);
      expect(await rows()).toHaveLength(1);
      // Only a switch-off counts: on again, or other kept days, leaves a running call's text kept.
      stub.beforeAnswer = async () => {
        await turn(true, 90);
      };
      await ai.generate(categoryFix);
      expect(await rows()).toHaveLength(2);
    });

    it("keeps nothing when the cleanup stops at its cap while the call runs", async () => {
      const ai = await connect();
      await turn(true);
      stub.beforeAnswer = async () => {
        await test.database.$client.execute(
          `UPDATE ai_request_log_settings SET cleanup_failures = ${AI_REQUEST_LOG_CLEANUP_CAP}`,
        );
      };

      expect(await ai.generate(categoryFix)).toMatchObject({ ready: true });

      expect(await rows()).toEqual([]);
      stub.beforeAnswer = async () => {};
      // One failure short of the cap keeps the text.
      await test.database.$client.execute(
        `UPDATE ai_request_log_settings SET cleanup_failures = ${AI_REQUEST_LOG_CLEANUP_CAP - 1}`,
      );
      expect(await ai.generate(categoryFix)).toMatchObject({ ready: true });
      expect(await rows()).toHaveLength(1);
    });

    it("keeps nothing for a Chat thread or an AI usage row that is gone, and never throws", async () => {
      await turn(true);
      expect(await keep(NOW, { chatThreadId: "no-such-thread" })).toBe(false);
      expect(
        await addAiRequestLogEntry(
          test.database,
          {
            at: NOW,
            aiCallId: 999_999,
            chatThreadId: null,
            use: "chat",
            model: "writer-model",
            request: "{}",
            requestCut: false,
            response: "",
            responseCut: false,
            failure: null,
            failureStatus: null,
          },
          await keeping(),
        ),
      ).toBe(false);
      expect(await keep(NOW)).toBe(true);
      expect(await rows()).toHaveLength(1);
    });

    it("deletes a kept call with its AI usage row", async () => {
      const ai = await connect();
      await turn(true);
      await ai.generate(categoryFix);
      expect(await rows()).toHaveLength(1);

      await test.database.$client.execute("DELETE FROM ai_calls");

      expect(await rows()).toEqual([]);
    });

    it("deletes every kept call with a removed Connection's history, and keeps the switch", async () => {
      const ai = await connect();
      await turn(true, 7);
      await ai.generate(categoryFix);
      expect(await keep(NOW)).toBe(true);
      const calls = await aiCallCount();
      await test.database.$client.execute({
        sql: `INSERT INTO connections (id, provider, bank_id, bank_name, sync_minute, origin, created_at, removed_at)
          VALUES ('c1', 'fake', 'fake-bank', 'Fake Bank', 7, 'linked', ?, ?)`,
        args: [NOW.toISOString(), NOW.toISOString()],
      });

      expect(await deleteRemovedConnection(test.database, "c1", NOW)).toBeDefined();

      expect(await rows()).toEqual([]);
      expect(await aiCallCount()).toBe(calls);
      expect(await routes().settings()).toEqual({ on: true, keepDays: 7, stopped: false });
    });
  });

  describe("its size cap", () => {
    // `bytes` of request text, all ASCII, so each kept call holds bytes + 9 ("Groceries").
    const sized = (bytes: number) => "x".repeat(bytes);

    it("deletes the oldest kept calls first when a new one passes the cap, in the same write", async () => {
      await turn(true);
      const cap = 3 * 109;
      for (const each of [0, 1, 2]) {
        expect(
          await keep(new Date(NOW.getTime() + each), { request: sized(100), maxBytes: cap }),
        ).toBe(true);
      }
      expect((await rows()).map((row) => row.bytes)).toEqual([109, 109, 109]);

      // One more call at 109 bytes passes the cap by one call: the oldest goes.
      expect(await keep(NOW, { request: sized(100), maxBytes: cap })).toBe(true);
      expect((await rows()).map((row) => row.id)).toEqual([2, 3, 4]);

      // A bigger call takes as many of the oldest as it must, and no more.
      expect(await keep(NOW, { request: sized(191), maxBytes: cap })).toBe(true);
      expect((await rows()).map((row) => [row.id, row.bytes])).toEqual([
        [4, 109],
        [5, 200],
      ]);
      // Under the cap, nothing goes.
      expect(await keep(NOW, { request: "{}", maxBytes: cap })).toBe(true);
      expect((await rows()).map((row) => row.id)).toEqual([4, 5, 6]);
    });

    it("adds up 20,000 kept calls and trims the oldest within a second", async () => {
      await turn(true);
      await keepMany(20_000, NOW);
      const started = performance.now();
      expect(await keep(NOW, { request: sized(100), maxBytes: 20_000 * 11 })).toBe(true);
      expect(performance.now() - started).toBeLessThan(1000);
      // The new call's 109 bytes pushed out the 10 oldest, at 11 bytes each.
      const left = await test.database.$client.execute(
        "SELECT count(*) AS n, sum(bytes) AS bytes FROM ai_request_log",
      );
      expect({ ...left.rows[0] }).toEqual({ n: 20_000 - 10 + 1, bytes: (20_000 - 10) * 11 + 109 });
    });

    it("counts bytes of UTF-8, and holds 100 MB", async () => {
      await turn(true);
      expect(AI_REQUEST_LOG_MAX_BYTES).toBe(100 * 1024 * 1024);
      expect(await keep(NOW, { request: "é😀" })).toBe(true);
      expect((await rows())[0]?.bytes).toBe(2 + 4 + 9);
    });
  });

  it("cuts each text at 256 KB, at a character's edge, and says so", async () => {
    // 2 bytes a character: 400,000 bytes.
    stub.reply = "é".repeat(200_000);
    const ai = await connect();
    await turn(true);

    await ai.generate(categoryFix);

    const entry = await onlyEntry();
    expect(entry.responseCut).toBe(true);
    expect(entry.requestCut).toBe(false);
    expect(new TextEncoder().encode(entry.response).length).toBe(AI_REQUEST_TEXT_LIMIT_BYTES);
    expect(entry.response).toBe("é".repeat(AI_REQUEST_TEXT_LIMIT_BYTES / 2));
    // A 4-byte character across the limit is left out whole.
    const cut = cutText(`a${"😀".repeat(AI_REQUEST_TEXT_LIMIT_BYTES / 4)}`);
    expect(cut.cut).toBe(true);
    expect(cut.text).not.toContain("�");
    expect(new TextEncoder().encode(cut.text).length).toBe(AI_REQUEST_TEXT_LIMIT_BYTES - 3);
    expect(cutText("short")).toEqual({ text: "short", cut: false });
  });

  describe("the switch and the kept days", () => {
    it("deletes every kept text when it goes off, and keeps the AI usage rows", async () => {
      const ai = await connect();
      await turn(true, 90);
      await ai.generate(categoryFix);
      await keep(new Date(NOW.getTime() - 2 * DAY_MS));
      const counted = await aiCallCount();

      // Changing the kept days with the switch on keeps the text.
      expect(await turn(true, 30)).toEqual({ on: true, keepDays: 30, stopped: false });
      expect(await rows()).toHaveLength(2);

      expect(await turn(false, 30)).toEqual({ on: false, keepDays: 30, stopped: false });
      expect(await rows()).toEqual([]);
      expect(await aiCallCount()).toBe(counted);
    });

    it("deletes what is older than fewer kept days at once, and only that", async () => {
      await turn(true, 90);
      await keep(new Date(NOW.getTime() - 40 * DAY_MS));
      await keep(new Date(NOW.getTime() - 8 * DAY_MS));
      await keep(new Date(NOW.getTime() - 6 * DAY_MS));

      await turn(true, 30);
      expect(await rows()).toHaveLength(2);
      await turn(true, 7);

      expect((await rows()).map((row) => row.at)).toEqual([
        new Date(NOW.getTime() - 6 * DAY_MS).toISOString(),
      ]);
    });
  });

  describe("the daily cleanup", () => {
    it("deletes each kept call older than the kept days, and only those", async () => {
      await turn(true, 7);
      await keep(new Date(NOW.getTime() - 7 * DAY_MS - 1));
      await keep(new Date(NOW.getTime() - 7 * DAY_MS + 1));
      await keep(new Date(NOW.getTime() - DAY_MS));

      ended = [];
      expect(await cleanUpAiRequestLog({ database: test.database, now: () => NOW, notices })).toBe(
        "done",
      );

      expect((await rows()).map((row) => row.at)).toEqual([
        new Date(NOW.getTime() - 7 * DAY_MS + 1).toISOString(),
        new Date(NOW.getTime() - DAY_MS).toISOString(),
      ]);
      expect(ended).toEqual([AI_REQUEST_LOG_CLEANUP_STOPPED]);
    });

    it("deletes 2,500 old kept calls in batches within a few seconds", async () => {
      await turn(true, 30);
      await keepMany(2_500, new Date(NOW.getTime() - 31 * DAY_MS));
      await keepMany(10, NOW);
      expect(await rows()).toHaveLength(2_510);

      const started = performance.now();
      expect(await cleanUpAiRequestLog({ database: test.database, now: () => NOW, notices })).toBe(
        "done",
      );
      const took = performance.now() - started;

      expect(await rows()).toHaveLength(10);
      expect(took).toBeLessThan(3_000);
      expect(2_500 / AI_REQUEST_LOG_CLEANUP_BATCH).toBeGreaterThan(1);
    });

    it("stops after 3 failed runs with one System notice, keeps no new text, and starts again when a Member changes the log", async () => {
      const ai = await connect();
      await turn(true, 30);
      await keep(new Date(NOW.getTime() - 40 * DAY_MS));
      // Every delete fails.
      await test.database.$client.execute(
        "CREATE TRIGGER no_delete BEFORE DELETE ON ai_request_log BEGIN SELECT RAISE(ABORT, 'no'); END",
      );
      const run = () =>
        cleanUpAiRequestLog({ database: test.database, now: () => NOW, notices, logger: logger() });

      expect(await run()).toBe("failed");
      expect(await run()).toBe("failed");
      expect(raised).toEqual([]);
      expect(await run()).toBe("stopped");
      expect(raised).toEqual([AI_REQUEST_LOG_CLEANUP_STOPPED]);
      // A stopped cleanup makes no more tries and raises no more notices.
      expect(await run()).toBe("stopped");
      expect(raised).toEqual([AI_REQUEST_LOG_CLEANUP_STOPPED]);
      expect((await routes().page({})).settings).toEqual({ on: true, keepDays: 30, stopped: true });
      expect(lines.filter((line) => line.includes("cleanup failed"))).toHaveLength(3);

      // While it is stopped, the log keeps no new text.
      await ai.generate(categoryFix);
      expect(await rows()).toHaveLength(1);

      // A Member's retry that fails again leaves it stopped: still no new text, and no new notice.
      expect(await turn(true, 30)).toEqual({ on: true, keepDays: 30, stopped: true });
      expect((await readAiRequestLogSettings(test.database)).cleanupFailures).toBe(
        AI_REQUEST_LOG_CLEANUP_CAP,
      );
      await ai.generate(categoryFix);
      expect(await rows()).toHaveLength(1);
      expect(raised).toEqual([AI_REQUEST_LOG_CLEANUP_STOPPED]);
      expect(ended).toEqual([]);

      // A Member's change starts it again at once, and the run that works ends the notice.
      await test.database.$client.execute("DROP TRIGGER no_delete");
      expect(await turn(true, 30)).toEqual({ on: true, keepDays: 30, stopped: false });
      expect(await rows()).toEqual([]);
      expect(ended).toEqual([AI_REQUEST_LOG_CLEANUP_STOPPED]);
      await ai.generate(categoryFix);
      expect(await rows()).toHaveLength(1);
    });

    it("runs daily at 12:30 AM, Household time, through its job", async () => {
      expect(scheduledTasks.find((task) => task.job === AiRequestLogCleanupJob)).toMatchObject({
        name: "ai request log cleanup",
      });
      await turn(true, 7);
      await keep(new Date(NOW.getTime() - 8 * DAY_MS));
      await expect(new AiRequestLogCleanupJob().run()).rejects.toThrow("not running");
      const stop = startAiRequestLogCleanup({ database: test.database, now: () => NOW, notices });
      try {
        await new AiRequestLogCleanupJob().run();
      } finally {
        stop();
      }
      expect(await rows()).toEqual([]);
    });
  });

  it("lists kept calls newest first, a page at a time", async () => {
    await turn(true);
    await keepMany(AI_REQUEST_LOG_PAGE * 2 + 20, NOW);

    const first = await routes().page({});
    expect(first.entries).toHaveLength(AI_REQUEST_LOG_PAGE);
    expect(first.entries[0]?.at).toBe(NOW.toISOString());
    const second = await routes().page({ before: first.older ?? 0 });
    const third = await routes().page({ before: second.older ?? 0 });

    const seen = [...first.entries, ...second.entries, ...third.entries].map((each) => each.id);
    expect(seen).toHaveLength(AI_REQUEST_LOG_PAGE * 2 + 20);
    expect([...seen].sort((a, b) => b - a)).toEqual(seen);
    expect(new Set(seen).size).toBe(seen.length);
    expect(third.older).toBeNull();
    expect(await routes().entry(999_999)).toBeUndefined();
  });
});
