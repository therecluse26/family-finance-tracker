import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AiOptions, aiCost, aiSettings, householdAi } from "../ai/index.ts";
import { newAiKey, type StubMessage, StubModels } from "../ai/testing.ts";
import { type FakePage, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { deleteRemovedConnection, markConnectionRemoved } from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { openReviewItems } from "../review/index.ts";
import {
  addManualLoan,
  linkByHand,
  type ManualLoanInput,
  MONEY_FROM_PERSON_KIND,
  POSSIBLE_PAYMENT_KIND,
  readTransactionDecision,
  readTransactionDetail,
  startMoneyMovement,
  UNCLEAR_PAIR_KIND,
  undoLink,
} from "./index.ts";

// The Quick tier's link decisions (spec 03, Tiers, Reimbursements, AI decisions and the no-AI
// path; spec 08, Every AI use, Failures), through the Matching follow-up step on Transactions the
// fake adapter syncs, with AI SDK test models. No test calls an AI provider.

const NOW = () => new Date("2026-11-20T14:00:00.000Z");
const MEMBER = "member-1";
const MINUTE = 60_000;

type Confidence = "high" | "medium" | "low";
type YesOrNo = { answer: "yes" | "no"; confidence: Confidence };
type Row = Record<string, string | number | null> & { row: number };

describe("the Quick tier's link decisions", () => {
  let bank: TestBank;
  let stub: StubModels;
  let stops: (() => void)[];
  let options: AiOptions;
  const connections = new Map<string, string>();

  // Checking and savings at Maple, a card at Birch, and a card at Cedar. Each keeps the fake
  // adapter's two-word name, such as "Account birch-card", which the privacy filter replaces with
  // its label wherever it finds it.
  const CHECKING = fakeAccount({ id: "maple-checking", mask: "1111" });
  const SAVINGS = fakeAccount({ id: "maple-savings", subtype: "savings", mask: "2222" });
  const CARD = fakeAccount({ id: "birch-card", type: "credit", subtype: "credit card" });
  const OTHER_CARD = fakeAccount({ id: "cedar-card", type: "credit", subtype: "credit card" });
  const BANKS = [
    { bankId: "maple", name: "Maple Bank", accounts: [CHECKING, SAVINGS] },
    { bankId: "birch", name: "Birch Card Services", accounts: [CARD] },
    { bankId: "cedar", name: "Cedar Card Co", accounts: [OTHER_CARD] },
  ];
  const bankOf = (accountId: string) =>
    BANKS.find((b) => b.accounts.some((account) => account.id === accountId))?.bankId ?? "";

  // A Transaction with a plain description and no category, so it brings no strong signal.
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

  // Syncs each record into its own bank, then runs the follow-up job.
  const sync = async (page: { added?: TxnRecord[]; changed?: TxnRecord[] }) => {
    for (const { bankId } of BANKS) {
      const mine = (record: TxnRecord) => bankOf(record.accountId) === bankId;
      const fakePage: FakePage = {
        added: (page.added ?? []).filter(mine),
        changed: (page.changed ?? []).filter(mine),
        removed: [],
        historyLoaded: true,
      };
      bank.fake.addPages(bankId, fakePage);
      await syncConnection(connections.get(bankId) ?? "", NOW);
    }
    return runFollowUp(NOW);
  };
  const idOf = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT id FROM transactions WHERE provider_transaction_id = ?",
      args: [providerId],
    });
    return String(rows.rows[0]?.id);
  };
  const itemsOf = async (kind: string) =>
    (await openReviewItems(bank.database)).filter((item) => item.kind === kind);
  const answerRows = async () =>
    (
      await bank.database.$client.execute(
        `SELECT a.kind, t.provider_transaction_id AS txn, a.answer, a.confidence
         FROM ai_link_answers a JOIN transactions t ON t.id = a.transaction_id
         ORDER BY a.kind, txn`,
      )
    ).rows.map((row) => ({ ...row }));

  // What the test model answers. Each row's answer comes from the test's function for its use.
  let pairAnswer: (row: Row) => YesOrNo;
  let loanAnswer: (row: Row) => YesOrNo;
  // The pick for one money row of a call, from all the call's rows.
  let pick: (rows: Row[], money: Row) => { spendingRow: number | null; confidence: Confidence };
  // The rows of each use's calls, and each call's user text parts, as the model read them.
  const asked = { pairs: [] as Row[][], loans: [] as Row[][], picks: [] as Row[][] };
  let sent: string[][];
  // Runs while the test model answers a call, before it reads the call's messages.
  let duringCall: () => Promise<void>;
  const textsOf = (messages: readonly StubMessage[]) =>
    messages.flatMap((message) =>
      message.role !== "user" || typeof message.content === "string"
        ? []
        : message.content.flatMap((part) => (part.text === undefined ? [] : [part.text])),
    );
  const rowsOf = (texts: readonly string[]) =>
    texts
      .filter((text) => text.startsWith('{"row":'))
      .map((text) => {
        try {
          return JSON.parse(text) as Row;
        } catch {
          throw new Error(`Not a JSON row: ${text}`);
        }
      });

  beforeEach(async () => {
    bank = await newTestBank();
    await bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('${MEMBER}', 'Avery Park', 'avery@example.com', '2026-10-01T00:00:00.000Z',
         '2026-10-01T00:00:00.000Z')`,
    );
    stub = new StubModels();
    pairAnswer = () => ({ answer: "no", confidence: "low" });
    loanAnswer = () => ({ answer: "no", confidence: "low" });
    pick = () => ({ spendingRow: null, confidence: "low" });
    asked.pairs = [];
    asked.loans = [];
    asked.picks = [];
    sent = [];
    duringCall = async () => {};
    // The test model's reply to each call comes from the call's own messages.
    stub.replyTo = (messages) => {
      const texts = textsOf(messages);
      sent.push(texts);
      const rows = rowsOf(texts);
      if (texts.some((text) => text.startsWith("Each row is a possible Transfer"))) {
        asked.pairs.push(rows);
        return JSON.stringify({
          answers: rows.map((row) => ({ row: row.row, ...pairAnswer(row) })),
        });
      }
      if (texts.some((text) => text.includes("the lender of a loan"))) {
        asked.loans.push(rows);
        return JSON.stringify({
          answers: rows.map((row) => ({ row: row.row, ...loanAnswer(row) })),
        });
      }
      if (texts.some((text) => text.startsWith("The first rows are money"))) {
        asked.picks.push(rows);
        const money = rows.filter((row) => row.kind === "money in");
        return JSON.stringify({
          answers: money.map((row) => ({ row: row.row, ...pick(rows, row) })),
        });
      }
      return "O";
    };
    stub.beforeAnswer = () => duringCall();
    options = {
      database: bank.database,
      secrets: bank.secrets,
      makeModels: stub.makeModels,
      cost: aiCost({ database: bank.database }),
      notices: { raise: async () => {}, end: async () => {} },
    };
    const saved = await aiSettings(options).save(
      {
        provider: "anthropic",
        apiKey: newAiKey(),
        baseUrl: null,
        quickModel: "quick-model",
        writerModel: "writer-model",
        prices: {
          quick: { input: 1_000_000, output: 2_000_000 },
          writer: { input: 1_000_000, output: 2_000_000 },
        },
      },
      { freshCode: true },
    );
    expect(saved).toMatchObject({ saved: true });
    stops = [startMoneyMovement({ database: bank.database, ai: householdAi(options) }).stop];
    connections.clear();
    for (const { bankId, name, accounts } of BANKS) {
      connections.set(bankId, await bank.connect(bankId, name));
      bank.fake.addPages(bankId, { accounts });
      await syncConnection(connections.get(bankId) ?? "", NOW);
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  describe("Unclear Transfer pairs", () => {
    const transferLinks = async () =>
      (
        await bank.database.$client.execute(
          `SELECT o.provider_transaction_id AS out_id, i.provider_transaction_id AS in_id,
             l.made_by AS madeBy, l.tier, l.ai_answer AS aiAnswer, l.ai_confidence AS aiConfidence
           FROM transfer_links l
           JOIN transactions o ON o.id = l.out_transaction_id
           JOIN transactions i ON i.id = l.in_transaction_id
           ORDER BY out_id`,
        )
      ).rows.map((row) => ({
        pair: `${row.out_id} → ${row.in_id}`,
        madeBy: row.madeBy,
        tier: row.tier,
        aiAnswer: row.aiAnswer,
        aiConfidence: row.aiConfidence,
      }));
    const byAmount: Record<string, YesOrNo> = {
      "$10.01": { answer: "yes", confidence: "high" },
      "$10.02": { answer: "no", confidence: "high" },
      "$10.03": { answer: "yes", confidence: "medium" },
      "$10.04": { answer: "no", confidence: "low" },
    };

    it("links on a high yes, drops a high no, and offers anything else, in one batch with no IDs", async () => {
      pairAnswer = (row) => byAmount[String(row.out_amount)] ?? { answer: "no", confidence: "low" };
      await sync({
        added: [1, 2, 3, 4].flatMap((n) => [
          txn(`maple-${n}`, CHECKING, -1_000 - n, "2026-10-05"),
          txn(`birch-${n}`, CARD, 1_000 + n, "2026-10-06"),
        ]),
      });

      // One call holds the four pairs, with dates, amounts, descriptions, and Account labels.
      expect(asked.pairs).toHaveLength(1);
      const rows = asked.pairs[0] ?? [];
      expect(rows.map((row) => row.out_amount).sort()).toEqual([
        "$10.01",
        "$10.02",
        "$10.03",
        "$10.04",
      ]);
      expect(rows[0]).toMatchObject({
        out_date: "2026-10-05",
        out_description: "ONLINE DEBIT",
        out_account: expect.any(String),
        in_date: "2026-10-06",
        in_description: "ONLINE CREDIT",
        in_account: expect.any(String),
      });
      expect(Object.keys(rows[0] ?? {}).some((field) => /id$/i.test(field))).toBe(false);
      const ids = await Promise.all(
        [1, 2, 3, 4].flatMap((n) => [idOf(`maple-${n}`), idOf(`birch-${n}`)]),
      );
      for (const id of ids) expect(JSON.stringify(sent)).not.toContain(id);

      // The AI made the link, and its evidence says so, with its answer and confidence.
      expect(await transferLinks()).toEqual([
        {
          pair: "maple-1 → birch-1",
          madeBy: "AI",
          tier: "Unclear",
          aiAnswer: "yes",
          aiConfidence: "high",
        },
      ]);
      // A high no makes no link and no item. Anything below high goes to the Review list.
      const offered = (await itemsOf(UNCLEAR_PAIR_KIND)).map((item) => item.subject);
      expect(offered).toEqual([
        { type: "transactions", transactionIds: [await idOf("maple-3"), await idOf("birch-3")] },
        { type: "transactions", transactionIds: [await idOf("maple-4"), await idOf("birch-4")] },
      ]);
      expect(
        (await bank.database.$client.execute("SELECT refused_by FROM refused_transfer_links")).rows,
      ).toMatchObject([{ refused_by: "AI" }]);
    });

    it("never asks about the same pair twice", async () => {
      pairAnswer = (row) => byAmount[String(row.out_amount)] ?? { answer: "no", confidence: "low" };
      await sync({
        added: [
          txn("maple-3", CHECKING, -1_003, "2026-10-05"),
          txn("birch-3", CARD, 1_003, "2026-10-06"),
        ],
      });
      expect(asked.pairs).toHaveLength(1);

      // A later sync decides the pair again, and the stored answer stands.
      await sync({
        changed: [txn("maple-3", CHECKING, -1_003, "2026-10-05", { description: "DEBIT" })],
      });
      expect(asked.pairs).toHaveLength(1);
      expect(await itemsOf(UNCLEAR_PAIR_KIND)).toHaveLength(1);
      expect(await answerRows()).toEqual([
        { kind: "Transfer", txn: "maple-3", answer: "yes", confidence: "medium" },
      ]);
    });

    it("pairs again without a pair the AI rejects, and asks about the next one", async () => {
      // The nearest money in is the first pick. The AI rejects it, and the other card is next.
      pairAnswer = (row) =>
        row.in_date === "2026-10-05"
          ? { answer: "no", confidence: "high" }
          : { answer: "yes", confidence: "high" };
      await sync({
        added: [
          txn("maple-out", CHECKING, -50_000, "2026-10-05"),
          txn("birch-in", CARD, 50_000, "2026-10-05"),
          txn("cedar-in", OTHER_CARD, 50_000, "2026-10-07"),
        ],
      });

      expect(asked.pairs.map((rows) => rows.map((row) => row.in_date))).toEqual([
        ["2026-10-05"],
        ["2026-10-07"],
      ]);
      expect((await transferLinks()).map((link) => [link.pair, link.madeBy])).toEqual([
        ["maple-out → cedar-in", "AI"],
      ]);
      expect(await itemsOf(UNCLEAR_PAIR_KIND)).toEqual([]);
    });

    it("never ends a Member's link, and never asks about its sides", async () => {
      await sync({
        added: [
          txn("maple-hand", CHECKING, -7_000, "2026-10-05"),
          txn("birch-hand", CARD, 7_000, "2026-10-06"),
        ],
      });
      expect(asked.pairs).toHaveLength(1);
      const made = await linkByHand(
        bank.database,
        {
          kind: "Transfer",
          outTransactionId: await idOf("maple-hand"),
          inTransactionId: await idOf("birch-hand"),
        },
        MEMBER,
        NOW(),
      );
      expect(made.outcome).toBe("linked");
      await runFollowUp(NOW);

      // Another money in of the same amount: the AI is asked about nothing, as the hand link holds
      // both sides.
      pairAnswer = () => ({ answer: "no", confidence: "high" });
      await sync({ added: [txn("cedar-same", OTHER_CARD, 7_000, "2026-10-06")] });
      expect(asked.pairs).toHaveLength(1);
      expect((await transferLinks()).map((link) => [link.pair, link.madeBy])).toEqual([
        ["maple-hand → birch-hand", "Member"],
      ]);
    });

    it("waits for the retry after a failed call, and takes the no-AI path after the last", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW());
      stub.answers.quick = "fail";
      const first = await sync({
        added: [
          txn("maple-out", CHECKING, -2_500, "2026-10-05"),
          txn("birch-in", CARD, 2_500, "2026-10-06"),
        ],
      });

      // The Matching step stops the job, and leaves the pair for the retry's follow-up job.
      expect(first).toEqual({ stoppedAt: "matching", again: new Date(NOW().getTime() + MINUTE) });
      const unhandled = await bank.database.$client.execute(
        `SELECT count(*) AS n FROM transactions t
         WHERE NOT EXISTS (SELECT 1 FROM follow_up_marks m
           WHERE m.transaction_id = t.id AND m.step = 'matching')`,
      );
      expect(unhandled.rows[0]?.n).toBe(2);
      // Before the retry is due, no call goes out.
      const calls = stub.calls.length;
      expect(await runFollowUp(NOW)).toMatchObject({ stoppedAt: "matching" });
      expect(stub.calls.length).toBe(calls);

      // Each retry fails again, at 1, 5, and 30 minutes. After the last, the pair takes the
      // no-AI path: it goes to the Review list, and the job runs on.
      let at = NOW().getTime();
      for (const wait of [1, 5, 30]) {
        at += wait * MINUTE;
        vi.setSystemTime(at);
        const run = await runFollowUp(() => new Date(at));
        expect(run === undefined).toBe(wait === 30);
      }
      expect(stub.calls.length).toBe(calls + 3);
      expect(await itemsOf(UNCLEAR_PAIR_KIND)).toHaveLength(1);
      expect(await answerRows()).toEqual([]);
    });
  });

  describe("Unclear Manual loan payments", () => {
    const loan = (fields: Partial<ManualLoanInput> = {}): ManualLoanInput => ({
      lender: "Lakeside Credit",
      kind: "car",
      balance: 1_000_000,
      balanceDate: "2026-07-01",
      apr: 7.3,
      regularPayment: 50_000,
      escrow: null,
      loanType: null,
      ...fields,
    });
    // A payment to the lender out of checking, then one out of savings under another Merchant,
    // which brings no strong signal.
    const payment = (id: string, postedDate: string, fields: Partial<TxnRecord> = {}) =>
      txn(id, CHECKING, -50_000, postedDate, {
        description: "LAKESIDE CREDIT PMT",
        merchantName: "Lakeside Credit",
        ...fields,
      });
    const unclear = (id: string, postedDate: string) =>
      payment(id, postedDate, {
        accountId: SAVINGS.id,
        description: "LAKESIDE CREDIT UNION LOAN",
        merchantName: "Lakeside Credit Union",
      });
    const loanLinks = async () =>
      (
        await bank.database.$client.execute(
          `SELECT t.provider_transaction_id AS payment, l.made_by AS madeBy, l.tier,
             l.ai_answer AS aiAnswer, l.ai_confidence AS aiConfidence
           FROM loan_links l JOIN transactions t ON t.id = l.transaction_id
           ORDER BY t.posted_date`,
        )
      ).rows.map((row) => ({ ...row }));
    const start = async (fields: Partial<ManualLoanInput> = {}) => {
      await sync({ added: [payment("aug", "2026-08-01")] });
      await addManualLoan(bank.database, loan(fields), MEMBER);
      await runFollowUp(NOW);
    };

    it("links on a high yes, drops a high no, and offers anything else", async () => {
      await start();
      const byDate: Record<string, YesOrNo> = {
        "2026-08-31": { answer: "yes", confidence: "high" },
        "2026-09-30": { answer: "no", confidence: "high" },
        "2026-10-30": { answer: "yes", confidence: "low" },
      };
      loanAnswer = (row) => byDate[String(row.payment_date)] ?? { answer: "no", confidence: "low" };
      await sync({
        added: [
          unclear("ai-yes", "2026-08-31"),
          unclear("ai-no", "2026-09-30"),
          unclear("ai-low", "2026-10-30"),
        ],
      });

      // One call, with the payment's clean Merchant name, the lender and regular payment, and the
      // last linked payment. No description.
      expect(asked.loans).toHaveLength(1);
      expect(asked.loans[0]?.find((row) => row.payment_date === "2026-08-31")).toEqual({
        row: expect.any(Number),
        payment_date: "2026-08-31",
        payment_amount: "$500.00",
        payment_merchant: expect.toBeOneOf([null, expect.any(String)]),
        payment_account: expect.any(String),
        lender: expect.stringContaining("Lakeside Credit"),
        regular_payment: "$500.00",
        last_payment_date: "2026-08-01",
        last_payment_amount: "$500.00",
        last_payment_merchant: expect.toBeOneOf([null, expect.any(String)]),
        last_payment_account: expect.any(String),
      });
      expect(JSON.stringify(asked.loans)).not.toContain("LAKESIDE CREDIT UNION LOAN");

      expect(await loanLinks()).toEqual([
        { payment: "aug", madeBy: "app", tier: "Strong", aiAnswer: null, aiConfidence: null },
        { payment: "ai-yes", madeBy: "AI", tier: "Unclear", aiAnswer: "yes", aiConfidence: "high" },
      ]);
      expect((await itemsOf(POSSIBLE_PAYMENT_KIND)).map((item) => item.subject)).toEqual([
        { type: "transactions", transactionIds: [await idOf("ai-low")] },
      ]);

      // Another sync asks nothing again.
      await sync({ added: [txn("other", CHECKING, -1_234, "2026-11-01")] });
      expect(asked.loans).toHaveLength(1);
      expect((await itemsOf(POSSIBLE_PAYMENT_KIND)).length).toBe(1);
    });

    it("never sends a Member's name in the lender a Member typed", async () => {
      await sync({
        added: [
          payment("aug", "2026-08-01", {
            description: "AVERYPARK FAMILY LOAN",
            merchantName: "AveryPark Family Loan",
          }),
        ],
      });
      await addManualLoan(bank.database, loan({ lender: "AveryPark Family Loan" }), MEMBER);
      await runFollowUp(NOW);
      await sync({
        added: [
          txn("asked", SAVINGS, -50_000, "2026-08-31", {
            description: "AVERYPARK FAMILY LOAN SVC",
            merchantName: "AveryPark Family Loan Svc",
          }),
        ],
      });

      expect(asked.loans).toHaveLength(1);
      const read = JSON.stringify(sent)
        .toLowerCase()
        .replace(/[^a-z]/g, "");
      expect(read).not.toContain("avery");
      expect(read).not.toContain("parkfamily");
    });
  });

  describe("Reimbursements", () => {
    const dinner = (id: string, amount: number, postedDate: string) =>
      txn(id, CARD, amount, postedDate, {
        description: "CORNER BISTRO",
        merchantName: "Corner Bistro",
        category: {
          name: "FOOD_AND_DRINK_RESTAURANT",
          confidence: "HIGH",
          version: "v2",
          mcc: null,
        },
      });
    const moneyIn = (id: string, amount: number, postedDate: string, description: string) =>
      txn(id, CHECKING, amount, postedDate, { description });
    const spendingLinks = async () =>
      (
        await bank.database.$client.execute(
          `SELECT m.provider_transaction_id AS money, s.provider_transaction_id AS spending,
             l.made_by AS madeBy, l.ai_answer AS aiAnswer, l.ai_confidence AS aiConfidence
           FROM spending_links l
           JOIN transactions m ON m.id = l.transaction_id
           JOIN transactions s ON s.id = l.spending_transaction_id`,
        )
      ).rows.map((row) => ({ ...row }));
    const itemAbout = async (providerId: string) => {
      const id = await idOf(providerId);
      return (await itemsOf(MONEY_FROM_PERSON_KIND)).find(
        (item) => item.subject.type === "transactions" && item.subject.transactionIds[0] === id,
      );
    };
    // The Spending row the test model picks: the one with this amount.
    const pickAmount = (amount: string, confidence: Confidence) => (rows: Row[]) => ({
      spendingRow:
        rows.find((row) => row.kind === "Spending" && row.amount === amount)?.row ?? null,
      confidence,
    });
    const setUp = () =>
      sync({
        added: [
          dinner("dinner", -6_000, "2026-09-28"),
          dinner("lunch", -2_500, "2026-09-30"),
          // More than 60 days before the money: never a choice.
          dinner("old", -9_000, "2026-08-01"),
          moneyIn("friend", 2_000, "2026-10-02", "VENMO *MORGAN LEE"),
        ],
      });

    it("links a high pick, with the AI's evidence, and reduces the Spending", async () => {
      pick = pickAmount("$60.00", "high");
      await setUp();

      // One call: the money, then the Household's Spending from the 60 days before, newest first.
      expect(asked.picks).toHaveLength(1);
      expect(asked.picks[0]).toEqual([
        {
          row: 1,
          kind: "money in",
          date: "2026-10-02",
          spending_from: "2026-08-03",
          amount: "$20.00",
          description: expect.stringContaining("VENMO"),
          account: expect.any(String),
        },
        expect.objectContaining({ row: 2, kind: "Spending", date: "2026-09-30", amount: "$25.00" }),
        expect.objectContaining({ row: 3, kind: "Spending", date: "2026-09-28", amount: "$60.00" }),
      ]);
      expect(await spendingLinks()).toEqual([
        {
          money: "friend",
          spending: "dinner",
          madeBy: "AI",
          aiAnswer: "yes",
          aiConfidence: "high",
        },
      ]);
      expect(await readTransactionDecision(bank.database, await idOf("friend"))).toMatchObject({
        parts: [{ type: "Reimbursement", amount: 2_000, linked: true }],
      });
      expect(await itemAbout("friend")).toBeUndefined();
    });

    it("asks about many money from a person in a few shared calls, each Spending once", async () => {
      const day = (n: number) => `2026-10-${String(n).padStart(2, "0")}`;
      await sync({
        added: [
          ...Array.from({ length: 80 }, (_, n) =>
            dinner(
              `meal-${n}`,
              -(1_000 + n),
              n < 30 ? `2026-09-${String(n + 1).padStart(2, "0")}` : day((n % 19) + 1),
            ),
          ),
          ...Array.from({ length: 40 }, (_, n) =>
            moneyIn(`friend-${n}`, 500 + n, day((n % 20) + 1), "VENMO *MORGAN LEE"),
          ),
        ],
      });

      // One question each would make 40 calls. Packed, 120 rows take 2 calls of up to 100.
      expect(asked.picks.length).toBeLessThanOrEqual(3);
      for (const rows of asked.picks) expect(rows.length).toBeLessThanOrEqual(100);
      const sentSpending = asked.picks.flatMap((rows) =>
        rows.filter((row) => row.kind === "Spending").map((row) => `${row.date} ${row.amount}`),
      );
      expect(sentSpending).toHaveLength(80);
      expect(new Set(sentSpending).size).toBe(80);
      expect(await answerRows()).toHaveLength(40);
    });

    it("links a pick only from the money's own 60 days", async () => {
      // Late money pays back only the September dinner, and early money only the August one.
      pick = (rows, money) => ({
        spendingRow:
          rows.find(
            (row) =>
              row.kind === "Spending" &&
              row.amount === (money.date === "2026-10-02" ? "$90.00" : "$60.00"),
          )?.row ?? null,
        confidence: "high",
      });
      await sync({
        added: [
          dinner("old", -9_000, "2026-08-01"),
          dinner("dinner", -6_000, "2026-09-28"),
          moneyIn("late", 2_000, "2026-10-02", "VENMO *MORGAN LEE"),
          moneyIn("early", 3_000, "2026-08-20", "VENMO *JORDAN BLAKE"),
        ],
      });

      expect(asked.picks).toHaveLength(1);
      expect(asked.picks[0]?.filter((row) => row.kind === "money in")).toEqual([
        expect.objectContaining({ date: "2026-10-02", spending_from: "2026-08-03" }),
        expect.objectContaining({ date: "2026-08-20", spending_from: "2026-06-21" }),
      ]);
      expect(await spendingLinks()).toEqual([]);
      expect(await answerRows()).toEqual([
        { kind: "Reimbursement", txn: "early", answer: "no", confidence: "low" },
        { kind: "Reimbursement", txn: "late", answer: "no", confidence: "low" },
      ]);
      expect((await itemAbout("late"))?.bestAnswer.value).toBe("keep");
    });

    it("never links a pick when the AI names Spending in more than one call of a window", async () => {
      // 150 Spending in one money's 60 days take 2 calls, each with the money row first. In each
      // call, the AI picks that call's newest Spending, with high confidence.
      const day = (n: number) =>
        new Date(Date.UTC(2026, 7, 5 + (n % 55))).toISOString().slice(0, 10);
      const picked: string[] = [];
      pick = (rows) => {
        const newest = rows.find((row) => row.kind === "Spending");
        if (newest !== undefined) picked.push(String(newest.amount));
        return { spendingRow: newest?.row ?? null, confidence: "high" };
      };
      await sync({
        added: [
          ...Array.from({ length: 150 }, (_, n) => dinner(`meal-${n}`, -(1_000 + n), day(n))),
          moneyIn("friend", 2_000, "2026-10-02", "VENMO *MORGAN LEE"),
        ],
      });

      expect(asked.picks).toHaveLength(2);
      expect(picked).toHaveLength(2);
      expect(await spendingLinks()).toEqual([]);
      expect(await answerRows()).toEqual([
        { kind: "Reimbursement", txn: "friend", answer: "yes", confidence: "low" },
      ]);
      // The item offers the first call's pick: the newest Spending.
      const cents = Math.round(Number(picked[0]?.replace(/[$,]/g, "")) * 100);
      expect((await itemAbout("friend"))?.bestAnswer.value).toBe(
        `link ${await idOf(`meal-${cents - 1_000}`)}`,
      );
    });

    it("keeps an AI pick of pending Spending when that Spending posts", async () => {
      pick = pickAmount("$60.00", "medium");
      const held = dinner("held", -6_000, "2026-09-28");
      await sync({
        added: [
          { ...held, pending: true },
          moneyIn("friend", 2_000, "2026-10-02", "VENMO *MORGAN LEE"),
        ],
      });
      expect((await itemAbout("friend"))?.bestAnswer.value).toBe(`link ${await idOf("held")}`);

      await sync({ added: [{ ...held, id: "posted", pendingTransactionId: "held" }] });
      const stored = await bank.database.$client.execute(
        "SELECT spending_transaction_id AS picked FROM ai_link_answers",
      );
      expect(stored.rows.map((row) => row.picked)).toEqual([await idOf("posted")]);
      // Decided again, the money's item offers the posted Spending, and nothing is asked again.
      await bank.database.$client.execute({
        sql: "DELETE FROM review_items WHERE kind = ?",
        args: [MONEY_FROM_PERSON_KIND],
      });
      await sync({
        changed: [moneyIn("friend", 2_000, "2026-10-02", "VENMO *MORGAN LEE PAYMENT")],
      });
      expect(asked.picks).toHaveLength(1);
      expect((await itemAbout("friend"))?.bestAnswer.value).toBe(`link ${await idOf("posted")}`);
    });

    it.each([
      ["medium", "a pick", pickAmount("$60.00", "medium")],
      ["low", "a pick", pickAmount("$25.00", "low")],
    ] as const)("leaves Income and an item that shows a %s pick", async (_, __, picker) => {
      pick = picker;
      await setUp();

      expect(await spendingLinks()).toEqual([]);
      expect(await readTransactionDecision(bank.database, await idOf("friend"))).toMatchObject({
        parts: [{ type: "Income" }],
      });
      const item = await itemAbout("friend");
      expect(item?.bestAnswer.value).toMatch(/^link /);
      expect(item?.needsAi).toBe(false);
    });

    it("leaves Income and an item that keeps it as Income when the AI picks none", async () => {
      pick = () => ({ spendingRow: null, confidence: "high" });
      await setUp();

      expect(await spendingLinks()).toEqual([]);
      expect(await itemAbout("friend")).toMatchObject({
        bestAnswer: { value: "keep" },
        needsAi: false,
      });
    });

    it("never asks about the same money twice", async () => {
      pick = pickAmount("$60.00", "medium");
      await setUp();
      expect(asked.picks).toHaveLength(1);

      await sync({
        changed: [moneyIn("friend", 2_000, "2026-10-02", "VENMO *MORGAN LEE PAYMENT")],
        added: [dinner("brunch", -3_000, "2026-10-01")],
      });
      expect(asked.picks).toHaveLength(1);
      expect((await itemAbout("friend"))?.bestAnswer.value).toBe(`link ${await idOf("dinner")}`);
      expect(await answerRows()).toEqual([
        { kind: "Reimbursement", txn: "friend", answer: "yes", confidence: "medium" },
      ]);
    });

    it("keeps the item marked for an AI redo when the call fails for good", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW());
      stub.answers.quick = "fail";
      expect(await setUp()).toMatchObject({ stoppedAt: "matching" });
      let at = NOW().getTime();
      for (const wait of [1, 5, 30]) {
        at += wait * MINUTE;
        vi.setSystemTime(at);
        await runFollowUp(() => new Date(at));
      }

      expect(await spendingLinks()).toEqual([]);
      expect(await itemAbout("friend")).toMatchObject({
        bestAnswer: { value: "keep" },
        needsAi: true,
      });
    });

    it("never ends a Member's link, even with a high pick of other Spending", async () => {
      pick = pickAmount("$60.00", "medium");
      await setUp();
      const made = await linkByHand(
        bank.database,
        {
          kind: "Reimbursement",
          transactionId: await idOf("friend"),
          spendingTransactionId: await idOf("lunch"),
        },
        MEMBER,
        NOW(),
      );
      expect(made.outcome).toBe("linked");
      await runFollowUp(NOW);

      // With the stored answer gone and a high pick waiting, the money is decided again: the hand
      // link holds, and nothing is asked.
      await bank.database.$client.execute("DELETE FROM ai_link_answers");
      pick = pickAmount("$60.00", "high");
      await sync({
        changed: [moneyIn("friend", 2_000, "2026-10-02", "VENMO *MORGAN LEE PAYMENT")],
      });
      expect(asked.picks).toHaveLength(1);
      expect(await spendingLinks()).toEqual([
        {
          money: "friend",
          spending: "lunch",
          madeBy: "Member",
          aiAnswer: null,
          aiConfidence: null,
        },
      ]);
    });

    it("never links, or offers, a pick a Member undid", async () => {
      pick = pickAmount("$60.00", "high");
      await setUp();
      const [link] = (
        await bank.database.$client.execute("SELECT id FROM spending_links")
      ).rows.map((row) => String(row.id));
      expect(await undoLink(bank.database, link ?? "", MEMBER, NOW())).toBe(true);
      await runFollowUp(NOW);
      expect(await spendingLinks()).toEqual([]);
      expect((await itemAbout("friend"))?.bestAnswer.value).toBe("keep");

      // Asked again, with the stored answer and the item gone, the AI picks the same Spending
      // with high confidence: it stays refused.
      await bank.database.$client.execute("DELETE FROM ai_link_answers");
      await bank.database.$client.execute("DELETE FROM review_items");
      await sync({
        changed: [moneyIn("friend", 2_000, "2026-10-02", "VENMO *MORGAN LEE PAYMENT")],
      });
      expect(asked.picks).toHaveLength(2);
      expect(await spendingLinks()).toEqual([]);
      expect((await itemAbout("friend"))?.bestAnswer.value).toBe("keep");
    });

    // A Member links while the AI answers. Its high pick then links nothing, and ends no link.
    it.each([
      ["links the money to other Spending", "Reimbursement"],
      ["pairs the money as a Transfer", "Transfer"],
      ["links the money to a Manual loan", "loan"],
      ["pairs the Spending as a Transfer", "Transfer"],
    ] as const)("never ends a link a Member makes while the AI answers: %s", async (what, kind) => {
      pick = pickAmount("$60.00", "high");
      const sides = {
        "links the money to other Spending": async () => ({
          kind: "Reimbursement" as const,
          transactionId: await idOf("friend"),
          spendingTransactionId: await idOf("lunch"),
        }),
        "pairs the money as a Transfer": async () => ({
          kind: "Transfer" as const,
          outTransactionId: await idOf("far-out"),
          inTransactionId: await idOf("friend"),
        }),
        "links the money to a Manual loan": async () => ({
          kind: "loan" as const,
          transactionId: await idOf("friend"),
          loanAccountId: loanId,
        }),
        "pairs the Spending as a Transfer": async () => ({
          kind: "Transfer" as const,
          outTransactionId: await idOf("dinner"),
          inTransactionId: await idOf("far-in"),
        }),
      };
      const loanId = (
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
        )
      ).id;
      // Far from each other side in time, so the app pairs neither.
      await sync({
        added: [
          txn("far-out", SAVINGS, -2_000, "2026-08-10"),
          txn("far-in", SAVINGS, 6_000, "2026-11-12"),
        ],
      });
      let made: string | undefined;
      duringCall = async () => {
        duringCall = async () => {};
        const result = await linkByHand(bank.database, await sides[what](), MEMBER, NOW());
        made = result.outcome;
      };
      await setUp();

      expect(made).toBe("linked");
      expect(asked.picks).toHaveLength(1);
      expect(await spendingLinks()).toEqual(
        kind === "Reimbursement"
          ? [
              {
                money: "friend",
                spending: "lunch",
                madeBy: "Member",
                aiAnswer: null,
                aiConfidence: null,
              },
            ]
          : [],
      );
    });

    it("deletes its answers with a removed Connection's Transactions", async () => {
      pick = pickAmount("$60.00", "medium");
      await setUp();
      expect(await answerRows()).toHaveLength(1);
      const birch = connections.get("birch") ?? "";
      const maple = connections.get("maple") ?? "";

      // The picked Spending goes first: the answer stays, with no pick.
      expect(await markConnectionRemoved(bank.database, birch, NOW())).toBe(true);
      expect(await deleteRemovedConnection(bank.database, birch, NOW())).toBeDefined();
      const left = await bank.database.$client.execute(
        "SELECT spending_transaction_id AS picked FROM ai_link_answers",
      );
      expect(left.rows).toEqual([expect.objectContaining({ picked: null })]);
      // Then the money.
      expect(await markConnectionRemoved(bank.database, maple, NOW())).toBe(true);
      expect(await deleteRemovedConnection(bank.database, maple, NOW())).toBeDefined();
      expect(await answerRows()).toEqual([]);
    });
  });

  it("sends no card number, Member name, or escape the model reads differently", async () => {
    pairAnswer = () => ({ answer: "no", confidence: "low" });
    await sync({
      added: [
        txn("maple-out", CHECKING, -4_444, "2026-10-05", {
          description: "TFR TO CARD 4111 1111\n1111 1111 AVERY\tPARK",
        }),
        txn("birch-in", CARD, 4_444, "2026-10-06", { description: "PAYMENT THANK YOU AveryPark" }),
      ],
    });

    expect(asked.pairs).toHaveLength(1);
    const texts = sent.flat().join("\n");
    expect(texts.replace(/\D/g, "")).not.toContain("4111111111111111");
    expect(texts.toLowerCase().replace(/[^a-z]/g, "")).not.toContain("averypark");
    for (const text of sent.flat()) expect(text).not.toMatch(/\\[a-zA-Z]/);
    expect(await readTransactionDetail(bank.database, await idOf("maple-out"))).toBeDefined();
  });
});
