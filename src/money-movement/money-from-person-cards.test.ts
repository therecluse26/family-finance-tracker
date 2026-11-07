import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { setHandSetFields } from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import {
  answerReviewItem,
  openReviewItemsOfKind,
  otherReviewChoices,
  type ReviewItem,
} from "../review/index.ts";
import { MONEY_FROM_PERSON_KIND, readTransactionDecision, startMoneyMovement } from "./index.ts";

// Money from a person cards (spec 03, Review list items): one open item per person on one payment
// app, through the Matching follow-up step on Transactions the fake adapter syncs.

const NOW = () => new Date("2026-11-20T14:00:00.000Z");
const BANK = "fake-first-bank";
const CHECKING = fakeAccount({ id: "acc-checking", mask: "3333" });
const MEMBER = "member-1";

describe("money from a person cards", () => {
  let bank: TestBank;
  let stops: (() => void)[];
  let connectionId: string;

  const sync = async (added: TxnRecord[]) => {
    bank.fake.addPages(BANK, { accounts: [CHECKING], added, historyLoaded: true });
    await syncConnection(connectionId, NOW);
    await runFollowUp(NOW);
  };
  const moneyIn = (id: string, amount: number, postedDate: string, description: string) =>
    fakeTxn({ id, accountId: CHECKING.id, amount, postedDate, description, category: null });
  const sql = (statement: string, args: string[] = []) =>
    bank.database.$client.execute({ sql: statement, args });
  const idOf = async (providerId: string) =>
    String(
      (await sql("SELECT id FROM transactions WHERE provider_transaction_id = ?", [providerId]))
        .rows[0]?.id,
    );
  const idsOf = (providerIds: string[]) => Promise.all(providerIds.map(idOf));
  const cards = () => openReviewItemsOfKind(bank.database, MONEY_FROM_PERSON_KIND);
  const cardOf = async (providerId: string): Promise<ReviewItem | undefined> => {
    const id = await idOf(providerId);
    return (await cards()).find(
      (item) => item.subject.type === "transactions" && item.subject.transactionIds.includes(id),
    );
  };
  const transactionsOf = (item: ReviewItem | undefined) =>
    item?.subject.type === "transactions" ? item.subject.transactionIds : [];
  const decisionOf = async (providerId: string) =>
    readTransactionDecision(bank.database, await idOf(providerId));

  beforeEach(async () => {
    bank = await newTestBank();
    stops = [startMoneyMovement({ database: bank.database }).stop];
    connectionId = await bank.connect(BANK);
    await sql(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES (?, 'Avery Park', 'avery@example.com', '2026-10-01T00:00:00.000Z',
         '2026-10-01T00:00:00.000Z')`,
      [MEMBER],
    );
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  it("puts one person's money on one app on one card, by the name's skeleton, and keeps lines that name no one apart", async () => {
    await sync([
      moneyIn("z1", 2_000, "2026-10-01", "ZELLE PAYMENT FROM JOHN SMITH"),
      moneyIn("z2", 2_100, "2026-10-02", "ZELLE FROM John  Smith"),
      // Full-width letters and a combining mark: the same skeleton (K13).
      moneyIn("z3", 2_200, "2026-10-03", "ZELLE FROM ＪＯＨＮ SMÍTH"),
      // The same person on another app is another card.
      moneyIn("cash", 2_300, "2026-10-04", "CASH APP*JOHN SMITH"),
      moneyIn("morgan", 2_400, "2026-10-05", "VENMO *MORGAN LEE"),
      moneyIn("cashout-1", 2_500, "2026-10-06", "VENMO CASHOUT"),
      moneyIn("cashout-2", 2_600, "2026-10-07", "VENMO CASHOUT"),
    ]);
    const card = await cardOf("z1");
    expect(transactionsOf(card)).toEqual(await idsOf(["z3", "z2", "z1"]));
    expect(card?.decided).toBe("3 payments from this person have no link, so they count as Income.");
    expect(card?.bestAnswer).toEqual({ value: "keep", label: "Keep all as Income" });
    // A link is about one Transaction, so a card of more offers none.
    expect(await otherReviewChoices(bank.database, card?.id ?? "")).toEqual([]);
    expect((await cardOf("cash"))?.id).not.toBe(card?.id);
    expect((await cardOf("cashout-1"))?.id).not.toBe((await cardOf("cashout-2"))?.id);
    expect(await cards()).toHaveLength(5);
    // A card of one works as before.
    expect((await cardOf("morgan"))?.bestAnswer).toEqual({ value: "keep", label: "Keep as Income" });
  });

  it("keeps only the money still on the card as Income, refuses a link on a card of more, and remembers nothing", async () => {
    await sync([
      moneyIn("a", 2_000, "2026-10-01", "ZELLE FROM JOHN SMITH"),
      moneyIn("hidden", 2_100, "2026-10-02", "ZELLE FROM JOHN SMITH"),
      moneyIn("typed", 2_200, "2026-10-03", "ZELLE FROM JOHN SMITH"),
      moneyIn("decided", 2_300, "2026-10-04", "ZELLE FROM JOHN SMITH"),
      moneyIn("linked", 2_400, "2026-10-05", "ZELLE FROM JOHN SMITH"),
      moneyIn("a2", 2_500, "2026-10-06", "ZELLE FROM JOHN SMITH"),
      moneyIn("other", 2_600, "2026-10-07", "ZELLE FROM MORGAN LEE"),
      fakeTxn({
        id: "dinner",
        accountId: CHECKING.id,
        amount: -9_000,
        postedDate: "2026-09-30",
        description: "CORNER BISTRO",
        merchantName: "Corner Bistro",
        category: null,
      }),
    ]);
    const card = await cardOf("a");
    // What changed since the card's last update, which the card's list does not know yet.
    await sql("UPDATE transactions SET hidden_reason = 'removed' WHERE id = ?", [
      await idOf("hidden"),
    ]);
    await setHandSetFields(bank.database, await idOf("typed"), { type: "Transfer" });
    await sql("UPDATE transaction_decisions SET step = '5.7' WHERE transaction_id = ?", [
      await idOf("decided"),
    ]);
    await sql(
      `INSERT INTO spending_links (id, kind, transaction_id, spending_transaction_id, tier, signals,
         ai_answer, ai_confidence, made_by, member_id, created_at)
       VALUES ('l1', 'Reimbursement', ?, ?, 'Unclear', '[]', NULL, NULL, 'Member', NULL, ?)`,
      [await idOf("linked"), await idOf("dinner"), NOW().toISOString()],
    );
    await sql("UPDATE review_items SET subject_ids = ? WHERE id = ?", [
      JSON.stringify([...transactionsOf(card), await idOf("other")]),
      card?.id ?? "",
    ]);
    await sql("DELETE FROM follow_up_changes");

    const link = `link ${await idOf("dinner")}`;
    expect(await answerReviewItem(bank.database, card?.id ?? "", link, MEMBER)).toBe("not a choice");
    // Not even as a best answer, which only a race leaves on a card of more.
    await sql("UPDATE review_items SET best_answer = ? WHERE id = ?", [
      JSON.stringify({ value: link, label: "Yes, it pays back dinner" }),
      card?.id ?? "",
    ]);
    expect(await answerReviewItem(bank.database, card?.id ?? "", link, MEMBER)).toBe("not a choice");
    expect((await sql("SELECT count(*) AS n FROM spending_links")).rows[0]?.n).toBe(1);
    await sql("UPDATE review_items SET best_answer = ? WHERE id = ?", [
      JSON.stringify(card?.bestAnswer),
      card?.id ?? "",
    ]);
    expect(await answerReviewItem(bank.database, card?.id ?? "", "keep", MEMBER)).toBe("answered");
    const marked = (await sql("SELECT DISTINCT transaction_id AS id FROM follow_up_changes")).rows;
    expect(new Set(marked.map((row) => String(row.id)))).toEqual(new Set(await idsOf(["a", "a2"])));
    const typed = (
      await sql(
        "SELECT provider_transaction_id AS id FROM transactions WHERE json_extract(hand_set, '$.type') = 'Income' ORDER BY id",
      )
    ).rows.map((row) => String(row.id));
    expect(typed).toEqual(["a", "a2"]);
    await runFollowUp(NOW);
    expect(await decisionOf("a")).toMatchObject({ step: "1", parts: [{ type: "Income" }] });
    expect(await cardOf("other")).toBeDefined();

    // Nothing is remembered: later money from the same person asks again.
    await sync([moneyIn("later", 3_000, "2026-10-20", "ZELLE FROM JOHN SMITH")]);
    expect(await cardOf("later")).toBeDefined();
  });
});
