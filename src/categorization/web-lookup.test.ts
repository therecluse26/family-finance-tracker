import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AiGates, aiCost, aiSettings, type HouseholdAi, householdAi } from "../ai/index.ts";
import { webSearchTools } from "../ai/providers.ts";
import { newAiKey, type StubMessage, StubModels } from "../ai/testing.ts";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import {
  countMerchantLookups,
  deleteRemovedConnection,
  markConnectionRemoved,
  readMerchantLookups,
  reserveMerchantLookup,
  storeMerchantLookup,
  storeWebLookupSwitch,
} from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { K7_LINES } from "../large-history/index.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import { runRedo, startRedo } from "../redo/index.ts";
import { answerReviewItem, openReviewItems } from "../review/index.ts";
import {
  AI_UNSURE_KIND,
  provenance,
  startCategorization,
  transactionWebLookupLine,
} from "./index.ts";
import { CATEGORY_FIX_TASK, MERCHANT_CLEANUP_TASK } from "./quick-tier.ts";
import {
  LOOKUPS_A_RUN,
  type LookupLine,
  lookupKeys,
  MERCHANT_LOOKUP_TASK,
  skipsLookup,
} from "./web-lookup.ts";

// The Web lookup (spec 04, Web lookup; spec 08, Merchant web lookup): when the Category fix is
// unsure of a Merchant it does not know, the AI provider's own web search looks the Merchant up.
// Transactions arrive through the fake adapter; the AI is AI SDK test models behind the real
// privacy filter, and each search is a provider-executed tool call in the test model's reply. No
// test calls an AI provider or a search.

const NOW = () => new Date("2026-11-01T14:00:00.000Z");
const BANK = "fake-first-bank";
const CARD = fakeAccount({
  id: "acc-card",
  name: "Everyday Card",
  type: "credit",
  subtype: "credit card",
});
const PRICE = { input: 1_000_000, output: 2_000_000 };
const DAY = 86_400_000;

type Row = Record<string, unknown> & { row: number };
type Use = "category fix" | "merchant cleanup" | "merchant lookup";
// One call the test models answered: its use, by its task, its rows, and the other texts it read.
type Asked = { use: Use; rows: Row[]; texts: string[] };
type CategoryAnswer = { category: string; confidence: string; needsLookup?: boolean };
type LookupAnswer = {
  found: boolean;
  category: string | null;
  confidence: string;
  description: string;
};

const found = (category: string, confidence = "high", description = "A pet supply shop.") => ({
  found: true,
  category,
  confidence,
  description,
});

describe("the Web lookup in the categorization step", () => {
  let bank: TestBank;
  let stub: StubModels;
  let stops: (() => void)[];
  let connectionId: string;
  let asked: Asked[];
  let lines: string[];
  // How the AI answers each Category fix row, each AI cleanup row, and each lookup, by its Merchant.
  let answerCategory: (row: Row) => CategoryAnswer;
  let answerName: (row: Row) => string;
  let answerLookup: (merchant: string) => LookupAnswer | string;

  const gates: AiGates = {
    historyLoaded: async () => true,
    costCapPausedUntil: async () => undefined,
  };
  const aiOptions = () => ({
    database: bank.database,
    secrets: bank.secrets,
    makeModels: stub.makeModels,
    cost: aiCost({ database: bank.database }),
    gates,
    notices: { raise: async () => undefined, end: async () => undefined },
  });
  const connectAi = async (provider: "anthropic" | "openai-compatible" = "anthropic") => {
    const saved = await aiSettings(aiOptions()).save({
      provider,
      apiKey: provider === "anthropic" ? newAiKey() : undefined,
      baseUrl: provider === "anthropic" ? null : "http://192.168.1.50:8080/v1",
      quickModel: "quick-model",
      writerModel: "writer-model",
      prices: { quick: PRICE, writer: PRICE },
    });
    expect(saved).toMatchObject({ saved: true });
    asked = [];
  };

  const textsOf = (messages: StubMessage[]) =>
    messages.flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) => (part.text === undefined ? [] : [part.text])),
    );
  const readCall = (messages: StubMessage[]): Asked | undefined => {
    const texts = textsOf(messages.filter((message) => message.role === "user"));
    const use: Use | undefined = texts.includes(CATEGORY_FIX_TASK)
      ? "category fix"
      : texts.includes(MERCHANT_CLEANUP_TASK)
        ? "merchant cleanup"
        : texts.includes(MERCHANT_LOOKUP_TASK)
          ? "merchant lookup"
          : undefined;
    if (use === undefined) return undefined;
    const rows = texts
      .filter((text) => text.startsWith("{"))
      .map((text) => JSON.parse(text) as Row);
    return { use, rows, texts: texts.filter((text) => !text.startsWith("{")) };
  };
  const callsOf = (use: Use) => asked.filter((call) => call.use === use);
  // The Merchant each lookup sent, from its one line "Merchant: <name>".
  const lookedUp = () =>
    callsOf("merchant lookup").map((call) =>
      (call.texts.find((text) => text.startsWith("Merchant: ")) ?? "").slice("Merchant: ".length),
    );

  const idOf = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT id FROM transactions WHERE provider_transaction_id = ? AND hidden_reason IS NULL",
      args: [providerId],
    });
    return String(rows.rows[0]?.id);
  };
  const partOf = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: `SELECT p.category, p.category_source AS source, p.category_confidence AS confidence,
              p.category_needs_ai AS needsAi
            FROM transaction_parts p JOIN transactions t ON t.id = p.transaction_id
            WHERE t.provider_transaction_id = ? AND t.hidden_reason IS NULL ORDER BY p.part`,
      args: [providerId],
    });
    return { ...rows.rows[0] };
  };
  const kept = async () =>
    (
      await bank.database.$client.execute(
        "SELECT merchant_key AS key, outcome, category, confidence, description FROM merchant_lookups ORDER BY merchant_key",
      )
    ).rows.map((row) => ({ ...row }));
  const itemsOf = async (kind: string) =>
    (await openReviewItems(bank.database)).filter((item) => item.kind === kind);
  // A Member, Morgan Lee, whose name the privacy filter takes out.
  const addMorgan = () =>
    bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('member-1', 'Morgan Lee', 'morgan@example.com', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    );
  const sync = async (...pages: Parameters<TestBank["fake"]["addPages"]>[1][]) => {
    bank.fake.addPages(BANK, ...pages);
    await syncConnection(connectionId, NOW);
    return runFollowUp(NOW);
  };

  // A purchase on the card whose provider category is too unsure for step 3, at a Merchant with no
  // history: the cascade asks the AI.
  const buy = (
    id: string,
    postedDate: string,
    merchantName: string | null,
    fields: Partial<TxnRecord> = {},
  ): TxnRecord =>
    fakeTxn({
      id,
      accountId: CARD.id,
      amount: -2_500,
      postedDate,
      description: `CARD PURCHASE ${id.toUpperCase()}`,
      merchantName,
      category: { name: "GENERAL_MERCHANDISE_OTHER", confidence: "LOW", version: "v2", mcc: null },
      ...fields,
    });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW());
    bank = await newTestBank();
    stub = new StubModels();
    asked = [];
    lines = [];
    answerCategory = () => ({ category: "Restaurants", confidence: "medium", needsLookup: true });
    answerName = (row) => String(row.description);
    answerLookup = () => found("Pets");
    stub.replyTo = (messages) => {
      const call = readCall(messages);
      if (call === undefined) return "O";
      asked.push(call);
      if (call.use === "merchant lookup") {
        const answer = answerLookup(lookedUp().at(-1) ?? "");
        return typeof answer === "string" ? answer : JSON.stringify(answer);
      }
      const answers = call.rows.map((row) =>
        call.use === "category fix"
          ? { row: row.row, ...answerCategory(row) }
          : { row: row.row, name: answerName(row) },
      );
      return JSON.stringify({ answers });
    };
    const write = process.stdout.write.bind(process.stdout);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk, ...rest) => {
      lines.push(String(chunk));
      return write(chunk, ...(rest as []));
    });
    stops = [
      startMoneyMovement({ database: bank.database }).stop,
      startCategorization({ database: bank.database, ai: householdAi(aiOptions()) }).stop,
    ];
    connectionId = await bank.connect(BANK);
    bank.fake.addPages(BANK, { accounts: [CARD] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  it("looks up an unsure Merchant it does not know with its clean name alone, keeps the answer, and the next one takes it with no AI call", async () => {
    await connectAi();
    await sync({ added: [buy("first", "2026-10-03", "Bluebird Pets")] });

    expect(lookedUp()).toEqual(["Bluebird Pets"]);
    const [lookup] = callsOf("merchant lookup");
    // Only the name goes: no description, amount, date, or Account.
    expect(lookup?.texts.filter((text) => text !== MERCHANT_LOOKUP_TASK)).toEqual([
      "Merchant: Bluebird Pets",
    ]);
    expect(lookup?.rows).toEqual([]);
    // The web search is the AI provider's own tool, and the only one offered.
    expect(stub.offered.at(-1)).toEqual({ tools: ["web_search"], toolChoice: "auto" });
    expect(await partOf("first")).toEqual({
      category: "Pets",
      source: "Web lookup",
      confidence: "high",
      needsAi: 0,
    });
    expect(provenance({ source: "Web lookup", confidence: "high" })).toBe("Web lookup");
    expect(await itemsOf(AI_UNSURE_KIND)).toEqual([]);
    expect(await kept()).toEqual([
      {
        key: "name:bluebirdpets",
        outcome: "found",
        category: "Pets",
        confidence: "high",
        description: "A pet supply shop.",
      },
    ]);
    expect(await transactionWebLookupLine(bank.database, await idOf("first"))).toBe(
      "A pet supply shop.",
    );

    // The kept answer decides at step 5 with no Category fix and no search.
    asked = [];
    await sync({ added: [buy("second", "2026-10-04", "BLUEBIRD PETS")] });

    expect(asked).toEqual([]);
    expect(await partOf("second")).toMatchObject({ category: "Pets", source: "Web lookup" });
  });

  it("puts a below-high lookup on the Review list as Web lookup, unsure", async () => {
    await connectAi();
    answerLookup = () => found("Pets", "medium");
    await sync({ added: [buy("unsure", "2026-10-05", "Corner Shop")] });

    expect(await partOf("unsure")).toEqual({
      category: "Pets",
      source: "Web lookup",
      confidence: "medium",
      needsAi: 0,
    });
    expect(provenance({ source: "Web lookup", confidence: "medium" })).toBe("Web lookup, unsure");
    expect(await itemsOf(AI_UNSURE_KIND)).toMatchObject([
      {
        subject: { type: "transactions", transactionIds: [await idOf("unsure")] },
        bestAnswer: { value: "Pets", label: "Yes, Pets" },
      },
    ]);
  });

  it("takes a Member's correction over a Web lookup, as a Category rule the next Transaction uses", async () => {
    await addMorgan();
    await connectAi();
    answerLookup = () => found("Pets", "medium");
    await sync({ added: [buy("corrected", "2026-10-05", "Corner Shop")] });
    const [item] = await itemsOf(AI_UNSURE_KIND);

    expect(await answerReviewItem(bank.database, item?.id ?? "", "Hobbies", "member-1")).toBe(
      "answered",
    );
    await runFollowUp(NOW);
    expect(await partOf("corrected")).toMatchObject({ category: "Hobbies", source: "hand-set" });
    asked = [];
    await sync({ added: [buy("after", "2026-10-06", "Corner Shop")] });

    expect(callsOf("merchant lookup")).toEqual([]);
    expect(await partOf("after")).toMatchObject({ category: "Hobbies", source: "Category rule" });
  });

  it("keeps a lookup that found nothing for 90 days, with the AI's answer standing, then looks again", async () => {
    await connectAi();
    answerLookup = () => ({ found: false, category: null, confidence: "low", description: "" });
    await sync({ added: [buy("none-1", "2026-10-05", "Zq Holdings")] });

    expect(lookedUp()).toEqual(["Zq Holdings"]);
    expect(await partOf("none-1")).toMatchObject({
      category: "Restaurants",
      source: "AI",
      confidence: "medium",
    });
    expect(await kept()).toEqual([
      {
        key: "name:zqholdings",
        outcome: "nothing found",
        category: null,
        confidence: null,
        description: null,
      },
    ]);

    vi.setSystemTime(NOW().getTime() + 89 * DAY);
    asked = [];
    await sync({ added: [buy("none-2", "2026-10-06", "Zq Holdings")] });
    expect(callsOf("category fix")).toHaveLength(1);
    expect(lookedUp()).toEqual([]);

    vi.setSystemTime(NOW().getTime() + 91 * DAY);
    asked = [];
    await sync({ added: [buy("none-3", "2026-10-07", "Zq Holdings")] });
    expect(lookedUp()).toEqual(["Zq Holdings"]);
  });

  it("makes no lookup when the AI is sure, or does not ask for one", async () => {
    await connectAi();
    answerCategory = (row) =>
      row.merchant === "Sure Shop"
        ? { category: "Pets", confidence: "high", needsLookup: true }
        : { category: "Pets", confidence: "low", needsLookup: false };
    await sync({
      added: [buy("sure", "2026-10-05", "Sure Shop"), buy("known", "2026-10-05", "Known Shop")],
    });

    expect(callsOf("category fix")).toHaveLength(1);
    expect(lookedUp()).toEqual([]);
    expect(await partOf("known")).toMatchObject({ source: "AI", confidence: "low", needsAi: 0 });
  });

  it("takes an old reply with no lookup field as no lookup", async () => {
    await connectAi();
    answerCategory = () => ({ category: "Pets", confidence: "low" });
    await sync({ added: [buy("old", "2026-10-05", "Old Shop")] });

    expect(lookedUp()).toEqual([]);
    expect(await partOf("old")).toMatchObject({ category: "Pets", source: "AI" });
  });

  describe("what is never looked up", () => {
    const line = (merchant: string | null, more: Partial<LookupLine> = {}): LookupLine => ({
      merchant: merchant === null ? null : { id: null, name: merchant },
      description: `CARD PURCHASE ${merchant ?? ""}`,
      providerCategory: "GENERAL_MERCHANDISE_OTHER",
      ...more,
    });

    // Each skip rule, alone: break any one and its line is looked up.
    it.each([
      ["a Transfer out", line("Ally Bank", { providerCategory: "TRANSFER_OUT_ACCOUNT_TRANSFER" })],
      ["a Transfer in", line("Ally Bank", { providerCategory: "TRANSFER_IN_DEPOSIT" })],
      [
        "a loan payment",
        line("Sallie Mae", { providerCategory: "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT" }),
      ],
      ["a card payment", line("Chase card payment", { providerCategory: null })],
      [
        "a payment app naming no one",
        line("Venmo", { description: "CARD PURCHASE", providerCategory: null }),
      ],
      [
        "a Zelle line to a person",
        line("Bluebird Books", {
          description: "ZELLE PAYMENT TO JOHN SMITH",
          providerCategory: null,
        }),
      ],
      ["no Merchant", line(null)],
      ["a clean name with no letter or digit", line("***")],
    ])("skips %s", (_, skipped) => {
      expect(skipsLookup(skipped)).toBe(true);
    });

    it("looks up a shop, a shop paid through PayPal, and a provider category that only looks like a skip", () => {
      expect(skipsLookup(line("Bluebird Books"))).toBe(false);
      expect(
        skipsLookup(
          line("Etsy Shop", { description: "PAYPAL *ETSY SHOP", providerCategory: null }),
        ),
      ).toBe(false);
      expect(skipsLookup(line("Transferwise Cafe", { providerCategory: "TRANSFERS_FEE" }))).toBe(
        false,
      );
      expect(skipsLookup(line("Card Payments Inc"))).toBe(false);
      expect(lookupKeys({ id: "m-1", name: "Bluebird Books" })).toEqual([
        "id:m-1",
        "name:bluebirdbooks",
      ]);
    });

    it("looks up only the hard Merchant lines that name a shop, through the real cleanup rules", async () => {
      await connectAi();
      await sync({
        added: [
          ...K7_LINES.map((text, index) =>
            buy(`k7-${index}`, "2026-10-08", null, { description: text, category: null }),
          ),
          // A provider Merchant name that is a payment app, and a Spending a card payment names.
          buy("app", "2026-10-08", "Venmo", { description: "WEB PURCHASE" }),
          buy("card-payment", "2026-10-08", "Chase card payment", { description: "WEB PURCHASE" }),
        ],
      });

      // AI cleanup answers each marked line with the description as it read it, after the filter.
      // A name that holds the filter's "[removed]" is not looked up, nor is a payment-app line.
      expect(lookedUp().toSorted()).toEqual(["BEST BUY CO", "Bluebird Books", "Etsy Shop"]);
    });

    it("never looks up a name the privacy filter matches, in forms the code never names", async () => {
      await addMorgan();
      await connectAi();
      const names = [
        "Morgan Lee Photo",
        "studioLeeMorganPrints",
        "MORGAN‐LEE DESIGNS",
        "Ḿorgan Lee Art",
        "Ｍｏｒｇａｎ Lee Crafts",
        "Bluebird Books",
      ];
      await sync({
        added: names.map((name, index) => buy(`private-${index}`, `2026-10-${10 + index}`, name)),
      });

      expect(lookedUp()).toEqual(["Bluebird Books"]);
      const sent = JSON.stringify(callsOf("merchant lookup"));
      expect(sent).not.toMatch(/morgan|lee/i);
    });

    it("never looks up with the switch off, and reads no kept answer", async () => {
      await connectAi();
      await storeMerchantLookup(bank.database, "name:bluebirdbooks", {
        outcome: "found",
        category: "Pets",
        confidence: "high",
        description: "A bookshop.",
        lookedUpAt: NOW(),
      });
      expect(await storeWebLookupSwitch(bank.database, false)).toBe(true);
      await sync({
        added: [
          buy("off-kept", "2026-10-05", "Bluebird Books"),
          buy("off-new", "2026-10-05", "Other Shop"),
        ],
      });

      expect(lookedUp()).toEqual([]);
      expect(callsOf("category fix").flatMap((call) => call.rows)).toHaveLength(2);
      expect(await partOf("off-kept")).toMatchObject({ category: "Restaurants", source: "AI" });
    });

    it("makes no lookup with a custom model, which has no web search", async () => {
      expect(webSearchTools("openai-compatible")).toBeUndefined();
      await connectAi("openai-compatible");
      await sync({ added: [buy("custom", "2026-10-05", "Bluebird Books")] });

      expect(callsOf("category fix")).toHaveLength(1);
      expect(lookedUp()).toEqual([]);
      expect(await partOf("custom")).toMatchObject({ source: "AI", needsAi: 0 });
    });
  });

  describe("limits and failures", () => {
    it("takes a reply that breaks the schema as a bad reply: the AI's answer stands, nothing is kept, and the next Merchant still goes", async () => {
      await connectAi();
      answerLookup = (merchant) =>
        merchant === "Alpha Shop"
          ? found("Not a Category")
          : merchant === "Beta Shop"
            ? found("Pets", "high", "x".repeat(121))
            : found("Pets");
      await sync({
        added: [
          buy("alpha", "2026-10-05", "Alpha Shop"),
          buy("beta", "2026-10-05", "Beta Shop"),
          buy("gamma", "2026-10-05", "Gamma Shop"),
        ],
      });

      expect(lookedUp().toSorted()).toEqual(["Alpha Shop", "Beta Shop", "Gamma Shop"]);
      expect(await partOf("alpha")).toMatchObject({
        source: "AI",
        confidence: "medium",
        needsAi: 0,
      });
      expect(await partOf("beta")).toMatchObject({ source: "AI", needsAi: 0 });
      expect(await partOf("gamma")).toMatchObject({ source: "Web lookup", category: "Pets" });
      expect((await kept()).map((row) => row.key)).toEqual(["name:gammashop"]);
    });

    it("stops after three bad replies in a row, as an AI error, and marks the rest for the redo", async () => {
      await connectAi();
      answerLookup = () => "not JSON";
      await sync({
        added: ["One", "Two", "Three", "Four", "Five"].map((name, index) =>
          buy(`bad-${index}`, "2026-10-05", `${name} Shop`),
        ),
      });

      // The first two are bad replies; the third is an AI error, which stops the run's lookups.
      expect(lookedUp()).toHaveLength(3);
      const parts = await bank.database.$client.execute(
        "SELECT category_source AS source, category_needs_ai AS needsAi, count(*) AS n FROM transaction_parts GROUP BY 1, 2 ORDER BY 2",
      );
      expect(parts.rows.map((row) => ({ ...row }))).toEqual([
        { source: "AI", needsAi: 0, n: 2 },
        { source: "AI", needsAi: 1, n: 3 },
      ]);
      expect(await kept()).toEqual([]);
    });

    it("stops the run's lookups at a failed call, leaves the AI's answers marked, and keeps the failed call's place", async () => {
      await connectAi();
      stub.lookupAnswer = "fail";
      await sync({
        added: ["One", "Two", "Three"].map((name, index) =>
          buy(`fail-${index}`, "2026-10-05", `${name} Shop`),
        ),
      });

      const searched = stub.offered.filter((call) => call.tools.includes("web_search"));
      expect(searched).toHaveLength(1);
      for (const id of ["fail-0", "fail-1", "fail-2"]) {
        expect(await partOf(id)).toMatchObject({
          category: "Restaurants",
          source: "AI",
          needsAi: 1,
        });
      }
      expect(await countMerchantLookups(bank.database, "2026-11")).toBe(1);
      expect(await kept()).toEqual([]);

      // While the AI retry waits, a run makes no lookup call and takes no place.
      await sync({ added: [buy("fail-3", "2026-10-06", "Four Shop")] });
      expect(stub.offered.filter((call) => call.tools.includes("web_search"))).toHaveLength(1);
      expect(await countMerchantLookups(bank.database, "2026-11")).toBe(1);
      expect(await partOf("fail-3")).toMatchObject({ source: "AI", needsAi: 1 });
    });

    it("looks a marked Merchant up again in Finish AI work now, once the AI retry wait ends", async () => {
      await connectAi();
      stops.push(startRedo({ database: bank.database, ai: householdAi(aiOptions()) }).stop);
      stub.lookupAnswer = "fail";
      await sync({ added: [buy("again", "2026-10-05", "Bluebird Books")] });
      expect(await partOf("again")).toMatchObject({ source: "AI", needsAi: 1 });

      stub.lookupAnswer = undefined;
      vi.setSystemTime(NOW().getTime() + DAY);
      expect(await runRedo("finish")).toBe("done");

      expect(lookedUp()).toEqual(["Bluebird Books"]);
      expect(await partOf("again")).toMatchObject({
        category: "Pets",
        source: "Web lookup",
        needsAi: 0,
      });
    });

    it(`makes at most ${LOOKUPS_A_RUN} lookups in a run, and marks the rest for the redo`, async () => {
      await connectAi();
      await sync({
        added: Array.from({ length: 55 }, (_, index) =>
          buy(
            `many-${index}`,
            "2026-10-05",
            `Shop ${String.fromCharCode(65 + (index % 26))}${Math.floor(index / 26)}`,
          ),
        ),
      });

      expect(lookedUp()).toHaveLength(LOOKUPS_A_RUN);
      expect(await countMerchantLookups(bank.database, "2026-11")).toBe(LOOKUPS_A_RUN);
      const parts = await bank.database.$client.execute(
        "SELECT category_source AS source, category_needs_ai AS needsAi, count(*) AS n FROM transaction_parts GROUP BY 1, 2 ORDER BY 1",
      );
      expect(parts.rows.map((row) => ({ ...row }))).toEqual([
        { source: "AI", needsAi: 1, n: 5 },
        { source: "Web lookup", needsAi: 0, n: 50 },
      ]);
    });

    it("stops at 200 lookups a month with no mark, and the AI usage page says so", async () => {
      await connectAi();
      for (let place = 0; place < 199; place++) {
        expect(await reserveMerchantLookup(bank.database, "2026-11", 200)).toBe(true);
      }
      await sync({
        added: ["One", "Two", "Three"].map((name, index) =>
          buy(`cap-${index}`, "2026-10-05", `${name} Shop`),
        ),
      });

      expect(lookedUp()).toHaveLength(1);
      const parts = await bank.database.$client.execute(
        "SELECT category_source AS source, category_needs_ai AS needsAi, count(*) AS n FROM transaction_parts GROUP BY 1, 2 ORDER BY 1",
      );
      expect(parts.rows.map((row) => ({ ...row }))).toEqual([
        { source: "AI", needsAi: 0, n: 2 },
        { source: "Web lookup", needsAi: 0, n: 1 },
      ]);
      expect((await aiCost({ database: bank.database }).usage()).lookups).toEqual({
        count: 200,
        cap: 200,
      });
    });

    it("gives each of many lookups side by side its own place under the cap, and gives back one that made no call", async () => {
      await connectAi();
      const ai: HouseholdAi = householdAi(aiOptions());

      const places = await Promise.all(Array.from({ length: 250 }, () => ai.reserveLookup()));

      expect(places.filter((place) => place !== undefined)).toHaveLength(200);
      expect(await countMerchantLookups(bank.database, "2026-11")).toBe(200);
      await places[0]?.giveBack();
      expect(await countMerchantLookups(bank.database, "2026-11")).toBe(199);
      expect(await ai.reserveLookup()).toBeDefined();
      expect(await ai.reserveLookup()).toBeUndefined();
    });

    it("counts each web search's fee in the lookup's cost", async () => {
      await connectAi();
      stub.searches = 2;
      await sync({ added: [buy("fee", "2026-10-05", "Bluebird Books")] });

      const costs = await bank.database.$client.execute(
        "SELECT use, cost_nanos AS cost FROM ai_calls WHERE use IN ('category fix', 'merchant lookup') ORDER BY use",
      );
      const [fix, lookup] = costs.rows.map((row) => Number(row.cost));
      // The same tokens, and $10 per 1,000 searches: 2 searches are 2 cents.
      expect((lookup ?? 0) - (fix ?? 0)).toBe(20_000_000);
    });

    it("writes no Merchant name and no web text to the log", async () => {
      await connectAi();
      answerLookup = (merchant) =>
        merchant === "Alpha Shop"
          ? "not JSON from Alpha Shop"
          : found("Pets", "high", "Sells pets.");
      stub.lookupAnswer = undefined;
      await sync({
        added: [buy("log-a", "2026-10-05", "Alpha Shop"), buy("log-b", "2026-10-05", "Beta Shop")],
      });
      stub.lookupAnswer = "fail";
      await sync({ added: [buy("log-c", "2026-10-06", "Gamma Shop")] });

      expect(lookedUp().toSorted()).toEqual(["Alpha Shop", "Beta Shop"]);
      expect(stub.offered.filter((call) => call.tools.includes("web_search"))).toHaveLength(3);
      const logged = lines.join("");
      expect(logged).toContain("An AI call failed");
      expect(logged).not.toMatch(/alpha|beta|gamma|sells pets|a shop/i);
    });
  });

  it("deletes a kept answer with the last Transaction of its Merchant", async () => {
    await connectAi();
    const other = await bank.connect("fake-second-bank");
    const SECOND = fakeAccount({ id: "acc-second", name: "Second Card", type: "credit" });
    bank.fake.addPages("fake-second-bank", {
      accounts: [SECOND],
      added: [{ ...buy("shared", "2026-10-09", "Shared Shop"), accountId: SECOND.id }],
    });
    await syncConnection(other, NOW);
    await sync({
      added: [
        buy("mine", "2026-10-09", "Shared Shop"),
        buy("only-mine", "2026-10-09", "Mine Shop"),
      ],
    });
    expect((await kept()).map((row) => row.key)).toEqual(["name:mineshop", "name:sharedshop"]);

    expect(await markConnectionRemoved(bank.database, connectionId, NOW())).toMatchObject({
      removed: true,
    });
    expect(await deleteRemovedConnection(bank.database, connectionId, NOW())).toBeDefined();

    expect((await kept()).map((row) => row.key)).toEqual(["name:sharedshop"]);
    expect([...(await readMerchantLookups(bank.database, ["name:mineshop"])).keys()]).toEqual([]);
  });

  it("decides 2,500 Transactions of 400 Merchants, 350 of them kept, with 50 lookups, in a few seconds", async () => {
    await connectAi();
    const name = (index: number) =>
      `Shop ${String.fromCharCode(65 + (index % 20), 65 + (Math.floor(index / 20) % 20))}`;
    for (let index = 0; index < 350; index++) {
      await storeMerchantLookup(
        bank.database,
        `name:${name(index).toLowerCase().replace(" ", "")}`,
        {
          outcome: "found",
          category: "Pets",
          confidence: "high",
          description: "A shop.",
          lookedUpAt: NOW(),
        },
      );
    }
    const added = Array.from({ length: 2_500 }, (_, index) =>
      buy(
        `big-${index}`,
        `2026-10-${String((index % 28) + 1).padStart(2, "0")}`,
        name(index % 400),
      ),
    );
    bank.fake.addPages(BANK, { added });
    await syncConnection(connectionId, NOW);

    // The limit is on the follow-up job's own work: the CPU time this test worker spends on it.
    const started = process.cpuUsage();
    expect(await runFollowUp(NOW)).toBeUndefined();
    const used = process.cpuUsage(started);
    const took = (used.user + used.system) / 1_000;

    expect(lookedUp()).toHaveLength(50);
    const sources = await bank.database.$client.execute(
      "SELECT category_source AS source, count(*) AS n FROM transaction_parts GROUP BY 1 ORDER BY 1",
    );
    expect(Object.fromEntries(sources.rows.map((row) => [row.source, row.n]))).toMatchObject({
      "Web lookup": expect.any(Number),
    });
    expect(took).toBeLessThan(5_000);
  }, 30_000);
});
