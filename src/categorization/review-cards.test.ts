import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import type { CategoryRecord } from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { K7_LINES } from "../large-history/index.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import {
  answerReviewItem,
  openReviewItem,
  openReviewItemBatch,
  openReviewItems,
  type ReviewItem,
  registerReviewKind,
  settleReviewItems,
} from "../review/index.ts";
import {
  AI_UNSURE_KIND,
  BEST_GUESS_KIND,
  categorize,
  correctCategory,
  startCategorization,
} from "./index.ts";
import { groupByMerchant, mostChosen } from "./review-cards.ts";

// The Category cards on the Review list (spec 04, Review list items): one open item per Merchant
// for each Category kind, through the categorization module. Transactions arrive through the fake
// adapter with no AI, so each one the provider is unsure of takes a best guess; an AI answer is
// stored on the part as the AI step stores it.

const NOW = () => new Date("2026-11-01T14:00:00.000Z");
const BANK = "fake-first-bank";
const MEMBER = "member-1";
const CARD = fakeAccount({
  id: "acc-card",
  name: "Everyday Card",
  type: "credit",
  subtype: "credit card",
});

const idsOf = (item: ReviewItem | undefined) =>
  item?.subject.type === "transactions" ? item.subject.transactionIds : [];

describe("the Category cards on the Review list", () => {
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
  const chosen = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: `SELECT p.category, p.category_source AS source
            FROM transaction_parts p JOIN transactions t ON t.id = p.transaction_id
            WHERE t.provider_transaction_id = ? AND t.hidden_reason IS NULL ORDER BY p.part`,
      args: [providerId],
    });
    const [row] = rows.rows;
    return row === undefined ? undefined : [row.category, row.source];
  };
  const sync = async (...pages: Parameters<TestBank["fake"]["addPages"]>[1][]) => {
    bank.fake.addPages(BANK, ...pages);
    await syncConnection(connectionId, NOW);
    await runFollowUp(NOW);
  };
  const cards = async (kind = BEST_GUESS_KIND) =>
    (await openReviewItems(bank.database)).filter((item) => item.kind === kind);
  const cardOf = async (providerId: string, kind = BEST_GUESS_KIND) => {
    const id = await idOf(providerId);
    return (await cards(kind)).find((item) => idsOf(item).includes(id));
  };
  const closings = async () =>
    (
      await bank.database.$client.execute(
        "SELECT id, closed_reason AS reason FROM review_items WHERE closed_at IS NOT NULL ORDER BY id",
      )
    ).rows.map((row) => ({ id: String(row.id), reason: String(row.reason) }));
  // Every item, open or closed, as stored.
  const stored = async () =>
    (
      await bank.database.$client.execute(
        "SELECT id, kind, subject_ids, decided, best_answer, closed_at, closed_reason FROM review_items ORDER BY id",
      )
    ).rows.map((row) => ({ ...row }));
  // The AI's answer for a part, as the AI step stores it.
  const answeredByAi = (providerId: string, category: string, confidence: string) =>
    bank.database.$client.execute({
      sql: `UPDATE transaction_parts SET category = ?, category_source = 'AI',
              category_confidence = ?, category_needs_ai = 0
            WHERE transaction_id = (SELECT id FROM transactions WHERE provider_transaction_id = ?)`,
      args: [category, confidence, providerId],
    });

  // A purchase the provider is unsure of: with no AI, it takes a best guess from the code.
  const guessed = (
    id: string,
    postedDate: string,
    merchantName: string | null = "Marathon",
    code: string | null = "TRANSPORTATION_GAS",
    fields: Partial<TxnRecord> = {},
  ): TxnRecord =>
    fakeTxn({
      id,
      accountId: CARD.id,
      amount: -2_500,
      postedDate,
      description: `CARD PURCHASE ${id.toUpperCase()}`,
      merchantName,
      category: code === null ? null : { name: code, confidence: "LOW", version: "v2", mcc: null },
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

  it("opens one card for each Merchant, with its Transactions newest first and the most chosen Category", async () => {
    await sync({
      added: [
        guessed("m1", "2026-10-01"),
        guessed("m2", "2026-10-03"),
        guessed("m3", "2026-10-02", "Marathon", "FOOD_AND_DRINK_COFFEE"),
        guessed("f1", "2026-10-04", "Firelands Vending", "FOOD_AND_DRINK_COFFEE"),
      ],
    });

    const open = await cards();
    expect(open).toHaveLength(2);
    expect(await cardOf("m1")).toMatchObject({
      subject: {
        type: "transactions",
        transactionIds: [await idOf("m2"), await idOf("m3"), await idOf("m1")],
      },
      decided: "No AI was available, so the app guessed Gas for 2 of 3.",
      bestAnswer: { value: "Gas", label: "Yes, Gas" },
    });
    expect(await cardOf("f1")).toMatchObject({
      subject: { transactionIds: [await idOf("f1")] },
      decided: "No AI was available, so the app guessed Restaurants.",
      bestAnswer: { value: "Restaurants" },
    });
  });

  it("adds a new Transaction to its Merchant's open card, and keeps the card's ID", async () => {
    await sync({ added: [guessed("m1", "2026-10-01")] });
    const before = await cardOf("m1");

    await sync({ added: [guessed("m2", "2026-10-02")] });

    const after = await cardOf("m2");
    expect(after?.id).toBe(before?.id);
    expect(idsOf(after)).toEqual([await idOf("m2"), await idOf("m1")]);
    expect(after?.decided).toBe("No AI was available, so the app guessed Gas.");
    expect(await cards()).toHaveLength(1);
  });

  it("takes a Transaction set by hand off its card at once, and closes the card when none is left", async () => {
    await sync({
      added: [
        guessed("m1", "2026-10-01", "Marathon", "FOOD_AND_DRINK_COFFEE"),
        guessed("m2", "2026-10-02"),
        guessed("m3", "2026-10-03"),
      ],
    });
    const card = await cardOf("m1");
    expect(card?.bestAnswer.value).toBe("Gas");

    // "Change" on a row: only this Transaction, with no follow-up job yet.
    const set = (providerId: string, category: "Groceries" | "Gas") =>
      idOf(providerId).then((id) =>
        correctCategory(bank.database, id, category, {
          onlyThisTransaction: true,
          memberId: MEMBER,
        }),
      );
    expect(await set("m2", "Groceries")).toMatchObject({ result: "corrected", rule: null });
    const left = await cardOf("m3");
    expect(left?.id).toBe(card?.id);
    expect(idsOf(left)).toEqual([await idOf("m3"), await idOf("m1")]);
    // A tie goes to the newest Transaction's Category.
    expect(left?.bestAnswer.value).toBe("Gas");
    expect(left?.decided).toBe("No AI was available, so the app guessed Gas for 1 of 2.");
    // The follow-up job stores the hand-set Category on the part, and makes no rule.
    await runFollowUp(NOW);
    expect(await chosen("m2")).toEqual(["Groceries", "hand-set"]);
    expect(await chosen("m3")).toEqual(["Gas", "best guess"]);
    expect(await cardOf("m3")).toEqual(left);

    await set("m3", "Gas");
    expect(idsOf(await cardOf("m1"))).toEqual([await idOf("m1")]);
    await set("m1", "Gas");
    expect(await cards()).toEqual([]);
    expect(await closings()).toEqual([{ id: card?.id, reason: "its Category was chosen again" }]);

    // The follow-up job finds nothing more to do.
    await runFollowUp(NOW);
    expect(await cards()).toEqual([]);
  });

  it("takes a Transaction the provider removed off its card", async () => {
    await sync({ added: [guessed("m1", "2026-10-01"), guessed("m2", "2026-10-02")] });
    const card = await cardOf("m1");

    await sync({ removed: [{ id: "m2" }] });

    expect(await cards()).toEqual([
      expect.objectContaining({ id: card?.id, subject: expect.anything() }),
    ]);
    expect(idsOf((await cards())[0])).toEqual([await idOf("m1")]);

    // Hidden with its parts still stored, as before Matching drops them: it leaves too.
    const m1 = await idOf("m1");
    await bank.database.$client.execute({
      sql: "UPDATE transactions SET hidden_reason = 'removed by the provider' WHERE id = ?",
      args: [m1],
    });
    await categorize(bank.database, [m1]);
    expect(await cards()).toEqual([]);
  });

  it("answers every Transaction on the card, and writes no other card's", async () => {
    await sync({
      added: [
        guessed("m1", "2026-10-01"),
        guessed("m2", "2026-10-02"),
        guessed("f1", "2026-10-03", "Firelands Vending"),
      ],
    });
    const marathon = await cardOf("m1");
    const firelands = await cardOf("f1");

    expect(await answerReviewItem(bank.database, marathon?.id ?? "", "Gas", MEMBER)).toBe(
      "answered",
    );
    await runFollowUp(NOW);

    expect(await chosen("m1")).toEqual(["Gas", "hand-set"]);
    expect(await chosen("m2")).toEqual(["Gas", "hand-set"]);
    expect(await chosen("f1")).toEqual(["Gas", "best guess"]);
    expect(await cards()).toEqual([firelands]);
  });

  it("keeps an item of its own for a Transaction with no Merchant that may have a rule", async () => {
    const check = { description: "CHECK 1042" };
    await sync({
      added: [
        guessed("check-1", "2026-10-01", null, null, check),
        guessed("check-2", "2026-10-02", null, null, check),
        ...K7_LINES.flatMap((line, n) => [
          guessed(`k7-${n}-a`, "2026-10-03", null, null, { description: line }),
          guessed(`k7-${n}-b`, "2026-10-04", null, null, { description: line }),
        ]),
      ],
    });

    expect(idsOf(await cardOf("check-1"))).toEqual([await idOf("check-1")]);
    expect(idsOf(await cardOf("check-2"))).toEqual([await idOf("check-2")]);
    // Each K7 line through the real cleanup rules: a line that names a person or a shop shares
    // its card with the same line; a line that names no one, or no Merchant, never does.
    const shared = new Map<string, number>();
    for (const [n, line] of K7_LINES.entries()) {
      const a = await cardOf(`k7-${n}-a`);
      const b = await cardOf(`k7-${n}-b`);
      if (a === undefined || b === undefined) continue;
      shared.set(line, a.id === b.id ? idsOf(a).length : 1);
    }
    expect(Object.fromEntries(shared)).toMatchObject({
      "PURCHASE 1005 BLUEBIRD BOOKS": 2,
      "BEST BUY CO": 2,
    });
    for (const line of [
      "VENMO PAYMENT 1234567890 WEB ID",
      "ZELLE PAYMENT TO 5551234",
      "PAYPAL *INST XFER",
      "CASH APP*SENT",
      "VENMO CASHOUT",
      "XXXX4821",
      "REF#12345678",
      "(800) 555-1212",
    ]) {
      expect([undefined, 1]).toContain(shared.get(line));
    }
  });

  it("puts only a low AI answer on a card, and lets a medium one go as decided", async () => {
    await sync({ added: [guessed("m1", "2026-10-01"), guessed("m2", "2026-10-02")] });
    await answeredByAi("m1", "Gas", "low");
    await answeredByAi("m2", "Gas", "medium");

    await categorize(bank.database, [await idOf("m1"), await idOf("m2")]);

    expect(await cards()).toEqual([]);
    const unsure = await cards(AI_UNSURE_KIND);
    expect(unsure.map(idsOf)).toEqual([[await idOf("m1")]]);
    expect(unsure[0]?.decided).toBe("The AI chose Gas, but it was unsure.");
  });

  describe("items from before cards", () => {
    // One item for each Transaction, as the Review list held them before cards.
    const asBefore = async (kind: string, providerIds: readonly string[], category = "Gas") => {
      const ids = await Promise.all(providerIds.map(idOf));
      return openReviewItemBatch(
        bank.database,
        ids.map((id) => ({
          kind,
          subject: { type: "transactions", transactionIds: [id] },
          decided: `The AI chose ${category}, but it was unsure.`,
          bestAnswer: { value: category, label: `Yes, ${category}` },
        })),
      );
    };
    const clear = async () =>
      bank.database.$client.execute(
        "UPDATE review_items SET closed_at = '2026-10-01T00:00:00.000Z', closed_reason = 'test'",
      );

    it("group by Merchant once, close medium items as decided, and change nothing the second time", async () => {
      await sync({
        added: [
          guessed("m1", "2026-10-01"),
          guessed("m2", "2026-10-02"),
          guessed("m3", "2026-10-03"),
          guessed("f1", "2026-10-04", "Firelands Vending"),
          guessed("f2", "2026-10-05", "Firelands Vending"),
        ],
      });
      for (const id of ["m1", "m2", "m3", "f1"]) await answeredByAi(id, "Gas", "low");
      await answeredByAi("f2", "Gas", "medium");
      await clear();
      const before = await asBefore(AI_UNSURE_KIND, ["m1", "m2", "m3", "f1", "f2"]);

      await categorize(bank.database, []);

      const open = await cards(AI_UNSURE_KIND);
      expect(open.map(idsOf).sort()).toEqual(
        [[await idOf("f1")], [await idOf("m3"), await idOf("m2"), await idOf("m1")]].sort(),
      );
      const reasons = new Map((await closings()).map(({ id, reason }) => [id, reason]));
      const [m1, m2, m3, f1, f2] = before;
      // The Merchant's card keeps one of its items; the others close as grouped.
      const marathon = open.find((item) => idsOf(item).length === 3);
      expect([m1, m2, m3]).toContain(marathon?.id);
      expect(
        [m1, m2, m3].filter((id) => id !== marathon?.id).map((id) => reasons.get(id ?? "")),
      ).toEqual(["grouped by Merchant", "grouped by Merchant"]);
      expect(marathon?.decided).toBe("The AI chose Gas, but it was unsure.");
      expect(open.find((item) => item.id === f1)).toBeDefined();
      expect(reasons.get(f2 ?? "")).toBe("a medium answer counts as decided");

      const once = await stored();
      await categorize(bank.database, []);
      await runFollowUp(NOW);
      expect(await stored()).toEqual(once);
    });

    it("group 2,500 items in a few seconds, reading the open items once", {
      timeout: 120_000,
    }, async () => {
      const day = (index: number) =>
        new Date(Date.UTC(2022, 0, 1 + (index % 1_000))).toISOString().slice(0, 10);
      const added = Array.from({ length: 2_500 }, (_, index) =>
        guessed(`g${index}`, day(index), `Shop ${index % 50}`),
      );
      await sync({ added });
      await clear();
      await asBefore(
        BEST_GUESS_KIND,
        added.map((txn) => txn.id),
      );

      // CPU time, which a busy host does not stretch.
      const started = process.cpuUsage();
      await categorize(bank.database, []);
      const used = process.cpuUsage(started);
      const took = (used.user + used.system) / 1_000;

      const open = await cards();
      expect(open).toHaveLength(50);
      expect(open.flatMap(idsOf)).toHaveLength(2_500);
      expect(took).toBeLessThan(3_000);

      const again = process.cpuUsage();
      await categorize(bank.database, []);
      const second = process.cpuUsage(again);
      expect((second.user + second.system) / 1_000).toBeLessThan(1_000);
      expect(await cards()).toHaveLength(50);
    });
  });

  describe("each filter on the write", () => {
    it("reads only the Category kinds: another kind's item about the Transaction stays open", async () => {
      const other = "test kind";
      stops.push(
        registerReviewKind(other, {
          otherChoices: async () => [],
          answer: async () => undefined,
        }),
      );
      await sync({ added: [guessed("m1", "2026-10-01")] });
      const id = await openReviewItem(bank.database, {
        kind: other,
        subject: { type: "transactions", transactionIds: [await idOf("m1")] },
        decided: "Something else.",
        bestAnswer: { value: "yes", label: "Yes" },
      });

      await categorize(bank.database, [await idOf("m1")]);

      expect((await openReviewItems(bank.database)).map((item) => item.id)).toContain(id);
      expect(await cards()).toHaveLength(1);
    });

    it("groups by Merchant: two Merchants never share a card", async () => {
      await sync({
        added: [guessed("m1", "2026-10-01"), guessed("f1", "2026-10-02", "Firelands Vending")],
      });

      expect((await cards()).map(idsOf)).toHaveLength(2);
      expect((await cardOf("m1"))?.id).not.toBe((await cardOf("f1"))?.id);
    });

    it("reads only open cards: a closed card neither takes nor gives Transactions", async () => {
      await sync({ added: [guessed("m1", "2026-10-01")] });
      const closed = await cardOf("m1");
      await settleReviewItems(
        bank.database,
        { kind: BEST_GUESS_KIND, subjectId: await idOf("m1") },
        "test",
      );

      await sync({ added: [guessed("m2", "2026-10-02")] });

      const open = await cardOf("m2");
      expect(open?.id).not.toBe(closed?.id);
      expect(idsOf(open)).toEqual([await idOf("m2")]);
      const [row] = (await stored()).filter((item) => item.id === closed?.id);
      expect(row?.subject_ids).toBe(JSON.stringify([await idOf("m1")]));
      expect(row?.closed_reason).toBe("test");
    });
  });
});

describe("grouping by Merchant", () => {
  const record = (id: string, merchantId: string | null, name: string | null): CategoryRecord => ({
    id,
    postedDate: "2026-10-01",
    hidden: false,
    merchantId,
    merchantCleanName: name,
    providerCategory: null,
    providerCategoryConfidence: null,
    handSet: {},
    parts: [],
  });
  const groups = (records: CategoryRecord[]) =>
    groupByMerchant(records.map((each) => ({ record: each, category: "Gas" as const })))
      .map((group) => group.map(({ record: each }) => each.id))
      .sort((a, b) => b.length - a.length || (a[0] ?? "").localeCompare(b[0] ?? ""));

  it("groups by clean name, splits one name by Merchant ID, and puts a name with no ID in the largest", () => {
    expect(
      groups([
        record("a", null, "Marathon"),
        record("b", null, "MARATHON!"),
        record("c", "x", "Firelands"),
        record("d", "x", "Firelands"),
        record("e", "y", "Firelands"),
        record("f", null, "Firelands"),
      ]),
    ).toEqual([["c", "d", "f"], ["a", "b"], ["e"]]);
  });

  it("gives a Transaction with no Merchant, or a payment app that names no one, a group of its own", () => {
    expect(
      groups([
        record("a", null, null),
        record("b", null, null),
        record("c", null, "Venmo"),
        record("d", null, "Venmo"),
        record("e", null, "!!"),
        record("f", null, "!!"),
      ]),
    ).toEqual([["a"], ["b"], ["c"], ["d"], ["e"], ["f"]]);
  });

  it("chooses the Category chosen most often, and the first, which is the newest, on a tie", () => {
    const member = (category: "Gas" | "Groceries") => ({
      record: record("a", null, "M"),
      category,
    });
    expect(mostChosen([member("Gas"), member("Groceries"), member("Groceries")])).toEqual({
      category: "Groceries",
      of: 2,
    });
    expect(mostChosen([member("Gas"), member("Groceries")])).toEqual({ category: "Gas", of: 1 });
  });
});
