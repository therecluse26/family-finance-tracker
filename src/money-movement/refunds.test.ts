import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { startCategorization } from "../categorization/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import {
  linkByHand,
  readTransactionDecision,
  setTransactionType,
  startMoneyMovement,
  switchExclude,
  totalsByMonth,
  undoLink,
} from "./index.ts";

// Refunds and Reimbursements (spec 03, Refunds, Link shapes, Which month a link changes), through
// the Matching and Categorization follow-up steps on Transactions the fake adapter syncs.

const NOW = () => new Date("2026-11-20T14:00:00.000Z");
const BANK = "fake-first-bank";
const CARD = "acc-card";
const OTHER_CARD = "acc-other-card";
const CHECKING = "acc-checking";
const MEMBER = "member-1";
const code = (name: string) => ({ name, confidence: "HIGH", version: "v2", mcc: null });
const CLOTHING = "GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES";
const RESTAURANT = "FOOD_AND_DRINK_RESTAURANT";

describe("Refunds", () => {
  let bank: TestBank;
  let stops: (() => void)[];
  let connectionId: string;

  const sync = async (page: {
    added?: TxnRecord[];
    changed?: TxnRecord[];
    removed?: { id: string }[];
  }) => {
    bank.fake.addPages(BANK, {
      accounts: [
        fakeAccount({ id: CARD, type: "credit", subtype: "credit card", mask: "1111" }),
        fakeAccount({ id: OTHER_CARD, type: "credit", subtype: "credit card", mask: "2222" }),
        fakeAccount({ id: CHECKING, mask: "3333" }),
      ],
      added: page.added ?? [],
      changed: page.changed ?? [],
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
  // A purchase, money out, or a Refund, money in, at a Merchant.
  const txn = (
    id: string,
    amount: number,
    postedDate: string,
    merchant: string | null,
    fields: Partial<TxnRecord> = {},
  ) =>
    fakeTxn({
      id,
      accountId: CARD,
      amount,
      postedDate,
      description: merchant === null ? `LINE ${id.toUpperCase()}` : merchant.toUpperCase(),
      merchantName: merchant,
      category: code(CLOTHING),
      ...fields,
    });
  // Each Refund or Reimbursement link, by its sides' provider IDs, with its kind and maker.
  const links = async () => {
    const rows = await bank.database.$client.execute(
      `SELECT m.provider_transaction_id AS money, s.provider_transaction_id AS spending, l.kind,
         l.made_by AS madeBy
       FROM spending_links l
       JOIN transactions m ON m.id = l.transaction_id
       JOIN transactions s ON s.id = l.spending_transaction_id
       ORDER BY money`,
    );
    return rows.rows.map((row) => ({ ...row }));
  };
  const accountIdOf = async (providerAccountId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT id FROM household_accounts WHERE provider_account_id = ?",
      args: [providerAccountId],
    });
    return String(rows.rows[0]?.id);
  };
  const decisionOf = async (providerId: string) =>
    readTransactionDecision(bank.database, await idOf(providerId));
  const month = async (name: string) =>
    (await totalsByMonth(bank.database)).find((totals) => totals.month === name);
  const linkHand = async (
    kind: "Refund" | "Reimbursement",
    money: string,
    spending: string,
  ): Promise<string> => {
    const made = await linkByHand(
      bank.database,
      {
        kind,
        transactionId: await idOf(money),
        spendingTransactionId: await idOf(spending),
      },
      MEMBER,
      NOW(),
    );
    if (made.outcome !== "linked") throw new Error(`Not linked: ${made.outcome}`);
    await runFollowUp(NOW);
    return made.linkId;
  };

  // Hides a Transaction as a sync does, before the follow-up job clears its result: its parts stay
  // until Matching runs.
  const hideBySync = async (providerId: string) => {
    await bank.database.$client.execute({
      sql: `UPDATE transactions SET hidden_reason = 'removed by provider',
              hidden_at = '2026-11-01T00:00:00.000Z'
            WHERE provider_transaction_id = ?`,
      args: [providerId],
    });
  };
  // A purchase's posted record, a few days after it was bought.
  const postedOf = (txn: TxnRecord, fields: Partial<TxnRecord>): TxnRecord => ({
    ...txn,
    id: `${txn.id}-posted`,
    pending: false,
    pendingTransactionId: txn.id,
    authorizedDate: txn.postedDate,
    ...fields,
  });

  beforeEach(async () => {
    bank = await newTestBank();
    stops = [
      startMoneyMovement({ database: bank.database }).stop,
      startCategorization({ database: bank.database }).stop,
    ];
    connectionId = await bank.connect(BANK);
    await bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('${MEMBER}', 'Jamie', 'jamie@example.com', '2026-10-01T00:00:00.000Z',
         '2026-10-01T00:00:00.000Z')`,
    );
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  it("links at once to the latest earlier purchase on the same Account and Merchant, and changes that past month", async () => {
    await sync({
      added: [
        txn("older", -5_000, "2026-08-10", "Shoe Barn"),
        txn("latest", -8_000, "2026-09-12", "Shoe Barn"),
        txn("dinner", -3_000, "2026-09-20", "Corner Bistro", { category: code(RESTAURANT) }),
        txn("other-card", -4_000, "2026-10-02", "Shoe Barn", { accountId: OTHER_CARD }),
        txn("later", -1_000, "2026-10-20", "Shoe Barn"),
      ],
    });
    expect(await month("2026-09")).toMatchObject({
      spending: 11_000,
      byCategory: { Clothing: 8_000, Restaurants: 3_000 },
    });

    await sync({ added: [txn("refund", 3_000, "2026-10-15", "Shoe Barn")] });

    // No AI and no Review list: the app makes the link, and the purchase's month changes.
    expect(await links()).toEqual([
      { money: "refund", spending: "latest", kind: "Refund", madeBy: "app" },
    ]);
    expect(await decisionOf("refund")).toEqual({
      step: "6.4",
      provisionalUntil: null,
      parts: [{ type: "Refund", amount: 3_000, category: "Clothing", linked: true }],
    });
    expect(await month("2026-09")).toMatchObject({
      spending: 8_000,
      byCategory: { Clothing: 5_000, Restaurants: 3_000 },
    });
    expect(await month("2026-10")).toMatchObject({
      spending: 5_000,
      byCategory: { Clothing: 5_000 },
    });
    const evidence = await bank.database.$client.execute(
      "SELECT tier, signals FROM spending_links",
    );
    expect(evidence.rows.map((row) => ({ ...row }))).toEqual([
      { tier: "Strong", signals: '["same Account","same Merchant"]' },
    ]);
  });

  it("links a purchase 120 days back, and never one 121 days back", async () => {
    await sync({
      added: [
        txn("in-window", -5_000, "2026-06-01", "Shoe Barn"),
        txn("too-old", -5_000, "2026-06-01", "Hat Shack"),
        txn("refund-120", 2_000, "2026-09-29", "Shoe Barn"),
        txn("refund-121", 2_000, "2026-09-30", "Hat Shack"),
      ],
    });

    expect(await links()).toEqual([
      { money: "refund-120", spending: "in-window", kind: "Refund", madeBy: "app" },
    ]);
    // With no link, a Refund with a Merchant and a Spending provider category is an unlinked
    // Refund: the cascade picks its Category, and it reduces the month it arrives.
    expect((await decisionOf("refund-121"))?.step).toBe("6.8");
    expect(await month("2026-09")).toMatchObject({ spending: 0, byCategory: { Clothing: 0 } });
    expect(await month("2026-06")).toMatchObject({
      spending: 8_000,
      byCategory: { Clothing: 8_000 },
    });
  });

  it("lets two partial Refunds reduce one purchase, and a larger one only down to $0", async () => {
    await sync({
      added: [
        txn("shoes", -10_000, "2026-10-01", "Shoe Barn"),
        txn("first", 4_000, "2026-10-05", "Shoe Barn"),
        txn("second", 4_000, "2026-10-08", "Shoe Barn"),
        txn("third", 5_000, "2026-10-10", "Shoe Barn"),
        // Nothing is left to reduce, so it links to nothing.
        txn("fourth", 1_000, "2026-10-12", "Shoe Barn", { category: code("INCOME_OTHER_INCOME") }),
        txn("coat", -9_000, "2026-11-02", "Coat Corner"),
      ],
    });

    expect(await links()).toEqual([
      { money: "first", spending: "shoes", kind: "Refund", madeBy: "app" },
      { money: "second", spending: "shoes", kind: "Refund", madeBy: "app" },
      { money: "third", spending: "shoes", kind: "Refund", madeBy: "app" },
    ]);
    expect((await decisionOf("second"))?.parts).toEqual([
      { type: "Refund", amount: 4_000, category: "Clothing", linked: true },
    ]);
    // The rest of a Refund follows the unlinked Refund rule.
    expect((await decisionOf("third"))?.parts).toEqual([
      { type: "Refund", amount: 2_000, category: "Clothing", linked: true },
      { type: "Refund", amount: 3_000, category: "Clothing" },
    ]);
    // No Spending provider category: Income.
    expect(await decisionOf("fourth")).toMatchObject({
      step: "6.9",
      parts: [{ type: "Income", amount: 1_000 }],
    });
    // October's Clothing would be 10,000 − 10,000 − 3,000: it shows $0, and the rest counts
    // nowhere, not even in November.
    expect(await month("2026-10")).toMatchObject({
      spending: 0,
      income: 1_000,
      byCategory: { Clothing: 0 },
    });
    expect(await month("2026-11")).toMatchObject({ spending: 9_000 });
  });

  it("never takes any Category's month below $0, and keeps the others' Spending", async () => {
    await sync({
      added: [
        txn("dinner", -2_000, "2026-10-03", "Corner Bistro", { category: code(RESTAURANT) }),
        txn("socks", -1_000, "2026-10-04", "Shoe Barn"),
        // An unlinked Refund from a restaurant with no purchase on the card.
        txn("refund", 5_000, "2026-10-06", "Harbor Grill", { category: code(RESTAURANT) }),
      ],
    });

    expect(await links()).toEqual([]);
    expect(await month("2026-10")).toMatchObject({
      spending: 1_000,
      byCategory: { Restaurants: 0, Clothing: 1_000 },
      byCategoryGroup: { Shopping: 1_000 },
    });
  });

  it("counts a hand Refund and hand Reimbursements, with a Reimbursement's rest as Income", async () => {
    await sync({
      added: [
        txn("dinner", -6_000, "2026-09-28", "Corner Bistro", { category: code(RESTAURANT) }),
        txn("friend", 2_500, "2026-10-03", null, {
          description: "VENMO *MORGAN LEE",
          category: null,
        }),
        txn("other-friend", 5_000, "2026-10-04", null, {
          description: "ZELLE PAYMENT FROM JOHN SMITH",
          category: null,
        }),
        txn("jacket", -7_000, "2026-09-01", "Coat Corner"),
        txn("store-credit", 1_500, "2026-10-05", null, { description: "STORE CREDIT" }),
      ],
    });
    expect(await links()).toEqual([]);
    // STORE CREDIT has a Merchant and a Spending provider category: an unlinked Refund.
    expect(await month("2026-10")).toMatchObject({ income: 7_500 });

    await linkHand("Reimbursement", "friend", "dinner");
    await linkHand("Reimbursement", "other-friend", "dinner");
    await linkHand("Refund", "store-credit", "jacket");

    expect(await decisionOf("friend")).toEqual({
      step: "2",
      provisionalUntil: null,
      parts: [{ type: "Reimbursement", amount: 2_500, category: "Restaurants", linked: true }],
    });
    expect((await decisionOf("other-friend"))?.parts).toEqual([
      { type: "Reimbursement", amount: 3_500, category: "Restaurants", linked: true },
      { type: "Income", amount: 1_500, category: null },
    ]);
    expect((await decisionOf("store-credit"))?.parts).toEqual([
      { type: "Refund", amount: 1_500, category: "Clothing", linked: true },
    ]);
    // Each reduces its Spending's September; only the rest of a Reimbursement is October's.
    expect(await month("2026-09")).toMatchObject({
      spending: 5_500,
      byCategory: { Restaurants: 0, Clothing: 5_500 },
    });
    expect(await month("2026-10")).toMatchObject({ spending: 0, income: 1_500 });
  });

  it("never links a payment-app line with a person as a Refund, and reads Merchants through cleanup", async () => {
    const out = (id: string, description: string, postedDate: string) =>
      txn(id, -2_000, postedDate, null, { description, category: null });
    const back = (id: string, description: string) =>
      txn(id, 2_000, "2026-10-10", null, { description, category: null });
    await sync({
      added: [
        out("venmo-out", "VENMO *MORGAN LEE", "2026-10-01"),
        back("venmo-back", "VENMO *MORGAN LEE"),
        out("zelle-out", "ZELLE PAYMENT TO JOHN SMITH", "2026-10-01"),
        back("zelle-back", "ZELLE PAYMENT TO JOHN SMITH"),
        out("cash-app-out", "CASH APP*JOHN SMITH", "2026-10-01"),
        back("cash-app-back", "CASH APP*JOHN SMITH"),
        out("venmo-plain-out", "VENMO PAYMENT 1234567890 WEB ID", "2026-10-01"),
        back("venmo-cashout", "VENMO CASHOUT"),
        out("paypal-out", "PAYPAL *INST XFER", "2026-10-01"),
        back("paypal-back", "PAYPAL *INST XFER"),
        out("etsy", "PAYPAL *ETSY SHOP", "2026-10-02"),
        back("etsy-refund", "PAYPAL *ETSY SHOP"),
        out("books", "PURCHASE 1005 BLUEBIRD BOOKS", "2026-10-03"),
        back("books-refund", "BLUEBIRD BOOKS"),
        out("best-buy", "BEST BUY CO", "2026-10-04"),
        back("best-buy-refund", "BEST BUY CO"),
      ],
    });

    // A PayPal purchase at a shop is an ordinary purchase, and so is its Refund. Store numbers and
    // lead-ins do not change the Merchant.
    expect(await links()).toEqual([
      { money: "best-buy-refund", spending: "best-buy", kind: "Refund", madeBy: "app" },
      { money: "books-refund", spending: "books", kind: "Refund", madeBy: "app" },
      { money: "etsy-refund", spending: "etsy", kind: "Refund", madeBy: "app" },
    ]);
    for (const id of ["venmo-back", "zelle-back", "cash-app-back", "venmo-cashout"]) {
      expect((await decisionOf(id))?.step, id).toBe("6.5");
    }
  });

  it("never makes an undone Refund link again", async () => {
    await sync({
      added: [
        txn("shoes", -5_000, "2026-10-01", "Shoe Barn"),
        txn("refund", 2_000, "2026-10-05", "Shoe Barn"),
      ],
    });
    const [link] = (await bank.database.$client.execute("SELECT id FROM spending_links")).rows;
    expect(await undoLink(bank.database, String(link?.id), MEMBER, NOW())).toBe(true);
    await runFollowUp(NOW);
    await sync({
      changed: [txn("refund", 2_000, "2026-10-05", "Shoe Barn", { description: "SHOE BARN RTN" })],
    });

    expect(await links()).toEqual([]);
    expect((await decisionOf("refund"))?.step).toBe("6.8");
  });

  // K12: re-matching never ends a hand link for the wrong reason.
  it("keeps a hand Refund link through Saving and back, with the Totals right at each step", async () => {
    await sync({ added: [txn("shoes", -10_000, "2026-09-10", "Shoe Barn")] });
    // Given back to the other card, so only a Member links it.
    await sync({
      added: [txn("refund", 4_000, "2026-10-05", "Shoe Barn", { accountId: OTHER_CARD })],
    });
    expect(await links()).toEqual([]);
    await linkHand("Refund", "refund", "shoes");
    expect(await month("2026-09")).toMatchObject({
      spending: 6_000,
      byCategory: { Clothing: 6_000 },
    });

    // The purchase is Saving: the hand link stays, and the Refund has no Spending to reduce.
    await setTransactionType(bank.database, await idOf("shoes"), "Saving", NOW());
    await runFollowUp(NOW);
    expect(await links()).toEqual([
      { money: "refund", spending: "shoes", kind: "Refund", madeBy: "Member" },
    ]);
    expect(await month("2026-09")).toMatchObject({ spending: 0, saving: 10_000 });

    // Spending again, in one Matching run with the Refund: the Refund reads the new parts.
    await setTransactionType(bank.database, await idOf("shoes"), "Spending", NOW());
    await runFollowUp(NOW);
    expect(await decisionOf("refund")).toEqual({
      step: "2",
      provisionalUntil: null,
      parts: [{ type: "Refund", amount: 4_000, category: "Clothing", linked: true }],
    });
    expect(await month("2026-09")).toMatchObject({
      spending: 6_000,
      byCategory: { Clothing: 6_000 },
    });
    expect((await month("2026-10"))?.byCategory.Clothing ?? 0).toBe(0);
  });

  it("keeps an app Refund link when its pending purchase posts later, for another amount", async () => {
    const shoes = txn("shoes", -10_000, "2026-09-28", "Shoe Barn", { pending: true });
    await sync({ added: [shoes, txn("refund", 4_000, "2026-10-02", "Shoe Barn")] });
    expect(await links()).toEqual([
      { money: "refund", spending: "shoes", kind: "Refund", madeBy: "app" },
    ]);

    // Bought Sep 28, posted Oct 3, after the Refund, for $120.
    await sync({
      added: [postedOf(shoes, { postedDate: "2026-10-03", amount: -12_000 })],
      removed: [{ id: "shoes" }],
    });

    expect(await links()).toEqual([
      { money: "refund", spending: "shoes-posted", kind: "Refund", madeBy: "app" },
    ]);
    expect(await decisionOf("refund")).toEqual({
      step: "6.4",
      provisionalUntil: null,
      parts: [{ type: "Refund", amount: 4_000, category: "Clothing", linked: true }],
    });
    expect(await month("2026-09")).toMatchObject({
      spending: 8_000,
      byCategory: { Clothing: 8_000 },
    });
    expect(await month("2026-10")).toBeUndefined();
  });

  it("keeps a hand Reimbursement on a pending dinner that posts after the money in", async () => {
    const dinner = txn("dinner", -5_000, "2026-10-03", "Corner Bistro", {
      category: code(RESTAURANT),
      pending: true,
    });
    await sync({
      added: [
        dinner,
        txn("zelle", 2_500, "2026-10-04", null, {
          accountId: CHECKING,
          description: "ZELLE FROM PAT",
          category: code("TRANSFER_IN_ACCOUNT_TRANSFER"),
        }),
      ],
    });
    await linkHand("Reimbursement", "zelle", "dinner");

    // Bought Oct 3, posted Oct 6 with the tip, after the Zelle on Oct 4.
    await sync({
      added: [postedOf(dinner, { postedDate: "2026-10-06", amount: -6_000 })],
      removed: [{ id: "dinner" }],
    });

    expect(await links()).toEqual([
      { money: "zelle", spending: "dinner-posted", kind: "Reimbursement", madeBy: "Member" },
    ]);
    expect(await month("2026-10")).toMatchObject({
      spending: 3_500,
      income: 0,
      byCategory: { Restaurants: 3_500 },
    });
  });

  it("links money in to a purchase bought before it that posted after it", async () => {
    await sync({
      added: [
        txn("shoes", -10_000, "2026-10-03", "Shoe Barn", { authorizedDate: "2026-09-28" }),
        txn("dinner", -6_000, "2026-10-06", "Corner Bistro", {
          authorizedDate: "2026-10-03",
          category: code(RESTAURANT),
        }),
        txn("refund", 4_000, "2026-10-02", "Shoe Barn"),
        txn("zelle", 2_500, "2026-10-04", null, {
          accountId: CHECKING,
          description: "ZELLE FROM PAT",
          category: code("TRANSFER_IN_ACCOUNT_TRANSFER"),
        }),
      ],
    });
    await linkHand("Reimbursement", "zelle", "dinner");

    expect(await links()).toEqual([
      { money: "refund", spending: "shoes", kind: "Refund", madeBy: "app" },
      { money: "zelle", spending: "dinner", kind: "Reimbursement", madeBy: "Member" },
    ]);
    expect(await month("2026-09")).toMatchObject({ byCategory: { Clothing: 6_000 } });
    expect(await month("2026-10")).toMatchObject({ income: 0, byCategory: { Restaurants: 3_500 } });
  });

  it("never links a Refund to a hidden purchase, even before its result is cleared", async () => {
    await sync({ added: [txn("shoes", -10_000, "2026-09-10", "Shoe Barn")] });
    await hideBySync("shoes");

    await sync({ added: [txn("refund", 4_000, "2026-10-05", "Shoe Barn")] });

    expect(await links()).toEqual([]);
    expect((await decisionOf("refund"))?.step).toBe("6.8");
  });

  it("gives a hidden Refund no share of its purchase", async () => {
    await sync({
      added: [
        txn("shoes", -10_000, "2026-09-10", "Shoe Barn"),
        txn("first", 4_000, "2026-10-05", "Shoe Barn"),
        txn("second", 8_000, "2026-10-06", "Shoe Barn"),
      ],
    });
    // The first Refund takes $40 of the $100, so the second reduces only the $60 left.
    expect((await decisionOf("second"))?.parts).toEqual([
      { type: "Refund", amount: 6_000, category: "Clothing", linked: true },
      { type: "Refund", amount: 2_000, category: "Clothing" },
    ]);
    await hideBySync("first");

    await sync({ changed: [txn("second", 8_000, "2026-10-07", "Shoe Barn")] });

    expect((await decisionOf("second"))?.parts).toEqual([
      { type: "Refund", amount: 8_000, category: "Clothing", linked: true },
    ]);
  });

  it("keeps a hand link and an app link through Exclude and back, and ends only the app link when a provider change breaks its filters", async () => {
    await sync({
      added: [
        txn("shoes", -10_000, "2026-10-01", "Shoe Barn"),
        txn("refund", 3_000, "2026-10-05", "Shoe Barn"),
        txn("store-credit", 2_000, "2026-10-06", null, { description: "STORE CREDIT" }),
      ],
    });
    await linkHand("Refund", "store-credit", "shoes");
    const both = [
      { money: "refund", spending: "shoes", kind: "Refund", madeBy: "app" },
      { money: "store-credit", spending: "shoes", kind: "Refund", madeBy: "Member" },
    ];
    expect(await links()).toEqual(both);
    expect(await month("2026-10")).toMatchObject({
      spending: 5_000,
      byCategory: { Clothing: 5_000 },
    });

    // An excluded Account's Transactions count nowhere, and their links stay.
    expect(await switchExclude(bank.database, await accountIdOf(CARD), true)).toBe(true);
    await runFollowUp(NOW);
    expect(await links()).toEqual(both);
    expect(await month("2026-10")).toMatchObject({ spending: 0, byCategory: {} });
    expect(await switchExclude(bank.database, await accountIdOf(CARD), false)).toBe(true);
    await runFollowUp(NOW);
    expect(await links()).toEqual(both);
    expect(await month("2026-10")).toMatchObject({
      spending: 5_000,
      byCategory: { Clothing: 5_000 },
    });

    // The Refund now names another Merchant: the app link fails its hard filters and ends, and
    // the hand link stays.
    await sync({ changed: [txn("refund", 3_000, "2026-10-05", "Hat Shack")] });
    expect(await links()).toEqual([both[1]]);
    expect(await month("2026-10")).toMatchObject({
      spending: 5_000,
      byCategory: { Clothing: 5_000 },
    });
    expect((await decisionOf("refund"))?.step).toBe("6.8");

    await sync({ changed: [txn("refund", 3_000, "2026-10-05", "Shoe Barn")] });
    expect(await links()).toEqual(both);
    expect(await month("2026-10")).toMatchObject({
      spending: 5_000,
      byCategory: { Clothing: 5_000 },
    });
  });

  it("links 2,500 Refunds on a first history load in a few seconds", async () => {
    // Purchases are read once for the batch, never once for each Refund.
    const day = (n: number) => new Date(Date.UTC(2025, 10, 1 + n)).toISOString().slice(0, 10);
    const shop = (n: number) => `Shop ${String.fromCharCode(65 + (n % 26))}${n % 50}`;
    bank.fake.addPages(BANK, {
      accounts: [fakeAccount({ id: CARD, type: "credit", subtype: "credit card", mask: "1111" })],
      added: Array.from({ length: 2_500 }, (_, n) => [
        txn(`buy-${n}`, -(2_000 + n), day(Math.floor(n / 7)), shop(n)),
        txn(`refund-${n}`, 1_000, day(Math.floor(n / 7) + 3), shop(n)),
      ]).flat(),
      historyLoaded: true,
    });
    await syncConnection(connectionId, NOW);
    // CPU time, which a busy host does not stretch.
    const started = process.cpuUsage();
    await runFollowUp(NOW);
    const used = process.cpuUsage(started);
    const took = (used.user + used.system) / 1_000;

    const made = await bank.database.$client.execute("SELECT count(*) AS n FROM spending_links");
    expect(Number(made.rows[0]?.n)).toBe(2_500);
    expect(took).toBeLessThan(8_000);
  }, 120_000);
});
