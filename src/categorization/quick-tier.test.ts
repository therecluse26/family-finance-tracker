import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AiGates,
  type AiReply,
  aiCost,
  aiSettings,
  type HouseholdAi,
  householdAi,
  RETRY_DELAYS_MS,
} from "../ai/index.ts";
import { newAiKey, type StubMessage, StubModels } from "../ai/testing.ts";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { CATEGORIES } from "../categories/index.ts";
import {
  deleteRemovedConnection,
  markConnectionRemoved,
  readAiRedo,
  readAiRetry,
  storeCategoryRule,
} from "../db/index.ts";
import { followUpAgain, runFollowUp } from "../follow-up/index.ts";
import { K7_LINES } from "../large-history/index.ts";
import { merchantKey } from "../merchants/index.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import { openReviewItems, type ReviewItem } from "../review/index.ts";
import {
  AI_UNSURE_KIND,
  BEST_GUESS_KIND,
  categorize,
  provenance,
  startCategorization,
} from "./index.ts";
import { CATEGORY_FIX_TASK, fixCategories, MERCHANT_CLEANUP_TASK } from "./quick-tier.ts";

// Cascade step 5 and AI cleanup of Merchant names on the Quick tier (spec 04, The categorization
// cascade, Names, AI decisions, Review list items; spec 08, Every AI use, Limits on each call,
// Failures). Transactions arrive through the fake adapter; the AI is AI SDK test models. No test
// calls an AI provider.

const NOW = () => new Date("2026-11-01T14:00:00.000Z");
const BANK = "fake-first-bank";
const CARD = fakeAccount({
  id: "acc-card",
  name: "Everyday Card",
  type: "credit",
  subtype: "credit card",
});
const PRICE = { input: 1_000_000, output: 2_000_000 };

// A card number that passes the Luhn check, made at test time. Its digits are drawn from 3, 5, 6,
// and 9, so no group of it is a stored last 4.
function newCardNumber(): string {
  const digits = [
    4,
    ...Array.from({ length: 14 }, () => [3, 5, 6, 9][Math.floor(Math.random() * 4)] ?? 3),
  ];
  const doubled = (digit: number) => (digit * 2 > 9 ? digit * 2 - 9 : digit * 2);
  const sum = digits
    .toReversed()
    .reduce((total, digit, place) => total + (place % 2 === 0 ? doubled(digit) : digit), 0);
  return [...digits, (10 - (sum % 10)) % 10].join("");
}

type Row = Record<string, unknown> & { row: number };
// One call the test models answered: its use, by its task, and its rows as the model read them.
type Asked = { use: "category fix" | "merchant cleanup"; rows: Row[]; texts: string[] };

type PartRow = { category: string | null; source: string | null; confidence: string | null };

describe("the Quick tier in the categorization step", () => {
  let bank: TestBank;
  let stub: StubModels;
  let stops: (() => void)[];
  let connectionId: string;
  let asked: Asked[];
  let historyLoaded: boolean;
  let pausedUntil: string | undefined;
  // How the AI answers each row of a Category fix, and of AI cleanup.
  let answerCategory: (row: Row) => { category: string; confidence: string };
  let answerName: (row: Row) => string;

  const gates: AiGates = {
    historyLoaded: async () => historyLoaded,
    costCapPausedUntil: async () => pausedUntil,
  };
  const aiOptions = () => ({
    database: bank.database,
    secrets: bank.secrets,
    makeModels: stub.makeModels,
    cost: aiCost({ database: bank.database }),
    gates,
    notices: { raise: async () => undefined, end: async () => undefined },
  });
  const connectAi = async () => {
    const saved = await aiSettings(aiOptions()).save({
      provider: "anthropic",
      apiKey: newAiKey(),
      baseUrl: null,
      quickModel: "quick-model",
      writerModel: "writer-model",
      prices: { quick: PRICE, writer: PRICE },
    });
    expect(saved).toMatchObject({ saved: true });
    // The two checks on save are not Quick batches.
    asked = [];
  };

  // The rows the model read: each Quick batch row is its own text, a JSON object.
  const readCall = (messages: StubMessage[]): Asked | undefined => {
    const texts = messages
      .filter((message) => message.role === "user")
      .flatMap((message) =>
        typeof message.content === "string"
          ? [message.content]
          : message.content.flatMap((part) => (part.text === undefined ? [] : [part.text])),
      );
    const use = texts.includes(CATEGORY_FIX_TASK)
      ? "category fix"
      : texts.includes(MERCHANT_CLEANUP_TASK)
        ? "merchant cleanup"
        : undefined;
    if (use === undefined) return undefined;
    // A row that is not JSON reads as row 0, with its text.
    const rows = texts
      .filter((text) => text.startsWith("{"))
      .map((text) => {
        try {
          return JSON.parse(text) as Row;
        } catch {
          return { row: 0, broken: text };
        }
      });
    return { use, rows, texts };
  };

  const idOf = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT id FROM transactions WHERE provider_transaction_id = ? AND hidden_reason IS NULL",
      args: [providerId],
    });
    return String(rows.rows[0]?.id);
  };
  const partOf = async (providerId: string): Promise<PartRow & { needsAi: number }> => {
    const rows = await bank.database.$client.execute({
      sql: `SELECT p.category, p.category_source AS source, p.category_confidence AS confidence,
              p.category_needs_ai AS needsAi
            FROM transaction_parts p JOIN transactions t ON t.id = p.transaction_id
            WHERE t.provider_transaction_id = ? AND t.hidden_reason IS NULL ORDER BY p.part`,
      args: [providerId],
    });
    return { ...rows.rows[0] } as unknown as PartRow & { needsAi: number };
  };
  const nameOf = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: `SELECT merchant_clean_name AS name, merchant_needs_ai AS needsAi FROM transactions
            WHERE provider_transaction_id = ? AND hidden_reason IS NULL`,
      args: [providerId],
    });
    return { ...rows.rows[0] } as { name: string | null; needsAi: number };
  };
  const itemsOf = async (kind: string) =>
    (await openReviewItems(bank.database)).filter((item) => item.kind === kind);
  const transactionIdsOf = (item: ReviewItem) =>
    item.subject.type === "transactions" ? item.subject.transactionIds : [];
  const sync = async (...pages: Parameters<TestBank["fake"]["addPages"]>[1][]) => {
    bank.fake.addPages(BANK, ...pages);
    await syncConnection(connectionId, NOW);
    return runFollowUp(NOW);
  };
  const callsOf = (use: Asked["use"]) => asked.filter((call) => call.use === use);

  // A purchase on the card whose provider category is too unsure for step 3, at a Merchant with no
  // history: the cascade asks the AI.
  const buy = (
    id: string,
    postedDate: string,
    fields: Partial<TxnRecord> = {},
    code = "FOOD_AND_DRINK_RESTAURANT",
  ): TxnRecord =>
    fakeTxn({
      id,
      accountId: CARD.id,
      amount: -2_500,
      postedDate,
      description: `CARD PURCHASE ${id.toUpperCase()}`,
      merchantName: `Merchant ${id}`,
      category: { name: code, confidence: "LOW", version: "v2", mcc: null },
      ...fields,
    });

  beforeEach(async () => {
    bank = await newTestBank();
    stub = new StubModels();
    asked = [];
    historyLoaded = true;
    pausedUntil = undefined;
    answerCategory = () => ({ category: "Restaurants", confidence: "high" });
    answerName = (row) => String(row.description).split(" ")[0] ?? "";
    stub.replyTo = (messages) => {
      const call = readCall(messages);
      if (call === undefined) return "O";
      asked.push(call);
      const answers = call.rows.map((row) =>
        call.use === "category fix"
          ? { row: row.row, ...answerCategory(row) }
          : { row: row.row, name: answerName(row) },
      );
      return JSON.stringify({ answers });
    };
    stops = [
      startMoneyMovement({ database: bank.database }).stop,
      startCategorization({ database: bank.database, ai: householdAi(aiOptions()) }).stop,
    ];
    connectionId = await bank.connect(BANK);
    bank.fake.addPages(BANK, { accounts: [CARD] });
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  describe("the Category fix, cascade step 5", () => {
    it("sends a batch of 250 as 100, 100, and 50, in normal calls, and applies every answer", async () => {
      await connectAi();
      const added = Array.from({ length: 250 }, (_, index) =>
        buy(`t${String(index).padStart(3, "0")}`, "2026-10-01"),
      );

      expect(await sync({ added })).toBeUndefined();

      expect(callsOf("category fix").map((call) => call.rows.length)).toEqual([100, 100, 50]);
      expect(stub.calls.slice(2).every((call) => call.tier === "quick")).toBe(true);
      expect(await partOf("t000")).toEqual({
        category: "Restaurants",
        source: "AI",
        confidence: "high",
        needsAi: 0,
      });
      expect(await partOf("t249")).toMatchObject({ source: "AI" });
      expect(await itemsOf(AI_UNSURE_KIND)).toEqual([]);
    });

    it("asks and stores 2,500 Transactions with 2,500 marked names in a few seconds", async () => {
      await connectAi();
      // 400 Merchants. The AI answers the first 3 of each; Merchant history answers the rest.
      answerName = (row) => String(row.description).replace(" AUSTIN TX", "");
      answerCategory = (row) => ({
        category: Number(String(row.date).slice(-2)) % 2 === 0 ? "Restaurants" : "Pets",
        confidence: "low",
      });
      const added = Array.from({ length: 2_500 }, (_, index) =>
        buy(`big-${index}`, `2026-10-${String((index % 28) + 1).padStart(2, "0")}`, {
          merchantName: null,
          description: `SHOP ${String.fromCharCode(65 + (index % 20), 65 + (Math.floor(index / 20) % 20))} AUSTIN TX`,
        }),
      );
      bank.fake.addPages(BANK, { added });
      await syncConnection(connectionId, NOW);

      // The limit is on the follow-up job's own work: the CPU time this test worker spends on it,
      // which a busy host does not stretch. The setup before it counts only toward the timeout.
      const started = process.cpuUsage();
      expect(await runFollowUp(NOW)).toBeUndefined();
      const used = process.cpuUsage(started);
      const took = (used.user + used.system) / 1_000;

      expect(callsOf("merchant cleanup").map((call) => call.rows.length)).toEqual([
        100, 100, 100, 100,
      ]);
      expect(callsOf("category fix").flatMap((call) => call.rows)).toHaveLength(1_200);
      // One card for each Merchant, with each of its 3 unsure Transactions.
      const cards = await itemsOf(AI_UNSURE_KIND);
      expect(cards).toHaveLength(400);
      expect(cards.flatMap(transactionIdsOf)).toHaveLength(1_200);
      expect(cards.every((card) => transactionIdsOf(card).length === 3)).toBe(true);
      expect(took).toBeLessThan(5_000);
    }, 30_000);

    it("sends the Merchant, bank description, amount, date, Account label, and provider category, by row number with no ID", async () => {
      await connectAi();
      await sync({
        added: [
          buy("plain", "2026-10-03"),
          buy("with-mcc", "2026-10-04", {
            category: {
              name: "GENERAL_SERVICES_OTHER",
              confidence: null,
              version: "v2",
              mcc: "7299",
            },
          }),
        ],
      });

      const [call] = callsOf("category fix");
      expect(call?.rows).toEqual([
        {
          row: 1,
          merchant: "Merchant plain",
          description: "CARD PURCHASE PLAIN",
          amount: "-25.00",
          date: "2026-10-03",
          account: expect.any(String),
          providerCategory: "FOOD_AND_DRINK_RESTAURANT",
        },
        {
          row: 2,
          merchant: "Merchant with-mcc",
          description: "CARD PURCHASE WITH-MCC",
          amount: "-25.00",
          date: "2026-10-04",
          account: call?.rows[0]?.account,
          providerCategory: "GENERAL_SERVICES_OTHER",
          mcc: "7299",
        },
      ]);
      const ids = [await idOf("plain"), await idOf("with-mcc")];
      expect(JSON.stringify(call?.texts)).not.toMatch(new RegExp(ids.join("|")));
    });

    it("counts a medium answer as decided, off the Review list, and shows it as AI, unsure", async () => {
      await connectAi();
      answerCategory = () => ({ category: "Pets", confidence: "medium" });
      await sync({ added: [buy("medium", "2026-10-05")] });

      expect(await partOf("medium")).toEqual({
        category: "Pets",
        source: "AI",
        confidence: "medium",
        needsAi: 0,
      });
      expect(provenance({ source: "AI", confidence: "medium" })).toBe("AI, unsure");
      expect(await itemsOf(AI_UNSURE_KIND)).toEqual([]);
      expect(await itemsOf(BEST_GUESS_KIND)).toEqual([]);
    });

    it("puts a low answer on the Review list as AI, unsure, and a later high answer takes it off", async () => {
      await connectAi();
      answerCategory = () => ({ category: "Pets", confidence: "low" });
      await sync({ added: [buy("unsure", "2026-10-05")] });

      const part = await partOf("unsure");
      expect(part).toEqual({ category: "Pets", source: "AI", confidence: "low", needsAi: 0 });
      expect(provenance({ source: "AI", confidence: "low" })).toBe("AI, unsure");
      expect(provenance({ source: "AI", confidence: "high" })).toBe("AI");
      expect(await itemsOf(AI_UNSURE_KIND)).toMatchObject([
        {
          subject: { type: "transactions", transactionIds: [await idOf("unsure")] },
          bestAnswer: { value: "Pets", label: "Yes, Pets" },
        },
      ]);
      expect(await itemsOf(BEST_GUESS_KIND)).toEqual([]);

      // A provider change runs the cascade again, and the AI is sure this time.
      answerCategory = () => ({ category: "Pets", confidence: "high" });
      await sync({ changed: [buy("unsure", "2026-10-05", { amount: -2_600 })] });

      expect(await partOf("unsure")).toMatchObject({ source: "AI", confidence: "high" });
      expect(await itemsOf(AI_UNSURE_KIND)).toEqual([]);
    });

    it("refuses a Category outside the list as a bad reply, which goes again in halves, then down the retry path, then the no-AI path", async () => {
      await connectAi();
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-01T14:00:00.000Z") });
      answerCategory = () => ({ category: "Snacks", confidence: "high" });
      expect(CATEGORIES.map((category) => category.name)).not.toContain("Snacks");
      const added = Array.from({ length: 150 }, (_, index) => buy(`r${index}`, "2026-10-06"));

      const stopped = await sync({ added });

      expect(stopped).toEqual({ stoppedAt: "categorization", again: expect.any(Date) });
      expect(await readAiRetry(bank.database, "category fix")).toMatchObject({ failures: 1 });
      expect(await partOf("r0")).toMatchObject({ category: null, source: null });
      // The batch goes again as two halves, and the third bad reply in a row is an AI error.
      expect(callsOf("category fix").map((call) => call.rows.length)).toEqual([100, 50, 50]);

      // Each retry is one call; the step stops again until the last retry fails.
      for (const delay of RETRY_DELAYS_MS) {
        vi.setSystemTime(Date.now() + delay);
        asked = [];
        const run = await runFollowUp(NOW);
        expect(callsOf("category fix")).toHaveLength(1);
        if (delay !== RETRY_DELAYS_MS.at(-1))
          expect(run).toMatchObject({ stoppedAt: "categorization" });
        else expect(run).toBeUndefined();
      }

      // After the last retry, the whole step takes the no-AI path: no second batch is asked.
      expect(await readAiRetry(bank.database, "category fix")).toBeUndefined();
      expect(await partOf("r0")).toEqual({
        category: "Restaurants",
        source: "best guess",
        confidence: "low",
        needsAi: 1,
      });
      expect(await partOf("r149")).toMatchObject({ source: "best guess", needsAi: 1 });
      expect(await itemsOf(BEST_GUESS_KIND)).toHaveLength(150);
    });

    it("keeps 99 answers when one row of 100 fails its schema, and the row left keeps its best guess and mark", async () => {
      await connectAi();
      answerCategory = (row) =>
        row.description === "CARD PURCHASE R37"
          ? { category: "Snacks", confidence: "high" }
          : { category: "Pets", confidence: "high" };
      const added = Array.from({ length: 100 }, (_, index) => buy(`r${index}`, "2026-10-06"));

      expect(await sync({ added })).toBeUndefined();

      // The bad row goes once more alone, then keeps its no-AI result.
      expect(callsOf("category fix").map((call) => call.rows.length)).toEqual([100, 1]);
      expect(await partOf("r36")).toMatchObject({ category: "Pets", source: "AI", needsAi: 0 });
      expect(await partOf("r38")).toMatchObject({ category: "Pets", source: "AI", needsAi: 0 });
      expect(await partOf("r37")).toMatchObject({ source: "best guess", needsAi: 1 });
      expect(await readAiRetry(bank.database, "category fix")).toBeUndefined();
    });

    it("goes on to the next batch after a bad reply, which is not an outage", async () => {
      await connectAi();
      // The first call and the second half of its batch answer badly; the rest answer well.
      let call = 0;
      const replyTo = stub.replyTo;
      stub.replyTo = (messages) => {
        const reply = replyTo?.(messages) ?? "O";
        call += 1;
        return call === 1 || call === 3 ? "Here are your answers!" : reply;
      };
      const added = Array.from({ length: 150 }, (_, index) =>
        buy(`r${String(index).padStart(3, "0")}`, "2026-10-06"),
      );

      expect(await sync({ added })).toBeUndefined();

      expect(callsOf("category fix").map((each) => each.rows.length)).toEqual([100, 50, 50, 50]);
      // The rows of the bad half keep their best guesses and marks.
      const [, good, bad, next] = callsOf("category fix").map((each) =>
        each.rows.map((row) => String(row.description).replace("CARD PURCHASE ", "").toLowerCase()),
      );
      for (const id of [good?.[0], next?.[0]]) {
        expect(await partOf(String(id))).toMatchObject({ source: "AI", needsAi: 0 });
      }
      expect(await partOf(String(bad?.[0]))).toMatchObject({ source: "best guess", needsAi: 1 });
      expect(await partOf(String(bad?.[49]))).toMatchObject({ source: "best guess", needsAi: 1 });
      expect(await readAiRetry(bank.database, "category fix")).toBeUndefined();
      expect(await readAiRedo(bank.database)).toMatchObject({ awayAt: null });
    });

    it("lets the later batches go after a bad reply, and stops them after a failed call with no retry left", async () => {
      const row = {
        merchant: null,
        description: "CARD PURCHASE",
        amount: -25,
        date: "2026-10-06",
        account: null,
        providerCategory: null,
        mcc: null,
      };
      const answering = (reply: AiReply<{ answers: never[] }>) =>
        ({ generate: async () => reply }) as unknown as HouseholdAi;

      expect(
        await fixCategories(answering({ ready: false, failed: "bad reply", badReply: true }), [
          row,
        ]),
      ).toEqual({ noAi: "bad reply" });
      expect(await fixCategories(answering({ ready: false, failed: "bad reply" }), [row])).toEqual({
        noAi: "off",
      });
    });

    it("reads the AI's answers in step 4, so the fourth of a new Merchant takes its history, in one call", async () => {
      await connectAi();
      answerCategory = () => ({ category: "Hobbies", confidence: "high" });
      const shop = { merchantName: "Bluebird Books" };

      await sync({
        added: [
          buy("b1", "2026-10-01", shop),
          buy("b2", "2026-10-02", shop),
          buy("b3", "2026-10-03", shop),
          buy("b4", "2026-10-04", shop),
          buy("other", "2026-10-05"),
        ],
      });

      // The fourth waits on the first three, so it joins their batch, and step 4 wins once the
      // answers come.
      expect(callsOf("category fix").map((call) => call.rows.length)).toEqual([5]);
      expect(await partOf("b3")).toMatchObject({ category: "Hobbies", source: "AI" });
      expect(await partOf("b4")).toMatchObject({ category: "Hobbies", source: "Merchant history" });
      expect(await partOf("other")).toMatchObject({ category: "Hobbies", source: "AI" });
    });

    it("asks about 200 Transactions of one new Merchant whose answers differ in 2 calls", async () => {
      await connectAi();
      answerCategory = (row) => ({
        category: Number(String(row.date).slice(-2)) % 2 === 0 ? "Hobbies" : "Clothing",
        confidence: "high",
      });
      const shop = { merchantName: "Mixed Mart" };
      const added = Array.from({ length: 200 }, (_, index) =>
        buy(
          `m${String(index).padStart(3, "0")}`,
          `2026-${String(Math.floor(index / 28) + 3).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`,
          shop,
        ),
      );

      expect(await sync({ added })).toBeUndefined();

      expect(callsOf("category fix").map((call) => call.rows.length)).toEqual([100, 100]);
      expect(await partOf("m000")).toMatchObject({ category: "Clothing", source: "AI" });
      expect(await partOf("m001")).toMatchObject({ category: "Hobbies", source: "AI" });
      expect(await partOf("m199")).toMatchObject({ source: "AI" });
    });

    it.each([
      ["no AI provider is set up", async () => {}],
      [
        "the first history load holds AI back",
        async () => {
          await connectAi();
          historyLoaded = false;
        },
      ],
      [
        "the month is at the AI cost cap",
        async () => {
          await connectAi();
          pausedUntil = "2026-12-01";
        },
      ],
    ])(
      "takes step 6 and keeps the rule-cleaned name, both marked for the redo, when %s",
      async (_, setUp) => {
        await setUp();
        await sync({
          added: [
            buy("guessed", "2026-10-07"),
            buy("chain", "2026-10-07", { merchantName: null, description: "CHIPOTLE AUSTIN TX" }),
          ],
        });

        expect(asked).toEqual([]);
        expect(await partOf("guessed")).toEqual({
          category: "Restaurants",
          source: "best guess",
          confidence: "low",
          needsAi: 1,
        });
        expect(await nameOf("chain")).toEqual({ name: "Chipotle Austin Tx", needsAi: 1 });
        expect(await itemsOf(BEST_GUESS_KIND)).toHaveLength(2);
      },
    );

    it("leaves step 5 to the follow-up job when Money movement decides a Transaction again", async () => {
      await connectAi();
      stub.answers.quick = "fail";
      await sync({ added: [buy("again", "2026-10-08")] });
      expect(await partOf("again")).toMatchObject({ category: null, source: null });
      stub.answers.quick = "work";
      const calls = stub.calls.length;

      const id = await idOf("again");
      expect(await categorize(bank.database, [id], "follow-up job")).toEqual({
        left: [id],
        again: undefined,
        answered: 0,
      });
      expect(stub.calls.length).toBe(calls);
      expect(await partOf("again")).toMatchObject({ category: null, source: null });
    });
  });

  describe("AI cleanup of Merchant names", () => {
    it("cleans each marked description once, before the cascade reads the name, and reuses the answer", async () => {
      await connectAi();
      answerName = (row) =>
        String(row.description).startsWith("CHIPOTLE") ? "Chipotle" : "Best Buy";
      await storeCategoryRule(
        bank.database,
        {
          merchantId: null,
          merchantName: "Chipotle",
          merchantKey: merchantKey("Chipotle"),
          category: "Restaurants",
          madeAt: new Date(),
          madeBy: null,
        },
        [],
      );
      const line = (id: string, description: string, postedDate = "2026-10-09") =>
        buy(id, postedDate, { merchantName: null, description });

      await sync({
        added: [
          line("austin", "CHIPOTLE AUSTIN TX"),
          line("austin-2", "CHIPOTLE AUSTIN TX"),
          line("best-buy", "BEST BUY CO", "2026-10-10"),
          // A provider name is never sent for cleanup.
          buy("named", "2026-10-09", {
            merchantName: "Chipotle",
            description: "CHIPOTLE AUSTIN TX",
          }),
        ],
      });

      expect(callsOf("merchant cleanup").map((call) => call.rows)).toEqual([
        [
          { row: 1, description: "CHIPOTLE AUSTIN TX" },
          { row: 2, description: "BEST BUY CO" },
        ],
      ]);
      expect(await nameOf("austin")).toEqual({ name: "Chipotle", needsAi: 0 });
      expect(await nameOf("austin-2")).toEqual({ name: "Chipotle", needsAi: 0 });
      expect(await nameOf("best-buy")).toEqual({ name: "Best Buy", needsAi: 0 });
      // The Category rule for the clean name wins at step 2.
      expect(await partOf("austin")).toMatchObject({
        category: "Restaurants",
        source: "Category rule",
      });

      asked = [];
      await sync({ added: [line("austin-3", "CHIPOTLE AUSTIN TX", "2026-10-11")] });
      expect(callsOf("merchant cleanup")).toEqual([]);
      expect(await nameOf("austin-3")).toEqual({ name: "Chipotle", needsAi: 0 });
    });

    it("sends the hard Merchant lines the cleanup rules mark, through the real rules, as they are", async () => {
      await connectAi();
      answerName = () => "Clean Name";
      const lines = [...K7_LINES];
      await sync({
        added: lines.map((description, index) =>
          buy(`k7-${index}`, "2026-10-11", { merchantName: null, description }),
        ),
      });

      const sent = callsOf("merchant cleanup").flatMap((call) =>
        call.rows.map((row) => row.description),
      );
      // A payment-app line is its app or its person, and a fixed name is not marked.
      expect(sent.toSorted()).toEqual([
        "(800) 555-1212",
        "BEST BUY CO",
        "REF#12345678",
        "XXXX4821",
      ]);
      const marked = new Set(["BEST BUY CO", "XXXX4821", "REF#12345678", "(800) 555-1212"]);
      for (const [index, description] of lines.entries()) {
        const name = await nameOf(`k7-${index}`);
        expect(name.needsAi).toBe(0);
        expect(name.name === "Clean Name").toBe(marked.has(description));
      }
    });

    it("keeps a name the provider gave while the AI was answering", async () => {
      await connectAi();
      answerName = () => "Chipotle";
      stub.beforeAnswer = async () => {
        stub.beforeAnswer = async () => {};
        // The provider's change, stored by a sync while the cleanup call runs.
        await bank.database.$client.execute(
          `UPDATE transactions SET merchant_clean_name = 'Chipotle Mexican Grill', merchant_needs_ai = 0
           WHERE provider_transaction_id = 'changed'`,
        );
      };

      await sync({
        added: [
          buy("changed", "2026-10-09", { merchantName: null, description: "CHIPOTLE AUSTIN TX" }),
          buy("kept", "2026-10-10", { merchantName: null, description: "CHIPOTLE AUSTIN TX" }),
        ],
      });

      expect(callsOf("merchant cleanup")).toHaveLength(1);
      expect(await nameOf("changed")).toEqual({ name: "Chipotle Mexican Grill", needsAi: 0 });
      expect(await nameOf("kept")).toEqual({ name: "Chipotle", needsAi: 0 });
    });

    it("never sends or names a hidden Transaction", async () => {
      await sync({
        added: [buy("gone", "2026-10-09", { merchantName: null, description: "BEST BUY CO" })],
      });
      const id = await idOf("gone");
      await sync({ removed: [{ id: "gone" }] });
      await connectAi();

      // Marked again for the follow-up job, as another step may do.
      await followUpAgain(bank.database, [id]);
      await runFollowUp(NOW);

      expect(asked).toEqual([]);
      const rows = await bank.database.$client.execute({
        sql: "SELECT merchant_clean_name AS name, merchant_needs_ai AS needsAi FROM transactions WHERE id = ?",
        args: [id],
      });
      expect({ ...rows.rows[0] }).toEqual({ name: "Best Buy Co", needsAi: 1 });
    });

    it("deletes a kept answer with the last history that holds its description", async () => {
      await connectAi();
      answerName = (row) => (String(row.description).startsWith("BEST") ? "Best Buy" : "Chipotle");
      const other = await bank.connect("fake-second-bank");
      const SECOND = fakeAccount({ id: "acc-second", name: "Second Card", type: "credit" });
      bank.fake.addPages("fake-second-bank", {
        accounts: [SECOND],
        added: [
          {
            ...buy("shared", "2026-10-09", { merchantName: null }),
            accountId: SECOND.id,
            description: "BEST BUY CO",
          },
        ],
      });
      await syncConnection(other, NOW);
      await sync({
        added: [
          buy("mine", "2026-10-09", { merchantName: null, description: "BEST BUY CO" }),
          buy("only-mine", "2026-10-09", { merchantName: null, description: "CHIPOTLE AUSTIN TX" }),
        ],
      });
      const kept = async () =>
        (
          await bank.database.$client.execute(
            "SELECT description FROM merchant_name_answers ORDER BY description",
          )
        ).rows.map((row) => row.description);
      expect(await kept()).toEqual(["BEST BUY CO", "CHIPOTLE AUSTIN TX"]);

      expect(await markConnectionRemoved(bank.database, connectionId, NOW())).toMatchObject({
        removed: true,
      });
      expect(await deleteRemovedConnection(bank.database, connectionId, NOW())).toBeDefined();

      expect(await kept()).toEqual(["BEST BUY CO"]);
    });

    it("waits for the AI retry before the cascade reaches a Transaction whose name waits", async () => {
      await connectAi();
      stub.answers.quick = "rate limit";
      const stopped = await sync({
        added: [
          buy("before", "2026-10-01"),
          buy("waits", "2026-10-02", { merchantName: null, description: "BEST BUY CO" }),
          buy("after", "2026-10-03"),
        ],
      });

      expect(stopped).toEqual({ stoppedAt: "categorization", again: expect.any(Date) });
      expect(await readAiRetry(bank.database, "merchant cleanup")).toMatchObject({ failures: 1 });
      expect(await nameOf("waits")).toEqual({ name: "Best Buy Co", needsAi: 1 });
      expect(await partOf("waits")).toMatchObject({ source: null });
      expect(await partOf("after")).toMatchObject({ source: null });
    });
  });

  describe("each row as the AI reads it", () => {
    it("writes each value on its own, so every row stays one JSON object with its own row number", async () => {
      await bank.database.$client.execute(
        `INSERT INTO members (id, name, email, created_at, updated_at)
         VALUES ('member-1', 'Dana Whitfield', 'dana@example.com', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
      );
      await connectAi();
      const card = newCardNumber();
      const spaced = card.replace(/(\d{4})(?=\d)/g, "$1 ");
      const split = `${card.slice(0, 8)}\n${card.slice(8)}`;
      await sync({
        added: [
          buy("spaced", "2026-10-12", { description: spaced }),
          buy("split", "2026-10-12", { description: `PAYPAL ${split}\tDANA` }),
          buy("glued", "2026-10-12", { description: `ZELLE TO DANAWHITFIELD ${card}` }),
          buy("slashed", "2026-10-12", { description: `REF 7\\${spaced}\\` }),
          buy("quoted", "2026-10-12", { description: `"${card.slice(0, 8)}"${card.slice(8)}"` }),
        ],
      });

      const [call] = callsOf("category fix");
      expect(call?.rows.map((row) => row.row)).toEqual([1, 2, 3, 4, 5]);
      expect(call?.rows.map((row) => row.description).toSorted()).toEqual(
        [
          spaced,
          `PAYPAL ${card.slice(0, 8)} ${card.slice(8)} DANA`,
          `ZELLE TO DANAWHITFIELD ${card}`,
          `REF 7\\${spaced}\\`,
          `"${card.slice(0, 8)}"${card.slice(8)}"`,
        ].toSorted(),
      );
      // Each control character is a space, so the model reads no escape that puts a letter in.
      for (const text of call?.texts ?? []) expect(text).not.toMatch(/\\[a-z]/i);
    });

    it("sends an amount and a description whose digits are an Account's last 4 as they are", async () => {
      await connectAi();
      const savings = fakeAccount({ id: "acc-savings", subtype: "savings", mask: "4821" });
      await sync({
        accounts: [CARD, savings],
        added: [
          buy("same-digits", "2026-10-12", {
            amount: -4_821,
            description: "PURCHASE 4821 BLUEBIRD BOOKS",
          }),
        ],
      });

      const [fix] = callsOf("category fix");
      expect(fix?.rows).toEqual([
        expect.objectContaining({
          row: 1,
          description: "PURCHASE 4821 BLUEBIRD BOOKS",
          amount: "-48.21",
          date: "2026-10-12",
        }),
      ]);
      for (const text of fix?.texts ?? []) expect(text).not.toMatch(/\\[a-z]/i);
    });

    it("keeps a cleanup row whole when its description is only a card number", async () => {
      await connectAi();
      const spaced = newCardNumber().replace(/(\d{4})(?=\d)/g, "$1 ");
      answerName = () => "Clean Name";
      await sync({
        added: [
          buy("before", "2026-10-12", { merchantName: null, description: "BEST BUY CO" }),
          buy("card", "2026-10-13", { merchantName: null, description: spaced }),
          buy("after", "2026-10-14", { merchantName: null, description: "CHIPOTLE AUSTIN TX" }),
        ],
      });

      const [call] = callsOf("merchant cleanup");
      expect(call?.rows).toEqual([
        { row: 1, description: "BEST BUY CO" },
        { row: 2, description: spaced },
        { row: 3, description: "CHIPOTLE AUSTIN TX" },
      ]);
      expect(await nameOf("after")).toEqual({ name: "Clean Name", needsAi: 0 });
    });
  });
});
