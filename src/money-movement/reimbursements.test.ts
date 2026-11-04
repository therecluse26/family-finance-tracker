import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { startCategorization } from "../categorization/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import {
  answerReviewItem,
  openReviewItemsOfKind,
  otherReviewChoices,
  type ReviewItem,
} from "../review/index.ts";
import {
  linkByHand,
  MONEY_FROM_PERSON_KIND,
  readTransactionDecision,
  registerReimbursementPicker,
  setTransactionType,
  startMoneyMovement,
  totalsByMonth,
  undoLink,
} from "./index.ts";

// Money from a person and Reimbursements without AI (spec 03, Reimbursements, Link shapes, Review
// list items), through the Matching and Categorization follow-up steps on Transactions the fake
// adapter syncs, and the Review list.

const NOW = () => new Date("2026-11-20T14:00:00.000Z");
const BANK = "fake-first-bank";
const CARD = "acc-card";
const CHECKING = "acc-checking";
const MEMBER = "member-1";
const code = (name: string) => ({ name, confidence: "HIGH", version: "v2", mcc: null });
const RESTAURANT = "FOOD_AND_DRINK_RESTAURANT";

describe("Money from a person", () => {
  let bank: TestBank;
  let stops: (() => void)[];
  let connectionId: string;

  const sync = async (page: { added?: TxnRecord[]; removed?: { id: string }[] }) => {
    bank.fake.addPages(BANK, {
      accounts: [
        fakeAccount({ id: CARD, type: "credit", subtype: "credit card", mask: "1111" }),
        fakeAccount({ id: CHECKING, mask: "3333" }),
      ],
      added: page.added ?? [],
      changed: [],
      removed: page.removed ?? [],
      historyLoaded: true,
    });
    await syncConnection(connectionId, NOW);
    await runFollowUp(NOW);
  };
  const idOf = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT id FROM transactions WHERE provider_transaction_id = ?",
      args: [providerId],
    });
    return String(rows.rows[0]?.id);
  };
  // A purchase on the card at a restaurant.
  const dinner = (
    id: string,
    amount: number,
    postedDate: string,
    fields: Partial<TxnRecord> = {},
  ) =>
    fakeTxn({
      id,
      accountId: CARD,
      amount,
      postedDate,
      description: "CORNER BISTRO",
      merchantName: "Corner Bistro",
      category: code(RESTAURANT),
      ...fields,
    });
  // Money into checking with a bank line and no Merchant.
  const moneyIn = (id: string, amount: number, postedDate: string, description: string) =>
    fakeTxn({
      id,
      accountId: CHECKING,
      amount,
      postedDate,
      description,
      merchantName: null,
      category: null,
    });
  const month = async (name: string) =>
    (await totalsByMonth(bank.database)).find((totals) => totals.month === name);
  const decisionOf = async (providerId: string) =>
    readTransactionDecision(bank.database, await idOf(providerId));
  const items = () => openReviewItemsOfKind(bank.database, MONEY_FROM_PERSON_KIND);
  const itemAbout = async (providerId: string): Promise<ReviewItem> => {
    const id = await idOf(providerId);
    const found = (await items()).find((item) =>
      item.subject.type === "transactions" ? item.subject.transactionIds[0] === id : false,
    );
    if (found === undefined) throw new Error(`No open item about ${providerId}`);
    return found;
  };
  // A Member answers the item about the money: links it to the Spending, or keeps it as Income.
  const answer = async (money: string, value: string) => {
    const answered = await answerReviewItem(
      bank.database,
      (await itemAbout(money)).id,
      value,
      MEMBER,
    );
    await runFollowUp(NOW);
    return answered;
  };
  const linkTo = async (money: string, spending: string) =>
    answer(money, `link ${await idOf(spending)}`);
  const spendingLinks = async () =>
    (
      await bank.database.$client.execute(
        `SELECT m.provider_transaction_id AS money, s.provider_transaction_id AS spending, l.kind,
           l.made_by AS madeBy
         FROM spending_links l
         JOIN transactions m ON m.id = l.transaction_id
         JOIN transactions s ON s.id = l.spending_transaction_id
         ORDER BY money`,
      )
    ).rows.map((row) => ({ ...row }));

  beforeEach(async () => {
    bank = await newTestBank();
    stops = [
      startMoneyMovement({ database: bank.database }).stop,
      startCategorization({ database: bank.database }).stop,
    ];
    connectionId = await bank.connect(BANK);
    await bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('${MEMBER}', 'Avery Park', 'avery@example.com', '2026-10-01T00:00:00.000Z',
         '2026-10-01T00:00:00.000Z')`,
    );
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  it("books a payment-app line that names no Member, or a deposit, as Income on the Review list, marked for an AI redo", async () => {
    await sync({
      added: [
        moneyIn("cashout", 2_000, "2026-10-03", "VENMO CASHOUT"),
        moneyIn("venmo-person", 2_100, "2026-10-03", "VENMO *MORGAN LEE"),
        moneyIn("zelle-person", 2_200, "2026-10-04", "ZELLE PAYMENT FROM JOHN SMITH"),
        moneyIn("cash-app", 2_300, "2026-10-04", "CASH APP*JOHN SMITH"),
        {
          ...moneyIn("deposit", 2_400, "2026-10-05", "COUNTER DEPOSIT"),
          category: code("TRANSFER_IN_DEPOSIT"),
        },
        // Zelle from a Member's own name is a one-sided Transfer, not money from a person.
        moneyIn("own-zelle", 2_500, "2026-10-05", "ZELLE PAYMENT FROM AVERY PARK"),
        // A paycheck is plain Income, with no item.
        moneyIn("paycheck", 300_000, "2026-10-01", "ACME PAYROLL"),
      ],
    });

    for (const money of ["cashout", "venmo-person", "zelle-person", "cash-app", "deposit"]) {
      expect(await decisionOf(money)).toMatchObject({
        step: "6.5",
        parts: [{ type: "Income", category: null }],
      });
    }
    expect((await decisionOf("own-zelle"))?.parts[0]?.type).toBe("Transfer");
    expect((await decisionOf("paycheck"))?.step).toBe("6.9");
    const open = await items();
    expect(open).toHaveLength(5);
    for (const item of open) {
      expect(item).toMatchObject({
        decided: "Money from a person with no link counts as Income.",
        bestAnswer: { value: "keep", label: "Keep as Income" },
        needsAi: true,
      });
    }
    expect(await month("2026-10")).toMatchObject({ income: 300_000 + 11_000 });

    // Another sync opens no second item.
    await sync({ added: [moneyIn("later", 1_000, "2026-10-20", "VENMO CASHOUT")] });
    expect(await items()).toHaveLength(6);
  });

  it("lets three friends pay back one dinner from the Review list, which reduces its past month", async () => {
    await sync({
      added: [
        dinner("dinner", -12_000, "2026-09-28"),
        moneyIn("friend-1", 4_000, "2026-10-02", "VENMO *MORGAN LEE"),
        moneyIn("friend-2", 4_000, "2026-10-03", "ZELLE PAYMENT FROM JOHN SMITH"),
        moneyIn("friend-3", 4_000, "2026-10-04", "CASH APP*SAM ROW"),
      ],
    });
    expect(await month("2026-09")).toMatchObject({
      spending: 12_000,
      byCategory: { Restaurants: 12_000 },
    });
    expect(await month("2026-10")).toMatchObject({ spending: 0, income: 12_000 });
    // The dinner is among the choices behind "Not this".
    const choices = await otherReviewChoices(bank.database, (await itemAbout("friend-1")).id);
    expect(choices).toEqual([
      { value: `link ${await idOf("dinner")}`, label: "Corner Bistro, $120.00, Sep 28" },
    ]);

    expect(await linkTo("friend-1", "dinner")).toBe("answered");
    expect(await linkTo("friend-2", "dinner")).toBe("answered");
    expect(await month("2026-09")).toMatchObject({ spending: 4_000 });
    expect(await linkTo("friend-3", "dinner")).toBe("answered");

    // Each takes the dinner's Category, and the September Spending is down to $0. October, the
    // month the money arrived, has none of it as Income, so nothing counts in it.
    for (const friend of ["friend-1", "friend-2", "friend-3"]) {
      expect(await decisionOf(friend)).toEqual({
        step: "2",
        provisionalUntil: null,
        parts: [{ type: "Reimbursement", amount: 4_000, category: "Restaurants", linked: true }],
      });
    }
    expect(await month("2026-09")).toMatchObject({ spending: 0, byCategory: { Restaurants: 0 } });
    expect(await month("2026-10")).toBeUndefined();
    expect(await spendingLinks()).toEqual(
      ["friend-1", "friend-2", "friend-3"].map((money) => ({
        money,
        spending: "dinner",
        kind: "Reimbursement",
        madeBy: "Member",
      })),
    );
    expect(await items()).toEqual([]);
  });

  it("reduces Spending only to $0 when a Reimbursement is larger, and counts the rest as Income", async () => {
    await sync({
      added: [
        dinner("dinner", -3_000, "2026-09-28"),
        moneyIn("friend", 5_000, "2026-10-02", "ZELLE PAYMENT FROM JOHN SMITH"),
      ],
    });

    await linkTo("friend", "dinner");

    expect((await decisionOf("friend"))?.parts).toEqual([
      { type: "Reimbursement", amount: 3_000, category: "Restaurants", linked: true },
      { type: "Income", amount: 2_000, category: null },
    ]);
    expect(await month("2026-09")).toMatchObject({ spending: 0, byCategory: { Restaurants: 0 } });
    expect(await month("2026-10")).toMatchObject({ income: 2_000 });
  });

  it("keeps the money as Income by hand when a Member says so, and never asks again", async () => {
    await sync({ added: [moneyIn("cashout", 2_000, "2026-10-03", "VENMO CASHOUT")] });

    expect(await answer("cashout", "keep")).toBe("answered");

    expect(await decisionOf("cashout")).toMatchObject({
      step: "1",
      parts: [{ type: "Income", amount: 2_000 }],
    });
    expect(await items()).toEqual([]);
    await sync({ added: [dinner("dinner", -1_000, "2026-10-04")] });
    expect(await items()).toEqual([]);
  });

  it("offers and links only shown money out with Spending, from the 60 days up to the money", async () => {
    await sync({
      added: [
        dinner("in-window", -2_000, "2026-08-04"),
        dinner("too-old", -2_000, "2026-08-02"),
        dinner("after", -2_000, "2026-10-05"),
        dinner("removed", -2_000, "2026-09-10"),
        dinner("hidden", -2_000, "2026-09-11"),
        // Money in that a Member set to Spending by hand.
        dinner("credit", 2_000, "2026-09-12"),
        // A card payment pairs as a Transfer: its money out is no Spending.
        fakeTxn({
          id: "card-payment-out",
          accountId: CHECKING,
          amount: -9_000,
          postedDate: "2026-09-20",
          description: "PAYMENT TO CARD 1111",
          merchantName: null,
          category: code("LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"),
        }),
        fakeTxn({
          id: "card-payment-in",
          accountId: CARD,
          amount: 9_000,
          postedDate: "2026-09-20",
          description: "PAYMENT THANK YOU",
          merchantName: null,
          category: code("LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"),
        }),
        moneyIn("friend", 2_500, "2026-10-03", "VENMO *MORGAN LEE"),
      ],
    });
    await sync({ removed: [{ id: "removed" }] });
    await setTransactionType(bank.database, await idOf("credit"), "Spending", NOW());
    await runFollowUp(NOW);
    // A sync hid it, and the follow-up job has not cleared its result yet.
    await bank.database.$client.execute({
      sql: `UPDATE transactions SET hidden_reason = 'removed by provider',
              hidden_at = '2026-11-01T00:00:00.000Z'
            WHERE provider_transaction_id = 'hidden'`,
      args: [],
    });
    expect((await decisionOf("credit"))?.parts[0]?.type).toBe("Spending");
    const { id } = await itemAbout("friend");

    const choices = await otherReviewChoices(bank.database, id);
    expect(choices?.map((choice) => choice.label)).toEqual(["Corner Bistro, $20.00, Aug 4"]);
    for (const other of ["too-old", "after", "removed", "hidden", "credit", "card-payment-out"]) {
      expect(await linkTo("friend", other)).toBe("not a choice");
    }
    expect((await spendingLinks()).filter((link) => link.kind === "Reimbursement")).toEqual([]);
    expect(await decisionOf("friend")).toMatchObject({ step: "6.5" });
    expect(await items()).toHaveLength(1);
  });

  it("settles the item when a Member links the money by hand, and opens it again after an Undo", async () => {
    await sync({
      added: [
        dinner("dinner", -6_000, "2026-09-28"),
        moneyIn("friend", 2_000, "2026-10-02", "VENMO *MORGAN LEE"),
      ],
    });
    const made = await linkByHand(
      bank.database,
      {
        kind: "Reimbursement",
        transactionId: await idOf("friend"),
        spendingTransactionId: await idOf("dinner"),
      },
      MEMBER,
      NOW(),
    );
    await runFollowUp(NOW);

    if (made.outcome !== "linked") throw new Error(made.outcome);
    expect(await items()).toEqual([]);
    expect(await month("2026-09")).toMatchObject({ spending: 4_000 });

    await undoLink(bank.database, made.linkId, MEMBER, NOW());
    await runFollowUp(NOW);

    expect(await items()).toHaveLength(1);
    expect(await month("2026-09")).toMatchObject({ spending: 6_000 });
  });

  it("shows the AI's pick as the best answer, with no mark for an AI redo", async () => {
    let dinnerId = "";
    const unregister = registerReimbursementPicker(async () => ({
      spendingTransactionId: dinnerId,
    }));
    try {
      bank.fake.addPages(BANK, {
        accounts: [fakeAccount({ id: CARD, type: "credit", subtype: "credit card", mask: "1111" })],
        added: [dinner("dinner", -6_000, "2026-09-28")],
        changed: [],
        removed: [],
        historyLoaded: true,
      });
      await syncConnection(connectionId, NOW);
      await runFollowUp(NOW);
      dinnerId = await idOf("dinner");
      await sync({ added: [moneyIn("friend", 2_000, "2026-10-02", "VENMO *MORGAN LEE")] });

      expect(await itemAbout("friend")).toMatchObject({
        bestAnswer: {
          value: `link ${dinnerId}`,
          label: "Yes, it pays back Corner Bistro, $60.00, Sep 28",
        },
        needsAi: false,
      });
      // The pick shows once: "Not this" lists only Keep as Income.
      const others = await otherReviewChoices(bank.database, (await itemAbout("friend")).id);
      expect(others?.map((choice) => choice.value)).toEqual(["keep"]);
      expect(await answer("friend", `link ${dinnerId}`)).toBe("answered");
      expect(await spendingLinks()).toEqual([
        { money: "friend", spending: "dinner", kind: "Reimbursement", madeBy: "Member" },
      ]);
    } finally {
      unregister();
    }
  });

  it.each(["replaced by re-link", "removed by provider"])(
    "refuses the AI's pick once its Spending is hidden (%s) after the item opened, and keeps the item open",
    async (reason) => {
      let dinnerId = "";
      const unregister = registerReimbursementPicker(async () => ({
        spendingTransactionId: dinnerId,
      }));
      try {
        await sync({ added: [dinner("dinner", -6_000, "2026-09-28")] });
        dinnerId = await idOf("dinner");
        await sync({ added: [moneyIn("friend", 2_000, "2026-10-02", "VENMO *MORGAN LEE")] });
        expect((await itemAbout("friend")).bestAnswer.value).toBe(`link ${dinnerId}`);
        // A sync hid it, and the follow-up job has not run yet.
        await bank.database.$client.execute({
          sql: `UPDATE transactions SET hidden_reason = ?, hidden_at = '2026-11-01T00:00:00.000Z'
              WHERE id = ?`,
          args: [reason, dinnerId],
        });

        expect(await answer("friend", `link ${dinnerId}`)).toBe("not a choice");
        expect(await spendingLinks()).toEqual([]);
        expect((await itemAbout("friend")).bestAnswer.value).toBe(`link ${dinnerId}`);
      } finally {
        unregister();
      }
    },
  );
});
