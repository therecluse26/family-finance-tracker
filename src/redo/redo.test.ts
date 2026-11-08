import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AiGates,
  type AiOptions,
  aiActivity,
  aiCost,
  aiSettings,
  householdAi,
  RETRY_DELAYS_MS,
  runAiRetries,
  startAiRetries,
} from "../ai/index.ts";
import { newAiKey, type StubMessage, StubModels } from "../ai/testing.ts";
import { seedDemoHousehold } from "../bank/demo.ts";
import { type FakePage, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { runFirstRun, syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import {
  AI_UNSURE_KIND,
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
  readAiRetry,
  storeAiFailure,
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
  type AiWorkKind,
  type AiWorkRun,
  type AiWorkView,
  aiWorkView,
  checkAiBack,
  monthsBefore,
  PROGRESS_MS,
  pressAiWork,
  REDO_ATTEMPTS,
  REDO_STOPPED,
  registerRedoStep,
  retryRedo,
  runRedo,
  runRedoJob,
  startRedo,
} from "./index.ts";

// The first AI run and the redo of no-AI work (spec 08, Runs that reuse these uses, Redo of no-AI
// work; spec 03, AI decisions and the no-AI path), through the First run job, the AI back check and
// the Redo no-AI work job, on Transactions the fake adapter syncs: the demo Household, or a few of
// the test's own. The AI is AI SDK test models. No test calls an AI provider.

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
    check: `Topic ${n}: ${40 + n} a month.`,
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
  // The kinds of the Member's runs whose jobs started.
  let works: AiWorkKind[];
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
    works = [];
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
      startWork: async (kind) => {
        works.push(kind);
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
        again: undefined,
        answered: 1,
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

    // Settings, AI's two buttons (spec 08, AI work on your Transactions). A press starts the run's
    // job: here `works` records it, and the test runs the job's work itself.
    describe("AI work on your Transactions", () => {
      const view = () => aiWorkView();
      const fixCategory = (category: string) => {
        const replyTo = stub.replyTo;
        stub.replyTo = (messages) => {
          const reply = replyTo?.(messages) ?? "O";
          return useOf(textsOf(messages)) === "category fix"
            ? reply.replaceAll('"Pets"', `"${category}"`)
            : reply;
        };
      };

      it("finishes the marked work at once, before AI comes back, and keeps a Member's answers out", async () => {
        await atTheCap();
        const marked = (await view()).waiting;
        expect(marked).toBeGreaterThan(0);
        // At the cap, the press is refused with its reason, makes no call, and starts no job.
        expect(await pressAiWork("finish")).toEqual({ started: false, refusal: "cost cap" });
        expect(await view()).toMatchObject({ running: null, waits: "cost cap", lastRun: null });

        // A Member raises the cap. AI has not come back: no redo is due.
        pausedUntil = undefined;
        expect(await runRedo()).toBe("not due");
        expect(await pressAiWork("finish")).toMatchObject({ started: true });
        expect(works).toEqual(["finish"]);
        expect((await view()).running).toEqual({ kind: "finish", step: "starting" });
        // One run at a time: a second press is refused, and a redo that AI's return starts gives
        // way to the Member's run.
        expect(await pressAiWork("all history")).toEqual({ started: false, refusal: "running" });
        expect(await runRedo()).toBe("busy");
        expect(asked).toEqual([]);

        const steps: AiWorkView["running"][] = [];
        stub.beforeAnswer = async () => {
          steps.push((await view()).running);
        };
        await runRedoJob("finish");

        expect(steps).toContainEqual(
          expect.objectContaining({ kind: "finish", step: "Money movement" }),
        );
        expect(steps).toContainEqual(
          expect.objectContaining({ kind: "finish", step: "Categories" }),
        );
        expect(fixedRows().sort()).toEqual(["CARD PURCHASE GUESS-1", "CARD PURCHASE GUESS-2"]);
        expect(asked.map((call) => call.use).sort()).toEqual(["category fix", "pairs", "picks"]);
        expect(await partOf("hand")).toMatchObject({ category: "Groceries", source: "hand-set" });
        const after = await view();
        expect(after).toMatchObject({ running: null, waits: null, waiting: 0 });
        expect(after.lastRun).toEqual({
          at: NOW().toISOString(),
          items: marked,
          // guess-1 and guess-2.
          aiCategories: 2,
          outcome: "finished",
        });
        expect(await itemsOf(BEST_GUESS_KIND)).toEqual([]);

        // Nothing is left: the next press is refused and makes no call.
        const calls = stub.calls.length;
        expect(await pressAiWork("finish")).toEqual({ started: false, refusal: "nothing waits" });
        expect(works).toEqual(["finish"]);
        expect(stub.calls).toHaveLength(calls);
      });

      // The progress bar (spec 08, AI work on your Transactions, Progress bar): the status line and
      // the live AI status carry the run's items, its step's place and the time left as it goes.
      it("shows a run's progress in the status line and the live AI status as it goes, and none once it ends", async () => {
        await atTheCap();
        pausedUntil = undefined;
        const marked = (await view()).waiting;
        // The run counts its items every 5 ms here, and every second in the app.
        expect(PROGRESS_MS).toBe(1_000);
        redo.stop();
        let clock = NOW().getTime();
        const counting = startRedo({
          database: bank.database,
          ai: householdAi(options),
          now: () => new Date(clock),
          startJob: async () => undefined,
          startWork: async (kind) => {
            works.push(kind);
          },
          progressMs: 5,
        });
        stops.push(counting.stop);
        const live: AiWorkRun[] = [];
        const stopWatching = aiActivity.watch(
          (next) => {
            if (next.run !== null) live.push(next.run);
          },
          () => undefined,
        );
        const shown: (AiWorkRun | null)[] = [];
        stub.beforeAnswer = async () => {
          shown.push((await view()).running);
          // 20 seconds pass during each call, while the run counts its items.
          clock += 20_000;
          await new Promise((resolve) => setTimeout(resolve, 30));
        };

        expect(await pressAiWork("finish")).toMatchObject({ started: true });
        // Before the run counts its items, it has no progress.
        expect((await view()).running).toEqual({ kind: "finish", step: "starting" });
        await runRedoJob("finish");
        stopWatching();

        const steps = ["Merchant names", "Money movement", "Categories"];
        const counted = [...shown, ...live].flatMap((run) =>
          run?.progress === undefined ? [] : [{ step: run.step, ...run.progress }],
        );
        expect(counted.length).toBeGreaterThan(0);
        for (const each of counted) {
          expect(each).toMatchObject({ before: marked, steps: 3 });
          expect(each.place).toBe(steps.includes(each.step) ? steps.indexOf(each.step) + 1 : null);
          expect(each.done).toBeLessThanOrEqual(marked);
          // No time left before 30 seconds of work, or before an item is decided.
          if (each.done === 0) expect(each.minutesLeft).toBeNull();
        }
        // The first call goes before any item is decided or 30 seconds pass.
        expect(shown[0]?.progress).toMatchObject({ done: 0, place: 2, minutesLeft: null });
        // The live AI status gets the counts between steps, with the time left once known.
        expect(live).toContainEqual(
          expect.objectContaining({
            step: "Categories",
            progress: expect.objectContaining({
              place: 3,
              done: expect.any(Number),
              minutesLeft: expect.any(Number),
            }),
          }),
        );
        expect(Math.max(...live.map((run) => run.progress?.done ?? 0))).toBeGreaterThan(0);
        // Once it ends, no run shows, and the status line shows the last run.
        expect(aiActivity.now().run).toBeNull();
        expect(await view()).toMatchObject({
          running: null,
          lastRun: { items: marked, outcome: "finished" },
        });

        // A follow-up job after a sync is not a run: its calls show no run and no progress.
        const followUp: unknown[] = [];
        stub.beforeAnswer = async () => {
          followUp.push(aiActivity.now().run);
        };
        await sync([buy("after", "2026-10-07")]);
        expect(followUp.length).toBeGreaterThan(0);
        expect(followUp.every((run) => run === null)).toBe(true);
        expect((await view()).running).toBeNull();
      });

      // A use the run calls waits for its retry after a failed call (spec 08, Failures). The status
      // line shows the wait, and a Member's press skips it: the press ends those retry times and
      // starts the run now. A pause still refuses.
      it("shows a retry wait, and a press ends the retry times of the uses the run calls and starts the run", async () => {
        await atTheCap();
        pausedUntil = undefined;
        const at = (ms: number) => new Date(NOW().getTime() + ms);
        const marked = (await view()).waiting;
        await storeAiFailure(bank.database, "merchant cleanup", 1, at(60_000));
        await storeAiFailure(bank.database, "reimbursement linking", 2, at(5 * 60_000));
        // Not a use the run calls.
        await storeAiFailure(bank.database, "alert advice", 1, at(30 * 60_000));

        // The latest retry time of the uses the run calls.
        expect(await view()).toMatchObject({
          running: null,
          waits: "retry wait",
          retryAt: at(5 * 60_000).toISOString(),
          waiting: marked,
        });
        // A pause wins over a retry wait, and the refused press ends no retry time.
        pausedUntil = "2026-12-01";
        expect(await pressAiWork("finish")).toEqual({ started: false, refusal: "cost cap" });
        expect(await readAiRetry(bank.database, "merchant cleanup")).toBeDefined();
        pausedUntil = undefined;
        expect(works).toEqual([]);

        expect(await pressAiWork("finish")).toMatchObject({ started: true });
        expect(works).toEqual(["finish"]);
        expect(await readAiRetry(bank.database, "merchant cleanup")).toBeUndefined();
        expect(await readAiRetry(bank.database, "reimbursement linking")).toBeUndefined();
        expect(await readAiRetry(bank.database, "alert advice")).toBeDefined();
      });

      // Named here, not read from the redo, so a use left out of the redo's list fails a case.
      it.each([
        "merchant cleanup",
        "unclear transfer",
        "reimbursement linking",
        "category fix",
      ] as const)("a press during the retry wait of %s ends it and starts the run", async (use) => {
        await atTheCap();
        pausedUntil = undefined;
        await storeAiFailure(bank.database, use, 1, new Date(NOW().getTime() + 60_000));
        expect(await view()).toMatchObject({ waits: "retry wait" });

        expect(await pressAiWork("finish")).toMatchObject({ started: true });
        expect(works).toEqual(["finish"]);
        expect(await readAiRetry(bank.database, use)).toBeUndefined();
      });

      // The owner's case: "Finish AI work now", and one bad reply to the Category fix.
      it("goes on after a bad reply: its rows go again in halves, and the run finishes with no retry wait", async () => {
        await atTheCap();
        pausedUntil = undefined;
        let bad = 1;
        const replyTo = stub.replyTo;
        stub.replyTo = (messages) => {
          const reply = replyTo?.(messages) ?? "O";
          if (useOf(textsOf(messages)) !== "category fix" || bad === 0) return reply;
          bad -= 1;
          return reply.replaceAll('"Pets"', '"Snacks"');
        };

        expect(await pressAiWork("finish")).toMatchObject({ started: true });
        await runRedoJob("finish");

        expect(callsOf("category fix").map((call) => call.rows.length)).toEqual([2, 1, 1]);
        for (const id of ["guess-1", "guess-2"]) {
          expect(await partOf(id)).toMatchObject({ category: "Pets", source: "AI", needsAi: 0 });
        }
        expect(await readAiRetry(bank.database, "category fix")).toBeUndefined();
        expect(await readAiRedo(bank.database)).toMatchObject({ awayAt: null });
        expect(await view()).toMatchObject({
          running: null,
          waits: null,
          retryAt: null,
          waiting: 0,
          lastRun: { outcome: "finished" },
        });
      });

      it("runs the later steps after a step's use always answers badly, and keeps that step's marks", async () => {
        await atTheCap();
        pausedUntil = undefined;
        const replyTo = stub.replyTo;
        stub.replyTo = (messages) => {
          const reply = replyTo?.(messages) ?? "O";
          return useOf(textsOf(messages)) === "pairs" ? "No JSON here." : reply;
        };

        expect(await pressAiWork("finish")).toMatchObject({ started: true });
        await runRedoJob("finish");

        // One pair: its one row goes once more, alone.
        expect(callsOf("pairs").map((call) => call.rows.length)).toEqual([1, 1]);
        expect(await itemsOf(UNCLEAR_PAIR_KIND)).toMatchObject([{ needsAi: true }]);
        expect(fixedRows()).toEqual(
          expect.arrayContaining(["CARD PURCHASE GUESS-1", "CARD PURCHASE GUESS-2"]),
        );
        expect(callsOf("picks").length).toBeGreaterThan(0);
        expect((await view()).lastRun).toMatchObject({ outcome: "finished" });
        expect(await readAiRedo(bank.database)).toMatchObject({ awayAt: null });
      });

      // The owner's case after an outage: the status line's retry time is when the run starts
      // again (spec 08, Failures).
      it("starts a run that stopped when AI went away again at the retry time, once, and finishes it", async () => {
        await atTheCap();
        pausedUntil = undefined;
        stops.push(
          startAiRetries({ database: bank.database, runners: { "category fix": retryRedo } }).stop,
        );
        // AI away with no run that stopped, such as after a follow-up job's call: the follow-up
        // job's own call brings AI back.
        await markAiAway(bank.database, "outage", NOW());
        expect(await retryRedo()).toBe(false);
        vi.useFakeTimers({ toFake: ["Date"], now: NOW() });
        // The AI provider fails the Category fix.
        stub.beforeAnswer = async () => {
          const use = useOf(textsOf(stub.prompts.at(-1) ?? []));
          stub.answers.quick = use === "category fix" ? "fail" : "work";
        };

        expect(await pressAiWork("finish")).toMatchObject({ started: true });
        await runRedoJob("finish");

        const stopped = await view();
        expect(stopped).toMatchObject({ waits: "retry wait", lastRun: { outcome: "stopped" } });
        expect(await partOf("guess-1")).toMatchObject({ source: "best guess", needsAi: 1 });
        // A sync never starts it, and neither does the retry before its time.
        await sync([]);
        expect(await runAiRetries(new Date())).toEqual([]);
        expect(started).toBe(0);

        stub.beforeAnswer = async () => {};
        stub.answers.quick = "work";
        vi.setSystemTime(new Date(stopped.retryAt ?? 0));
        expect(await runAiRetries(new Date())).toEqual(["category fix"]);
        expect(started).toBe(1);
        expect(await runRedo()).toBe("done");

        // The failed call had no reply, so only the second run's call answered.
        expect(fixedRows().sort()).toEqual(["CARD PURCHASE GUESS-1", "CARD PURCHASE GUESS-2"]);
        expect(await partOf("guess-1")).toMatchObject({ source: "AI", needsAi: 0 });
        expect(await view()).toMatchObject({
          waits: null,
          waiting: 0,
          lastRun: { outcome: "finished" },
        });
        // The retry time starts it once.
        expect(await runAiRetries(new Date())).toEqual([]);
        expect(await retryRedo()).toBe(false);
        expect(started).toBe(1);
      });

      it("stops a run whose model always answers badly: the third bad reply takes the retries, which end", async () => {
        await atTheCap();
        pausedUntil = undefined;
        stops.push(
          startAiRetries({ database: bank.database, runners: { "category fix": retryRedo } }).stop,
        );
        vi.useFakeTimers({ toFake: ["Date"], now: NOW() });
        fixCategory("Snacks");

        expect(await pressAiWork("finish")).toMatchObject({ started: true });
        await runRedoJob("finish");
        expect(callsOf("category fix").map((call) => call.rows.length)).toEqual([2, 1, 1]);
        expect((await view()).lastRun).toMatchObject({ outcome: "stopped" });

        // Each retry starts the run again, which makes one call and stops.
        for (const delay of RETRY_DELAYS_MS) {
          vi.setSystemTime(Date.now() + delay);
          expect(await runAiRetries(new Date())).toEqual(["category fix"]);
          expect(await runRedo()).toBe("AI away");
        }
        expect(callsOf("category fix").map((call) => call.rows.length)).toEqual([2, 1, 1, 2, 2, 2]);
        expect(started).toBe(RETRY_DELAYS_MS.length);

        // After the last retry, nothing more is due: the marks wait for AI's next return.
        expect(await readAiRetry(bank.database, "category fix")).toBeUndefined();
        vi.setSystemTime(Date.now() + 24 * 60 * 60_000);
        expect(await runAiRetries(new Date())).toEqual([]);
        expect(await partOf("guess-1")).toMatchObject({ source: "best guess", needsAi: 1 });
        expect(await view()).toMatchObject({ waits: null, retryAt: null });
      });

      it("refuses a press while AI waits, with no call, and gives the place back", async () => {
        const calls = stub.calls.length;
        historyLoaded = false;
        expect(await pressAiWork("all history")).toEqual({
          started: false,
          refusal: "waits for history",
        });
        historyLoaded = true;
        pausedUntil = "2026-12-01";
        expect(await pressAiWork("all history")).toEqual({ started: false, refusal: "cost cap" });
        pausedUntil = undefined;
        await aiSettings(options).remove();
        expect(await pressAiWork("all history")).toEqual({
          started: false,
          refusal: "no AI provider",
        });
        expect((await view()).waits).toBe("no AI provider");
        expect(works).toEqual([]);
        expect(asked).toEqual([]);
        expect(stub.calls).toHaveLength(calls);

        await connectAi();
        expect(await pressAiWork("all history")).toMatchObject({ started: true });
        expect(works).toEqual(["all history"]);
      });

      it("starts one run for presses sent together", async () => {
        const pressed = await Promise.all([
          pressAiWork("all history"),
          pressAiWork("finish"),
          pressAiWork("all history"),
        ]);

        expect(pressed.filter((each) => each.started)).toHaveLength(1);
        expect(pressed.filter((each) => !each.started)).toEqual([
          { started: false, refusal: "running" },
          { started: false, refusal: "running" },
        ]);
        expect(works).toEqual(["all history"]);
        await runRedoJob("all history");
        expect(await pressAiWork("all history")).toMatchObject({ started: true });
        expect(works).toEqual(["all history", "all history"]);
      });

      it("sends the AI each Category of the last 18 months that no hand edit, Category rule, or Money movement set, past the provider and Merchant history", async () => {
        const cutoff = monthsBefore("2026-11-20", 18);
        expect(cutoff).toBe("2025-05-20");
        const shared = (id: string, postedDate: string) =>
          txn(id, CARD, -1_800, postedDate, {
            description: `SHARED SHOP ${id.toUpperCase()}`,
            merchantName: "Shared Shop",
          });
        const regular = (id: string, postedDate: string) =>
          txn(id, CARD, -1_200, postedDate, {
            description: `REGULAR CAFE ${id.toUpperCase()}`,
            merchantName: "Regular Cafe",
          });
        // Best guesses at the cap. Merchant history would now decide cafe-5, once the Transactions
        // before it are in.
        pausedUntil = "2026-12-01";
        await sync([buy("guess", "2026-10-14"), regular("cafe-5", "2026-10-14")]);
        pausedUntil = undefined;
        await sync([
          buy("recent", "2026-10-10"),
          buy("edge", cutoff),
          buy("old", "2025-05-19"),
          buy("gone", "2026-10-11"),
          shared("ruled-1", "2026-10-12"),
          shared("ruled-2", "2026-10-13"),
          // A confident provider category: cascade step 3.
          txn("plaid", CARD, -6_000, "2026-09-28", {
            description: "HARBOR GRILL",
            merchantName: "Harbor Grill",
            category: {
              name: "FOOD_AND_DRINK_RESTAURANT",
              confidence: "HIGH",
              version: "v2",
              mcc: null,
            },
          }),
          // Three Categories the AI chose for one Merchant, so the fourth takes Merchant history.
          regular("cafe-1", "2026-09-01"),
          regular("cafe-2", "2026-09-08"),
          regular("cafe-3", "2026-09-15"),
          regular("cafe-4", "2026-09-22"),
          buy("income", "2026-10-15"),
          buy("linked", "2026-10-16"),
          buy("moved", "2026-10-17"),
          buy("loan", "2026-10-18"),
        ]);
        // A Member's correction makes a Category rule, and the rule sets the other Transaction.
        await correctCategory(
          bank.database,
          await idOf("ruled-1"),
          "Groceries",
          { onlyThisTransaction: false, memberId: MEMBER },
          NOW(),
        );
        await runFollowUp(NOW);
        expect(await partOf("ruled-1")).toMatchObject({
          category: "Groceries",
          source: "hand-set",
        });
        expect(await partOf("ruled-2")).toMatchObject({
          category: "Groceries",
          source: "Category rule",
        });
        expect(await partOf("plaid")).toMatchObject({ source: "provider", needsAi: 0 });
        expect(await partOf("cafe-4")).toMatchObject({
          category: "Pets",
          source: "Merchant history",
          needsAi: 0,
        });
        // Parts the cascade does not cover keep their Category whatever its source: here, a part
        // that is not Spending, and a Refund its link reduces. A Category Money movement named
        // takes the place of steps 3 to 6.
        const execute = (sql: string, id: string) =>
          bank.database.$client.execute({ sql, args: [id] });
        await execute(
          "UPDATE transaction_parts SET type = 'Income' WHERE transaction_id = ?",
          await idOf("income"),
        );
        await execute(
          "UPDATE transaction_parts SET type = 'Refund', linked = 1 WHERE transaction_id = ?",
          await idOf("linked"),
        );
        await execute(
          "UPDATE transaction_parts SET category = 'Cash', category_source = 'money movement' WHERE transaction_id = ?",
          await idOf("moved"),
        );
        // A part of a tracked loan payment keeps its Category, whatever chose it.
        await execute(
          "UPDATE transaction_parts SET keeps_category = 1 WHERE transaction_id = ?",
          await idOf("loan"),
        );
        await execute(
          "UPDATE transactions SET hidden_reason = 'removed by provider' WHERE id = ?",
          await idOf("gone"),
        );
        for (const id of ["recent", "edge", "old", "gone"]) {
          expect(await partOf(id)).toMatchObject({ category: "Pets", source: "AI", needsAi: 0 });
        }
        expect(await partOf("guess")).toMatchObject({ source: "best guess", needsAi: 1 });
        expect(await partOf("cafe-5")).toMatchObject({ source: "best guess", needsAi: 1 });
        asked = [];
        // The AI answers low: as at step 5, each answer goes on the Review list.
        fixCategory("Hobbies");
        const replyTo = stub.replyTo;
        stub.replyTo = (messages) => {
          const reply = replyTo?.(messages) ?? "O";
          return useOf(textsOf(messages)) === "category fix"
            ? reply.replaceAll('"high"', '"low"')
            : reply;
        };

        expect(await pressAiWork("all history")).toMatchObject({ started: true });
        const sent = [
          ...["cafe-1", "cafe-2", "cafe-3", "cafe-4", "cafe-5"],
          ...["edge", "guess", "plaid", "recent"],
        ];
        expect((await view()).waiting).toBe(sent.length + 1);
        await runRedoJob("all history");

        // One Quick batch holds them all.
        expect(callsOf("category fix")).toHaveLength(1);
        expect(fixedRows().sort()).toEqual([
          "CARD PURCHASE EDGE",
          "CARD PURCHASE GUESS",
          "CARD PURCHASE RECENT",
          "CARD PURCHASE UNSURE",
          "HARBOR GRILL",
          "REGULAR CAFE CAFE-1",
          "REGULAR CAFE CAFE-2",
          "REGULAR CAFE CAFE-3",
          "REGULAR CAFE CAFE-4",
          "REGULAR CAFE CAFE-5",
        ]);
        for (const id of [...sent, "unsure"]) {
          expect(await partOf(id)).toEqual({ category: "Hobbies", source: "AI", needsAi: 0 });
        }
        const unsure = new Set(
          (await itemsOf(AI_UNSURE_KIND)).flatMap((item) =>
            item.subject.type === "transactions" ? item.subject.transactionIds : [],
          ),
        );
        for (const id of [...sent, "unsure"]) expect(unsure.has(await idOf(id))).toBe(true);
        // Older than 18 months, hidden, set by hand, by a Category rule, or by Money movement, a
        // part the cascade does not cover, or a part of a tracked loan payment: never marked,
        // never sent.
        expect(await partOf("old")).toEqual({ category: "Pets", source: "AI", needsAi: 0 });
        expect(await partOf("gone")).toEqual({ category: "Pets", source: "AI", needsAi: 0 });
        expect(await partOf("ruled-1")).toMatchObject({ category: "Groceries", needsAi: 0 });
        expect(await partOf("ruled-2")).toMatchObject({ category: "Groceries", needsAi: 0 });
        expect(await partOf("income")).toEqual({ category: "Pets", source: "AI", needsAi: 0 });
        expect(await partOf("linked")).toEqual({ category: "Pets", source: "AI", needsAi: 0 });
        expect(await partOf("loan")).toEqual({ category: "Pets", source: "AI", needsAi: 0 });
        expect(await partOf("moved")).toEqual({
          category: "Cash",
          source: "money movement",
          needsAi: 0,
        });
        expect(await view()).toMatchObject({
          waiting: 0,
          lastRun: { items: sent.length + 1, aiCategories: sent.length + 1, outcome: "finished" },
        });
        expect(callsOf("insight cards")).toEqual([]);

        // The press marked them once: the job's next attempt asks about nothing again.
        expect(await runRedo("all history")).toBe("done");
        expect(callsOf("category fix")).toHaveLength(1);
      });

      it("lets a hand edit and a Category rule made after the press win over the AI", async () => {
        const late = (id: string) =>
          txn(id, CARD, -1_800, "2026-10-20", {
            description: `LATE SHOP ${id.toUpperCase()}`,
            merchantName: "Late Shop",
          });
        await sync([late("late-1"), late("late-2")]);
        expect(await partOf("late-2")).toMatchObject({ source: "AI", needsAi: 0 });
        asked = [];
        fixCategory("Hobbies");

        expect(await pressAiWork("all history")).toMatchObject({ started: true });
        expect(await partOf("late-2")).toMatchObject({ needsAi: 1 });
        // Before the job runs, a Member's correction makes a Category rule for the Merchant.
        await correctCategory(
          bank.database,
          await idOf("late-1"),
          "Groceries",
          { onlyThisTransaction: false, memberId: MEMBER },
          NOW(),
        );
        await runRedoJob("all history");

        expect(fixedRows().sort()).toEqual(["CARD PURCHASE UNSURE"]);
        expect(await partOf("late-1")).toEqual({
          category: "Groceries",
          source: "hand-set",
          needsAi: 0,
        });
        expect(await partOf("late-2")).toEqual({
          category: "Groceries",
          source: "Category rule",
          needsAi: 0,
        });
      });

      it("keeps the AI's Categories and their marks when AI goes away during the run, never a best guess", async () => {
        // 101 Categories the AI chose: two batches, so the last one is decided after AI went away.
        const bought = Array.from({ length: 101 }, (_, n) =>
          buy(`b${String(n).padStart(3, "0")}`, "2026-08-01"),
        );
        await sync(bought);
        // A name the rules cannot clean, from a sync at the cap.
        pausedUntil = "2026-12-01";
        await sync([
          txn("odd", CARD, -900, "2026-07-01", { description: "QX ZRT LMN OPQ RST UVW" }),
        ]);
        pausedUntil = undefined;
        expect(await listMarkedNameIds(bank.database)).toEqual([await idOf("odd")]);
        asked = [];
        fixCategory("Hobbies");
        // The cap is reached during the run's first call, the name's cleanup.
        stub.beforeAnswer = async () => {
          pausedUntil = "2026-12-01";
        };

        expect(await pressAiWork("all history")).toMatchObject({ started: true });
        await runRedoJob("all history");

        expect(callsOf("merchant cleanup")).toHaveLength(1);
        expect(callsOf("category fix")).toEqual([]);
        for (const txn of [bought[0], bought[99], bought[100]]) {
          expect(await partOf(txn?.id ?? "")).toEqual({
            category: "Pets",
            source: "AI",
            needsAi: 1,
          });
        }
        expect(
          await count(
            `SELECT count(*) AS n FROM transaction_parts
             WHERE category_source = 'best guess' AND category_needs_ai = 1`,
          ),
        ).toBe(1);
        expect(await itemsOf(BEST_GUESS_KIND)).toHaveLength(1);
        expect((await view()).lastRun).toMatchObject({ items: 1, outcome: "stopped" });
        expect(await pressAiWork("finish")).toEqual({ started: false, refusal: "cost cap" });

        // AI's next return redoes them.
        stub.beforeAnswer = async () => {};
        pausedUntil = undefined;
        expect(await checkAiBack()).toBe(true);
        await runRedoJob();
        expect(await partOf(bought[100]?.id ?? "")).toEqual({
          category: "Hobbies",
          source: "AI",
          needsAi: 0,
        });
        expect(await view()).toMatchObject({ waiting: 0, lastRun: { outcome: "finished" } });
      });

      it("keeps a marked Category and its mark when AI goes away between the run's batches, and the next redo asks the AI", async () => {
        // 102 Categories the AI chose and a confident provider category: two batches.
        const bought = Array.from({ length: 101 }, (_, n) =>
          buy(`b${String(n).padStart(3, "0")}`, "2026-08-01"),
        );
        await sync([
          ...bought,
          txn("plaid", CARD, -6_000, "2026-08-02", {
            description: "HARBOR GRILL",
            merchantName: "Harbor Grill",
            category: {
              name: "FOOD_AND_DRINK_RESTAURANT",
              confidence: "HIGH",
              version: "v2",
              mcc: null,
            },
          }),
        ]);
        const plaid = await partOf("plaid");
        expect(plaid).toMatchObject({ source: "provider", needsAi: 0 });
        asked = [];
        fixCategory("Hobbies");
        // The cap is reached during the first batch: the second one gets no answer.
        stub.beforeAnswer = async () => {
          pausedUntil = "2026-12-01";
        };

        expect(await pressAiWork("all history")).toMatchObject({ started: true });
        await runRedoJob("all history");

        expect(callsOf("category fix")).toHaveLength(1);
        // The second batch got no answer: its Categories keep their source and their mark.
        expect(
          await count(
            `SELECT count(*) AS n FROM transaction_parts
             WHERE category_source = 'AI' AND category_needs_ai = 1`,
          ),
        ).toBe(2);
        expect(
          await count(
            `SELECT count(*) AS n FROM transaction_parts
             WHERE category = 'Hobbies' AND category_source = 'AI' AND category_needs_ai = 0`,
          ),
        ).toBe(100);
        expect(await partOf("plaid")).toEqual({ ...plaid, needsAi: 1 });
        expect((await view()).lastRun).toMatchObject({ aiCategories: 100, outcome: "stopped" });

        // AI's next return asks the AI about each Category still marked, past the provider.
        stub.beforeAnswer = async () => {};
        pausedUntil = undefined;
        expect(await checkAiBack()).toBe(true);
        await runRedoJob();
        expect(await partOf("plaid")).toEqual({ category: "Hobbies", source: "AI", needsAi: 0 });
        expect(await view()).toMatchObject({
          waiting: 0,
          lastRun: { aiCategories: 3, outcome: "finished" },
        });
      });

      // The marked best guess Merchant history can now decide, and one on a hidden Transaction.
      const guessAtTheCap = async () => {
        const regular = (id: string, postedDate: string) =>
          txn(id, CARD, -1_200, postedDate, {
            description: `REGULAR CAFE ${id.toUpperCase()}`,
            merchantName: "Regular Cafe",
          });
        pausedUntil = "2026-12-01";
        await sync([regular("cafe-4", "2026-10-14"), buy("hidden-guess", "2026-10-15")]);
        pausedUntil = undefined;
        await bank.database.$client.execute({
          sql: "UPDATE transactions SET hidden_reason = 'removed by provider' WHERE id = ?",
          args: [await idOf("hidden-guess")],
        });
        // Three Categories the AI chose for the Merchant, posted before it.
        await sync([
          regular("cafe-1", "2026-09-01"),
          regular("cafe-2", "2026-09-08"),
          regular("cafe-3", "2026-09-15"),
        ]);
        expect(await partOf("cafe-4")).toMatchObject({ source: "best guess", needsAi: 1 });
        expect(await partOf("hidden-guess")).toMatchObject({ source: "best guess", needsAi: 1 });
        // A hidden Transaction's mark does not wait for the AI.
        expect((await view()).waiting).toBe(1);
        asked = [];
        fixCategory("Hobbies");
      };

      it.each([
        ["AI's return", undefined],
        ["Finish AI work now", "finish"],
      ] as const)(
        "lets Merchant history decide a marked best guess in %s, with no AI call",
        async (_, kind) => {
          await guessAtTheCap();
          if (kind === undefined) {
            await markAiAway(bank.database, "pause", NOW());
            expect(await claimAiBack(bank.database, NOW())).toBe(true);
          } else {
            expect(await pressAiWork(kind)).toMatchObject({ started: true });
          }
          await runRedoJob(kind);

          expect(fixedRows()).toEqual([]);
          expect(await partOf("cafe-4")).toEqual({
            category: "Pets",
            source: "Merchant history",
            needsAi: 0,
          });
          expect(await view()).toMatchObject({
            waiting: 0,
            lastRun: { items: 1, aiCategories: 0, outcome: "finished" },
          });
        },
      );

      it("sends a marked best guess Merchant history could decide to the AI in Run AI on all history", async () => {
        await guessAtTheCap();
        expect(await pressAiWork("all history")).toMatchObject({ started: true });
        await runRedoJob("all history");

        expect(fixedRows()).toContain("REGULAR CAFE CAFE-4");
        expect(await partOf("cafe-4")).toEqual({ category: "Hobbies", source: "AI", needsAi: 0 });
      });

      // The first AI run's Insight card run fails after the steps on each attempt, here with a
      // database error.
      const insightCardsAlwaysFail = async () => {
        await bank.database.$client.execute("UPDATE ai_redo SET first_run_done_at = NULL");
        await bank.database.$client.execute(
          "ALTER TABLE insight_cards RENAME TO insight_cards_gone",
        );
      };
      const stoppedNotices = async () =>
        (await listOpenNotices(bank.database)).filter((each) => each.condition === REDO_STOPPED);

      it("stops a Member's run whose Insight card run always fails after its last attempt, with one System notice", async () => {
        await insightCardsAlwaysFail();
        expect(await pressAiWork("finish")).toMatchObject({ started: true });

        for (let attempt = 1; attempt < REDO_ATTEMPTS; attempt += 1) {
          await expect(runRedoJob("finish")).rejects.toThrow();
          expect((await readAiRedo(bank.database)).failures).toBe(attempt);
          expect(await pressAiWork("all history")).toEqual({
            started: false,
            refusal: "running",
          });
        }
        await runRedoJob("finish");

        expect(await stoppedNotices()).toHaveLength(1);
        expect(await view()).toMatchObject({ running: null, lastRun: { outcome: "stopped" } });
        expect(await pressAiWork("finish")).toMatchObject({ started: true });
        expect(works).toEqual(["finish", "finish"]);
      });

      it("stops a redo AI's return starts whose Insight card run always fails after its last attempt, with one System notice", async () => {
        await insightCardsAlwaysFail();
        await markAiAway(bank.database, "pause", NOW());
        expect(await claimAiBack(bank.database, NOW())).toBe(true);

        for (let attempt = 1; attempt < REDO_ATTEMPTS; attempt += 1) {
          await expect(runRedoJob()).rejects.toThrow();
          expect((await readAiRedo(bank.database)).failures).toBe(attempt);
        }
        await runRedoJob();

        expect(await stoppedNotices()).toHaveLength(1);
        expect(await readAiRedo(bank.database)).toMatchObject({ dueAt: null, failures: 0 });
        expect(await view()).toMatchObject({ running: null, lastRun: { outcome: "stopped" } });
      });

      it("stops a Member's run after its last attempt with one System notice, and takes a new press", async () => {
        stopCategorization();
        let attempts = 0;
        stopCategorization = registerRedoStep("Categories", async () => {
          attempts += 1;
          throw new Error("The step always fails.");
        });
        expect(await pressAiWork("all history")).toMatchObject({ started: true });

        for (let attempt = 1; attempt < REDO_ATTEMPTS; attempt += 1) {
          await expect(runRedoJob("all history")).rejects.toThrow("The step always fails.");
          // Between attempts the run still holds its place.
          expect(await pressAiWork("finish")).toEqual({ started: false, refusal: "running" });
        }
        await runRedoJob("all history");

        expect(attempts).toBe(REDO_ATTEMPTS);
        expect(
          (await listOpenNotices(bank.database)).filter((each) => each.condition === REDO_STOPPED),
        ).toHaveLength(1);
        expect(await view()).toMatchObject({ running: null, lastRun: { outcome: "stopped" } });
        expect(await pressAiWork("all history")).toMatchObject({ started: true });
        expect(works).toEqual(["all history", "all history"]);
      });
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
