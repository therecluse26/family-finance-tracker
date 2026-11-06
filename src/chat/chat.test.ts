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
  listChatMessages,
  listGoals,
  loginTables,
  type NewBudget,
  removeMember,
  storeAlerts,
  storeFirstDraft,
} from "../db/index.ts";
import { readEveryTable } from "../db/testing.ts";
import { saveHouseholdFacts } from "../household/index.ts";
import { createLogger } from "../log.ts";
import { GUARDRAIL, propose } from "../proposals/index.ts";
import {
  ANSWERS_PER_HOUR,
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

// What must never reach the AI: the Members' names, the Account's last 4, the ZIP code, and a card.
const PRIVATE = ["Dana", "Whitfield", "Ravi", "Okafor", "4821", "10001", "4111"];

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
    it("streams as the AI writes it, with each Member's name in place of their label, and is stored", async () => {
      stub.reply = "Member A spent **$480** on Restaurants.";
      // Two characters a piece, so "Member A" arrives split. The AI looks up once first.
      stub.streamPiece = 2;
      callingOnce([{ toolName: "get_budgets_and_goals", input: { month: "2026-10" } }]);
      const id = await started("How much did we spend on Restaurants?");

      const parts = await answered(id, null);

      expect(parts.at(0)).toEqual({ type: "start" });
      expect(parts.at(-1)).toEqual({ type: "finish" });
      expect(parts.filter((part) => part.type === "text-delta").length).toBeGreaterThan(1);
      expect(textOf(parts)).toBe("Dana Whitfield spent **$480** on Restaurants.");
      // The browser gets the text, and no tool call, tool result, or label.
      expect(toolResults(prompts().at(-1))).toEqual([
        expect.objectContaining({ value: expect.objectContaining({ goals: [] }) }),
      ]);
      expect(parts.filter((part) => /tool|source|file|data-/u.test(part.type))).toEqual([]);
      const streamed = JSON.stringify(parts);
      for (const word of ["get_budgets_and_goals", "2026-10", "goals", "budgets", "Member A"]) {
        expect(streamed).not.toContain(word);
      }

      // app.db keeps the AI's words as it wrote them, and the thread shows them with the name.
      const rows = await listChatMessages(test.database, id);
      expect(rows.map((row) => [row.author, row.text])).toEqual([
        ["Member", "How much did we spend on Restaurants?"],
        ["AI", "Member A spent **$480** on Restaurants."],
      ]);
      const thread = await talk.thread(id);
      expect(thread?.messages.map(({ name, text }) => [name, text])).toEqual([
        ["Dana Whitfield", "How much did we spend on Restaurants?"],
        ["AI", "Dana Whitfield spent **$480** on Restaurants."],
      ]);
      expect(thread?.answering).toBe(false);
    });

    it("still names each Member after one is removed, and the AI keeps calling the others by the same label", async () => {
      stub.reply = "Member A paid and Member B saved.";
      const id = await started("Who paid?", RAVI);
      await answered(id, null, RAVI);
      expect(await ai.memberLabels()).toEqual(
        new Map([
          ["m1", "Member A"],
          ["m2", "Member B"],
        ]),
      );

      expect(await removeMember(test.database, "m1", NOW)).toBe("removed");

      // The stored answer shows the removed Member's kept name, and the other Member's own name.
      const thread = await talk.thread(id);
      expect(thread?.messages.map(({ name, text }) => [name, text])).toEqual([
        ["Ravi Okafor", "Who paid?"],
        ["AI", "Dana Whitfield paid and Ravi Okafor saved."],
      ]);
      expect(await ai.memberLabels()).toEqual(new Map([["m2", "Member B"]]));

      // The next prompt calls Ravi "Member B", as the earlier answer does.
      await answered(id, "What did Ravi Okafor save?", RAVI);
      const [, , , ...turns] = prompts().at(-1) ?? [];
      expect(turns.map((turn) => [turn.role, textsOf(turn).join("")])).toEqual([
        ["user", "Who paid?"],
        ["assistant", "Member A paid and Member B saved."],
        ["user", "What did Member B save?"],
      ]);
    });

    it("sends the fixed rules, the summary with the cache mark, the tools, Chat's task, and the turns, with at most 1,500 reply tokens", async () => {
      const id = await started("Card 4111\n1111\n1111\n1111 and\tDana Whitfield paid?");
      await answered(id, null);
      await answered(id, "And Ravi\tOkafor?", RAVI);

      expect(modelCalls()).toEqual([
        { tier: "writer", modelId: "writer-model", maxOutputTokens: 1500 },
        { tier: "writer", modelId: "writer-model", maxOutputTokens: 1500 },
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
      // A Member's card split by newlines and a name after a tab, in the characters the AI reads.
      expect(turns.map((turn) => [turn.role, textsOf(turn).join("")])).toEqual([
        ["user", "Card [removed] and Member A paid?"],
        ["assistant", "O"],
        ["user", "And Member B?"],
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
      const sent = JSON.stringify(prompts());
      for (const word of PRIVATE) expect(sent).not.toContain(word);
      // Each Member message and each earlier answer goes as text a Member typed: filtered best
      // effort, never refused.
      expect(
        calls.at(-1)?.changes?.map((turn) => [turn.role, "typed" in turn && turn.typed]),
      ).toEqual([
        ["user", true],
        ["assistant", true],
        ["user", true],
      ]);
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

    it("sends a tool result filtered exactly, with a card split by newlines and a name after a tab removed and no letter escape", async () => {
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
        value: { goals: [{ target: "Merchant: PAID Member A [removed]" }] },
      });
      expect(JSON.stringify(result)).not.toMatch(LETTER_ESCAPE);
      const sent = JSON.stringify(prompts());
      for (const word of PRIVATE) expect(sent).not.toContain(word);
    });

    it("shows an error with no retry when the AI provider fails, stores no answer, and answers again on Try again", async () => {
      stub.answers.writer = "fail";
      const id = await started("How are we doing?");

      const parts = await answered(id, null);

      expect(parts.at(-1)).toEqual({ type: "error", errorText: "The AI provider did not answer." });
      expect(modelCalls()).toHaveLength(1);
      expect((await listChatMessages(test.database, id)).map((row) => row.author)).toEqual([
        "Member",
      ]);

      stub.answers.writer = "work";
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

    it(`sends the last ${CHAT_TURNS} turns, and marks where older ones stop going to the AI`, async () => {
      const id = await started("Turn 1");
      await answered(id, null);
      for (const turn of [3, 5, 7]) await answered(id, `Turn ${turn}`);
      // A 9th message whose answer fails: the next call sends all 9.
      stub.answers.writer = "fail";
      await answered(id, "Turn 9");
      const nine = await talk.thread(id);
      expect(nine?.messages).toHaveLength(9);
      expect(nine?.firstSent).toBeNull();

      stub.answers.writer = "work";
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

      expect(toolResults(prompts().at(-1))).toEqual([
        { type: "json", value: { error: GUARDRAIL.range } },
        { type: "json", value: { result: "shown" } },
        { type: "json", value: { result: "shown" } },
        { type: "json", value: { error: GUARDRAIL.perRun } },
      ]);
      const thread = await talk.thread(id);
      const answer = thread?.messages.at(-1);
      expect(thread?.proposals.map((each) => [each.kind, each.changes, each.runId])).toEqual([
        ["Budget change", ["Restaurants Budget: $600 → $480"], `${id}/${answer?.id}`],
        ["new Goal", [`New Goal: "Save for a car"`], `${id}/${answer?.id}`],
      ]);
      expect(thread?.proposals.map((each) => each.reason)).toEqual([
        "Takeout is steady.",
        "It fits.",
      ]);
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

    it("attaches a note from the AI box, with its numbers as typed values, read from app.db by its ID", async () => {
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
      // Each number the app made goes as a typed value, which the filter sends as written.
      const typed = (calls.at(-1)?.note ?? []).filter((part) => typeof part !== "string");
      expect(typed).toHaveLength(2);
    });
  });

  describe("an Alert note", () => {
    it("goes with its Account as a label, its amounts and dates typed, and its card number left out", async () => {
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
      // $48.21 matches the Account's last 4, 4821, but goes as a typed amount, as the app made it.
      expect(text).toContain("$48.21");
      for (const word of PRIVATE) expect(text).not.toContain(word);
      const typed = (calls.at(-1)?.note ?? []).filter((part) => typeof part !== "string");
      expect(typed.length).toBeGreaterThanOrEqual(3);
    });

    it("keeps the spaces between its pieces, so a Member's name in a Merchant name is left out", async () => {
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
        "$48.21 at Member A Photo on an Account, on 2026-10-17 and 2026-10-18.",
      );
      const sent = JSON.stringify(prompts());
      for (const word of ["Dana", "Whitfield", "DANA", "dana"]) expect(sent).not.toContain(word);
    });
  });
});
