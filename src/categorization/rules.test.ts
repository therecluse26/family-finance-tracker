import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import type { Category } from "../categories/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { setTransactionType, startMoneyMovement } from "../money-movement/index.ts";
import { answerReviewItem, openReviewItems } from "../review/index.ts";
import {
  BEST_GUESS_KIND,
  categoryRules,
  correctCategory,
  deleteCategoryRule,
  startCategorization,
} from "./index.ts";

// Category rules (spec 04, Category rules, Re-runs, Review list items), through the
// categorization module's interface. Transactions arrive through the fake adapter, and the
// follow-up job runs Matching, then Categorization.

const NOW = () => new Date("2026-11-01T14:00:00.000Z");
const BANK = "fake-first-bank";
const MEMBER = "member-1";
const CARD = fakeAccount({
  id: "acc-card",
  name: "Everyday Card",
  type: "credit",
  subtype: "credit card",
});

describe("Category rules", () => {
  let bank: TestBank;
  let stops: (() => void)[];
  let connectionId: string;

  const idOf = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT id FROM transactions WHERE provider_transaction_id = ? AND hidden_reason IS NULL",
      args: [providerId],
    });
    return String(rows.rows[0]?.id);
  };
  // The first part's type, Category, and the step that chose it.
  const chosen = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: `SELECT p.type, p.category, p.category_source AS source
            FROM transaction_parts p JOIN transactions t ON t.id = p.transaction_id
            WHERE t.provider_transaction_id = ? AND t.hidden_reason IS NULL ORDER BY p.part`,
      args: [providerId],
    });
    const [row] = rows.rows;
    return row === undefined ? undefined : [row.type, row.category, row.source];
  };
  const sync = async (...pages: Parameters<TestBank["fake"]["addPages"]>[1][]) => {
    bank.fake.addPages(BANK, ...pages);
    await syncConnection(connectionId, NOW);
    await runFollowUp(NOW);
  };
  const correct = async (providerId: string, category: Category, onlyThisTransaction = false) =>
    correctCategory(bank.database, await idOf(providerId), category, {
      onlyThisTransaction,
      memberId: MEMBER,
    });
  const rules = async () =>
    (await categoryRules(bank.database)).map((rule) => [
      rule.merchant.id,
      rule.merchant.name,
      rule.category,
    ]);

  // A purchase on the card, with a Plaid category the cascade takes at step 3.
  const buy = (id: string, postedDate: string, fields: Partial<TxnRecord> = {}): TxnRecord =>
    fakeTxn({
      id,
      accountId: CARD.id,
      amount: -2_500,
      postedDate,
      description: `CARD PURCHASE ${id.toUpperCase()}`,
      merchantName: "Corner Bistro",
      category: { name: "FOOD_AND_DRINK_RESTAURANT", confidence: "HIGH", version: "v2", mcc: null },
      ...fields,
    });

  beforeEach(async () => {
    bank = await newTestBank();
    stops = [
      startMoneyMovement({ database: bank.database }).stop,
      startCategorization({ database: bank.database }).stop,
    ];
    connectionId = await bank.connect(BANK);
    bank.fake.addPages(BANK, { accounts: [CARD] });
    await bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('${MEMBER}', 'Jamie', 'jamie@example.com', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    );
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  it("covers the Merchant's past and future Transactions, except those set by hand", async () => {
    await sync({
      added: [buy("past", "2026-10-01"), buy("hand", "2026-10-02"), buy("fixed", "2026-10-03")],
    });
    await correct("hand", "Pets", true);

    const corrected = await correct("fixed", "Hobbies");

    expect(corrected).toMatchObject({
      result: "corrected",
      category: "Hobbies",
      rule: { merchant: { id: null, name: "Corner Bistro" }, category: "Hobbies" },
      setSpending: false,
    });
    // The correction hands off to the follow-up job, which runs the cascade again.
    expect(bank.followUpsAsked()).toBe(2);
    await runFollowUp(NOW);
    expect(await chosen("past")).toEqual(["Spending", "Hobbies", "Category rule"]);
    expect(await chosen("fixed")).toEqual(["Spending", "Hobbies", "hand-set"]);
    expect(await chosen("hand")).toEqual(["Spending", "Pets", "hand-set"]);

    await sync({ added: [buy("future", "2026-10-20")] });
    expect(await chosen("future")).toEqual(["Spending", "Hobbies", "Category rule"]);
    expect(await rules()).toEqual([[null, "Corner Bistro", "Hobbies"]]);
  });

  it("makes no rule for only this Transaction", async () => {
    await sync({ added: [buy("one", "2026-10-01"), buy("other", "2026-10-02")] });

    expect(await correct("one", "Pets", true)).toMatchObject({ result: "corrected", rule: null });
    await runFollowUp(NOW);

    expect(await chosen("one")).toEqual(["Spending", "Pets", "hand-set"]);
    expect(await chosen("other")).toEqual(["Spending", "Restaurants", "provider"]);
    expect(await rules()).toEqual([]);
  });

  it("keeps one rule per Merchant: a newer correction replaces the older rule", async () => {
    await sync({
      added: [buy("first", "2026-10-01"), buy("second", "2026-10-02"), buy("third", "2026-10-03")],
    });

    await correct("first", "Hobbies");
    await correct("second", "Pets");
    await runFollowUp(NOW);

    expect(await rules()).toEqual([[null, "Corner Bistro", "Pets"]]);
    expect(await chosen("first")).toEqual(["Spending", "Hobbies", "hand-set"]);
    expect(await chosen("third")).toEqual(["Spending", "Pets", "Category rule"]);
  });

  it("matches the same Merchant ID, and by clean name when either has no Merchant ID", async () => {
    await sync({
      added: [
        buy("m1", "2026-10-01", { merchantId: "merchant-1" }),
        buy("m1-later", "2026-10-02", { merchantId: "merchant-1", merchantName: "Bistro" }),
        buy("m2", "2026-10-03", { merchantId: "merchant-2" }),
        buy("no-id", "2026-10-04", { merchantName: "CORNER BISTRO" }),
        buy("elsewhere", "2026-10-05", { merchantName: "Lakeside Diner" }),
      ],
    });

    await correct("m1", "Hobbies");
    await runFollowUp(NOW);

    expect(await rules()).toEqual([["merchant-1", "Corner Bistro", "Hobbies"]]);
    expect(await chosen("m1-later")).toEqual(["Spending", "Hobbies", "Category rule"]);
    expect(await chosen("no-id")).toEqual(["Spending", "Hobbies", "Category rule"]);
    expect(await chosen("m2")).toEqual(["Spending", "Restaurants", "provider"]);
    expect(await chosen("elsewhere")).toEqual(["Spending", "Restaurants", "provider"]);
  });

  it("runs the cascade again when a rule is deleted, and keeps hand-set Categories", async () => {
    await sync({ added: [buy("fixed", "2026-10-01"), buy("ruled", "2026-10-02")] });
    await correct("fixed", "Hobbies");
    await runFollowUp(NOW);
    expect(await chosen("ruled")).toEqual(["Spending", "Hobbies", "Category rule"]);
    const [rule] = await categoryRules(bank.database);

    expect(await deleteCategoryRule(bank.database, rule?.id ?? "")).toBe(true);
    expect(await deleteCategoryRule(bank.database, rule?.id ?? "")).toBe(false);
    await runFollowUp(NOW);

    expect(await rules()).toEqual([]);
    expect(await chosen("ruled")).toEqual(["Spending", "Restaurants", "provider"]);
    expect(await chosen("fixed")).toEqual(["Spending", "Hobbies", "hand-set"]);
  });

  it("makes a Transfer Spending by hand, while the rule sets only the Category", async () => {
    // Money in from the Merchant, with no purchase before it and no provider category: Income.
    const income = buy("income", "2026-09-30", { amount: 4_000, category: null });
    await sync({ added: [buy("moved", "2026-10-01"), income] });
    await setTransactionType(bank.database, await idOf("moved"), "Transfer");
    await runFollowUp(NOW);
    expect(await chosen("moved")).toEqual(["Transfer", null, null]);

    expect(await correct("moved", "Hobbies")).toMatchObject({ setSpending: true });
    await runFollowUp(NOW);

    expect(await chosen("moved")).toEqual(["Spending", "Hobbies", "hand-set"]);
    // The rule covers the Merchant, but never changes a Transaction's type.
    expect(await rules()).toEqual([[null, "Corner Bistro", "Hobbies"]]);
    expect(await chosen("income")).toEqual(["Income", null, null]);
  });

  it("changes only that Transaction on a line with no name or no Merchant, and may name a person", async () => {
    const venmo = { merchantName: "Venmo", description: "VENMO PAYMENT 1234567890 WEB ID" };
    const check = { merchantName: null, description: "CHECK 1042", category: null };
    await sync({
      added: [
        buy("venmo", "2026-10-01", venmo),
        buy("venmo-2", "2026-10-02", venmo),
        buy("check", "2026-10-03", check),
        buy("person", "2026-10-04", { merchantName: "Morgan Lee" }),
        buy("person-2", "2026-10-05", { merchantName: "Morgan Lee" }),
      ],
    });

    expect(await correct("venmo", "Childcare")).toMatchObject({ rule: null });
    expect(await correct("check", "Housing")).toMatchObject({ rule: null });
    expect(await correct("person", "Childcare")).toMatchObject({
      rule: { merchant: { name: "Morgan Lee" } },
    });
    await runFollowUp(NOW);

    expect(await chosen("venmo")).toEqual(["Spending", "Childcare", "hand-set"]);
    // No rule reaches the next Venmo line, so Money movement's Category stays.
    expect(await chosen("venmo-2")).toEqual(["Spending", "Payments to people", "money movement"]);
    expect(await chosen("check")).toEqual(["Spending", "Housing", "hand-set"]);
    expect(await chosen("person-2")).toEqual(["Spending", "Childcare", "Category rule"]);
    expect(await rules()).toEqual([[null, "Morgan Lee", "Childcare"]]);
  });

  it("makes no rule for a payment-app line whose provider sends no Merchant name", async () => {
    const line = (id: string, postedDate: string, description: string) =>
      buy(id, postedDate, { merchantName: null, description });
    await sync({
      added: [
        line("venmo", "2026-10-01", "VENMO PAYMENT 1234567890 WEB ID"),
        line("venmo-2", "2026-10-02", "VENMO PAYMENT 9876543210 WEB ID"),
        line("zelle", "2026-10-03", "ZELLE PAYMENT"),
        line("zelle-2", "2026-10-04", "ZELLE PAYMENT"),
        line("paypal", "2026-10-05", "PAYPAL INST XFER"),
        line("paypal-2", "2026-10-06", "PAYPAL INST XFER"),
        // A payee by number only, and a line whose "PAYPAL *" prefix cleanup strips.
        line("zelle-to", "2026-10-07", "ZELLE PAYMENT TO 5551234"),
        line("zelle-to-2", "2026-10-08", "ZELLE PAYMENT TO 5559999"),
        line("paypal-star", "2026-10-09", "PAYPAL *INST XFER"),
        line("paypal-star-2", "2026-10-10", "PAYPAL *INST XFER"),
        line("cashapp", "2026-10-11", "CASH APP*SENT"),
        line("cashapp-2", "2026-10-12", "CASH APP*SENT"),
        line("cashout", "2026-10-13", "VENMO CASHOUT"),
        line("cashout-2", "2026-10-14", "VENMO CASHOUT"),
      ],
    });

    // Matching decides an XFER line as a one-sided Transfer. A Member makes the second PayPal lines
    // Spending, so a rule for their Merchant would reach them.
    for (const providerId of ["paypal-2", "paypal-star-2"]) {
      await setTransactionType(bank.database, await idOf(providerId), "Spending");
    }
    await runFollowUp(NOW);
    const lines = ["venmo", "zelle", "paypal", "zelle-to", "paypal-star", "cashapp", "cashout"];
    for (const providerId of lines) {
      expect(await correct(providerId, "Childcare")).toMatchObject({
        result: "corrected",
        rule: null,
      });
    }
    await runFollowUp(NOW);

    expect(await rules()).toEqual([]);
    // No rule reaches the second lines: Money movement names Payments to people for a Venmo, Zelle
    // or Cash App line, and a PayPal line keeps its provider's Category.
    const unruled = (providerId: string) =>
      providerId.startsWith("paypal")
        ? ["Spending", "Restaurants", "provider"]
        : ["Spending", "Payments to people", "money movement"];
    for (const providerId of lines) {
      expect(await chosen(providerId)).toEqual(["Spending", "Childcare", "hand-set"]);
      expect(await chosen(`${providerId}-2`)).toEqual(unruled(providerId));
    }
  });

  it("makes a rule for a line that names a person, a shop, or a store", async () => {
    const line = (id: string, postedDate: string, description: string) =>
      buy(id, postedDate, { merchantName: null, description });
    await sync({
      added: [
        line("person", "2026-10-01", "VENMO *MORGAN LEE"),
        line("person-2", "2026-10-02", "VENMO *MORGAN LEE"),
        line("shop", "2026-10-03", "PAYPAL *ETSY SHOP"),
        line("shop-2", "2026-10-04", "PAYPAL *ETSY SHOP"),
        line("zelle-person", "2026-10-05", "ZELLE PAYMENT TO JOHN SMITH"),
        line("zelle-person-2", "2026-10-06", "ZELLE PAYMENT TO JOHN SMITH"),
        line("cashapp-person", "2026-10-07", "CASH APP*JOHN SMITH"),
        line("cashapp-person-2", "2026-10-08", "CASH APP*JOHN SMITH"),
        line("store", "2026-10-09", "PURCHASE 1005 BLUEBIRD BOOKS"),
        line("store-2", "2026-10-10", "PURCHASE 1005 BLUEBIRD BOOKS"),
        line("lead-in", "2026-10-11", "BEST BUY CO"),
        line("lead-in-2", "2026-10-12", "BEST BUY CO"),
      ],
    });

    const lines = ["person", "shop", "zelle-person", "cashapp-person", "store", "lead-in"];
    for (const providerId of lines) {
      expect(await correct(providerId, "Childcare")).toMatchObject({ rule: expect.any(Object) });
    }
    await runFollowUp(NOW);

    // The Zelle and Cash App lines name the same person, so they share one Merchant and one rule.
    expect(await rules()).toEqual([
      [null, "Best Buy Co", "Childcare"],
      [null, "Bluebird Books", "Childcare"],
      [null, "Etsy Shop", "Childcare"],
      [null, "John Smith", "Childcare"],
      [null, "Morgan Lee", "Childcare"],
    ]);
    for (const providerId of lines) {
      expect(await chosen(`${providerId}-2`)).toEqual(["Spending", "Childcare", "Category rule"]);
    }
  });

  it("answers not found for a hidden Transaction", async () => {
    await sync({ added: [buy("gone", "2026-10-01"), buy("kept", "2026-10-02")] });
    const gone = await idOf("gone");
    // The provider removes it, so it no longer shows.
    await sync({ removed: [{ id: "gone" }] });

    expect(
      await correctCategory(bank.database, gone, "Pets", {
        onlyThisTransaction: false,
        memberId: MEMBER,
      }),
    ).toEqual({ result: "not found" });
    await runFollowUp(NOW);
    expect(await rules()).toEqual([]);
    expect(await chosen("kept")).toEqual(["Spending", "Restaurants", "provider"]);
  });

  it("answers not found for an unknown ID, and not decided before Matching", async () => {
    bank.fake.addPages(BANK, { added: [buy("new", "2026-10-01")] });
    await syncConnection(connectionId, NOW);

    expect(await correct("new", "Pets")).toEqual({ result: "not decided" });
    expect(
      await correctCategory(bank.database, "no-such-id", "Pets", {
        onlyThisTransaction: false,
        memberId: MEMBER,
      }),
    ).toEqual({ result: "not found" });
    expect(await rules()).toEqual([]);
  });

  describe("on the Review list", () => {
    // A best guess: a low-confidence provider category, with no AI.
    const guessed = (id: string, postedDate: string, merchantName = "Corner Bistro") =>
      buy(id, postedDate, {
        merchantName,
        category: { name: "FOOD_AND_DRINK_COFFEE", confidence: "LOW", version: "v2", mcc: null },
      });
    const itemAbout = async (providerId: string) => {
      const id = await idOf(providerId);
      const items = await openReviewItems(bank.database);
      return items.find(
        (item) =>
          item.kind === BEST_GUESS_KIND &&
          item.subject.type === "transactions" &&
          item.subject.transactionIds.includes(id),
      );
    };

    it("makes a rule with the guess when a Member accepts it", async () => {
      await sync({ added: [guessed("a", "2026-10-01"), guessed("b", "2026-10-02")] });
      const item = await itemAbout("a");

      expect(await answerReviewItem(bank.database, item?.id ?? "", "Restaurants", MEMBER)).toBe(
        "answered",
      );
      await runFollowUp(NOW);

      expect(await rules()).toEqual([[null, "Corner Bistro", "Restaurants"]]);
      expect(await chosen("a")).toEqual(["Spending", "Restaurants", "hand-set"]);
      expect(await chosen("b")).toEqual(["Spending", "Restaurants", "Category rule"]);
      // The rule settled the other best guess.
      expect(await itemAbout("b")).toBeUndefined();
    });

    it("makes a rule for another Category, unless the Member picks only this Transaction", async () => {
      await sync({
        added: [
          guessed("a", "2026-10-01"),
          guessed("b", "2026-10-02"),
          guessed("c", "2026-10-03", "Green Grocer"),
          guessed("d", "2026-10-04", "Green Grocer"),
        ],
      });

      const a = await itemAbout("a");
      expect(await answerReviewItem(bank.database, a?.id ?? "", "Hobbies", MEMBER)).toBe(
        "answered",
      );
      const c = await itemAbout("c");
      expect(
        await answerReviewItem(
          bank.database,
          c?.id ?? "",
          "only this Transaction: Groceries",
          MEMBER,
        ),
      ).toBe("answered");
      await runFollowUp(NOW);

      expect(await rules()).toEqual([[null, "Corner Bistro", "Hobbies"]]);
      expect(await chosen("b")).toEqual(["Spending", "Hobbies", "Category rule"]);
      expect(await chosen("c")).toEqual(["Spending", "Groceries", "hand-set"]);
      expect(await chosen("d")).toEqual(["Spending", "Restaurants", "best guess"]);
    });

    it("settles 2,500 best guesses in one quick follow-up job", { timeout: 120_000 }, async () => {
      // 2,500 best guesses for the Merchant, while 2,500 more for another stay open.
      const day = (index: number) =>
        new Date(Date.UTC(2020, 0, 1 + (index % 1_500))).toISOString().slice(0, 10);
      const added = Array.from({ length: 5_000 }, (_, index) =>
        guessed(`g${index}`, day(index), index < 2_500 ? "Corner Bistro" : "Green Grocer"),
      );
      await sync({ added });
      expect((await openReviewItems(bank.database)).length).toBe(5_000);
      const first = await itemAbout("g0");
      await answerReviewItem(bank.database, first?.id ?? "", "Restaurants", MEMBER);

      const started = performance.now();
      await runFollowUp(NOW);
      const took = performance.now() - started;

      expect((await openReviewItems(bank.database)).length).toBe(2_500);
      expect(await chosen("g2499")).toEqual(["Spending", "Restaurants", "Category rule"]);
      // Settling one at a time, each reading every open item, took minutes.
      expect(took).toBeLessThan(5_000);
    });
  });
});
