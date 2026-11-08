import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AiCall,
  type AiCost,
  type AiGates,
  aiCost,
  aiSettings,
  FIXED_RULES,
  type HouseholdAi,
  householdAi,
  typedCount,
} from "../ai/index.ts";
import {
  newAiKey,
  newTestAi,
  type StubMessage,
  StubModels,
  type StubToolCall,
  type TestAi,
} from "../ai/testing.ts";
import { type AlertFacts, alertText } from "../anomalies/index.ts";
import {
  addGoal,
  addUnconnectedAccount,
  deleteChatThread,
  listChatMessages,
  listGoals,
  loginTables,
  type NewBudget,
  removeMember,
  storeAlerts,
  storeAlertThread,
  storeFirstDraft,
} from "../db/index.ts";
import { readEveryTable } from "../db/testing.ts";
import { saveHouseholdFacts } from "../household/index.ts";
import { createLogger } from "../log.ts";
import { GUARDRAIL, propose } from "../proposals/index.ts";
import {
  ANSWERS_PER_HOUR,
  alertThreadTitle,
  CHAT_TASK,
  CHAT_TURNS,
  type Chat,
  type ChatMember,
  chat,
  TITLE_LENGTH,
} from "./index.ts";

// Chat (spec 08, Chat): shared threads, each answer streamed as the AI writes it, on AI SDK test
// models with streamed text and streamed tool calls. No test calls an AI provider. The Household's
// names, numbers, and facts are made up.

const QUIET = createLogger(() => {}, { throwOnSecretField: true });
const PRICE = { input: 1_000_000, output: 2_000_000 };
// Oct 20, 2026, 4 PM UTC.
const NOW = new Date("2026-10-20T16:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const $ = (dollars: number) => Math.round(dollars * 100);

const DANA: ChatMember = { id: "m1", name: "Dana Whitfield" };
const RAVI: ChatMember = { id: "m2", name: "Ravi Okafor" };

// What never reaches the AI: the ZIP code.
const ZIP_CODE = "10001";

type StreamPart = { type: string; [key: string]: unknown };

// A stream's parts, as @ai-sdk/react reads them.
async function partsOf(response: Response): Promise<StreamPart[]> {
  const body = await response.text();
  return body
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)) as StreamPart);
}

const textOf = (parts: StreamPart[]) =>
  parts
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("");

// The text of a message the model read, part by part.
const textsOf = (message: StubMessage | undefined): string[] =>
  message === undefined
    ? []
    : typeof message.content === "string"
      ? [message.content]
      : message.content.flatMap((part) => (part.text === undefined ? [] : [part.text]));

// Each tool result the model read in a request.
const toolResults = (messages: StubMessage[] = []) =>
  messages.flatMap((message) =>
    message.role === "tool" && typeof message.content !== "string"
      ? message.content.map((part) => part.output)
      : [],
  );

// A JSON letter escape, such as \n or \t, which the AI reads as a different character.
const LETTER_ESCAPE = /\\[^\\"]/u;

describe("Chat", () => {
  let test: TestAi;
  let cost: AiCost;
  let stub: StubModels;
  let ai: HouseholdAi;
  let calls: AiCall[];
  let talk: Chat;
  let clock: Date;
  let loaded: boolean;
  let capped: boolean;

  beforeEach(async () => {
    test = await newTestAi();
    cost = aiCost({ database: test.database });
    stub = new StubModels();
    clock = NOW;
    loaded = true;
    capped = false;
    calls = [];
    const joined = new Date("2026-01-02T00:00:00Z");
    await test.database.insert(loginTables.user).values([
      {
        id: "m1",
        name: "Dana Whitfield",
        email: "dana@example.com",
        createdAt: joined,
        updatedAt: joined,
      },
      {
        id: "m2",
        name: "Ravi Okafor",
        email: "ravi@example.org",
        createdAt: new Date("2026-03-04T00:00:00Z"),
        updatedAt: joined,
      },
    ]);
    await addUnconnectedAccount(test.database, {
      subtype: "savings",
      institutionName: "Ally",
      name: "Rainy day fund",
      mask: "4821",
    });
    await saveHouseholdFacts(
      test.database,
      { zipCode: "10001", ages: [41, 39, 8], rentOrOwn: "own" },
      "m1",
    );
    const gates: AiGates = {
      historyLoaded: async () => loaded,
      costCapPausedUntil: async () => (capped ? "2026-11-01" : undefined),
    };
    const options = {
      database: test.database,
      secrets: test.secrets,
      makeModels: stub.makeModels,
      cost,
      gates,
      logger: QUIET,
      notices: { raise: async () => {}, end: async () => {} },
    };
    expect(
      await aiSettings(options).save({
        provider: "anthropic",
        apiKey: newAiKey(),
        baseUrl: null,
        quickModel: "quick-model",
        writerModel: "writer-model",
        prices: { quick: PRICE, writer: PRICE },
      }),
    ).toMatchObject({ saved: true });
    ai = householdAi(options);
    talk = chat({
      database: test.database,
      // The one AI, with each call Chat makes noted.
      ai: {
        ...ai,
        stream: (call, hooks) => {
          calls.push(call);
          return ai.stream(call, hooks);
        },
      },
      summary: {
        today: async () => ({
          parts: ["Household summary: 2 Members, ", typedCount(3), " Accounts."],
        }),
      },
      now: () => clock,
    });
  });

  afterEach(() => {
    test.close();
  });

  // The model calls, prompts, and tools offered, after the two checks on save.
  const modelCalls = () => stub.calls.slice(2);
  const prompts = () => stub.prompts.slice(2);
  const offered = () => stub.offered.slice(2);

  async function started(text: string, member = DANA): Promise<string> {
    const result = await talk.start(member, { text, note: null, sendAnyway: false });
    if (!("threadId" in result)) throw new Error(`Refused: ${result.refused}`);
    return result.threadId;
  }

  async function answered(threadId: string, text: string | null, member = DANA) {
    const response = await talk.answer(member, threadId, { text, sendAnyway: false });
    if (!(response instanceof Response)) throw new Error(`Refused: ${response.refused}`);
    return partsOf(response);
  }

  // Test models that make these tool calls in the first round, and answer in the next.
  const callingOnce = (toolCalls: StubToolCall[]) => {
    stub.callTools = (messages) => (messages.some((each) => each.role === "tool") ? [] : toolCalls);
  };

  describe("an answer", () => {
    it("streams as the AI writes it, and is stored as it wrote it", async () => {
      stub.reply = "Dana Whitfield spent **$480** on Restaurants.";
      // Two characters a piece, so the name arrives split. The AI looks up once first.
      stub.streamPiece = 2;
      callingOnce([{ toolName: "get_budgets_and_goals", input: { month: "2026-10" } }]);
      const id = await started("How much did we spend on Restaurants?");

      const parts = await answered(id, null);

      expect(parts.at(0)).toEqual({ type: "start" });
      expect(parts.at(-1)).toEqual({ type: "finish" });
      expect(parts.filter((part) => part.type === "text-delta").length).toBeGreaterThan(1);
      expect(textOf(parts)).toBe("Dana Whitfield spent **$480** on Restaurants.");
      // The browser gets the text, and no tool call or tool result.
      expect(toolResults(prompts().at(-1))).toEqual([
        expect.objectContaining({ value: expect.objectContaining({ goals: [] }) }),
      ]);
      expect(parts.filter((part) => /tool|source|file|data-/u.test(part.type))).toEqual([]);
      const streamed = JSON.stringify(parts);
      for (const word of ["get_budgets_and_goals", "2026-10", "goals", "budgets"]) {
        expect(streamed).not.toContain(word);
      }

      // app.db keeps the AI's words as it wrote them, and the thread shows them.
      const rows = await listChatMessages(test.database, id);
      expect(rows.map((row) => [row.author, row.text])).toEqual([
        ["Member", "How much did we spend on Restaurants?"],
        ["AI", "Dana Whitfield spent **$480** on Restaurants."],
      ]);
      const thread = await talk.thread(id);
      expect(thread?.messages.map(({ name, text }) => [name, text])).toEqual([
        ["Dana Whitfield", "How much did we spend on Restaurants?"],
        ["AI", "Dana Whitfield spent **$480** on Restaurants."],
      ]);
      expect(thread?.answering).toBe(false);
    });

    it("keeps an answer as the AI wrote it after a Member is removed, and sends it again as it is", async () => {
      stub.reply = "Dana Whitfield paid and Ravi Okafor saved.";
      const id = await started("Who paid?", RAVI);
      await answered(id, null, RAVI);
      expect(await ai.memberNames()).toEqual(
        new Map([
          ["m1", "Dana Whitfield"],
          ["m2", "Ravi Okafor"],
        ]),
      );

      expect(await removeMember(test.database, "m1", NOW)).toBe("removed");

      const thread = await talk.thread(id);
      expect(thread?.messages.map(({ name, text }) => [name, text])).toEqual([
        ["Ravi Okafor", "Who paid?"],
        ["AI", "Dana Whitfield paid and Ravi Okafor saved."],
      ]);
      expect(await ai.memberNames()).toEqual(new Map([["m2", "Ravi Okafor"]]));

      await answered(id, "What did Ravi Okafor save?", RAVI);
      const [, , , ...turns] = prompts().at(-1) ?? [];
      expect(turns.map((turn) => [turn.role, textsOf(turn).join("")])).toEqual([
        ["user", "Who paid?"],
        ["assistant", "Dana Whitfield paid and Ravi Okafor saved."],
        ["user", "What did Ravi Okafor save?"],
      ]);
    });

    it("sends the fixed rules, the summary with the cache mark, the tools, Chat's task, and the turns, with at most 1,500 reply tokens", async () => {
      const id = await started("Card 4111\n1111\n1111\n1111 and\tDana Whitfield paid?");
      await answered(id, null);
      await answered(id, "And Ravi\tOkafor?", RAVI);

      expect(modelCalls()).toEqual([
        { tier: "chat", modelId: "writer-model", maxOutputTokens: 8_000 },
        { tier: "chat", modelId: "writer-model", maxOutputTokens: 8_000 },
      ]);
      const [system, summary, task, ...turns] = prompts().at(-1) ?? [];
      expect(system).toEqual({ role: "system", content: FIXED_RULES });
      // The mark ends the cached part: the tools, the fixed rules, and the summary.
      expect(summary).toMatchObject({
        role: "user",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      });
      expect(textsOf(summary)).toEqual(["Household summary: 2 Members, 3 Accounts."]);
      expect(JSON.stringify([task, ...turns])).not.toContain("cacheControl");
      expect(textsOf(task)).toEqual([CHAT_TASK]);
      // A Member's words as the app stores them: their line breaks kept, a tab as a space.
      expect(turns.map((turn) => [turn.role, textsOf(turn).join("")])).toEqual([
        ["user", "Card 4111\n1111\n1111\n1111 and Dana Whitfield paid?"],
        ["assistant", "O"],
        ["user", "And Ravi Okafor?"],
      ]);
      expect(offered().at(-1)).toEqual({
        tools: [
          "search_transactions",
          "get_totals",
          "get_balance_history",
          "get_recurring_charges",
          "get_budgets_and_goals",
          "propose_budget_change",
          "propose_goal",
        ],
        toolChoice: "auto",
      });
      expect(JSON.stringify(prompts())).not.toContain(ZIP_CODE);
    });

    it("makes one model call for an answer with no tool call, and makes none when it does not start", async () => {
      const id = await started("How are we doing?");
      expect(modelCalls()).toEqual([]);
      await answered(id, null);
      expect(modelCalls()).toHaveLength(1);
      expect((await cost.usage()).calls.map((each) => each.use)).toEqual([
        "chat",
        "check on save",
        "check on save",
      ]);
    });

    it("runs at most 5 tool calls for a question: a 6th is refused, and the next round offers no tool", async () => {
      // Two lookups a round, every round the model may call one.
      const lookup = { toolName: "get_budgets_and_goals", input: { month: "2026-10" } };
      stub.callTools = () => [lookup, lookup];
      stub.streamPiece = 5;
      const id = await started("What changed?");

      const parts = await answered(id, null);

      expect(textOf(parts)).toBe("O");
      expect(offered().map((each) => each.toolChoice)).toEqual(["auto", "auto", "auto", "none"]);
      const results = toolResults(prompts().at(-1));
      expect(results).toHaveLength(6);
      expect(results.slice(0, 5)).toEqual(
        Array(5).fill(expect.objectContaining({ value: expect.objectContaining({ goals: [] }) })),
      );
      expect(results.at(5)).toEqual({
        type: "json",
        value: { error: "No more lookups for this question." },
      });
      expect(modelCalls()).toHaveLength(4);
    });

    it("sends a tool result as the app built it, each control character a space, with no letter escape", async () => {
      await addGoal(test.database, {
        words: "Spend less at one shop",
        authorId: "m1",
        date: "2026-10-01",
        target: {
          kind: "Merchant",
          merchant: { id: null, name: "PAID\tDana Whitfield 4111\n1111\n1111\n1111" },
        },
        change: { amount: $(50) },
        deadline: "2027-06-30",
      });
      callingOnce([{ toolName: "get_budgets_and_goals", input: { month: "2026-10" } }]);
      const id = await started("How are the Goals?");

      await answered(id, null);

      const [result] = toolResults(prompts().at(-1));
      expect(result).toMatchObject({
        type: "json",
        value: { goals: [{ target: "Merchant: PAID Dana Whitfield 4111 1111 1111 1111" }] },
      });
      expect(JSON.stringify(result)).not.toMatch(LETTER_ESCAPE);
    });

    it("shows an error with no retry when the AI provider fails, stores no answer, and answers again on Try again", async () => {
      stub.answers.chat = "fail";
      const id = await started("How are we doing?");

      const parts = await answered(id, null);

      expect(parts.at(-1)).toEqual({ type: "error", errorText: "The AI provider did not answer." });
      expect(modelCalls()).toHaveLength(1);
      expect((await listChatMessages(test.database, id)).map((row) => row.author)).toEqual([
        "Member",
      ]);

      stub.answers.chat = "work";
      expect(textOf(await answered(id, null))).toBe("O");
      expect((await listChatMessages(test.database, id)).map((row) => row.author)).toEqual([
        "Member",
        "AI",
      ]);
      expect(modelCalls()).toHaveLength(2);
    });

    it("refuses a second question in a thread while the AI is answering, and stores nothing", async () => {
      let release = () => {};
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      stub.beforeAnswer = () => waiting;
      const id = await started("How are we doing?");
      const first = await talk.answer(DANA, id, { text: null, sendAnyway: false });
      expect(first).toBeInstanceOf(Response);
      const before = await readEveryTable(test.database);

      expect(await talk.answer(RAVI, id, { text: "And now?", sendAnyway: false })).toEqual({
        refused: "busy",
      });
      expect((await talk.thread(id))?.answering).toBe(true);
      expect(await readEveryTable(test.database)).toEqual(before);

      release();
      await partsOf(first as Response);
      expect((await talk.thread(id))?.answering).toBe(false);
      expect(textOf(await answered(id, "And now?", RAVI))).toBe("O");
    });

    it(`starts at most ${ANSWERS_PER_HOUR} answers a Member an hour, and stores no message past the cap`, async () => {
      const id = await started("Question 1");
      await answered(id, null);
      for (let asked = 2; asked <= ANSWERS_PER_HOUR; asked += 1) {
        await answered(id, `Question ${asked}`);
      }
      const before = await readEveryTable(test.database);

      expect(await talk.answer(DANA, id, { text: "One more", sendAnyway: false })).toEqual({
        refused: "rate cap",
      });
      expect(await talk.start(DANA, { text: "New", note: null, sendAnyway: false })).toEqual({
        refused: "rate cap",
      });
      expect(await readEveryTable(test.database)).toEqual(before);
      expect(modelCalls()).toHaveLength(ANSWERS_PER_HOUR);

      // Another Member's answers count on their own, and the hour moves on.
      expect(textOf(await answered(id, "Mine", RAVI))).toBe("O");
      clock = new Date(NOW.getTime() + HOUR + 1);
      expect(textOf(await answered(id, "One more"))).toBe("O");
    });

    it(`holds the cap for answers sent together over many threads: ${ANSWERS_PER_HOUR} start, the rest are refused`, async () => {
      const ids: string[] = [];
      for (let each = 0; each < ANSWERS_PER_HOUR + 5; each += 1) {
        ids.push(await started(`Question ${each}`));
      }

      const answers = await Promise.all(
        ids.map((id) => talk.answer(DANA, id, { text: null, sendAnyway: false })),
      );

      const streams = answers.filter((each): each is Response => each instanceof Response);
      expect(streams).toHaveLength(ANSWERS_PER_HOUR);
      expect(answers.filter((each) => !(each instanceof Response))).toEqual(
        Array(5).fill({ refused: "rate cap" }),
      );
      for (const stream of streams) expect(textOf(await partsOf(stream))).toBe("O");
      expect(modelCalls()).toHaveLength(ANSWERS_PER_HOUR);
    });

    it("gives the place back when an answer does not start", async () => {
      const id = await started("Question");
      await answered(id, null);
      for (let each = 0; each < ANSWERS_PER_HOUR; each += 1) {
        expect(await talk.answer(DANA, id, { text: null, sendAnyway: false })).toEqual({
          refused: "nothing to answer",
        });
      }
      capped = true;
      for (let each = 0; each < ANSWERS_PER_HOUR; each += 1) {
        expect(await talk.answer(DANA, id, { text: "And?", sendAnyway: false })).toMatchObject({
          refused: "paused",
        });
      }
      capped = false;
      expect(textOf(await answered(id, "And now?"))).toBe("O");
      expect(modelCalls()).toHaveLength(2);
    });
  });

  describe("the gate", () => {
    it("asks Send anyway? at the AI cost cap before each message, storing nothing, and sends once the Member says yes", async () => {
      const id = await started("How are we doing?");
      capped = true;
      const before = await readEveryTable(test.database);

      expect(await talk.pause()).toBe("send anyway?");
      expect(await talk.start(DANA, { text: "Hi", note: null, sendAnyway: false })).toEqual({
        refused: "paused",
        pause: "send anyway?",
      });
      expect(await talk.answer(DANA, id, { text: "And?", sendAnyway: false })).toEqual({
        refused: "paused",
        pause: "send anyway?",
      });
      expect(await readEveryTable(test.database)).toEqual(before);
      expect(modelCalls()).toEqual([]);

      const response = await talk.answer(DANA, id, { text: null, sendAnyway: true });
      expect(textOf(await partsOf(response as Response))).toBe("O");
      expect(modelCalls()).toHaveLength(1);
    });

    it("waits until history has loaded", async () => {
      loaded = false;
      expect(await talk.pause()).toBe("waits for history");
      expect(await talk.start(DANA, { text: "Hi", note: null, sendAnyway: true })).toEqual({
        refused: "paused",
        pause: "waits for history",
      });
      expect(await talk.threads()).toEqual([]);
    });
  });

  describe("threads", () => {
    it("are shared, newest first by last message, titled by the first message cut to 60 characters", async () => {
      const long = `${"Why did Groceries go up so much ".repeat(3)}this month?`;
      const first = await started(long);
      clock = new Date(NOW.getTime() + 1000);
      const second = await started("Rent\nquestion", RAVI);
      expect((await talk.threads()).map((each) => each.id)).toEqual([second, first]);

      clock = new Date(NOW.getTime() + 2000);
      await answered(first, null, RAVI);
      const threads = await talk.threads();
      expect(threads.map((each) => each.id)).toEqual([first, second]);
      expect(threads[0]?.title).toBe(long.slice(0, TITLE_LENGTH).trim());
      expect(threads[1]?.title).toBe("Rent question");
    });

    it("starts threads sent together: one by each of two Members, then 15 by one Member", async () => {
      const both = await Promise.all([started("Groceries?", DANA), started("Rent?", RAVI)]);
      const many = await Promise.all(
        Array.from({ length: 15 }, (_, each) => started(`Question ${each}`)),
      );

      const threads = await talk.threads();
      expect(threads.map((each) => each.id).sort()).toEqual([...both, ...many].sort());
      expect(new Set(threads.map((each) => each.title)).size).toBe(17);
      for (const id of [...both, ...many]) {
        expect((await talk.thread(id))?.messages).toHaveLength(1);
      }
    });

    it(`sends the last ${CHAT_TURNS} turns, and marks where older ones stop going to the AI`, async () => {
      const id = await started("Turn 1");
      await answered(id, null);
      for (const turn of [3, 5, 7]) await answered(id, `Turn ${turn}`);
      // A 9th message whose answer fails: the next call sends all 9.
      stub.answers.chat = "fail";
      await answered(id, "Turn 9");
      const nine = await talk.thread(id);
      expect(nine?.messages).toHaveLength(9);
      expect(nine?.firstSent).toBeNull();

      stub.answers.chat = "work";
      await answered(id, null);
      const ten = await talk.thread(id);
      expect(ten?.messages).toHaveLength(10);
      // The next call sends the 9 latest and the new message: the line goes above the 2nd.
      expect(ten?.firstSent).toBe(ten?.messages[1]?.id);

      await answered(id, "Turn 11");
      const sent = (calls.at(-1)?.changes ?? []).map((turn) => ("text" in turn ? turn.text : null));
      expect(sent).toHaveLength(CHAT_TURNS);
      expect(sent.at(0)).toBe("O");
      expect(sent.at(-1)).toBe("Turn 11");
      expect(JSON.stringify(prompts().at(-1))).not.toContain('Turn 1"');
    });

    it("deletes a thread with its messages, keeps its Proposals, and refuses a wrong ID with no change", async () => {
      callingOnce([
        { toolName: "propose_goal", input: { words: "Save for a car", reason: "It fits." } },
      ]);
      const id = await started("A Goal?");
      const other = await started("Another");
      await answered(id, null);
      const before = await readEveryTable(test.database);

      expect(await talk.remove("no-such-thread")).toBe(false);
      expect(await talk.answer(DANA, "no-such-thread", { text: "Hi", sendAnyway: false })).toEqual({
        refused: "not found",
      });
      expect(await readEveryTable(test.database)).toEqual(before);

      expect(await talk.remove(id)).toBe(true);
      expect(await talk.thread(id)).toBeUndefined();
      expect(await listChatMessages(test.database, id)).toEqual([]);
      expect(await listChatMessages(test.database, other)).toHaveLength(1);
      const tables = await readEveryTable(test.database);
      expect(tables.proposals).toHaveLength(1);
    });

    it("keeps a removed Member's name on their messages", async () => {
      const id = await started("Mine", RAVI);
      await test.database.$client.execute({
        sql: "DELETE FROM members WHERE id = ?",
        args: [RAVI.id],
      });
      expect((await talk.thread(id))?.messages.map((each) => each.name)).toEqual(["Ravi Okafor"]);
      expect(textOf(await answered(id, null))).toBe("O");
    });
  });

  describe("Proposals", () => {
    beforeEach(async () => {
      const budget = (category: string, amount: number): NewBudget => ({
        category,
        amount,
        period: "monthly",
        takesEffect: "2026-10",
        source: "formula",
        setBy: null,
        pinned: null,
        setAt: new Date("2026-10-01T00:00:00.000Z"),
      });
      await storeFirstDraft(test.database, {
        inputs: {
          steadyIncome: $(6000),
          ceDataYear: 2024,
          sampleBenchmarks: false,
          firstDraftMonth: "2026-10",
          fixedCostsPassIncome: false,
          recordedAt: new Date("2026-10-01T00:00:00.000Z"),
        },
        budgets: [budget("Restaurants", $(600)), budget("Clothing", $(200))],
      });
    });

    it("shows at most 2 in an answer, answers each tool with shown or the broken guardrail, and changes nothing until accepted", async () => {
      callingOnce([
        {
          toolName: "propose_budget_change",
          input: { category: "Restaurants", newAmount: 100, reason: "Too low." },
        },
        {
          toolName: "propose_budget_change",
          input: { category: "Restaurants", newAmount: 480, reason: "Takeout is steady." },
        },
        {
          toolName: "propose_goal",
          // The model's JSON holds each newline as an escape: the card shows a space.
          input: { words: "Save\nfor a\tcar", reason: "It\nfits." },
        },
        {
          toolName: "propose_goal",
          input: { words: "Save for a trip", reason: "It fits too." },
        },
      ]);
      const before = await readEveryTable(test.database);
      const id = await started("Can we save more?");

      await answered(id, null);

      // The tool calls run at once, so which 2 of the 3 good ones are stored is the order their
      // writes reach app.db; the third gets the cap's guardrail.
      const results = toolResults(prompts().at(-1));
      expect(results[0]).toEqual({ type: "json", value: { error: GUARDRAIL.range } });
      const rest = results.slice(1) as { value?: { result?: string; error?: string } }[];
      expect(rest.filter((each) => each?.value?.result === "shown")).toHaveLength(2);
      expect(rest.filter((each) => each?.value?.error === GUARDRAIL.perRun)).toHaveLength(1);
      const good = [
        ["Budget change", ["Restaurants Budget: $600 → $480"], "Takeout is steady."],
        ["new Goal", [`New Goal: "Save for a car"`], "It fits."],
        ["new Goal", [`New Goal: "Save for a trip"`], "It fits too."],
      ];
      const thread = await talk.thread(id);
      const answer = thread?.messages.at(-1);
      expect(thread?.proposals.map((each) => [each.kind, each.changes, each.reason])).toEqual(
        expect.arrayContaining(good.filter((_, index) => rest[index]?.value?.result === "shown")),
      );
      expect(thread?.proposals).toHaveLength(2);
      for (const each of thread?.proposals ?? []) expect(each.runId).toBe(`${id}/${answer?.id}`);
      // Nothing changes until a Member accepts it: no Budget and no Goal.
      const after = await readEveryTable(test.database);
      expect(after.budgets).toEqual(before.budgets);
      expect(await listGoals(test.database)).toEqual([]);
    });

    it("answers a Budget change for a Category not on the list with the guardrail it broke", async () => {
      callingOnce([
        {
          toolName: "propose_budget_change",
          input: { category: "Takeout", newAmount: 300, reason: "Lower." },
        },
      ]);
      const id = await started("Lower takeout?");

      await answered(id, null);

      expect(toolResults(prompts().at(-1))).toEqual([
        { type: "json", value: { error: GUARDRAIL.category } },
      ]);
      expect((await talk.thread(id))?.proposals).toEqual([]);
    });

    it("attaches a note from the AI box, with its numbers as the app made them, read from app.db by its ID", async () => {
      const shown = await propose(
        test.database,
        {
          kind: "Budget change",
          source: "Monthly review",
          runId: "review-1",
          reason: "Takeout has been steady.",
          budgets: [{ category: "Restaurants", amount: $(480) }],
        },
        NOW,
      );
      if (shown.outcome !== "shown") throw new Error("Refused");
      const before = await readEveryTable(test.database);
      expect(
        await talk.start(DANA, {
          text: "Tell me more",
          note: { kind: "Proposal", id: "no-such-proposal" },
          sendAnyway: false,
        }),
      ).toEqual({ refused: "note gone" });
      expect(
        await talk.start(DANA, {
          text: "Tell me more",
          note: { kind: "Alert note", id: shown.id },
          sendAnyway: false,
        }),
      ).toEqual({ refused: "note gone" });
      expect(await readEveryTable(test.database)).toEqual(before);

      const result = await talk.start(DANA, {
        text: "Tell me more about this: Restaurants Budget: $600 → $480",
        note: { kind: "Proposal", id: shown.id },
        sendAnyway: false,
      });
      if (!("threadId" in result)) throw new Error(`Refused: ${result.refused}`);
      expect((await talk.thread(result.threadId))?.note).toEqual({
        kind: "Proposal",
        title: "Restaurants Budget: $600 → $480",
        lines: ["Restaurants Budget: $600 → $480", "Takeout has been steady."],
      });

      await answered(result.threadId, null);

      const [, , task, note, question] = prompts().at(-1) ?? [];
      expect(textsOf(task)).toEqual([CHAT_TASK]);
      expect(textsOf(note).join("")).toBe(
        "The Member asks about this note from the AI box.\nAn open Proposal from Monthly review: Budget change.\n- Restaurants Budget: $600 a month to $480 a month\nIts reason: Takeout has been steady.",
      );
      expect(textsOf(question)).toEqual([
        "Tell me more about this: Restaurants Budget: $600 → $480",
      ]);
    });
  });

  describe("an Alert note", () => {
    it("goes with its amounts and dates as the app made them, and no Account name", async () => {
      const facts: AlertFacts = {
        kind: "Duplicate charge",
        merchant: { id: null, name: "Shell" },
        account: "Dana's Rewards Card ··4821",
        amount: 4_821,
        dates: ["2026-10-17", "2026-10-18"],
      };
      await storeAlerts(test.database, [
        {
          id: "duplicate",
          kind: "Duplicate charge",
          createdAt: new Date(NOW.getTime() - HOUR),
          facts,
          text: alertText(facts, "2026-10-20"),
          category: null,
          state: "sent",
          transactionIds: [],
        },
      ]);

      const result = await talk.start(DANA, {
        text: "Tell me more about this: Duplicate charge",
        note: { kind: "Alert note", id: "duplicate" },
        sendAnyway: false,
      });
      if (!("threadId" in result)) throw new Error(`Refused: ${result.refused}`);
      expect((await talk.thread(result.threadId))?.note).toMatchObject({ kind: "Alert note" });
      await answered(result.threadId, null);

      const [, , , note] = prompts().at(-1) ?? [];
      const text = textsOf(note).join("");
      expect(text).toMatch(/^The Member asks about this note from the AI box\.\nAn Alert note: /u);
      expect(text).toContain("Shell");
      expect(text).toContain("an Account");
      // $48.21 matches the Account's last 4, 4821, and goes as the app made it.
      expect(text).toContain("$48.21");
      expect(text).toContain("2026-10-17");
    });

    it("keeps the spaces between its pieces", async () => {
      const facts: AlertFacts = {
        kind: "Duplicate charge",
        merchant: { id: null, name: "Dana Whitfield Photo" },
        account: "Rewards Card",
        amount: 4_821,
        dates: ["2026-10-17", "2026-10-18"],
      };
      await storeAlerts(test.database, [
        {
          id: "photo",
          kind: "Duplicate charge",
          createdAt: new Date(NOW.getTime() - HOUR),
          facts,
          text: alertText(facts, "2026-10-20"),
          category: null,
          state: "sent",
          transactionIds: [],
        },
      ]);

      const result = await talk.start(RAVI, {
        text: "Tell me more about this",
        note: { kind: "Alert note", id: "photo" },
        sendAnyway: false,
      });
      if (!("threadId" in result)) throw new Error(`Refused: ${result.refused}`);
      await answered(result.threadId, null, RAVI);

      const [, , , note] = prompts().at(-1) ?? [];
      const text = textsOf(note).join("");
      expect(text).toContain(
        "$48.21 at Dana Whitfield Photo on an Account, on 2026-10-17 and 2026-10-18.",
      );
    });
  });

  describe('"Ask the AI" on an Alert', () => {
    // Card interest of $48.21 on the Account whose last 4 is 4821, sent.
    const interest: AlertFacts = {
      kind: "Card interest or fee",
      cardInterest: true,
      merchant: null,
      account: "Dana's Rewards Card ··4821",
      amount: 4_821,
      date: "2026-10-17",
    };
    // A Large purchase at a Merchant whose name holds a tab, a Member's name, and a card split by
    // line breaks, held back by the weekly cap.
    const purchase: AlertFacts = {
      kind: "Large purchase",
      merchant: { id: null, name: "PAID\tDana Whitfield 4111\n1111\n1111\n1111" },
      amount: 31_240,
      date: "2026-10-18",
      budget: null,
    };

    const alertRow = (id: string, facts: AlertFacts, state: "sent" | "held back (weekly cap)") => ({
      id,
      kind: facts.kind,
      createdAt: new Date(NOW.getTime() - HOUR),
      facts,
      text: alertText(facts, "2026-10-20"),
      category: null,
      state,
      transactionIds: [],
    });

    beforeEach(async () => {
      await storeAlerts(test.database, [
        alertRow("interest", interest, "sent"),
        alertRow("purchase", purchase, "held back (weekly cap)"),
      ]);
    });

    async function asked(alertId: string, member = DANA) {
      const result = await talk.askAboutAlert(member, alertId);
      if (!("threadId" in result)) throw new Error(`Refused: ${result.refused}`);
      return result;
    }

    const links = async () =>
      (
        await test.database.$client.execute(
          "SELECT thread_id, alert_id, member_id FROM chat_alert_threads ORDER BY rowid",
        )
      ).rows.map((row) => ({ ...row }));

    it("starts a thread titled after the Alert, with the Alert attached and no message, making no AI call", async () => {
      const { threadId, started } = await asked("interest");

      expect(started).toBe(true);
      expect(await talk.thread(threadId)).toMatchObject({
        title: "About: Card interest on Dana's Rewards Card ··4821",
        note: {
          kind: "Alert",
          title: "Card interest on Dana's Rewards Card ··4821",
          lines: ["Card interest: $48.21 on Dana's Rewards Card ··4821 on Oct 17."],
        },
        messages: [],
        firstSent: null,
        answering: false,
      });
      expect((await talk.threads()).map((thread) => thread.title)).toEqual([
        "About: Card interest on Dana's Rewards Card ··4821",
      ]);
      expect(await links()).toEqual([
        { thread_id: threadId, alert_id: "interest", member_id: "m1" },
      ]);
      expect(modelCalls()).toEqual([]);
      // With nothing asked yet, there is nothing to answer.
      expect(await talk.answer(DANA, threadId, { text: null, sendAnyway: false })).toEqual({
        refused: "nothing to answer",
      });
      expect(modelCalls()).toEqual([]);
    });

    it("cuts the title to 60 characters", () => {
      expect(alertThreadTitle("x".repeat(80))).toBe(`About: ${"x".repeat(53)}`);
    });

    it("gives the AI the Alert with each first question: its amounts and dates as the app made them", async () => {
      const { threadId } = await asked("interest");

      const parts = await answered(threadId, "Why did this happen?");

      expect(textOf(parts)).toBe("O");
      const [, , task, note, question] = prompts().at(-1) ?? [];
      expect(textsOf(task)).toEqual([CHAT_TASK]);
      const text = textsOf(note).join("");
      // $48.21 matches the Account's last 4, 4821, and goes as the app made it.
      expect(text).toBe(
        "The Member asks about this Alert from the Alert list.\nAn Alert from the Alert list: Card interest or fee.\n- Card interest: $48.21 on an Account on 2026-10-17.\nThe app sent it to the Members.",
      );
      expect(textsOf(question)).toEqual(["Why did this happen?"]);
      const sent = JSON.stringify(prompts());
      // The title, which names the Account, never goes to the AI.
      expect(sent).not.toContain("Rewards");
    });

    it("sends the Alert's words as the model reads them, each control character a space, with no letter escape", async () => {
      await talk.askAboutAlert(DANA, "purchase").then(async (result) => {
        if (!("threadId" in result)) throw new Error("Refused");
        await answered(result.threadId, "What should we do?");
      });

      const [, , , note] = prompts().at(-1) ?? [];
      const text = textsOf(note).join("");
      expect(text).toContain(
        "Large purchase: $312.40 at PAID Dana Whitfield 4111 1111 1111 1111 on 2026-10-18.",
      );
      expect(text).toContain("The weekly cap held it back, so the app sent no message for it.");
      // The note's own line breaks start its lines. No other control character is left.
      expect(
        text
          .split("\n")
          .slice(1)
          .every((line) => /^(- |An |The )/u.test(line)),
      ).toBe(true);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the characters it must not hold.
      expect(text).not.toMatch(/[\u0000-\u0009\u000B-\u001F]/u);
      expect(text).not.toMatch(/\\[a-z]/iu);
    });

    it("opens the same thread on the same Member's next press, and another thread for another Member or another Alert", async () => {
      const first = await asked("interest");
      await answered(first.threadId, "Why?");
      const before = await readEveryTable(test.database);

      expect(await talk.askAboutAlert(DANA, "interest")).toEqual({
        threadId: first.threadId,
        started: false,
      });
      expect(await readEveryTable(test.database)).toEqual(before);

      const ravi = await asked("interest", RAVI);
      const other = await asked("purchase");
      expect(ravi.started).toBe(true);
      expect(other.started).toBe(true);
      expect(new Set([first.threadId, ravi.threadId, other.threadId]).size).toBe(3);
      expect(await links()).toEqual([
        { thread_id: first.threadId, alert_id: "interest", member_id: "m1" },
        { thread_id: ravi.threadId, alert_id: "interest", member_id: "m2" },
        { thread_id: other.threadId, alert_id: "purchase", member_id: "m1" },
      ]);
      // Every Member sees every thread.
      expect(await talk.thread(ravi.threadId)).toMatchObject({ messages: [] });
    });

    it("starts one thread for presses at once, which share the first press", async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => talk.askAboutAlert(DANA, "interest")),
      );

      // Each later press joined the first one, so each answers as it did.
      const [first] = results;
      expect(first).toMatchObject({ started: true });
      expect(results).toEqual(Array.from({ length: 5 }, () => first));
      expect(await talk.threads()).toHaveLength(1);
      expect(await links()).toHaveLength(1);
    });

    it("stores one thread for writes at once, as the link's unique index decides, and the loser leaves no thread", async () => {
      const note = { kind: "Alert", title: "Card interest", lines: [], pieces: [] };
      const link = { alertId: "interest", memberId: "m1" };
      const results = await Promise.all(
        Array.from({ length: 3 }, () =>
          storeAlertThread(test.database, { title: "About: Card interest", note }, link, NOW),
        ),
      );

      expect(new Set(results.map((result) => result?.threadId)).size).toBe(1);
      expect(results.filter((result) => result?.started)).toHaveLength(1);
      expect(await talk.threads()).toHaveLength(1);
      expect(await links()).toHaveLength(1);
    });

    it("attaches every part of a merged Alert, from the merged Alert's ID or a part's", async () => {
      const later: AlertFacts = { ...interest, amount: 1_250, date: "2026-10-18" };
      await storeAlerts(test.database, [alertRow("interest-2", later, "sent")]);
      await test.database.$client.execute(
        "INSERT INTO alert_parts (alert_id, merged_into) VALUES ('interest-2', 'interest')",
      );
      await test.database.$client.execute(
        "INSERT INTO alert_presses (alert_id, member_id, pressed_at) VALUES ('interest-2', 'm2', '2026-10-20T15:00:00.000Z')",
      );

      const { threadId } = await asked("interest-2");

      expect(await asked("interest")).toEqual({ threadId, started: false });
      expect(await links()).toEqual([
        { thread_id: threadId, alert_id: "interest", member_id: "m1" },
      ]);
      expect((await talk.thread(threadId))?.title).toBe("About: 2 Card interest or fee charges");
      await answered(threadId, "Why?");
      const [, , , note] = prompts().at(-1) ?? [];
      expect(textsOf(note).join("")).toBe(
        'The Member asks about this Alert from the Alert list.\nAn Alert from the Alert list: Card interest or fee.\n- Card interest: $48.21 on an Account on 2026-10-17.\n- Card interest: $12.50 on an Account on 2026-10-18.\nThe app sent it to the Members.\nMembers marked 1 of its parts "Not a problem".',
      );
    });

    it("gives the AI the Alert's advice, each part's joined with a space", async () => {
      const later: AlertFacts = { ...interest, amount: 1_250, date: "2026-10-18" };
      await storeAlerts(test.database, [alertRow("interest-2", later, "sent")]);
      await test.database.$client.execute(
        "INSERT INTO alert_parts (alert_id, merged_into) VALUES ('interest-2', 'interest')",
      );
      await test.database.$client.execute(
        "UPDATE alerts SET advice = 'Ask the card issuer to waive it.' WHERE id = 'interest'",
      );
      await test.database.$client.execute(
        "UPDATE alerts SET advice = 'Pay the full balance before the due date.' WHERE id = 'interest-2'",
      );

      const { threadId } = await asked("interest");

      const advice = "Ask the card issuer to waive it. Pay the full balance before the due date.";
      expect((await talk.thread(threadId))?.note?.lines.at(-1)).toBe(`Next step: ${advice}`);
      await answered(threadId, "Why?");
      const [, , , note] = prompts().at(-1) ?? [];
      expect(textsOf(note).join("")).toBe(
        `The Member asks about this Alert from the Alert list.\nAn Alert from the Alert list: Card interest or fee.\n- Card interest: $48.21 on an Account on 2026-10-17.\n- Card interest: $12.50 on an Account on 2026-10-18.\nThe app sent it to the Members.\nThe next step the AI gave: ${advice}`,
      );
    });

    it("starts nothing when the Alert or the Member goes while the press reads the Alert, and leaves no thread", async () => {
      // Delete history or a Member removal runs after the Alert is read, before the thread is stored.
      const racing = (gone: () => Promise<unknown>) =>
        chat({
          database: test.database,
          ai: {
            ...ai,
            accountNames: async () => {
              await gone();
              return ai.accountNames();
            },
          },
          summary: { today: async () => ({ parts: [] }) },
          now: () => clock,
        });

      const deleted = racing(() =>
        test.database.$client.execute("DELETE FROM alerts WHERE id = 'interest'"),
      );
      expect(await deleted.askAboutAlert(DANA, "interest")).toEqual({ refused: "no alert" });
      const removed = racing(() => removeMember(test.database, "m2", NOW));
      expect(await removed.askAboutAlert(RAVI, "purchase")).toEqual({ refused: "no alert" });

      // The thread and its link go in one write: a failed link leaves no thread.
      expect(await talk.threads()).toEqual([]);
      expect(await links()).toEqual([]);
      expect(
        await storeAlertThread(
          test.database,
          { title: "About: x", note: {} },
          { alertId: "interest", memberId: "m1" },
          NOW,
        ),
      ).toBeUndefined();
      expect(await talk.threads()).toEqual([]);
    });

    it("starts nothing for an ID no Alert has, with no AI provider, or before history has loaded", async () => {
      const before = await readEveryTable(test.database);

      expect(await talk.askAboutAlert(DANA, "no-such-alert")).toEqual({ refused: "no alert" });
      loaded = false;
      expect(await talk.askAboutAlert(DANA, "interest")).toEqual({
        refused: "paused",
        pause: "waits for history",
      });
      loaded = true;
      const off = chat({
        database: test.database,
        ai: { ...ai, pauseFor: async () => "no AI provider" },
        summary: { today: async () => ({ parts: [] }) },
        now: () => clock,
      });
      expect(await off.askAboutAlert(DANA, "interest")).toEqual({
        refused: "paused",
        pause: "no AI provider",
      });

      expect(await readEveryTable(test.database)).toEqual(before);
      expect(modelCalls()).toEqual([]);
    });

    it("starts the thread at the AI cost cap, where each question asks Send anyway? and counts against the cap", async () => {
      capped = true;
      const { threadId, started } = await asked("interest");
      expect(started).toBe(true);

      expect(await talk.answer(DANA, threadId, { text: "Why?", sendAnyway: false })).toEqual({
        refused: "paused",
        pause: "send anyway?",
      });
      expect(await listChatMessages(test.database, threadId)).toEqual([]);
      const response = await talk.answer(DANA, threadId, { text: "Why?", sendAnyway: true });
      if (!(response instanceof Response)) throw new Error("Refused");
      expect(textOf(await partsOf(response))).toBe("O");
      // The answer is a Chat call, counted like every other.
      expect((await cost.usage()).calls.map((each) => each.use)).toEqual([
        "chat",
        "check on save",
        "check on save",
      ]);
    });

    it("keeps the thread when its Alert is deleted or its Member removed, and a deleted thread starts again", async () => {
      const dana = await asked("interest");
      const ravi = await asked("purchase", RAVI);
      await answered(dana.threadId, "Why?");

      // Delete history deletes each Alert about the Transactions it deletes.
      await test.database.$client.execute("DELETE FROM alerts WHERE id = 'interest'");
      expect(await links()).toEqual([
        { thread_id: ravi.threadId, alert_id: "purchase", member_id: "m2" },
      ]);
      expect(await talk.thread(dana.threadId)).toMatchObject({
        note: { kind: "Alert" },
        messages: [{ author: "Member", text: "Why?" }, { author: "AI" }],
      });
      expect(await talk.askAboutAlert(DANA, "interest")).toEqual({ refused: "no alert" });

      expect(await removeMember(test.database, "m2", NOW)).toBe("removed");
      expect(await links()).toEqual([]);
      expect(await talk.thread(ravi.threadId)).toMatchObject({ note: { kind: "Alert" } });

      const again = await asked("purchase");
      expect(await deleteChatThread(test.database, again.threadId)).toBe(true);
      expect(await links()).toEqual([]);
      expect(await asked("purchase")).toMatchObject({ started: true });
    });
  });
});
