import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedDemoHousehold } from "../bank/demo.ts";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { CATEGORIES } from "../categories/index.ts";
import { setHandSetFields, storeCategoryRule } from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { merchantKey } from "../merchants/index.ts";
import {
  addManualLoan,
  linkByHand,
  readTransactionDecision,
  setTransactionType,
  startMoneyMovement,
} from "../money-movement/index.ts";
import { answerReviewItem, openReviewItems, otherReviewChoices } from "../review/index.ts";
import { BEST_GUESS_KIND, startCategorization } from "./index.ts";

// The categorization cascade, as the Categorization follow-up step after Matching (spec 04, The
// categorization cascade, Provenance, Re-runs, Review list items). Transactions arrive through the
// fake adapter; the demo Household covers the whole history.

const NOW = () => new Date("2026-11-01T14:00:00.000Z");
const BANK = "fake-first-bank";
const CARD = fakeAccount({
  id: "acc-card",
  name: "Everyday Card",
  type: "credit",
  subtype: "credit card",
});

type PartRow = {
  part: number;
  type: string;
  category: string | null;
  source: string | null;
  confidence: string | null;
  needsAi: number;
};

describe("the categorization cascade", () => {
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
  const partsOf = async (providerId: string): Promise<PartRow[]> => {
    const rows = await bank.database.$client.execute({
      sql: `SELECT p.part, p.type, p.category, p.category_source AS source,
              p.category_confidence AS confidence, p.category_needs_ai AS needsAi
            FROM transaction_parts p JOIN transactions t ON t.id = p.transaction_id
            WHERE t.provider_transaction_id = ? AND t.hidden_reason IS NULL ORDER BY p.part`,
      args: [providerId],
    });
    return rows.rows.map((row) => ({ ...row }) as unknown as PartRow);
  };
  const chosen = async (providerId: string) => {
    const [part] = await partsOf(providerId);
    return part === undefined ? undefined : [part.category, part.source, part.confidence];
  };
  const guesses = async () =>
    (await openReviewItems(bank.database)).filter((item) => item.kind === BEST_GUESS_KIND);
  // Syncs pages into the test bank, then runs the follow-up job: Matching, then Categorization.
  const sync = async (...pages: Parameters<TestBank["fake"]["addPages"]>[1][]) => {
    bank.fake.addPages(BANK, ...pages);
    await syncConnection(connectionId, NOW);
    await runFollowUp(NOW);
  };
  // A stored Category rule for a Merchant with no Merchant ID.
  const addRule = (name: string, category: string) =>
    storeCategoryRule(
      bank.database,
      {
        merchantId: null,
        merchantName: name,
        merchantKey: merchantKey(name),
        category,
        madeAt: new Date(),
        madeBy: null,
      },
      [],
    );

  // A purchase on the card. The category is Plaid's detailed code with its confidence level.
  const buy = (
    id: string,
    postedDate: string,
    fields: { merchant?: string | null; code?: string; confidence?: string | null } = {},
  ): TxnRecord =>
    fakeTxn({
      id,
      accountId: CARD.id,
      amount: -2_500,
      postedDate,
      description: `CARD PURCHASE ${id.toUpperCase()}`,
      merchantName: fields.merchant === undefined ? "Corner Bistro" : fields.merchant,
      category:
        fields.code === undefined
          ? null
          : {
              name: fields.code,
              confidence: fields.confidence === undefined ? "HIGH" : fields.confidence,
              version: "v2",
              mcc: null,
            },
    });

  beforeEach(async () => {
    bank = await newTestBank();
    stops = [
      startMoneyMovement({ database: bank.database }).stop,
      startCategorization({ database: bank.database }).stop,
    ];
    connectionId = await bank.connect(BANK);
    bank.fake.addPages(BANK, { accounts: [CARD] });
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  describe("on the demo Household", () => {
    it("gives every Spending Transaction one Category, and stores the step and its confidence", async () => {
      await seedDemoHousehold(bank.database, bank.fake, NOW);
      await runFollowUp(NOW);

      const rows = await bank.database.$client.execute(
        `SELECT p.category, p.category_source AS source, p.category_confidence AS confidence,
           p.category_needs_ai AS needsAi, count(*) AS n
         FROM transaction_parts p JOIN transactions t ON t.id = p.transaction_id
         WHERE p.type = 'Spending' AND t.hidden_reason IS NULL
         GROUP BY 1, 2, 3, 4`,
      );
      const found = rows.rows.map((row) => ({ ...row }));
      expect(found.every((row) => row.category !== null && row.source !== null)).toBe(true);
      const bySource = new Map<unknown, number>();
      for (const row of found)
        bySource.set(row.source, (bySource.get(row.source) ?? 0) + Number(row.n));
      // With no AI, the cascade answers at steps 3, 4, and 6. Money movement names Cash and
      // Payments to people.
      expect([...bySource.keys()].sort()).toEqual([
        "Merchant history",
        "best guess",
        "money movement",
        "provider",
      ]);
      for (const row of found) {
        if (row.source === "money movement") {
          expect(["Cash", "Payments to people"]).toContain(row.category);
          expect(row.confidence).toBe("certain");
        }
        if (row.source === "provider") expect(["very high", "high"]).toContain(row.confidence);
        if (row.source === "Merchant history") expect(row.confidence).toBe("high");
        if (row.source === "best guess") expect([row.confidence, row.needsAi]).toEqual(["low", 1]);
      }
      // Each best guess is on the Review list once.
      expect((await guesses()).length).toBe(bySource.get("best guess"));
    });
  });

  describe("steps 3 and 4", () => {
    it("takes a provider category that maps cleanly at VERY_HIGH or HIGH", async () => {
      await sync({
        added: [
          buy("very-high", "2026-10-01", {
            code: "FOOD_AND_DRINK_RESTAURANT",
            confidence: "VERY_HIGH",
          }),
          buy("high", "2026-10-02", { merchant: "Green Grocer", code: "FOOD_AND_DRINK_GROCERIES" }),
        ],
      });

      expect(await chosen("very-high")).toEqual(["Restaurants", "provider", "very high"]);
      expect(await chosen("high")).toEqual(["Groceries", "provider", "high"]);
      expect(await guesses()).toEqual([]);
    });

    it("sends a lossy code on down the cascade, even at VERY_HIGH", async () => {
      const lossy = { code: "GENERAL_MERCHANDISE_DEPARTMENT_STORES", confidence: "VERY_HIGH" };
      await sync({ added: [buy("lossy", "2026-10-01", { merchant: "Hartley's", ...lossy })] });

      expect(await chosen("lossy")).toEqual(["General goods", "best guess", "low"]);
    });

    it("counts UNKNOWN as LOW, and a category with no confidence level as a hint only", async () => {
      await sync({
        added: [
          buy("unknown", "2026-10-01", {
            code: "FOOD_AND_DRINK_RESTAURANT",
            confidence: "UNKNOWN",
          }),
          buy("no-level", "2026-10-02", {
            merchant: "Lakeside Diner",
            code: "FOOD_AND_DRINK_RESTAURANT",
            confidence: null,
          }),
        ],
      });

      expect(await chosen("unknown")).toEqual(["Restaurants", "best guess", "low"]);
      // A hint only: the best guess passes over it to Miscellaneous.
      expect(await chosen("no-level")).toEqual(["Miscellaneous", "best guess", "low"]);
    });

    it("takes the Merchant's last 3 Spending Transactions' Category, built in date order", async () => {
      // One page, newest first: the cascade still works through them oldest first.
      await sync({
        added: [
          buy("fourth", "2026-10-04", {
            code: "GENERAL_MERCHANDISE_DEPARTMENT_STORES",
            confidence: "MEDIUM",
          }),
          buy("third", "2026-10-03", { code: "FOOD_AND_DRINK_RESTAURANT" }),
          buy("second", "2026-10-02", {
            code: "FOOD_AND_DRINK_RESTAURANT",
            confidence: "VERY_HIGH",
          }),
          buy("first", "2026-10-01", { code: "FOOD_AND_DRINK_RESTAURANT" }),
        ],
      });

      expect(await chosen("fourth")).toEqual(["Restaurants", "Merchant history", "high"]);
    });

    it("gives no answer from fewer than 3, from a best guess, or from Categories that differ", async () => {
      await sync({
        added: [
          // Fewer than 3.
          buy("a1", "2026-10-01", { merchant: "Alpha", code: "FOOD_AND_DRINK_RESTAURANT" }),
          buy("a2", "2026-10-02", { merchant: "Alpha", code: "FOOD_AND_DRINK_RESTAURANT" }),
          buy("a3", "2026-10-03", {
            merchant: "Alpha",
            confidence: "LOW",
            code: "FOOD_AND_DRINK_COFFEE",
          }),
          // 3 best guesses, each Restaurants.
          ...["b1", "b2", "b3"].map((id, day) =>
            buy(id, `2026-10-0${day + 1}`, {
              merchant: "Beta",
              code: "FOOD_AND_DRINK_RESTAURANT",
              confidence: "LOW",
            }),
          ),
          buy("b4", "2026-10-05", {
            merchant: "Beta",
            code: "FOOD_AND_DRINK_GROCERIES",
            confidence: "MEDIUM",
          }),
          // 3 that differ.
          buy("c1", "2026-10-01", { merchant: "Gamma", code: "FOOD_AND_DRINK_RESTAURANT" }),
          buy("c2", "2026-10-02", { merchant: "Gamma", code: "FOOD_AND_DRINK_GROCERIES" }),
          buy("c3", "2026-10-03", { merchant: "Gamma", code: "FOOD_AND_DRINK_RESTAURANT" }),
          buy("c4", "2026-10-04", {
            merchant: "Gamma",
            code: "FOOD_AND_DRINK_COFFEE",
            confidence: "LOW",
          }),
        ],
      });

      expect(await chosen("a3")).toEqual(["Restaurants", "best guess", "low"]);
      expect(await chosen("b4")).toEqual(["Groceries", "best guess", "low"]);
      expect(await chosen("c4")).toEqual(["Restaurants", "best guess", "low"]);
    });
  });

  describe("step 6, the best guess", () => {
    it("falls back to the provider's Category, then the Merchant's most recent one, then Miscellaneous", async () => {
      await sync({
        added: [
          buy("earlier", "2026-10-01", { merchant: "Delta", code: "FOOD_AND_DRINK_GROCERIES" }),
          buy("provider", "2026-10-02", {
            merchant: "Delta",
            code: "FOOD_AND_DRINK_RESTAURANT",
            confidence: "LOW",
          }),
          buy("recent", "2026-10-03", { merchant: "Delta" }),
          buy("nothing", "2026-10-04", { merchant: "Nowhere Co" }),
          buy("no-merchant", "2026-10-05", { merchant: null }),
        ],
      });

      expect(await partsOf("provider")).toEqual([
        {
          part: 0,
          type: "Spending",
          category: "Restaurants",
          source: "best guess",
          confidence: "low",
          needsAi: 1,
        },
      ]);
      // The Merchant's most recent Category before this one, a best guess included.
      expect(await chosen("recent")).toEqual(["Restaurants", "best guess", "low"]);
      expect(await chosen("nothing")).toEqual(["Miscellaneous", "best guess", "low"]);
    });

    it("puts each best guess on the Review list, with the Category list behind Not this", async () => {
      await sync({
        added: [
          buy("guess", "2026-10-01", { code: "FOOD_AND_DRINK_COFFEE", confidence: "MEDIUM" }),
        ],
      });
      const [item] = await guesses();

      expect(item).toMatchObject({
        subject: { type: "transactions", transactionIds: [await idOf("guess")] },
        decided: "No AI was available, so the app guessed Restaurants.",
        bestAnswer: { value: "Restaurants", label: "Yes, Restaurants" },
      });
      const choices = await otherReviewChoices(bank.database, item?.id ?? "");
      // Each Category makes a rule; each one for only this Transaction makes none.
      expect(choices?.map((choice) => choice.value)).toEqual([
        ...CATEGORIES.map((c) => c.name),
        ...CATEGORIES.map((c) => `only this Transaction: ${c.name}`),
      ]);

      // A second run keeps one item.
      await sync({
        changed: [buy("guess", "2026-10-01", { code: "FOOD_AND_DRINK_COFFEE", confidence: "LOW" })],
      });
      expect(await guesses()).toHaveLength(1);
    });

    it("makes a Member's answer the hand-set Category, which every re-run keeps", async () => {
      await sync({
        added: [
          buy("guess", "2026-10-01", { code: "FOOD_AND_DRINK_COFFEE", confidence: "MEDIUM" }),
        ],
      });
      const [item] = await guesses();
      await bank.database.$client.execute(
        `INSERT INTO members (id, name, email, created_at, updated_at)
         VALUES ('member-1', 'Jamie', 'jamie@example.com', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
      );

      expect(await answerReviewItem(bank.database, item?.id ?? "", "Groceries", "member-1")).toBe(
        "answered",
      );
      // The answer asks for a follow-up job, which runs the cascade again.
      expect(bank.followUpsAsked()).toBe(1);
      await runFollowUp(NOW);
      expect(await partsOf("guess")).toEqual([
        {
          part: 0,
          type: "Spending",
          category: "Groceries",
          source: "hand-set",
          confidence: "certain",
          needsAi: 0,
        },
      ]);
      expect(await guesses()).toEqual([]);

      // A provider change runs the cascade again, and step 1 still wins.
      await sync({
        changed: [
          buy("guess", "2026-10-01", {
            code: "FOOD_AND_DRINK_RESTAURANT",
            confidence: "VERY_HIGH",
          }),
        ],
      });
      expect(await chosen("guess")).toEqual(["Groceries", "hand-set", "certain"]);
    });

    it("takes the item off the Review list when a provider change settles the Category", async () => {
      await sync({
        added: [
          buy("guess", "2026-10-01", { code: "FOOD_AND_DRINK_COFFEE", confidence: "MEDIUM" }),
        ],
      });
      expect(await guesses()).toHaveLength(1);

      await sync({
        changed: [
          buy("guess", "2026-10-01", { code: "FOOD_AND_DRINK_GROCERIES", confidence: "HIGH" }),
        ],
      });

      expect(await chosen("guess")).toEqual(["Groceries", "provider", "high"]);
      expect(await guesses()).toEqual([]);
    });
  });

  describe("registered steps", () => {
    // Step 5, the AI, is in quick-tier.test.ts.
    it("lets a Category rule win over the provider", async () => {
      await addRule("Ruled Co", "Hobbies");

      await sync({
        added: [
          buy("ruled", "2026-10-01", {
            merchant: "Ruled Co",
            code: "FOOD_AND_DRINK_RESTAURANT",
            confidence: "VERY_HIGH",
          }),
        ],
      });

      expect(await chosen("ruled")).toEqual(["Hobbies", "Category rule", "certain"]);
      expect(await guesses()).toEqual([]);
    });
  });

  describe("Categories that Money movement names", () => {
    // A cash withdrawal, which Money movement puts in Cash at step 5.3.
    const cash = (id: string, merchant: string) =>
      fakeTxn({
        id,
        accountId: CARD.id,
        amount: -6_000,
        description: `ATM WITHDRAWAL ${id}`,
        merchantName: merchant,
        category: {
          name: "TRANSFER_OUT_WITHDRAWAL",
          confidence: "VERY_HIGH",
          version: "v2",
          mcc: null,
        },
      });

    beforeEach(async () => {
      await addRule("Ruled Lender", "Services");
      await addRule("Ruled ATM", "Services");
    });

    it("takes the place of steps 3 to 6, while a Category rule still wins", async () => {
      await sync({ added: [cash("atm", "Main Street ATM"), cash("ruled-atm", "Ruled ATM")] });

      expect(await chosen("atm")).toEqual(["Cash", "money movement", "certain"]);
      expect(await chosen("ruled-atm")).toEqual(["Services", "Category rule", "certain"]);
    });

    it("keeps a tracked loan payment's parts in Money movement's Categories, except by hand", async () => {
      const loan = fakeTxn({
        id: "loan",
        accountId: CARD.id,
        amount: -45_000,
        description: "LOAN PMT",
        merchantName: "Ruled Lender",
      });
      await sync({ added: [loan] });
      // A tracked loan payment: interest, then the principal of a Cash loan.
      await bank.database.$client.execute(
        `INSERT INTO members (id, name, email, created_at, updated_at)
         VALUES ('member-1', 'Jamie', 'jamie@example.com', '2026-10-01T00:00:00.000Z',
           '2026-10-01T00:00:00.000Z')`,
      );
      const personal = await addManualLoan(
        bank.database,
        {
          lender: "Ruled Lender",
          kind: "personal",
          balance: 1_000_000,
          balanceDate: "2026-09-01",
          apr: 7.3,
          regularPayment: null,
          escrow: null,
          loanType: null,
        },
        "member-1",
      );
      const linked = await linkByHand(
        bank.database,
        { kind: "loan", transactionId: await idOf("loan"), loanAccountId: personal.id },
        "member-1",
        NOW(),
      );
      expect(linked.outcome).toBe("linked");
      await runFollowUp(NOW);

      expect(await partsOf("loan")).toEqual([
        {
          part: 0,
          type: "Spending",
          category: "Interest and fees",
          source: "money movement",
          confidence: "certain",
          needsAi: 0,
        },
        { part: 1, type: "Transfer", category: null, source: null, confidence: null, needsAi: 0 },
      ]);

      // A hand edit is the only change.
      await setHandSetFields(bank.database, await idOf("loan"), { category: "Housing" });
      await sync({ changed: [{ ...loan, description: "LOAN PMT 2" }] });
      expect(await chosen("loan")).toEqual(["Housing", "hand-set", "certain"]);
    });
  });

  describe("Refunds", () => {
    it("runs an unlinked Refund through the cascade as if it were Spending, and leaves a linked one", async () => {
      // The linked Refund has a purchase at its Merchant; the unlinked one's Merchant has none.
      const refund = (id: string, merchant: string): TxnRecord => ({
        ...buy(id, "2026-10-05", { merchant, code: "FOOD_AND_DRINK_RESTAURANT" }),
        amount: 2_500,
        description: "REFUND",
      });

      await sync({
        added: [
          buy("purchase", "2026-10-01", {
            merchant: "Shoe Barn",
            code: "GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES",
          }),
          refund("unlinked", "Corner Bistro"),
          refund("linked", "Shoe Barn"),
        ],
      });

      expect(await partsOf("unlinked")).toMatchObject([
        { type: "Refund", category: "Restaurants", source: "provider", confidence: "high" },
      ]);
      // The linked part has no Category of its own: it counts with its purchase's.
      expect(await partsOf("linked")).toMatchObject([
        { type: "Refund", category: null, source: null, confidence: null },
      ]);
      expect((await readTransactionDecision(bank.database, await idOf("linked")))?.parts).toEqual([
        { type: "Refund", amount: 2_500, category: "Clothing", linked: true },
      ]);
    });
  });

  describe("re-runs", () => {
    it("runs the cascade again on a provider change", async () => {
      await sync({ added: [buy("txn", "2026-10-01", { code: "FOOD_AND_DRINK_GROCERIES" })] });
      expect(await chosen("txn")).toEqual(["Groceries", "provider", "high"]);

      await sync({
        changed: [
          buy("txn", "2026-10-01", { code: "FOOD_AND_DRINK_RESTAURANT", confidence: "VERY_HIGH" }),
        ],
      });

      expect(await chosen("txn")).toEqual(["Restaurants", "provider", "very high"]);
    });

    it("carries a pending Transaction's Category over when it posts", async () => {
      const held = {
        ...buy("held", "2026-10-28", { code: "FOOD_AND_DRINK_RESTAURANT" }),
        pending: true,
      };
      await sync({ added: [held] });
      expect(await chosen("held")).toEqual(["Restaurants", "provider", "high"]);

      // The posted record has a tip and a different provider category.
      await sync({
        added: [
          {
            ...buy("posted", "2026-10-30", {
              code: "FOOD_AND_DRINK_GROCERIES",
              confidence: "VERY_HIGH",
            }),
            amount: -3_000,
            pendingTransactionId: "held",
          },
        ],
        removed: [{ id: "held" }],
      });

      expect(await chosen("posted")).toEqual(["Restaurants", "provider", "high"]);
    });

    it("chooses a Category when a Member sets the type to Spending, and drops it for a Transfer", async () => {
      const income = fakeTxn({
        id: "in",
        accountId: CARD.id,
        amount: 5_000,
        merchantName: "Corner Bistro",
      });
      await sync({ added: [income] });
      expect(await partsOf("in")).toMatchObject([{ type: "Income", category: null, source: null }]);

      await setTransactionType(bank.database, await idOf("in"), "Spending");
      await runFollowUp(NOW);
      expect(await chosen("in")).toEqual(["Miscellaneous", "best guess", "low"]);
      expect(await guesses()).toHaveLength(1);

      await setTransactionType(bank.database, await idOf("in"), "Transfer");
      await runFollowUp(NOW);
      expect(await partsOf("in")).toMatchObject([
        { type: "Transfer", category: null, source: null },
      ]);
      expect(await guesses()).toEqual([]);
    });
  });
});
