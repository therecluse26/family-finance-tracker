import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AiGates, type AiOptions, aiCost, aiSettings, householdAi } from "../ai/index.ts";
import { newAiKey, type StubMessage, StubModels } from "../ai/testing.ts";
import { seedDemoHousehold } from "../bank/demo.ts";
import { type FakePage, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { runFirstRun, syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import {
  BEST_GUESS_KIND,
  categorize,
  correctCategory,
  startCategorization,
} from "../categorization/index.ts";
import { CATEGORY_FIX_TASK, MERCHANT_CLEANUP_TASK } from "../categorization/quick-tier.ts";
import {
  claimAiBack,
  claimFirstAiRunDone,
  claimHistoryWaitEnd,
  listBestGuessIds,
  listMarkedNameIds,
  listOpenNotices,
  markAiAway,
  readAiRedo,
} from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { INSIGHT_CARDS_TASK } from "../insights/index.ts";
import {
  addManualLoan,
  MONEY_FROM_PERSON_KIND,
  POSSIBLE_PAYMENT_KIND,
  startMoneyMovement,
  UNCLEAR_PAIR_KIND,
} from "../money-movement/index.ts";
import { answerReviewItem, openReviewItems } from "../review/index.ts";
import {
  checkAiBack,
  REDO_ATTEMPTS,
  REDO_STOPPED,
  registerRedoStep,
  runRedo,
  runRedoJob,
  startRedo,
} from "./index.ts";

// The first AI run and the redo of no-AI work (spec 08, Runs that reuse these uses, Redo of no-AI
// work; spec 03, AI decisions and the no-AI path), through the First run job, the AI back check and
// the Redo no-AI work job, on Transactions the fake adapter syncs: the demo Household, or a few of
// the test's own. The AI is AI SDK test models behind the real privacy filter. No test calls an AI
// provider.

const NOW = () => new Date("2026-11-20T14:00:00.000Z");
const MEMBER = "member-1";
const MINUTE = 60_000;
const PRICE = { input: 1_000_000, output: 2_000_000 };

type Row = Record<string, string | number | null> & { row: number };
type Use =
  | "category fix"
  | "merchant cleanup"
  | "pairs"
  | "loans"
  | "picks"
  | "insight cards"
  | "other";
type Confidence = "high" | "medium" | "low";

const textsOf = (messages: readonly StubMessage[]) =>
  messages.flatMap((message) =>
    message.role !== "user"
      ? []
      : typeof message.content === "string"
        ? [message.content]
        : message.content.flatMap((part) => (part.text === undefined ? [] : [part.text])),
  );

function useOf(texts: readonly string[]): Use {
  if (texts.includes(CATEGORY_FIX_TASK)) return "category fix";
  if (texts.includes(MERCHANT_CLEANUP_TASK)) return "merchant cleanup";
  if (texts.some((text) => text.startsWith("Each row is a possible Transfer"))) return "pairs";
  if (texts.some((text) => text.includes("the lender of a loan"))) return "loans";
  if (texts.some((text) => text.startsWith("The first rows are money"))) return "picks";
  if (texts.some((text) => text.includes(INSIGHT_CARDS_TASK))) return "insight cards";
  return "other";
}

const insightCards = JSON.stringify({
  cards: [1, 2, 3, 4].map((n) => ({
    group: "worth_acting_on",
    about: `Topic ${n}`,
    figure: 40 + n,
    figureKind: "dollars",
    figureLabel: "a month",
    title: `Card ${n} title`,
    why: `Why card ${n} matters.`,
    nextStep: `Do step ${n} this week.`,
    picture: null,
  })),
});

describe("the first AI run and the redo of no-AI work", () => {
  let bank: TestBank;
  let stub: StubModels;
  let stops: (() => void)[];
  let stopCategorization: () => void;
  let redo: ReturnType<typeof startRedo>;
  let options: AiOptions;
  // The calls the test models answered, by use, with their rows as the model read them.
  let asked: { use: Use; rows: Row[] }[];
  let historyLoaded: boolean;
  let pausedUntil: string | undefined;
  // Redo no-AI work jobs started, and AI's returns after an outage.
  let started: number;
  let backs: number;
  let pairAnswer: () => { answer: "yes" | "no"; confidence: Confidence };
  let loanAnswer: () => { answer: "yes" | "no"; confidence: Confidence };
  let pick: (rows: Row[]) => { spendingRow: number | null; confidence: Confidence };

  const gates: AiGates = {
    historyLoaded: async () => historyLoaded,
    costCapPausedUntil: async () => pausedUntil,
  };
  const callsOf = (use: Use) => asked.filter((call) => call.use === use);
  const count = async (sql: string) =>
    Number((await bank.database.$client.execute(sql)).rows[0]?.n ?? 0);
  const itemsOf = async (kind: string) =>
    (await openReviewItems(bank.database)).filter((item) => item.kind === kind);
  const idOf = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT id FROM transactions WHERE provider_transaction_id = ?",
      args: [providerId],
    });
    return String(rows.rows[0]?.id);
  };
  const partOf = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: `SELECT p.category, p.category_source AS source, p.category_needs_ai AS needsAi
            FROM transaction_parts p JOIN transactions t ON t.id = p.transaction_id
            WHERE t.provider_transaction_id = ? ORDER BY p.part`,
      args: [providerId],
    });
    return { ...rows.rows[0] };
  };
  const connectAi = async (afterChange?: () => Promise<void>) => {
    const saved = await aiSettings({ ...options, afterChange }).save({
      provider: "anthropic",
      apiKey: newAiKey(),
      baseUrl: null,
      quickModel: "quick-model",
      writerModel: "writer-model",
      prices: { quick: PRICE, writer: PRICE },
    });
    expect(saved).toMatchObject({ saved: true });
    // The two checks on save are not uses.
    asked = [];
  };

  beforeEach(async () => {
    bank = await newTestBank();
    await bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('${MEMBER}', 'Avery Park', 'avery@example.com', '2026-10-01T00:00:00.000Z',
         '2026-10-01T00:00:00.000Z')`,
    );
    stub = new StubModels();
    asked = [];
    historyLoaded = true;
    pausedUntil = undefined;
    started = 0;
    backs = 0;
    pairAnswer = () => ({ answer: "yes", confidence: "high" });
    loanAnswer = () => ({ answer: "yes", confidence: "high" });
    pick = () => ({ spendingRow: null, confidence: "low" });
    stub.replyTo = (messages) => {
      const texts = textsOf(messages);
      const use = useOf(texts);
      const rows = texts
        .filter((text) => text.startsWith('{"row":'))
        .map((text) => JSON.parse(text) as Row);
      if (use !== "other") asked.push({ use, rows });
      const money = rows.filter((row) => row.kind === "money in");
      switch (use) {
        case "category fix":
          return JSON.stringify({
            answers: rows.map((row) => ({ row: row.row, category: "Pets", confidence: "high" })),
          });
        case "merchant cleanup":
          return JSON.stringify({
            answers: rows.map((row) => ({ row: row.row, name: `Shop ${row.description}` })),
          });
        case "pairs":
          return JSON.stringify({
            answers: rows.map((row) => ({ row: row.row, ...pairAnswer() })),
          });
        case "loans":
          return JSON.stringify({
            answers: rows.map((row) => ({ row: row.row, ...loanAnswer() })),
          });
        case "picks":
          return JSON.stringify({ answers: money.map((row) => ({ row: row.row, ...pick(rows) })) });
        case "insight cards":
          return insightCards;
        default:
          return "O";
      }
    };
    options = {
      database: bank.database,
      secrets: bank.secrets,
      makeModels: stub.makeModels,
      cost: aiCost({ database: bank.database }),
      gates,
      notices: { raise: async () => undefined, end: async () => undefined },
      aiBack: async () => {
        backs += 1;
      },
    };
    const ai = householdAi(options);
    stopCategorization = startCategorization({ database: bank.database, ai }).stop;
    redo = startRedo({
      database: bank.database,
      ai,
      now: NOW,
      startJob: async () => {
        started += 1;
      },
    });
    stops = [
      startMoneyMovement({ database: bank.database, ai }).stop,
      () => stopCategorization(),
      redo.stop,
    ];
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  describe("the first AI run", () => {
    const marked = async () => ({
      guesses: await count(
        "SELECT count(*) AS n FROM transaction_parts WHERE category_needs_ai = 1",
      ),
      names: await count(
        "SELECT count(DISTINCT description) AS n FROM transactions WHERE merchant_needs_ai = 1",
      ),
    });

    it("runs the Quick-tier uses on all the demo history once the wait ends, in batches, then one Insight card run", async () => {
      await connectAi();
      historyLoaded = false;
      await seedDemoHousehold(bank.database, bank.fake, NOW);
      await runFollowUp(NOW);
      // While the history loads, AI waits: every Category the AI would choose is a best guess.
      expect(asked).toEqual([]);
      const before = await marked();
      expect(before.guesses).toBeGreaterThan(0);
      expect(before.names).toBeGreaterThan(0);
      expect(await itemsOf(BEST_GUESS_KIND)).not.toEqual([]);
      const costBefore = await count("SELECT count(*) AS n FROM ai_calls");
      // Not before the wait ends.
      expect(await runRedo()).toBe("not due");

      historyLoaded = true;
      await claimHistoryWaitEnd(bank.database, NOW());
      await runFirstRun(NOW);

      // Batches of up to 100, never one call for each Transaction: each best guess goes out once,
      // and Merchant history answers some once the AI has answered others of the Merchant.
      for (const call of asked) expect(call.rows.length).toBeLessThanOrEqual(100);
      expect(callsOf("merchant cleanup")).toHaveLength(Math.ceil(before.names / 100));
      const fixes = callsOf("category fix");
      expect(fixes.length).toBeGreaterThan(0);
      expect(fixes.length).toBeLessThanOrEqual(Math.ceil(before.guesses / 100));
      expect(fixes.flatMap((call) => call.rows).length).toBeLessThanOrEqual(before.guesses);
      // It ends with one Insight card run, at any hour: 9 AM in New York here is not the point.
      expect(callsOf("insight cards")).toHaveLength(1);
      expect(asked.at(-1)?.use).toBe("insight cards");
      // Each call counts against the AI cost cap.
      expect((await count("SELECT count(*) AS n FROM ai_calls")) - costBefore).toBe(
        stub.calls.length - 2,
      );
      expect(await marked()).toEqual({ guesses: 0, names: 0 });
      expect(await itemsOf(BEST_GUESS_KIND)).toEqual([]);
      expect((await readAiRedo(bank.database)).firstRunDoneAt).toEqual(NOW());

      // Once: the First run and the redo find nothing to do again.
      const calls = asked.length;
      await runFirstRun(NOW);
      expect(await runRedo()).toBe("not due");
      expect(asked).toHaveLength(calls);
      expect(started).toBe(0);
    });

    it("waits for AI when it finds no AI provider, even with nothing the follow-up job asked", async () => {
      await claimHistoryWaitEnd(bank.database, NOW());
      expect(await runRedo()).toBe("AI away");
      expect(await readAiRedo(bank.database)).toMatchObject({ awayReason: "pause" });

      await connectAi(redo.afterAiChange);
      expect(started).toBe(1);
      expect(await runRedo()).toBe("done");
      expect(callsOf("insight cards")).toHaveLength(1);
    });

    it("starts when an AI provider is set up after the history has loaded", async () => {
      await seedDemoHousehold(bank.database, bank.fake, NOW);
      await runFollowUp(NOW);
      await claimHistoryWaitEnd(bank.database, NOW());
      await runFirstRun(NOW);
      // No AI provider: the step makes no call, and the first AI run waits for AI.
      expect(asked).toEqual([]);
      expect(await readAiRedo(bank.database)).toMatchObject({
        awayReason: "pause",
        firstRunDoneAt: null,
      });
      expect(started).toBe(0);
      const guesses = await count(
        "SELECT count(*) AS n FROM transaction_parts WHERE category_needs_ai = 1",
      );
      expect(guesses).toBeGreaterThan(0);

      await connectAi(redo.afterAiChange);
      expect(started).toBe(1);
      await runRedoJob();

      expect(callsOf("category fix").length).toBeLessThanOrEqual(Math.ceil(guesses / 100));
      expect(callsOf("insight cards")).toHaveLength(1);
      expect(
        await count("SELECT count(*) AS n FROM transaction_parts WHERE category_needs_ai = 1"),
      ).toBe(0);
      expect((await readAiRedo(bank.database)).firstRunDoneAt).toEqual(NOW());

      // A later change of the AI settings starts no other redo.
      await connectAi(redo.afterAiChange);
      expect(started).toBe(1);
    });
  });

  describe("the redo of no-AI work", () => {
    const CHECKING = fakeAccount({ id: "maple-checking", mask: "1111" });
    const CARD = fakeAccount({ id: "birch-card", type: "credit", subtype: "credit card" });
    const BANKS = [
      { bankId: "maple", accounts: [CHECKING] },
      { bankId: "birch", accounts: [CARD] },
    ];
    const connections = new Map<string, string>();

    // A Transaction with no strong signal: Matching cannot pair it for sure, and the cascade asks
    // the AI for its Category.
    const txn = (
      id: string,
      account: { id: string },
      amount: number,
      postedDate: string,
      fields: Partial<TxnRecord> = {},
    ): TxnRecord =>
      fakeTxn({
        id,
        accountId: account.id,
        amount,
        postedDate,
        description: amount < 0 ? "ONLINE DEBIT" : "ONLINE CREDIT",
        merchantName: null,
        category: null,
        ...fields,
      });
    const buy = (id: string, postedDate: string, amount = -2_500) =>
      txn(id, CARD, amount, postedDate, {
        description: `CARD PURCHASE ${id.toUpperCase()}`,
        merchantName: `Merchant ${id}`,
        category: {
          name: "FOOD_AND_DRINK_RESTAURANT",
          confidence: "LOW",
          version: "v2",
          mcc: null,
        },
      });
    const sync = async (added: TxnRecord[]) => {
      for (const { bankId, accounts } of BANKS) {
        const page: FakePage = {
          added: added.filter((record) => accounts.some((each) => each.id === record.accountId)),
          changed: [],
          removed: [],
          historyLoaded: true,
        };
        bank.fake.addPages(bankId, page);
        await syncConnection(connections.get(bankId) ?? "", NOW);
      }
      return runFollowUp(NOW);
    };
    const fixedRows = () =>
      callsOf("category fix").flatMap((call) => call.rows.map((row) => String(row.description)));

    beforeEach(async () => {
      connections.clear();
      for (const { bankId, accounts } of BANKS) {
        connections.set(bankId, await bank.connect(bankId));
        bank.fake.addPages(bankId, { accounts });
        await syncConnection(connections.get(bankId) ?? "", NOW);
      }
      // The first AI run is done: each redo here is one return of AI.
      await claimHistoryWaitEnd(bank.database, NOW());
      await claimFirstAiRunDone(bank.database, NOW());
      await connectAi();
      // A Category the AI chose below high, before the cap: it is not no-AI work.
      const replyTo = stub.replyTo;
      stub.replyTo = (messages) => {
        const reply = replyTo?.(messages) ?? "O";
        return useOf(textsOf(messages)) === "category fix"
          ? reply.replaceAll('"high"', '"medium"')
          : reply;
      };
      await sync([buy("unsure", "2026-10-01")]);
      expect(await partOf("unsure")).toMatchObject({ source: "AI", needsAi: 0 });
      stub.replyTo = replyTo;
      asked = [];
    });

    // At the AI cost cap, the follow-up job takes every no-AI path. A Member then sets one best
    // guess by hand and keeps one money from a person as Income.
    const atTheCap = async () => {
      pausedUntil = "2026-12-01";
      await sync([
        buy("guess-1", "2026-10-02"),
        buy("guess-2", "2026-10-03"),
        buy("hand", "2026-10-04"),
        txn("pair-out", CHECKING, -1_001, "2026-10-05"),
        txn("pair-in", CARD, 1_001, "2026-10-06"),
        txn("dinner", CARD, -6_000, "2026-09-28", {
          description: "CORNER BISTRO",
          merchantName: "Corner Bistro",
          category: {
            name: "FOOD_AND_DRINK_RESTAURANT",
            confidence: "HIGH",
            version: "v2",
            mcc: null,
          },
        }),
        txn("friend", CHECKING, 2_000, "2026-10-02", { description: "VENMO *MORGAN LEE" }),
        txn("kept", CHECKING, 1_500, "2026-10-03", { description: "VENMO *JORDAN BELL" }),
      ]);
      expect(asked).toEqual([]);
      expect(await readAiRedo(bank.database)).toMatchObject({ awayReason: "pause", dueAt: null });
      // Each no-AI decision keeps its mark.
      expect(await partOf("guess-1")).toMatchObject({ source: "best guess", needsAi: 1 });
      expect(await itemsOf(UNCLEAR_PAIR_KIND)).toMatchObject([{ needsAi: true }]);
      expect((await itemsOf(MONEY_FROM_PERSON_KIND)).map((item) => item.needsAi)).toEqual([
        true,
        true,
      ]);
      const hand = await correctCategory(
        bank.database,
        await idOf("hand"),
        "Groceries",
        { onlyThisTransaction: true, memberId: MEMBER },
        NOW(),
      );
      expect(hand).toMatchObject({ result: "corrected" });
      const keptId = await idOf("kept");
      const keptItem = (await itemsOf(MONEY_FROM_PERSON_KIND)).find(
        (item) => item.subject.type === "transactions" && item.subject.transactionIds[0] === keptId,
      );
      expect(keptItem).toBeDefined();
      expect(await answerReviewItem(bank.database, keptItem?.id ?? "", "keep", MEMBER)).toBe(
        "answered",
      );
    };

    it("sends each marked item through the AI once after the cap resets, skips hand-set items, and closes their Review list items", async () => {
      // The pick for the friend's money: the dinner, with high confidence.
      pick = (rows) => ({
        spendingRow:
          rows.find((row) => row.kind === "Spending" && row.amount === "60.00")?.row ?? null,
        confidence: "high",
      });
      await atTheCap();
      const alerts = await count("SELECT count(*) AS n FROM alerts");
      const reviews = await count("SELECT count(*) AS n FROM monthly_reviews");
      // The cap is still on: AI is not back.
      expect(await checkAiBack()).toBe(false);
      expect(started).toBe(0);

      // The cap resets on the 1st: the AI back check starts one redo.
      pausedUntil = undefined;
      expect(await checkAiBack()).toBe(true);
      expect(await checkAiBack()).toBe(false);
      expect(started).toBe(1);
      const callsBefore = stub.calls.length;
      await runRedoJob();

      // One call for the pair, one for the money a Member did not answer, and the best guesses a
      // Member did not set by hand. Never an AI-chosen Category, an Alert's advice, or a card run.
      expect(callsOf("pairs")).toHaveLength(1);
      expect(callsOf("picks")).toHaveLength(1);
      expect(callsOf("picks")[0]?.rows.filter((row) => row.kind === "money in")).toMatchObject([
        { description: "VENMO *MORGAN LEE" },
      ]);
      expect(fixedRows().sort()).toEqual(["CARD PURCHASE GUESS-1", "CARD PURCHASE GUESS-2"]);
      expect(asked.map((call) => call.use).sort()).toEqual(["category fix", "pairs", "picks"]);
      expect(stub.calls.length - callsBefore).toBe(asked.length);
      expect(await partOf("guess-1")).toEqual({ category: "Pets", source: "AI", needsAi: 0 });
      expect(await partOf("hand")).toMatchObject({ category: "Groceries", source: "hand-set" });
      expect(await partOf("unsure")).toMatchObject({ source: "AI", needsAi: 0 });
      // The AI's later answers apply: their items leave the Review list.
      expect(await itemsOf(BEST_GUESS_KIND)).toEqual([]);
      expect(await itemsOf(UNCLEAR_PAIR_KIND)).toEqual([]);
      expect(await itemsOf(MONEY_FROM_PERSON_KIND)).toEqual([]);
      // Sent Alerts and written Monthly reviews stay as they were.
      expect(await count("SELECT count(*) AS n FROM alerts")).toBe(alerts);
      expect(await count("SELECT count(*) AS n FROM monthly_reviews")).toBe(reviews);

      // Once for each return: later syncs and checks start no other redo.
      const calls = asked.length;
      await sync([buy("later", "2026-10-07")]);
      expect(await checkAiBack()).toBe(false);
      expect(await runRedo()).toBe("not due");
      expect(started).toBe(1);
      expect(asked.length).toBe(calls + 1);
    });

    it("chooses again only best guesses, never a Category the AI or a Member chose", async () => {
      await atTheCap();
      pausedUntil = undefined;
      const ids = [await idOf("unsure"), await idOf("hand"), await idOf("guess-1")];
      expect(await categorize(bank.database, ids, householdAi(options), { redo: true })).toEqual({
        left: [],
      });

      expect(fixedRows()).toEqual(["CARD PURCHASE GUESS-1"]);
      expect(await partOf("unsure")).toMatchObject({ source: "AI", needsAi: 0 });
      expect(await partOf("hand")).toMatchObject({ category: "Groceries", source: "hand-set" });
    });

    it("keeps an item open with the AI's answer when it is below high, and never asks again", async () => {
      pairAnswer = () => ({ answer: "yes", confidence: "medium" });
      await atTheCap();
      pausedUntil = undefined;
      expect(await checkAiBack()).toBe(true);
      await runRedoJob();

      expect(callsOf("pairs")).toHaveLength(1);
      expect(await itemsOf(UNCLEAR_PAIR_KIND)).toMatchObject([{ needsAi: false }]);
      expect(await itemsOf(MONEY_FROM_PERSON_KIND)).toMatchObject([
        { bestAnswer: { value: "keep" }, needsAi: false },
      ]);

      // AI goes away and comes back: nothing is left to redo.
      await markAiAway(bank.database, "pause", NOW());
      expect(await checkAiBack()).toBe(true);
      const calls = asked.length;
      expect(await runRedo()).toBe("done");
      expect(asked).toHaveLength(calls);
    });

    // A Manual loan with one linked payment out of checking. At the cap, a payment to the lender
    // from the card, under another Merchant, is Unclear: it goes on the Review list with its mark.
    const loanPaymentAtTheCap = async () => {
      const lender = { description: "LAKESIDE CREDIT PMT", merchantName: "Lakeside Credit" };
      await sync([txn("loan-aug", CHECKING, -50_000, "2026-08-01", lender)]);
      await addManualLoan(
        bank.database,
        {
          lender: "Lakeside Credit",
          kind: "car",
          balance: 1_000_000,
          balanceDate: "2026-07-01",
          apr: 7.3,
          regularPayment: 50_000,
          escrow: null,
          loanType: null,
        },
        MEMBER,
      );
      await runFollowUp(NOW);
      asked = [];
      pausedUntil = "2026-12-01";
      await sync([
        txn("loan-oct", CARD, -50_000, "2026-10-01", {
          description: "LAKESIDE CREDIT UNION LOAN",
          merchantName: "Lakeside Credit Union",
        }),
      ]);
      expect(asked).toEqual([]);
      expect(await itemsOf(POSSIBLE_PAYMENT_KIND)).toMatchObject([
        {
          subject: { type: "transactions", transactionIds: [await idOf("loan-oct")] },
          needsAi: true,
        },
      ]);
    };
    const loanLinkOf = async (providerId: string) =>
      (
        await bank.database.$client.execute({
          sql: `SELECT l.made_by AS madeBy, l.tier FROM loan_links l
                JOIN transactions t ON t.id = l.transaction_id
                WHERE t.provider_transaction_id = ?`,
          args: [providerId],
        })
      ).rows.map((row) => ({ ...row }));

    it.each([
      {
        answer: "yes" as const,
        confidence: "high" as const,
        link: [{ madeBy: "AI", tier: "Unclear" }],
        items: [],
      },
      { answer: "no" as const, confidence: "high" as const, link: [], items: [] },
      {
        answer: "yes" as const,
        confidence: "low" as const,
        link: [],
        items: [{ bestAnswer: { value: expect.stringMatching(/^link /) }, needsAi: false }],
      },
    ])(
      "sends an Unclear Manual loan payment to the AI once after the cap resets ($answer, $confidence)",
      async ({ answer, confidence, link, items }) => {
        loanAnswer = () => ({ answer, confidence });
        await loanPaymentAtTheCap();

        pausedUntil = undefined;
        expect(await checkAiBack()).toBe(true);
        await runRedoJob();

        expect(callsOf("loans")).toHaveLength(1);
        expect(callsOf("loans")[0]?.rows).toHaveLength(1);
        expect(await loanLinkOf("loan-oct")).toEqual(link);
        expect(await itemsOf(POSSIBLE_PAYMENT_KIND)).toMatchObject(items);

        // Never on a later sync, and never again on AI's next return.
        await sync([buy("later", "2026-10-07")]);
        await markAiAway(bank.database, "pause", NOW());
        expect(await checkAiBack()).toBe(true);
        expect(await runRedo()).toBe("done");
        expect(callsOf("loans")).toHaveLength(1);
      },
    );

    it.each(["high", "low"] as const)(
      "keeps a Member's answer given during the pick call (%s pick)",
      async (confidence) => {
        pick = (rows) => ({
          spendingRow:
            rows.find((row) => row.kind === "Spending" && row.amount === "60.00")?.row ?? null,
          confidence,
        });
        await atTheCap();
        pausedUntil = undefined;
        expect(await checkAiBack()).toBe(true);
        const friendId = await idOf("friend");
        const [item] = (await itemsOf(MONEY_FROM_PERSON_KIND)).filter(
          (each) =>
            each.subject.type === "transactions" && each.subject.transactionIds[0] === friendId,
        );
        // A Member keeps the friend's money as Income while the AI picks for it.
        stub.beforeAnswer = async () => {
          if (useOf(textsOf(stub.prompts.at(-1) ?? [])) !== "picks") return;
          stub.beforeAnswer = async () => {};
          expect(await answerReviewItem(bank.database, item?.id ?? "", "keep", MEMBER)).toBe(
            "answered",
          );
        };
        expect(await runRedo()).toBe("done");

        expect(callsOf("picks")).toHaveLength(1);
        // The AI's pick links nothing, and leaves the answered item as the Member closed it.
        expect(
          await count(
            `SELECT count(*) AS n FROM spending_links WHERE transaction_id = '${friendId}'`,
          ),
        ).toBe(0);
        const stored = await bank.database.$client.execute({
          sql: "SELECT best_answer AS bestAnswer, needs_ai AS needsAi, closed_at AS closedAt FROM review_items WHERE id = ?",
          args: [item?.id ?? ""],
        });
        expect({ ...stored.rows[0] }).toMatchObject({
          bestAnswer: expect.stringContaining('"keep"'),
          needsAi: 1,
          closedAt: expect.anything(),
        });
      },
    );

    it("never sends a hidden Transaction's marked name or best guess", async () => {
      await atTheCap();
      const [guess1, guess2, hand] = [
        await idOf("guess-1"),
        await idOf("guess-2"),
        await idOf("hand"),
      ];
      await bank.database.$client.execute(
        `UPDATE transactions SET merchant_needs_ai = 1 WHERE id IN ('${guess1}', '${guess2}')`,
      );
      await bank.database.$client.execute(
        `UPDATE transactions SET hidden_reason = 'removed by provider' WHERE id = '${guess2}'`,
      );

      for (const listed of [
        await listMarkedNameIds(bank.database),
        await listBestGuessIds(bank.database),
        await listBestGuessIds(bank.database, [guess2, hand]),
      ]) {
        expect(listed).toContain(guess1);
        expect(listed).not.toContain(guess2);
      }
      expect(await listBestGuessIds(bank.database, [guess2, hand])).toContain(hand);

      pausedUntil = undefined;
      expect(await checkAiBack()).toBe(true);
      expect(await runRedo()).toBe("done");
      expect(fixedRows()).toEqual(["CARD PURCHASE GUESS-1"]);
      expect(JSON.stringify(asked)).not.toContain("GUESS-2");
    });

    it("leaves what it did not reach for AI's next return when AI goes away during the redo", async () => {
      await atTheCap();
      pausedUntil = undefined;
      expect(await checkAiBack()).toBe(true);
      // The cap is reached again during the pair's call.
      stub.beforeAnswer = async () => {
        pausedUntil = "2027-01-01";
      };
      expect(await runRedo()).toBe("AI away");

      expect(callsOf("pairs")).toHaveLength(1);
      expect(callsOf("category fix")).toEqual([]);
      // Each best guess keeps its Category and its mark; the money a run decided again has one.
      expect(await partOf("guess-1")).toMatchObject({ source: "best guess", needsAi: 1 });
      expect(await partOf("pair-out")).toMatchObject({ needsAi: 0 });
      expect(await readAiRedo(bank.database)).toMatchObject({ awayReason: "pause", dueAt: null });

      stub.beforeAnswer = async () => {};
      pausedUntil = undefined;
      expect(await checkAiBack()).toBe(true);
      expect(await runRedo()).toBe("done");
      expect(fixedRows().sort()).toEqual(["CARD PURCHASE GUESS-1", "CARD PURCHASE GUESS-2"]);
    });

    it("keeps a return that comes during a redo for the next one", async () => {
      await atTheCap();
      pausedUntil = undefined;
      expect(await checkAiBack()).toBe(true);
      const later = new Date(NOW().getTime() + MINUTE);
      stub.beforeAnswer = async () => {
        stub.beforeAnswer = async () => {};
        // An outage, and a call that works, while the redo runs.
        await markAiAway(bank.database, "outage", later);
        expect(await claimAiBack(bank.database, later)).toBe(true);
      };
      await runRedo();

      expect((await readAiRedo(bank.database)).dueAt).toEqual(later);
    });

    it("does nothing when a redo starts beside a running one", async () => {
      await atTheCap();
      pausedUntil = undefined;
      expect(await checkAiBack()).toBe(true);
      const beside: string[] = [];
      stub.beforeAnswer = async () => {
        stub.beforeAnswer = async () => {};
        beside.push(await runRedo());
      };
      expect(await runRedo()).toBe("done");

      expect(beside).toEqual(["busy"]);
      expect(callsOf("pairs")).toHaveLength(1);
      expect(callsOf("picks")).toHaveLength(1);
    });

    it("stops after its last attempt with one System notice, and ends it after a redo that works", async () => {
      stopCategorization();
      let attempts = 0;
      const unregister = registerRedoStep("Categories", async () => {
        attempts += 1;
        throw new Error("The step always fails.");
      });
      stopCategorization = unregister;
      await markAiAway(bank.database, "outage", NOW());
      expect(await claimAiBack(bank.database, NOW())).toBe(true);

      for (let attempt = 1; attempt < REDO_ATTEMPTS; attempt += 1) {
        await expect(runRedoJob()).rejects.toThrow("The step always fails.");
      }
      await runRedoJob();

      expect(attempts).toBe(REDO_ATTEMPTS);
      expect(
        (await listOpenNotices(bank.database)).filter((each) => each.condition === REDO_STOPPED),
      ).toHaveLength(1);
      expect(await runRedo()).toBe("not due");
      expect(attempts).toBe(REDO_ATTEMPTS);

      // The next return runs a redo that works, which ends the notice.
      unregister();
      stopCategorization = registerRedoStep("Categories", async () => []);
      await markAiAway(bank.database, "outage", NOW());
      expect(await claimAiBack(bank.database, NOW())).toBe(true);
      await runRedoJob();
      expect(
        (await listOpenNotices(bank.database)).filter((each) => each.condition === REDO_STOPPED),
      ).toEqual([]);
      expect((await readAiRedo(bank.database)).failures).toBe(0);
    });
  });

  describe("AI's return after an outage", () => {
    it("comes with the first background call that works, once, and never from the AI back check", async () => {
      await claimHistoryWaitEnd(bank.database, NOW());
      await connectAi();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW());
      const ai = householdAi(options);
      stub.answers.quick = "fail";
      expect(await ai.generate({ use: "category fix", task: "Say O." })).toMatchObject({
        ready: false,
        retryAt: expect.any(Date),
      });
      expect(await readAiRedo(bank.database)).toMatchObject({ awayReason: "outage" });
      expect(await checkAiBack()).toBe(false);
      expect(started).toBe(0);

      vi.setSystemTime(NOW().getTime() + MINUTE);
      stub.answers.quick = "work";
      expect(await ai.generate({ use: "category fix", task: "Say O." })).toMatchObject({
        ready: true,
      });
      expect(await ai.generate({ use: "category fix", task: "Say O." })).toMatchObject({
        ready: true,
      });
      expect(backs).toBe(1);
      expect(await readAiRedo(bank.database)).toMatchObject({
        awayAt: null,
        dueAt: new Date(NOW().getTime() + MINUTE),
      });
    });

    it("never counts the wait for the history as AI away", async () => {
      historyLoaded = false;
      await connectAi();
      const ai = householdAi(options);
      expect(await ai.generate({ use: "category fix", task: "Say O." })).toMatchObject({
        pause: "waits for history",
      });
      expect(await readAiRedo(bank.database)).toMatchObject({ awayAt: null });
    });
  });
});
