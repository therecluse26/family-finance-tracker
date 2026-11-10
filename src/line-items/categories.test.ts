import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AiGates, aiCost, aiSettings, householdAi, RETRY_DELAYS_MS } from "../ai/index.ts";
import { newAiKey, type StubMessage, StubModels } from "../ai/testing.ts";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { startCategorization, transactionStepCategory } from "../categorization/index.ts";
import {
  deleteLineItemData,
  readAiRetry,
  setHandSetCategory,
  storeLineItemChoices,
  storeLineItemParts,
} from "../db/index.ts";
import { followUpAgain, runFollowUp } from "../follow-up/index.ts";
import {
  removeSplit,
  setTransactionType,
  splitTransaction,
  startMoneyMovement,
} from "../money-movement/index.ts";
import { runRedo, startRedo } from "../redo/index.ts";
import { answerReviewItem, openReviewItems } from "../review/index.ts";
import {
  changeLineItemCategory,
  deleteLineItemRule,
  LINE_ITEM_CATEGORY_KIND,
  LINE_ITEM_CATEGORY_TASK,
  lineItemCategoriesSettled,
  registerLineItemsRemoved,
  startLineItemCategories,
} from "./index.ts";
import { addTestLineItems, type TestLineItem } from "./testing.ts";

// Line item Categories, Item rules, and splits from Line items (spec 14; spec 04, step 1a).
// Transactions arrive through the fake adapter, Line items are made up, and the AI is AI SDK test
// models. No test calls an AI provider.

const NOW = () => new Date("2026-11-01T14:00:00.000Z");
const BANK = "fake-first-bank";
const CARD = fakeAccount({
  id: "acc-card",
  name: "Everyday Card",
  type: "credit",
  subtype: "credit card",
});
const PRICE = { input: 1_000_000, output: 2_000_000 };

type Row = Record<string, unknown> & { row: number };
type PartRow = { amount: number; category: string | null; source: string | null };
type ItemRow = {
  id: string;
  category: string | null;
  source: string | null;
  confidence: string | null;
  needsAi: number;
};

describe("Line item Categories and splits from Line items", () => {
  let bank: TestBank;
  let stub: StubModels;
  let stops: (() => void)[];
  let connectionId: string;
  // The rows of each Line item Category call, as the model read them.
  let asked: Row[][];
  let answerItem: (row: Row) => { category: string; confidence: string };

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
  const connectAi = async () => {
    const saved = await aiSettings(aiOptions()).save({
      provider: "anthropic",
      apiKey: newAiKey(),
      baseUrl: null,
      quickModel: "quick-model",
      writerModel: "writer-model",
      prices: { quick: PRICE, writer: PRICE },
    });
    expect(saved).toMatchObject({ saved: true });
    asked = [];
  };

  const readRows = (messages: StubMessage[]): Row[] | undefined => {
    const texts = messages
      .filter((message) => message.role === "user")
      .flatMap((message) =>
        typeof message.content === "string"
          ? [message.content]
          : message.content.flatMap((part) => (part.text === undefined ? [] : [part.text])),
      );
    if (!texts.includes(LINE_ITEM_CATEGORY_TASK)) return undefined;
    return texts.filter((text) => text.startsWith("{")).map((text) => JSON.parse(text) as Row);
  };

  const sql = async (text: string, args: (string | number | null)[] = []) =>
    (await bank.database.$client.execute({ sql: text, args })).rows;
  const idOf = async (providerId: string) =>
    String(
      (
        await sql(
          "SELECT id FROM transactions WHERE provider_transaction_id = ? AND hidden_reason IS NULL",
          [providerId],
        )
      )[0]?.id,
    );
  const partsOf = async (providerId: string): Promise<PartRow[]> =>
    (await sql(
      `SELECT p.amount, p.category, p.category_source AS source FROM transaction_parts p
       JOIN transactions t ON t.id = p.transaction_id
       WHERE t.provider_transaction_id = ? AND t.hidden_reason IS NULL ORDER BY p.part`,
      [providerId],
    )) as unknown as PartRow[];
  const itemsOf = async (): Promise<ItemRow[]> =>
    (await sql(
      `SELECT id, category, category_source AS source, category_confidence AS confidence,
         category_needs_ai AS needsAi FROM line_items ORDER BY id`,
    )) as unknown as ItemRow[];
  const itemOf = async (id: string) => (await itemsOf()).find((item) => item.id === id);
  const rules = async () =>
    sql("SELECT product_id, clean_name, category, made_by FROM item_rules ORDER BY product_key");
  // A made-up Member, for the Item rules a Member makes.
  const memberId = async () => {
    await sql(
      `INSERT OR IGNORE INTO members (id, name, email, created_at, updated_at) VALUES
       ('m1', 'Test Member', 'member@example.com', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    );
    return "m1";
  };
  const cards = async () =>
    (await openReviewItems(bank.database)).filter((item) => item.kind === LINE_ITEM_CATEGORY_KIND);

  // A card purchase at Amazon, which the provider puts in a marketplace category.
  const buy = (id: string, amount: number, fields: Partial<TxnRecord> = {}): TxnRecord =>
    fakeTxn({
      id,
      accountId: CARD.id,
      amount,
      postedDate: "2026-05-03",
      description: `AMAZON MKTPL*${id.toUpperCase()}`,
      merchantName: "Amazon",
      ...fields,
    });
  const sync = async (...added: TxnRecord[]) => {
    bank.fake.addPages(BANK, { added });
    await syncConnection(connectionId, NOW);
    return runFollowUp(NOW);
  };
  // Links made-up Line items to the Transaction, as linking does, and sends it down the steps.
  const link = async (
    providerId: string,
    items: readonly Omit<TestLineItem, "transactionId">[],
  ) => {
    const transactionId = await idOf(providerId);
    await addTestLineItems(
      bank.database,
      items.map((item) => ({ ...item, transactionId })),
    );
    await followUpAgain(bank.database, [transactionId]);
    return runFollowUp(NOW);
  };
  const again = async (providerId: string) => {
    await followUpAgain(bank.database, [await idOf(providerId)]);
    return runFollowUp(NOW);
  };

  let ai: ReturnType<typeof householdAi> | undefined;
  const start = async (withAi: boolean) => {
    ai = withAi ? householdAi(aiOptions()) : undefined;
    stops.push(
      startMoneyMovement({ database: bank.database }).stop,
      startCategorization({ database: bank.database, ...(ai === undefined ? {} : { ai }) }).stop,
      startLineItemCategories({ database: bank.database, ...(ai === undefined ? {} : { ai }) })
        .stop,
    );
  };

  beforeEach(async () => {
    bank = await newTestBank();
    stub = new StubModels();
    asked = [];
    answerItem = () => ({ category: "Groceries", confidence: "high" });
    stub.replyTo = (messages) => {
      const rows = readRows(messages);
      if (rows === undefined) {
        // A Category fix for the Transaction itself.
        return JSON.stringify({ answers: [{ row: 1, category: "Clothing", confidence: "high" }] });
      }
      asked.push(rows);
      return JSON.stringify({ answers: rows.map((row) => ({ row: row.row, ...answerItem(row) })) });
    };
    stops = [];
    connectionId = await bank.connect(BANK);
    bank.fake.addPages(BANK, { accounts: [CARD] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await lineItemCategoriesSettled();
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  describe("cascade step 1a", () => {
    beforeEach(() => start(false));

    it("splits a Spending Transaction by its Line items' Categories: $65.40 for $40.00 and $20.00 is $43.60 and $21.80, with no Category rule", async () => {
      await sync(buy("t-split", -6_540));
      await link("t-split", [
        { id: "1", total: 4_000, category: "Groceries", categorySource: "hand-set" },
        { id: "2", total: 2_000, category: "Home and garden", categorySource: "Item rule" },
      ]);

      expect(await partsOf("t-split")).toEqual([
        { amount: -4_360, category: "Groceries", source: "Line items" },
        { amount: -2_180, category: "Home and garden", source: "Line items" },
      ]);
      expect(await sql("SELECT * FROM category_rules")).toEqual([]);
      // Making the parts again changes nothing.
      await again("t-split");
      expect((await partsOf("t-split")).map((part) => part.amount)).toEqual([-4_360, -2_180]);
    });

    it("gives the Transaction the one Category its Line items share, with no split", async () => {
      await sync(buy("t-one", -2_700));
      await link("t-one", [
        { id: "1", total: 1_200, category: "Pets", categorySource: "hand-set" },
        {
          id: "2",
          total: 1_300,
          category: "Pets",
          categorySource: "AI",
          categoryConfidence: "high",
        },
      ]);

      expect(await partsOf("t-one")).toEqual([
        { amount: -2_700, category: "Pets", source: "Line items" },
      ]);
    });

    it("lets a hand-set Category and a hand split win, and answers again once the hand split goes", async () => {
      await sync(buy("t-hand", -3_000), buy("t-hand-split", -3_000));
      const items = (prefix: string) => [
        {
          id: `${prefix}1`,
          total: 1_000,
          category: "Groceries",
          categorySource: "hand-set" as const,
        },
        { id: `${prefix}2`, total: 2_000, category: "Pets", categorySource: "hand-set" as const },
      ];
      await setHandSetCategory(bank.database, [await idOf("t-hand")], "Clothing");
      await link("t-hand", items("a"));
      expect(await partsOf("t-hand")).toEqual([
        { amount: -3_000, category: "Clothing", source: "hand-set" },
      ]);

      const split = [
        { amount: 500, category: "Hobbies" as const },
        { amount: 2_500, category: "Gifts and donations" as const },
      ];
      expect(
        await splitTransaction(bank.database, await idOf("t-hand-split"), split),
      ).toMatchObject({
        outcome: "split",
      });
      await link("t-hand-split", items("b"));
      expect(await partsOf("t-hand-split")).toEqual([
        { amount: -500, category: "Hobbies", source: "hand-set" },
        { amount: -2_500, category: "Gifts and donations", source: "hand-set" },
      ]);

      // The Member removes the hand split: the Line items answer again.
      expect(await removeSplit(bank.database, await idOf("t-hand-split"))).toBe(true);
      await runFollowUp(NOW);
      expect(await partsOf("t-hand-split")).toEqual([
        { amount: -2_000, category: "Pets", source: "Line items" },
        { amount: -1_000, category: "Groceries", source: "Line items" },
      ]);
    });

    it("with no AI, gives a Line item with no Category the Transaction's own Category, marked for the redo, and splits it from the rest", async () => {
      await sync(buy("t-own", -3_000), buy("t-plain", -3_000));
      const own = (await partsOf("t-plain"))[0]?.category;
      expect(own).toEqual(expect.any(String));
      await link("t-own", [
        { id: "1", total: 2_000, category: "Pets", categorySource: "hand-set" },
        { id: "2", total: 1_000 },
      ]);

      const parts = await partsOf("t-own");
      expect(parts.map((part) => [part.amount, part.category, part.source])).toEqual([
        [-2_000, "Pets", "Line items"],
        [-1_000, own, "Line items"],
      ]);
      const item = await itemOf("2");
      expect(item).toMatchObject({ source: "Transaction", needsAi: 1 });
      // A Line item never takes Superstores, Cash or Payments to people.
      expect(item?.category).toBe(
        own === "Superstores" || own === "Cash" || own === "Payments to people"
          ? "Miscellaneous"
          : own,
      );
    });

    it("leaves a Transfer's and a Refund's Line items unused", async () => {
      await sync(buy("t-refund", 1_500));
      await link("t-refund", [
        { id: "1", total: 1_000, category: "Pets", categorySource: "hand-set" },
        { id: "2", total: 500, category: "Hobbies", categorySource: "hand-set" },
      ]);
      const parts = await partsOf("t-refund");
      expect(parts).toHaveLength(1);
      expect(parts[0]?.source).not.toBe("Line items");
    });

    it("gives a Line item and its part Miscellaneous when the Transaction's own Category is Superstores", async () => {
      // The provider's marketplace category, which the cascade's step 3 reads as Superstores.
      const category = {
        name: "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES",
        confidence: "VERY_HIGH",
        version: "v2",
        mcc: null,
      } as TxnRecord["category"];
      await sync(buy("t-superstore", -3_000, { category }), buy("t-plain", -3_000, { category }));
      expect(await partsOf("t-plain")).toEqual([
        { amount: -3_000, category: "Superstores", source: "provider" },
      ]);
      await link("t-superstore", [
        { id: "1", total: 2_000, category: "Pets", categorySource: "Item rule" },
        { id: "2", total: 1_000 },
      ]);

      expect(await partsOf("t-superstore")).toEqual([
        { amount: -2_000, category: "Pets", source: "Line items" },
        { amount: -1_000, category: "Miscellaneous", source: "Line items" },
      ]);
      expect(await itemOf("2")).toMatchObject({ category: "Miscellaneous", source: "Transaction" });
    });

    it.each(["Superstores", "Cash", "Payments to people"] as const)(
      "gives a Line item Miscellaneous in place of its Transaction's %s",
      (category) => {
        expect(transactionStepCategory(category)).toBe("Miscellaneous");
        expect(transactionStepCategory("Pets")).toBe("Pets");
      },
    );

    it.each(["Transfer", "Saving"] as const)(
      "leaves the Line items of a Transaction a Member made a %s unused, with one Category or two (K2)",
      async (type) => {
        await sync(buy("t-one", -3_000), buy("t-two", -3_000));
        for (const id of ["t-one", "t-two"]) {
          expect(
            await setTransactionType(bank.database, await idOf(id), type, NOW()),
          ).toMatchObject({
            parts: [{ type, category: null }],
          });
        }
        await runFollowUp(NOW);
        const before = [await partsOf("t-one"), await partsOf("t-two")];
        await link("t-one", [
          { id: "1", total: 3_000, category: "Pets", categorySource: "hand-set" },
        ]);
        await link("t-two", [
          { id: "2", total: 2_000, category: "Pets", categorySource: "hand-set" },
          { id: "3", total: 1_000, category: "Hobbies", categorySource: "hand-set" },
        ]);
        expect([await partsOf("t-one"), await partsOf("t-two")]).toEqual(before);
        for (const parts of before) {
          expect(parts).toEqual([{ amount: -3_000, category: null, source: null }]);
        }
      },
    );

    it("keeps Categories from Line items out of the Merchant's history (spec 04, step 4)", async () => {
      // Three Amazon charges, each with Line items of one Category, then a fourth with none.
      const dates = ["2026-05-03", "2026-05-10", "2026-05-17"];
      await sync(...dates.map((postedDate, n) => buy(`t-order-${n}`, -2_000, { postedDate })));
      for (const [n] of dates.entries()) {
        await link(`t-order-${n}`, [
          { id: `${n}`, total: 2_000, category: "Pets", categorySource: "hand-set" },
        ]);
        expect(await partsOf(`t-order-${n}`)).toEqual([
          { amount: -2_000, category: "Pets", source: "Line items" },
        ]);
      }

      await sync(buy("t-later", -2_000, { postedDate: "2026-05-24" }));
      const [later] = await partsOf("t-later");
      expect(later?.category).not.toBe("Pets");
      expect(later?.source).not.toBe("Merchant history");
    });

    it("keeps a Category a Member set by hand after the steps read the Line item (K2)", async () => {
      await addTestLineItems(bank.database, [
        { id: "1", total: 1_000 },
        { id: "2", total: 1_000, category: "Pets", categorySource: "hand-set" },
      ]);
      await storeLineItemChoices(
        bank.database,
        ["1", "2"].map((id) => ({
          id,
          category: "Hobbies",
          categorySource: "AI" as const,
          categoryConfidence: "high" as const,
          categoryNeedsAi: false,
        })),
      );
      expect(await itemsOf()).toMatchObject([
        { id: "1", category: "Hobbies", source: "AI" },
        { id: "2", category: "Pets", source: "hand-set" },
      ]);
    });

    it("keeps a Transaction's parts when they changed since the cascade read them (K2)", async () => {
      await sync(buy("t-moved", -3_000));
      const id = await idOf("t-moved");
      const parts = [
        { amount: -2_000, category: "Pets" as const },
        { amount: -1_000, category: "Hobbies" as const },
      ];
      // A different amount, a hand-set part, and a part that is not Spending each keep the parts.
      expect(
        await storeLineItemParts(bank.database, [{ transactionId: id, amount: -2_999, parts }]),
      ).toEqual([]);
      await sql(
        "UPDATE transaction_parts SET category_source = 'hand-set' WHERE transaction_id = ?",
        [id],
      );
      expect(
        await storeLineItemParts(bank.database, [{ transactionId: id, amount: -3_000, parts }]),
      ).toEqual([]);
      await sql(
        "UPDATE transaction_parts SET category_source = NULL, type = 'Transfer' WHERE transaction_id = ?",
        [id],
      );
      expect(
        await storeLineItemParts(bank.database, [{ transactionId: id, amount: -3_000, parts }]),
      ).toEqual([]);
      await sql(
        "UPDATE transaction_parts SET type = 'Spending', keeps_category = 1 WHERE transaction_id = ?",
        [id],
      );
      expect(
        await storeLineItemParts(bank.database, [{ transactionId: id, amount: -3_000, parts }]),
      ).toEqual([]);
      await sql(
        "UPDATE transaction_parts SET keeps_category = 0, linked = 1 WHERE transaction_id = ?",
        [id],
      );
      expect(
        await storeLineItemParts(bank.database, [{ transactionId: id, amount: -3_000, parts }]),
      ).toEqual([]);
      await sql("UPDATE transaction_parts SET linked = 0 WHERE transaction_id = ?", [id]);
      expect(
        await storeLineItemParts(bank.database, [{ transactionId: id, amount: -3_000, parts }]),
      ).toEqual([id]);
      expect(await partsOf("t-moved")).toHaveLength(2);
      // Parts already split are not one Spending part.
      const other = [{ amount: -3_000, category: "Pets" as const }];
      expect(
        await storeLineItemParts(bank.database, [
          { transactionId: id, amount: -3_000, parts: other },
        ]),
      ).toEqual([]);
      expect(await partsOf("t-moved")).toHaveLength(2);
    });

    it("sends every Transaction that had Line items back to the cascade inside Delete all, even when the step after the commit fails (K5)", async () => {
      await sync(buy("t-gone", -3_000), buy("t-plain", -3_000));
      await link("t-gone", [
        { id: "1", total: 1_000, category: "Pets", categorySource: "hand-set" },
        { id: "2", total: 2_000, category: "Hobbies", categorySource: "hand-set" },
      ]);
      expect(await partsOf("t-gone")).toHaveLength(2);
      // The step after the commit fails.
      const index = stops.length - 1;
      stops[index]?.();
      stops[index] = registerLineItemsRemoved("Categories", async () => {
        throw new Error("The step failed.");
      });

      const deleted = await deleteLineItemData(bank.database, "amazon", {
        reviewKinds: [],
        at: new Date(),
      });
      expect(deleted.transactionIds).toEqual([await idOf("t-gone")]);
      await runFollowUp(NOW);

      expect(await partsOf("t-gone")).toEqual(
        (await partsOf("t-plain")).map((part) => ({ ...part, amount: -3_000 })),
      );
    });
  });

  describe("the AI at the Line items' step 3", () => {
    beforeEach(() => start(true));

    it("asks for each Line item's name, quantity, price and store only, and applies each answer", async () => {
      await connectAi();
      answerItem = (row) =>
        String(row.name).startsWith("Dog")
          ? { category: "Pets", confidence: "high" }
          : String(row.name).startsWith("Puzzle")
            ? { category: "Hobbies", confidence: "low" }
            : String(row.name).startsWith("Gift")
              ? { category: "Superstores", confidence: "high" }
              : { category: "Groceries", confidence: "medium" };
      await sync(buy("t-ai", -6_000));
      await link("t-ai", [
        { id: "1", name: "Dog food, 30 lb", total: 3_000, quantity: 2 },
        { id: "2", name: "Puzzle, 500 pieces", total: 1_000 },
        { id: "3", name: "Gift box", total: 1_000 },
        { id: "4", name: "Oat milk, 6 pack", total: 1_000 },
      ]);

      expect(asked).toHaveLength(1);
      expect(asked[0]?.[0]).toEqual({
        row: 1,
        name: "Dog food, 30 lb",
        quantity: 2,
        price: "15.00",
        store: "Amazon",
      });
      expect(await itemsOf()).toEqual([
        { id: "1", category: "Pets", source: "AI", confidence: "high", needsAi: 0 },
        { id: "2", category: "Hobbies", source: "AI", confidence: "low", needsAi: 0 },
        // A Category a Line item never takes counts as low, with Miscellaneous.
        { id: "3", category: "Miscellaneous", source: "AI", confidence: "low", needsAi: 0 },
        { id: "4", category: "Groceries", source: "AI", confidence: "medium", needsAi: 0 },
      ]);
      expect(await partsOf("t-ai")).toEqual([
        { amount: -3_000, category: "Pets", source: "Line items" },
        { amount: -1_000, category: "Hobbies", source: "Line items" },
        { amount: -1_000, category: "Miscellaneous", source: "Line items" },
        { amount: -1_000, category: "Groceries", source: "Line items" },
      ]);
      // The low answers go on the Review list, one card per product.
      expect((await cards()).map((card) => card.subject)).toEqual(
        expect.arrayContaining([
          { type: "line items", lineItemIds: ["2"] },
          { type: "line items", lineItemIds: ["3"] },
        ]),
      );
      expect(await cards()).toHaveLength(2);
    });

    it("sends each Line item the Transaction step answered to the AI once in the redo, and remakes its Transaction's parts", async () => {
      // No AI provider yet: step 4.
      await sync(buy("t-redo", -3_000));
      await link("t-redo", [
        { id: "1", name: "Dog food, 30 lb", total: 2_000 },
        { id: "2", name: "Puzzle", total: 1_000, category: "Hobbies", categorySource: "hand-set" },
      ]);
      expect(await itemOf("1")).toMatchObject({ source: "Transaction", needsAi: 1 });
      expect(asked).toEqual([]);

      await connectAi();
      answerItem = () => ({ category: "Pets", confidence: "high" });
      if (ai === undefined) throw new Error("No AI.");
      const redo = startRedo({ database: bank.database, ai, now: NOW, startJob: async () => {} });
      stops.push(redo.stop);
      // A Member presses "Finish the work" (spec 08, Redo of no-AI work).
      expect(await runRedo("finish")).toBe("done");
      await runFollowUp(NOW);

      expect(asked.map((rows) => rows.map((row) => row.name))).toEqual([["Dog food, 30 lb"]]);
      expect(await itemOf("1")).toMatchObject({ category: "Pets", source: "AI", needsAi: 0 });
      expect(await partsOf("t-redo")).toEqual([
        { amount: -2_000, category: "Pets", source: "Line items" },
        { amount: -1_000, category: "Hobbies", source: "Line items" },
      ]);
      // Once: the redo finds nothing to do again.
      expect(await runRedo()).toBe("not due");
      expect(asked).toHaveLength(1);
    });

    it("stops at the AI's retries, and takes the Transaction step after the last one (K4)", async () => {
      await connectAi();
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-01T14:00:00.000Z") });
      await sync(buy("t-retry", -2_000));
      stub.answers.quick = "rate limit";
      const stopped = await link("t-retry", [{ id: "1", total: 2_000 }]);

      expect(stopped).toEqual({ stoppedAt: "categorization", again: expect.any(Date) });
      expect(await readAiRetry(bank.database, "line item category")).toMatchObject({ failures: 1 });
      expect(await itemOf("1")).toMatchObject({ category: null, source: null });
      // Each retry stops the step again, until the last one fails.
      for (const delay of RETRY_DELAYS_MS) {
        vi.setSystemTime(Date.now() + delay);
        expect(await runFollowUp(NOW)).toMatchObject({ stoppedAt: "categorization" });
      }

      // After the last retry, the Line item takes the Transaction step, and waits for the
      // Transaction's own Category, which its own AI use asks for.
      expect(await readAiRetry(bank.database, "line item category")).toBeUndefined();
      expect(await readAiRetry(bank.database, "category fix")).toMatchObject({ failures: 1 });
      expect(await itemOf("1")).toMatchObject({
        category: null,
        source: "Transaction",
        needsAi: 1,
      });

      stub.answers.quick = "work";
      vi.setSystemTime(Date.now() + RETRY_DELAYS_MS[0]);
      expect(await runFollowUp(NOW)).toBeUndefined();
      expect(asked).toEqual([]);
      expect(await partsOf("t-retry")).toEqual([
        { amount: -2_000, category: "Clothing", source: "AI" },
      ]);
      expect(await itemOf("1")).toMatchObject({
        category: "Clothing",
        source: "Transaction",
        needsAi: 1,
      });
    });

    it("makes an Item rule when a Member accepts a card, and a correction makes one unless only this item", async () => {
      await connectAi();
      answerItem = () => ({ category: "Hobbies", confidence: "low" });
      await sync(buy("t-card", -2_000), buy("t-card-2", -1_000));
      await link("t-card", [
        { id: "1", name: "Puzzle", productId: "B000000001", total: 1_000 },
        { id: "2", name: "Puzzle", productId: "B000000001", total: 1_000, orderDate: "2026-05-02" },
      ]);
      await link("t-card-2", [{ id: "3", name: "Crayons", productId: "B000000003", total: 1_000 }]);
      const [puzzles, crayons] = (await cards()).sort(
        (a, b) =>
          (b.subject.type === "line items" ? b.subject.lineItemIds.length : 0) -
          (a.subject.type === "line items" ? a.subject.lineItemIds.length : 0),
      );
      expect(puzzles?.subject).toEqual({ type: "line items", lineItemIds: ["2", "1"] });
      expect(puzzles?.bestAnswer).toEqual({ value: "Hobbies", label: "Yes, Hobbies" });
      if (puzzles === undefined || crayons === undefined) throw new Error("No cards.");

      expect(await answerReviewItem(bank.database, puzzles.id, "Hobbies", await memberId())).toBe(
        "answered",
      );
      expect(await itemsOf()).toMatchObject([
        { id: "1", category: "Hobbies", source: "hand-set" },
        { id: "2", category: "Hobbies", source: "hand-set" },
        { id: "3", category: "Hobbies", source: "AI" },
      ]);
      expect(await rules()).toMatchObject([{ product_id: "B000000001", category: "Hobbies" }]);

      expect(
        await answerReviewItem(
          bank.database,
          crayons.id,
          "only this Transaction: Gifts and donations",
          "m1",
        ),
      ).toBe("answered");
      expect(await itemOf("3")).toMatchObject({
        category: "Gifts and donations",
        source: "hand-set",
      });
      expect(await rules()).toHaveLength(1);
      expect(await cards()).toEqual([]);
      await runFollowUp(NOW);
      expect(await partsOf("t-card-2")).toEqual([
        { amount: -1_000, category: "Gifts and donations", source: "Line items" },
      ]);
    });
  });

  describe("Item rules", () => {
    beforeEach(() => start(false));

    it("covers the product's past and future Line items, except those set by hand and other sizes, and remakes each changed Transaction's parts (K2)", async () => {
      await sync(buy("t-a", -2_000), buy("t-b", -2_000));
      await link("t-a", [
        {
          id: "1",
          name: "Paper towels, 12 rolls",
          productId: "B000000012",
          total: 1_000,
          category: "Pets",
          categorySource: "hand-set",
        },
        {
          id: "2",
          name: "Dish soap",
          productId: "B000000020",
          total: 1_000,
          category: "Pets",
          categorySource: "hand-set",
        },
      ]);
      await link("t-b", [
        {
          id: "3",
          name: "Paper towels, 12 rolls",
          productId: "B000000012",
          total: 1_000,
          category: "Hobbies",
          categorySource: "AI",
          categoryConfidence: "high",
        },
        {
          id: "4",
          name: "Paper towels, 12 rolls",
          productId: "B000000012",
          total: 1_000,
          category: "Gifts and donations",
          categorySource: "hand-set",
        },
        {
          id: "5",
          name: "Paper towels, 6 rolls",
          productId: "B000000006",
          total: 1_000,
          category: "Hobbies",
          categorySource: "AI",
          categoryConfidence: "high",
        },
        {
          id: "6",
          name: "Paper towels 12 rolls",
          productId: null,
          total: 1_000,
          category: "Hobbies",
          categorySource: "AI",
          categoryConfidence: "high",
        },
      ]);

      expect(
        await changeLineItemCategory(
          bank.database,
          "1",
          { category: "Home and garden", onlyThisItem: false },
          await memberId(),
        ),
      ).toBe("changed");
      expect(await itemsOf()).toMatchObject([
        { id: "1", category: "Home and garden", source: "hand-set" },
        { id: "2", category: "Pets", source: "hand-set" },
        { id: "3", category: "Home and garden", source: "Item rule" },
        { id: "4", category: "Gifts and donations", source: "hand-set" },
        { id: "5", category: "Hobbies", source: "AI" },
        // No product ID: the clean name matches.
        { id: "6", category: "Home and garden", source: "Item rule" },
      ]);
      await runFollowUp(NOW);
      expect((await partsOf("t-b")).map((part) => part.category).sort()).toEqual([
        "Gifts and donations",
        "Hobbies",
        "Home and garden",
      ]);
      // A later Line item of the product takes the rule's Category.
      await sync(buy("t-c", -1_000));
      await link("t-c", [
        { id: "7", name: "Paper towels, 12 rolls", productId: "B000000012", total: 1_000 },
      ]);
      expect(await itemOf("7")).toMatchObject({ category: "Home and garden", source: "Item rule" });

      // A newer correction replaces the rule.
      await changeLineItemCategory(
        bank.database,
        "3",
        { category: "Groceries", onlyThisItem: false },
        "m1",
      );
      expect(await rules()).toMatchObject([{ product_id: "B000000012", category: "Groceries" }]);
      expect(await itemOf("7")).toMatchObject({ category: "Groceries", source: "Item rule" });
      expect(await itemOf("1")).toMatchObject({ category: "Home and garden", source: "hand-set" });
    });

    it("makes no rule for only this item, and refuses a Category a Line item never takes", async () => {
      await addTestLineItems(bank.database, [
        { id: "1", total: 1_000 },
        { id: "2", total: 1_000, productId: "B000000001" },
      ]);
      expect(
        await changeLineItemCategory(
          bank.database,
          "1",
          { category: "Hobbies", onlyThisItem: true },
          await memberId(),
        ),
      ).toBe("changed");
      expect(await rules()).toEqual([]);
      expect(await itemOf("1")).toMatchObject({ category: "Hobbies", source: "hand-set" });
      for (const category of ["Superstores", "Cash", "Payments to people", "Snacks"]) {
        expect(
          await changeLineItemCategory(bank.database, "2", { category, onlyThisItem: false }, "m1"),
        ).toBe("not a Category");
      }
      expect(
        await changeLineItemCategory(
          bank.database,
          "missing",
          { category: "Hobbies", onlyThisItem: false },
          "m1",
        ),
      ).toBe("not found");
      expect(await rules()).toEqual([]);
    });

    it("sends a deleted rule's Line items not set by hand down the steps again", async () => {
      await sync(buy("t-del", -2_000));
      await link("t-del", [
        {
          id: "1",
          name: "Lamp",
          productId: "B000000001",
          total: 1_000,
          category: "Pets",
          categorySource: "hand-set",
        },
        { id: "2", name: "Lamp", productId: "B000000001", total: 1_000 },
      ]);
      await addTestLineItems(bank.database, [
        { id: "3", name: "Lamp", productId: "B000000001", total: 1_000 },
      ]);
      await changeLineItemCategory(
        bank.database,
        "1",
        { category: "Home and garden", onlyThisItem: false },
        await memberId(),
      );
      expect(await itemOf("3")).toMatchObject({ category: "Home and garden", source: "Item rule" });
      const [rule] = await sql("SELECT id FROM item_rules");

      expect(await deleteLineItemRule(bank.database, String(rule?.id))).toBe(true);
      expect(await deleteLineItemRule(bank.database, String(rule?.id))).toBe(false);
      await runFollowUp(NOW);
      expect(await rules()).toEqual([]);
      expect(await itemsOf()).toMatchObject([
        { id: "1", category: "Home and garden", source: "hand-set" },
        // With no AI, the Transaction step answers, marked for the redo.
        { id: "2", source: "Transaction", needsAi: 1 },
        { id: "3", category: "Miscellaneous", source: "Transaction", needsAi: 1 },
      ]);
    });

    it("changes 2,000 Line items of one product in under 2 s (K3)", async () => {
      const items = Array.from({ length: 2_000 }, (_, index) => ({
        id: `i${String(index).padStart(5, "0")}`,
        name: "Paper towels, 12 rolls",
        productId: "B000000012",
        total: 1_000,
        category: "Hobbies",
        categorySource: "AI" as const,
        categoryConfidence: "high" as const,
      }));
      await addTestLineItems(bank.database, items);
      const member = await memberId();
      const started = performance.now();
      await changeLineItemCategory(
        bank.database,
        "i00000",
        { category: "Home and garden", onlyThisItem: false },
        member,
      );
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(
        (await sql("SELECT count(*) AS n FROM line_items WHERE category = 'Home and garden'"))[0]
          ?.n,
      ).toBe(2_000);
    });
  });
});
