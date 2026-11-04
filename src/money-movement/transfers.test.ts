import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedDemoHousehold } from "../bank/demo.ts";
import { type FakePage, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { answerReviewItem, openReviewItems } from "../review/index.ts";
import { addDays } from "./business-days.ts";
import {
  addBusinessDays,
  federalReserveHolidays,
  PAIR_GUESS_KIND,
  readTransactionDetail,
  registerDecidedAgain,
  registerUnclearPairJudge,
  setTransactionType,
  startMoneyMovement,
  UNCLEAR_PAIR_KIND,
  type UnclearPairAnswer,
} from "./index.ts";

// Transfer pairing between two of the Household's Accounts (spec 03, Transfers), through the
// Matching follow-up step on Transactions the fake adapter syncs.

const NOW = () => new Date("2026-12-10T14:00:00.000Z");

describe("the Federal Reserve calendar", () => {
  it("closes weekends and the Federal Reserve's holidays, moving a Sunday holiday to Monday", () => {
    expect([...federalReserveHolidays(2026)].sort()).toEqual([
      "2026-01-01",
      "2026-01-19",
      "2026-02-16",
      "2026-05-25",
      "2026-06-19",
      // Independence Day falls on a Saturday, and no weekday closes for it.
      "2026-07-04",
      "2026-09-07",
      "2026-10-12",
      "2026-11-11",
      "2026-11-26",
      "2026-12-25",
    ]);
    // Independence Day 2027 falls on a Sunday, so Monday the 5th closes.
    expect(addBusinessDays("2027-07-02", 1)).toBe("2027-07-06");
    expect(addBusinessDays("2026-11-25", 1)).toBe("2026-11-27");
    expect(addBusinessDays("2026-10-17", 1)).toBe("2026-10-19");
  });
});

describe("Transfer pairing", () => {
  let bank: TestBank;
  let stops: (() => void)[];
  const connections = new Map<string, string>();

  // Four fake banks: checking and savings at Maple, a card at Birch, a card at Cedar, and checking
  // at Elm.
  const CHECKING = fakeAccount({ id: "maple-checking", mask: "1111" });
  const SAVINGS = fakeAccount({ id: "maple-savings", subtype: "savings", mask: "2222" });
  const CARD = fakeAccount({
    id: "birch-card",
    type: "credit",
    subtype: "credit card",
    mask: "3333",
  });
  const OTHER_CARD = fakeAccount({
    id: "cedar-card",
    type: "credit",
    subtype: "credit card",
    mask: "4444",
  });
  const ELM = fakeAccount({ id: "elm-checking", mask: "5555" });
  const BANKS = [
    { bankId: "maple", name: "Maple Bank", accounts: [CHECKING, SAVINGS] },
    { bankId: "birch", name: "Birch Card Services", accounts: [CARD] },
    { bankId: "cedar", name: "Cedar Card Co", accounts: [OTHER_CARD] },
    { bankId: "elm", name: "Elm Savings Bank", accounts: [ELM] },
  ];
  const bankOf = (accountId: string) =>
    BANKS.find((b) => b.accounts.some((account) => account.id === accountId))?.bankId ?? "";

  // A Transaction record with a plain description and no category, so it brings no strong signal
  // unless the test gives one.
  const txn = (
    id: string,
    account: { id: string },
    amount: number,
    postedDate: string,
    fields: Partial<TxnRecord> & { code?: string } = {},
  ): TxnRecord => {
    const { code, ...rest } = fields;
    return fakeTxn({
      id,
      accountId: account.id,
      amount,
      postedDate,
      description: amount < 0 ? "ONLINE DEBIT" : "ONLINE CREDIT",
      category:
        code === undefined ? null : { name: code, confidence: "HIGH", version: "v2", mcc: null },
      ...rest,
    });
  };

  // Syncs each record into its own bank, then runs the follow-up job.
  const sync = async (page: { added?: TxnRecord[]; changed?: TxnRecord[]; removed?: string[] }) => {
    for (const { bankId } of BANKS) {
      const mine = (record: TxnRecord) => bankOf(record.accountId) === bankId;
      const fakePage: FakePage = {
        added: (page.added ?? []).filter(mine),
        changed: (page.changed ?? []).filter(mine),
        // Each provider ID starts with its bank's ID.
        removed: (page.removed ?? []).filter((id) => id.startsWith(bankId)).map((id) => ({ id })),
      };
      bank.fake.addPages(bankId, fakePage);
      await syncConnection(connections.get(bankId) ?? "", NOW);
    }
    await runFollowUp(NOW);
  };

  const idOf = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT id FROM transactions WHERE provider_transaction_id = ?",
      args: [providerId],
    });
    return String(rows.rows[0]?.id);
  };
  // Each stored link as "out → in", by provider IDs, with its evidence.
  const links = async () => {
    const rows = await bank.database.$client.execute(
      `SELECT o.provider_transaction_id AS out_id, i.provider_transaction_id AS in_id, l.tier,
         l.signals, l.made_by, l.uncertain
       FROM transfer_links l
       JOIN transactions o ON o.id = l.out_transaction_id
       JOIN transactions i ON i.id = l.in_transaction_id
       ORDER BY o.posted_date, o.provider_transaction_id`,
    );
    return rows.rows.map((row) => ({
      pair: `${row.out_id} → ${row.in_id}`,
      tier: row.tier,
      signals: JSON.parse(String(row.signals)),
      madeBy: row.made_by,
      uncertain: row.uncertain === 1,
    }));
  };
  const pairs = async () => (await links()).map((link) => link.pair);
  const typeOf = async (providerId: string) => {
    const detail = await readTransactionDetail(bank.database, await idOf(providerId));
    return detail?.decision?.parts.map((part) => part.type).join(" + ");
  };
  const pairItems = async () =>
    (await openReviewItems(bank.database)).filter(
      (item) => item.kind === UNCLEAR_PAIR_KIND || item.kind === PAIR_GUESS_KIND,
    );
  const addMember = () =>
    bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('member-1', 'Jamie', 'jamie@example.com', '2026-10-01T00:00:00.000Z',
         '2026-10-01T00:00:00.000Z')`,
    );

  beforeEach(async () => {
    bank = await newTestBank();
    stops = [startMoneyMovement({ database: bank.database }).stop];
    connections.clear();
    for (const { bankId, name, accounts } of BANKS) {
      connections.set(bankId, await bank.connect(bankId, name));
      bank.fake.addPages(bankId, { accounts });
      await syncConnection(connections.get(bankId) ?? "", NOW);
    }
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  describe("on the demo Household", () => {
    beforeEach(async () => {
      await seedDemoHousehold(bank.database, bank.fake, NOW);
      await runFollowUp(NOW);
    });

    const linkedFrom = async (description: string) => {
      const rows = await bank.database.$client.execute({
        sql: `SELECT o.posted_date AS paid, i.posted_date AS received, a.name AS card, l.tier,
                l.made_by AS madeBy, l.signals
              FROM transactions o
              LEFT JOIN transfer_links l ON l.out_transaction_id = o.id
              LEFT JOIN transactions i ON i.id = l.in_transaction_id
              LEFT JOIN household_accounts a ON a.id = i.account_id
              WHERE o.description = ? AND o.hidden_reason IS NULL`,
        args: [description],
      });
      return rows.rows.map((row) => ({ ...row }));
    };

    it("pairs each card payment from Ally checking with its card, inside 4 business days", async () => {
      for (const [description, card] of [
        ["CAPITAL ONE MOBILE PMT", "Rewards Card"],
        ["PAYMENT TO CHASE CARD ENDING IN 7731", "Chase Card"],
        ["SYNCHRONY BANK PAYMENT ACCT ENDING 5520", "Home Store Card"],
      ]) {
        const payments = await linkedFrom(description ?? "");
        expect(payments.length).toBeGreaterThan(10);
        for (const payment of payments) {
          expect(payment).toMatchObject({ card, tier: "Strong", madeBy: "app" });
          expect(String(payment.received) > String(payment.paid)).toBe(true);
          expect(addBusinessDays(String(payment.paid), 4) >= String(payment.received)).toBe(true);
        }
      }
      // Capital One's lines name only the bank; the others name the card's last 4 digits too.
      const [capitalOne] = await linkedFrom("CAPITAL ONE MOBILE PMT");
      expect(JSON.parse(String(capitalOne?.signals))).toEqual([
        "institution name",
        "Plaid category",
      ]);
      const chase = await linkedFrom("PAYMENT TO CHASE CARD ENDING IN 7731");
      expect(JSON.parse(String(chase.at(-1)?.signals))).toEqual([
        "last 4 digits",
        "institution name",
        "Plaid category",
        "earlier Transfer",
      ]);
    });

    it("pairs checking to savings at one bank, and decides both sides as a Transfer", async () => {
      const description = "Internet transfer to Online Savings account XXXXXX8802";
      const transfers = await linkedFrom(description);
      expect(transfers.length).toBeGreaterThan(10);
      for (const transfer of transfers) {
        expect(transfer).toMatchObject({ card: "Online Savings", tier: "Strong" });
        expect(transfer.received).toBe(transfer.paid);
      }
      const rows = await bank.database.$client.execute({
        sql: `SELECT d.step, p.type FROM transfer_links l
              JOIN transactions o ON o.id = l.out_transaction_id
              JOIN transaction_decisions d ON d.transaction_id IN (l.out_transaction_id, l.in_transaction_id)
              JOIN transaction_parts p ON p.transaction_id = d.transaction_id
              WHERE o.description = ?`,
        args: [description],
      });
      expect(new Set(rows.rows.map((row) => `${row.step} ${row.type}`))).toEqual(
        new Set(["3 Transfer"]),
      );
      // No pair is unclear or a guess.
      expect(await pairItems()).toEqual([]);
    });
  });

  describe("windows", () => {
    it("pairs within one bank inside 1 business day, over a weekend and Columbus Day", async () => {
      await sync({
        added: [
          // Friday to Tuesday: Monday the 12th is Columbus Day.
          txn("maple-out-1", CHECKING, -10_000, "2026-10-09", { description: "TO SAVINGS 2222" }),
          txn("maple-in-1", SAVINGS, 10_000, "2026-10-13"),
          // Friday to Tuesday, with no holiday: 2 business days.
          txn("maple-out-2", CHECKING, -20_000, "2026-10-16", { description: "TO SAVINGS 2222" }),
          txn("maple-in-2", SAVINGS, 20_000, "2026-10-20"),
        ],
      });

      expect(await pairs()).toEqual(["maple-out-1 → maple-in-1"]);
    });

    it("counts Thanksgiving as closed", async () => {
      await sync({
        added: [
          // Wednesday to Friday over Thanksgiving: 1 business day.
          txn("maple-out-1", CHECKING, -10_000, "2026-11-25", {
            code: "TRANSFER_OUT_ACCOUNT_TRANSFER",
          }),
          txn("maple-in-1", SAVINGS, 10_000, "2026-11-27"),
          // The next Wednesday to Friday: 2 business days.
          txn("maple-out-2", CHECKING, -10_000, "2026-12-02", {
            code: "TRANSFER_OUT_ACCOUNT_TRANSFER",
          }),
          txn("maple-in-2", SAVINGS, 10_000, "2026-12-04"),
        ],
      });

      expect(await pairs()).toEqual(["maple-out-1 → maple-in-1"]);
      // With no pair, its transfer category makes it a one-sided Transfer.
      expect(await typeOf("maple-out-2")).toBe("Transfer");
      expect(await typeOf("maple-in-2")).toBe("Income");
    });

    it("gives a card payment from another bank 4 business days, either side first", async () => {
      const pay = { code: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" };
      await sync({
        added: [
          txn("maple-pay-1", CHECKING, -30_000, "2026-10-19", pay),
          txn("birch-got-1", CARD, 30_000, "2026-10-23"),
          txn("maple-pay-2", CHECKING, -40_000, "2026-10-26", pay),
          txn("birch-got-2", CARD, 40_000, "2026-11-02"),
          // The card posts first.
          txn("birch-got-3", CARD, 50_000, "2026-11-09"),
          txn("maple-pay-3", CHECKING, -50_000, "2026-11-13", pay),
        ],
      });

      expect(await pairs()).toEqual(["maple-pay-1 → birch-got-1", "maple-pay-3 → birch-got-3"]);
    });

    it("gives a transfer between two banks 5 business days", async () => {
      const move = { code: "TRANSFER_OUT_ACCOUNT_TRANSFER" };
      await sync({
        added: [
          txn("maple-move-1", CHECKING, -30_000, "2026-10-19", move),
          txn("elm-move-1", ELM, 30_000, "2026-10-26"),
          txn("maple-move-2", CHECKING, -40_000, "2026-10-19", move),
          txn("elm-move-2", ELM, 40_000, "2026-10-27"),
        ],
      });

      expect(await pairs()).toEqual(["maple-move-1 → elm-move-1"]);
    });
  });

  describe("global pairing", () => {
    it("picks the set with the most Strong pairs, where first come, first served would not", async () => {
      // The first payment and the first card's credit carry Plaid categories, so every pair but
      // the second payment with the second card is Strong. First come, first served would pair the
      // first payment with the nearest credit and leave one Unclear pair.
      await sync({
        added: [
          txn("maple-pay-1", CHECKING, -30_000, "2026-10-05", {
            code: "TRANSFER_OUT_ACCOUNT_TRANSFER",
          }),
          txn("maple-pay-2", CHECKING, -30_000, "2026-10-06"),
          txn("birch-got", CARD, 30_000, "2026-10-06", {
            code: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
          }),
          txn("cedar-got", OTHER_CARD, 30_000, "2026-10-07"),
        ],
      });

      expect(await pairs()).toEqual(["maple-pay-1 → cedar-got", "maple-pay-2 → birch-got"]);
      expect(await pairItems()).toEqual([]);
    });

    it("then prefers more strong signals, then the smaller date gap", async () => {
      const move = { code: "TRANSFER_OUT_ACCOUNT_TRANSFER" };
      await sync({
        added: [
          txn("maple-out-1", CHECKING, -15_000, "2026-10-05", { ...move, description: "TO 5555" }),
          // Two signals beat one, even with the larger gap.
          txn("birch-in-1", CARD, 15_000, "2026-10-05"),
          txn("elm-in-1", ELM, 15_000, "2026-10-07"),
          txn("maple-out-2", CHECKING, -16_000, "2026-10-05", move),
          // The same signals: the nearer one wins.
          txn("elm-in-2", ELM, 16_000, "2026-10-08"),
          txn("birch-in-2", CARD, 16_000, "2026-10-06"),
        ],
      });

      expect(await links()).toMatchObject([
        { pair: "maple-out-1 → elm-in-1", signals: ["last 4 digits", "Plaid category"] },
        { pair: "maple-out-2 → birch-in-2", signals: ["Plaid category"], uncertain: false },
      ]);
    });

    it("picks one of two equal sets, marks it uncertain, and puts it on the Review list", async () => {
      await sync({
        added: [
          txn("maple-out", CHECKING, -25_000, "2026-10-05", {
            code: "TRANSFER_OUT_ACCOUNT_TRANSFER",
          }),
          txn("maple-in", SAVINGS, 25_000, "2026-10-05"),
          txn("elm-in", ELM, 25_000, "2026-10-05"),
        ],
      });

      const [link] = await links();
      expect(link).toMatchObject({ tier: "Strong", madeBy: "app", uncertain: true });
      const [item] = await pairItems();
      expect(item).toMatchObject({
        kind: PAIR_GUESS_KIND,
        subject: {
          type: "transactions",
          transactionIds: [await idOf("maple-out"), expect.any(String)],
        },
        bestAnswer: { value: "link" },
      });
      expect(await typeOf("maple-out")).toBe("Transfer");

      // "Not this" acts as an undo: the app pairs the other side instead, and never this pair again.
      await addMember();
      const first = link?.pair ?? "";
      expect(await answerReviewItem(bank.database, item?.id ?? "", "not this", "member-1")).toBe(
        "answered",
      );
      // The answer asks for a follow-up job, which pairs both sides again.
      expect(bank.followUpsAsked()).toBe(1);
      await runFollowUp(NOW);
      const [after] = await links();
      expect(after).toMatchObject({ madeBy: "app", uncertain: false });
      expect(after?.pair).not.toBe(first);
      expect(await pairItems()).toEqual([]);
      const lonely = first.endsWith("maple-in") ? "maple-in" : "elm-in";
      expect(await typeOf(lonely)).toBe("Income");
    });

    it("makes an accepted guess a hand-made link", async () => {
      await sync({
        added: [
          txn("maple-out", CHECKING, -25_000, "2026-10-05", {
            code: "TRANSFER_OUT_ACCOUNT_TRANSFER",
          }),
          txn("maple-in", SAVINGS, 25_000, "2026-10-05"),
          txn("elm-in", ELM, 25_000, "2026-10-05"),
        ],
      });
      const [item] = await pairItems();
      await addMember();

      expect(await answerReviewItem(bank.database, item?.id ?? "", "link", "member-1")).toBe(
        "answered",
      );
      await runFollowUp(NOW);

      expect(await links()).toMatchObject([{ tier: "Strong", madeBy: "Member", uncertain: false }]);
      const detail = await readTransactionDetail(bank.database, await idOf("maple-out"));
      expect(detail?.decision?.step).toBe("2");
    });
  });

  describe("Unclear pairs", () => {
    const unclear = () =>
      sync({
        added: [
          txn("maple-out", CHECKING, -12_345, "2026-10-05"),
          txn("birch-in", CARD, 12_345, "2026-10-06"),
        ],
      });

    it("does not link equal amounts with no strong signal, and offers the pair", async () => {
      await unclear();

      expect(await links()).toEqual([]);
      expect(await typeOf("maple-out")).toBe("Spending");
      expect(await typeOf("birch-in")).toBe("Income");
      expect(await pairItems()).toMatchObject([
        {
          kind: UNCLEAR_PAIR_KIND,
          subject: { transactionIds: [await idOf("maple-out"), await idOf("birch-in")] },
        },
      ]);

      // A later run keeps one item.
      await sync({
        changed: [txn("maple-out", CHECKING, -12_345, "2026-10-05", { description: "DEBIT" })],
      });
      expect(await pairItems()).toHaveLength(1);
    });

    it("makes a hand-made link when a Member accepts it, with its evidence", async () => {
      await unclear();
      const [item] = await pairItems();
      await addMember();

      await answerReviewItem(bank.database, item?.id ?? "", "link", "member-1");
      await runFollowUp(NOW);

      const detail = await readTransactionDetail(bank.database, await idOf("birch-in"));
      expect(detail).toMatchObject({
        decision: { step: "2", parts: [{ type: "Transfer", amount: 12_345 }] },
        transferLink: {
          otherTransactionId: await idOf("maple-out"),
          tier: "Unclear",
          signals: [],
          aiAnswer: null,
          aiConfidence: null,
          madeBy: "Member",
          uncertain: false,
        },
      });
      // Re-matching never breaks a hand-made link.
      await sync({
        changed: [txn("birch-in", CARD, 12_345, "2026-10-06", { description: "THANKS" })],
      });
      expect(await links()).toMatchObject([{ madeBy: "Member" }]);
    });

    it("never offers the pair again after Not this", async () => {
      await unclear();
      const [item] = await pairItems();
      await addMember();

      await answerReviewItem(bank.database, item?.id ?? "", "not this", "member-1");
      await sync({
        changed: [txn("maple-out", CHECKING, -12_345, "2026-10-05", { description: "DEBIT" })],
      });

      expect(await links()).toEqual([]);
      expect(await pairItems()).toEqual([]);
    });

    it("leaves a hook for the AI's judgment", async () => {
      const answers = new Map<string, UnclearPairAnswer>([
        ["maple-yes", { answer: "yes", confidence: "high" }],
        ["maple-no", { answer: "no", confidence: "high" }],
        ["maple-maybe", { answer: "yes", confidence: "medium" }],
      ]);
      const asked: string[] = [];
      stops.push(
        registerUnclearPairJudge(async ({ out }) => {
          const providerId = (
            await bank.database.$client.execute({
              sql: "SELECT provider_transaction_id AS p FROM transactions WHERE id = ?",
              args: [out.id],
            })
          ).rows[0]?.p;
          asked.push(String(providerId));
          return answers.get(String(providerId));
        }),
      );

      await sync({
        added: [
          txn("maple-yes", CHECKING, -1_001, "2026-10-05"),
          txn("birch-yes", CARD, 1_001, "2026-10-05"),
          txn("maple-no", CHECKING, -1_002, "2026-10-05"),
          txn("birch-no", CARD, 1_002, "2026-10-05"),
          txn("maple-maybe", CHECKING, -1_003, "2026-10-05"),
          txn("birch-maybe", CARD, 1_003, "2026-10-05"),
        ],
      });

      expect(asked.sort()).toEqual(["maple-maybe", "maple-no", "maple-yes"]);
      expect(await links()).toMatchObject([
        { pair: "maple-yes → birch-yes", tier: "Unclear", madeBy: "AI" },
      ]);
      const detail = await readTransactionDetail(bank.database, await idOf("maple-yes"));
      expect(detail?.transferLink).toMatchObject({ aiAnswer: "yes", aiConfidence: "high" });
      expect((await pairItems()).map((item) => item.subject)).toEqual([
        {
          type: "transactions",
          transactionIds: [await idOf("maple-maybe"), await idOf("birch-maybe")],
        },
      ]);
    });
  });

  describe("what never pairs", () => {
    it("keeps card rewards out of pairing", async () => {
      const move = { code: "TRANSFER_OUT_ACCOUNT_TRANSFER" };
      await sync({
        added: [
          txn("maple-out-1", CHECKING, -2_500, "2026-10-05", move),
          txn("birch-reward", CARD, 2_500, "2026-10-05", {
            description: "CREDIT-CASH BACK REWARD",
          }),
          txn("maple-out-2", CHECKING, -3_500, "2026-10-05", move),
          txn("birch-redeem", CARD, 3_500, "2026-10-05", { description: "Redemption Credit" }),
          // Money into a bank Account with the word is not card rewards.
          txn("elm-out", ELM, -4_500, "2026-10-05", move),
          txn("maple-reward", CHECKING, 4_500, "2026-10-05", { description: "REWARD TRANSFER" }),
        ],
      });

      expect(await pairs()).toEqual(["elm-out → maple-reward"]);
    });

    it("never pairs two Transactions on one Account, or amounts a cent apart", async () => {
      const move = { code: "TRANSFER_OUT_ACCOUNT_TRANSFER" };
      await sync({
        added: [
          txn("maple-out-1", CHECKING, -7_000, "2026-10-05", move),
          txn("maple-back-1", CHECKING, 7_000, "2026-10-05", move),
          txn("maple-out-2", CHECKING, -8_000, "2026-10-05", move),
          txn("maple-in-2", SAVINGS, 8_001, "2026-10-05", move),
        ],
      });

      expect(await pairs()).toEqual([]);
    });

    it("ends the app's link when a Member sets a type by hand, or the provider removes a side", async () => {
      const move = { code: "TRANSFER_OUT_ACCOUNT_TRANSFER" };
      await sync({
        added: [
          txn("maple-out-1", CHECKING, -9_000, "2026-10-05", move),
          txn("maple-in-1", SAVINGS, 9_000, "2026-10-05"),
          txn("maple-out-2", CHECKING, -9_500, "2026-10-05", move),
          txn("maple-in-2", SAVINGS, 9_500, "2026-10-05"),
        ],
      });
      expect(await pairs()).toHaveLength(2);

      await setTransactionType(bank.database, await idOf("maple-out-1"), "Spending", NOW());
      await runFollowUp(NOW);
      expect(await pairs()).toEqual(["maple-out-2 → maple-in-2"]);
      expect(await typeOf("maple-in-1")).toBe("Income");

      await sync({ removed: ["maple-in-2"] });
      expect(await pairs()).toEqual([]);
      // One-sided now.
      expect(await typeOf("maple-out-2")).toBe("Transfer");
    });

    it("tells Categorization about each other side decided again, oldest first", async () => {
      const move = { code: "TRANSFER_OUT_ACCOUNT_TRANSFER" };
      await sync({
        added: [
          txn("maple-out-late", CHECKING, -1_100, "2026-10-20", move),
          txn("maple-in-late", SAVINGS, 1_100, "2026-10-20"),
          txn("maple-out-early", CHECKING, -1_200, "2026-10-05", move),
          txn("maple-in-early", SAVINGS, 1_200, "2026-10-05"),
          txn("maple-out-middle", CHECKING, -1_300, "2026-10-12", move),
          txn("maple-in-middle", SAVINGS, 1_300, "2026-10-12"),
        ],
      });
      const told: string[] = [];
      stops.push(registerDecidedAgain(async (ids) => void told.push(...ids)));

      await sync({ removed: ["maple-in-late", "maple-in-middle", "maple-in-early"] });

      expect(told).toEqual([
        await idOf("maple-out-early"),
        await idOf("maple-out-middle"),
        await idOf("maple-out-late"),
      ]);
    });
  });

  describe("speed", () => {
    // Every day for 5 years, the same amount moves from Maple checking to Elm checking, and lands the
    // next day. Each week's window overlaps the next, so all of it is one chain of candidates.
    const DAYS = 5 * 365;
    const move = { code: "TRANSFER_OUT_ACCOUNT_TRANSFER" };
    const day = (n: number) => addDays("2021-12-01", n);
    const daily = (n: number) => [
      txn(`maple-day-${n}`, CHECKING, -2_000, day(n), move),
      txn(`elm-day-${n}`, ELM, 2_000, day(n + 1)),
    ];
    const linkCount = async () =>
      Number(
        (await bank.database.$client.execute("SELECT count(*) AS n FROM transfer_links")).rows[0]
          ?.n,
      );

    it("pairs one more sync in well under a second, after 5 years of daily Transfers", async () => {
      const history = Array.from({ length: DAYS }, (_, n) => daily(n)).flat();
      const loadStarted = performance.now();
      await sync({ added: history });
      const load = performance.now() - loadStarted;
      expect(await linkCount()).toBe(DAYS);

      const started = performance.now();
      await sync({ added: daily(DAYS) });
      const took = performance.now() - started;

      expect(await linkCount()).toBe(DAYS + 1);
      expect(took).toBeLessThan(1_000);
      process.stderr.write(
        `Transfer pairing: first load of ${DAYS * 2} Transactions ${Math.round(load)} ms, ` +
          `one more sync ${Math.round(took)} ms\n`,
      );
    }, 120_000);
  });
});
