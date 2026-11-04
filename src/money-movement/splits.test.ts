import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { readDraftTerms } from "../budgets/index.ts";
import { correctCategory, startCategorization } from "../categorization/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import {
  linkByHand,
  readTransactionDecision,
  removeSplit,
  type SplitPart,
  setTransactionType,
  splitTransaction,
  startMoneyMovement,
  totalsByMonth,
  undoLink,
} from "./index.ts";

// Splits (spec 04, Splits; spec 03, Refunds for split purchases), through the Matching and
// Categorization follow-up steps on Transactions the fake adapter syncs.

const NOW = () => new Date("2026-11-20T14:00:00.000Z");
const BANK = "fake-first-bank";
const CARD = "acc-card";
const CHECKING = "acc-checking";
const MEMBER = "member-1";
const code = (name: string) => ({ name, confidence: "HIGH", version: "v2", mcc: null });
const MERCHANDISE = "GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE";

// $80 Groceries and $40 Clothing, in whole cents spent.
const GROCERIES_AND_CLOTHING: SplitPart[] = [
  { amount: 8_000, category: "Groceries" },
  { amount: 4_000, category: "Clothing" },
];

describe("Splits", () => {
  let bank: TestBank;
  let stops: (() => void)[];
  let connectionId: string;

  const sync = async (page: { added?: TxnRecord[]; changed?: TxnRecord[] }) => {
    bank.fake.addPages(BANK, {
      accounts: [
        fakeAccount({ id: CARD, type: "credit", subtype: "credit card", mask: "1111" }),
        fakeAccount({ id: CHECKING, mask: "3333" }),
      ],
      added: page.added ?? [],
      changed: page.changed ?? [],
      removed: [],
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
  // A purchase at Target, money out, or a Refund from it, money in.
  const target = (
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
      description: "TARGET",
      merchantName: "Target",
      category: code(MERCHANDISE),
      ...fields,
    });
  const purchase = target("purchase", -12_000, "2026-10-01");
  const split = async (providerId: string, parts: SplitPart[] = GROCERIES_AND_CLOTHING) => {
    const result = await splitTransaction(bank.database, await idOf(providerId), parts, NOW());
    await runFollowUp(NOW);
    return result;
  };
  const month = async (name: string) =>
    (await totalsByMonth(bank.database)).find((totals) => totals.month === name);
  const decisionOf = async (providerId: string) =>
    readTransactionDecision(bank.database, await idOf(providerId));
  // Each stored part's Category and how it was chosen.
  const provenance = async (providerId: string) =>
    (
      await bank.database.$client.execute({
        sql: `SELECT amount, category, category_source AS source FROM transaction_parts
              WHERE transaction_id = ? ORDER BY part`,
        args: [await idOf(providerId)],
      })
    ).rows.map((row) => ({ ...row }));
  const handSet = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT hand_set FROM transactions WHERE provider_transaction_id = ?",
      args: [providerId],
    });
    return JSON.parse(String(rows.rows[0]?.hand_set));
  };
  const rules = async () =>
    (await bank.database.$client.execute("SELECT * FROM category_rules")).rows.length;

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

  it("counts each part in its own Category and the Transaction's month, and a $30 Refund reduces Groceries by $20 and Clothing by $10", async () => {
    await sync({ added: [purchase] });
    expect(await month("2026-10")).toMatchObject({
      spending: 12_000,
      byCategory: { Superstores: 12_000 },
    });

    expect(await split("purchase")).toEqual({
      outcome: "split",
      decision: {
        step: "5.7",
        provisionalUntil: null,
        parts: [
          {
            type: "Spending",
            amount: -8_000,
            category: "Groceries",
            categorySource: "hand-set",
            categoryConfidence: "certain",
          },
          {
            type: "Spending",
            amount: -4_000,
            category: "Clothing",
            categorySource: "hand-set",
            categoryConfidence: "certain",
          },
        ],
      },
    });
    expect(await provenance("purchase")).toEqual([
      { amount: -8_000, category: "Groceries", source: "hand-set" },
      { amount: -4_000, category: "Clothing", source: "hand-set" },
    ]);
    expect(await month("2026-10")).toEqual(
      expect.objectContaining({
        spending: 12_000,
        byCategory: { Groceries: 8_000, Clothing: 4_000 },
      }),
    );
    // A split part makes no Category rule.
    expect(await rules()).toBe(0);

    await sync({ added: [target("refund", 3_000, "2026-11-02")] });

    expect(await decisionOf("refund")).toMatchObject({
      step: "6.4",
      parts: [{ type: "Refund", amount: 3_000, linked: true }],
    });
    expect(await month("2026-10")).toMatchObject({
      spending: 9_000,
      byCategory: { Groceries: 6_000, Clothing: 3_000 },
    });
    expect(await month("2026-11")).toBeUndefined();
    // Budgets read the same parts: October is the history window for November's draft.
    const { n, categories } = await readDraftTerms(bank.database, "2026-11", NOW());
    expect(n).toBe(1);
    expect([
      categories.Groceries.spent,
      categories.Clothing.spent,
      categories.Superstores.spent,
    ]).toEqual([6_000, 3_000, 0]);
  });

  it("reduces the parts in proportion for a Reimbursement, and keeps a hand-made link through a split and its removal", async () => {
    await sync({
      added: [
        purchase,
        fakeTxn({
          id: "payback",
          accountId: CHECKING,
          amount: 6_000,
          postedDate: "2026-10-09",
          description: "MOBILE DEPOSIT",
          merchantName: null,
        }),
      ],
    });
    const linked = await linkByHand(
      bank.database,
      {
        kind: "Reimbursement",
        transactionId: await idOf("payback"),
        spendingTransactionId: await idOf("purchase"),
      },
      MEMBER,
      NOW(),
    );
    expect(linked.outcome).toBe("linked");
    await runFollowUp(NOW);
    expect(await month("2026-10")).toMatchObject({
      spending: 6_000,
      income: 0,
      byCategory: { Superstores: 6_000 },
    });

    await split("purchase");

    // $60 back: $40 off Groceries and $20 off Clothing.
    expect(await month("2026-10")).toMatchObject({
      spending: 6_000,
      income: 0,
      byCategory: { Groceries: 4_000, Clothing: 2_000 },
    });
    const links = async () =>
      (await bank.database.$client.execute("SELECT made_by FROM spending_links")).rows.map(
        (row) => row.made_by,
      );
    expect(await links()).toEqual(["Member"]);

    expect(await removeSplit(bank.database, await idOf("purchase"))).toBe(true);
    await runFollowUp(NOW);

    expect(await links()).toEqual(["Member"]);
    expect(await month("2026-10")).toMatchObject({
      spending: 6_000,
      income: 0,
      byCategory: { Superstores: 6_000 },
    });
    if (linked.outcome === "linked") {
      expect(await undoLink(bank.database, linked.linkId, MEMBER)).toBe(true);
    }
  });

  it("scales each part in proportion when the provider changes the amount", async () => {
    await sync({ added: [purchase] });
    await split("purchase");

    await sync({ changed: [{ ...purchase, amount: -15_000 }] });

    expect(await provenance("purchase")).toEqual([
      { amount: -10_000, category: "Groceries", source: "hand-set" },
      { amount: -5_000, category: "Clothing", source: "hand-set" },
    ]);

    // A cent left over goes to the part with the larger remainder.
    await sync({ changed: [{ ...purchase, amount: -12_001 }] });

    expect(await provenance("purchase")).toEqual([
      { amount: -8_001, category: "Groceries", source: "hand-set" },
      { amount: -4_000, category: "Clothing", source: "hand-set" },
    ]);
    // The split the Member made stays as typed.
    expect((await handSet("purchase")).split).toEqual(GROCERIES_AND_CLOTHING);
  });

  it("never lets the cascade change a split, and sends the Transaction back to the cascade when the split is removed", async () => {
    await sync({ added: [purchase, target("later", -2_000, "2026-10-20")] });
    await split("purchase");

    // A Category rule for Target, from a Member's correction on another Target purchase.
    await correctCategory(bank.database, await idOf("later"), "General goods", {
      onlyThisTransaction: false,
      memberId: MEMBER,
    });
    await runFollowUp(NOW);

    expect(await rules()).toBe(1);
    expect(await provenance("purchase")).toEqual([
      { amount: -8_000, category: "Groceries", source: "hand-set" },
      { amount: -4_000, category: "Clothing", source: "hand-set" },
    ]);

    expect(await removeSplit(bank.database, await idOf("purchase"))).toBe(true);
    await runFollowUp(NOW);

    expect(await provenance("purchase")).toEqual([
      { amount: -12_000, category: "General goods", source: "Category rule" },
    ]);
    expect(await handSet("purchase")).toEqual({});
    expect(await removeSplit(bank.database, await idOf("purchase"))).toBe(false);
  });

  it("ends the split when a Member gives the whole Transaction one Category", async () => {
    await sync({ added: [purchase] });
    await split("purchase");

    await correctCategory(bank.database, await idOf("purchase"), "Gifts and donations", {
      onlyThisTransaction: true,
      memberId: MEMBER,
    });
    await runFollowUp(NOW);

    expect(await provenance("purchase")).toEqual([
      { amount: -12_000, category: "Gifts and donations", source: "hand-set" },
    ]);
    expect(await handSet("purchase")).toEqual({ category: "Gifts and donations" });
  });

  it("refuses a split on money in, a Transfer, a hidden Transaction, or parts that do not add up, and changes nothing", async () => {
    await sync({
      added: [
        purchase,
        target("refund", 3_000, "2026-11-02"),
        target("moved", -5_000, "2026-10-07", { description: "PAYMENT", merchantName: null }),
        target("gone", -6_000, "2026-10-08"),
        target("credit", 2_000, "2026-10-09"),
      ],
    });
    await setTransactionType(bank.database, await idOf("moved"), "Transfer");
    // Money in that a Member made Spending by hand.
    await setTransactionType(bank.database, await idOf("credit"), "Spending");
    await runFollowUp(NOW);
    // The provider removed a split Transaction.
    await split("gone", [
      { amount: 3_000, category: "Groceries" },
      { amount: 3_000, category: "Clothing" },
    ]);
    await bank.database.$client.execute(
      "UPDATE transactions SET hidden_reason = 'removed by provider' WHERE provider_transaction_id = 'gone'",
    );
    const before = await bank.database.$client.execute("SELECT * FROM transactions ORDER BY id");

    expect(
      await split("refund", [
        { amount: 1_500, category: "Groceries" },
        { amount: 1_500, category: "Clothing" },
      ]),
    ).toEqual({ outcome: "not Spending" });
    expect(
      await split("gone", [
        { amount: 3_000, category: "Groceries" },
        { amount: 3_000, category: "Clothing" },
      ]),
    ).toEqual({ outcome: "not found" });
    expect(
      await split("moved", [
        { amount: 2_500, category: "Groceries" },
        { amount: 2_500, category: "Clothing" },
      ]),
    ).toEqual({ outcome: "not Spending" });
    expect(
      await split("purchase", [
        { amount: 8_000, category: "Groceries" },
        { amount: 3_999, category: "Clothing" },
      ]),
    ).toEqual({ outcome: "wrong total" });
    expect(
      await split("credit", [
        { amount: 1_000, category: "Groceries" },
        { amount: 1_000, category: "Clothing" },
      ]),
    ).toEqual({ outcome: "not Spending" });
    expect(await split("nothing")).toEqual({ outcome: "not found" });
    expect(await removeSplit(bank.database, await idOf("gone"))).toBe(false);

    const after = await bank.database.$client.execute("SELECT * FROM transactions ORDER BY id");
    expect(after.rows).toEqual(before.rows);
    expect(await provenance("purchase")).toEqual([
      { amount: -12_000, category: "Superstores", source: "provider" },
    ]);
  });
});
