import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { addUnconnectedAccount, syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { deleteRemovedConnection, markConnectionRemoved, setHandSetFields } from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import {
  answerReviewItem,
  openReviewItemBatch,
  openReviewItemsOfKind,
  type ReviewItem,
} from "../review/index.ts";
import {
  deleteTransferAnswer,
  linkByHand,
  ONE_SIDED_KIND,
  readTransactionDecision,
  runMatching,
  setTransactionType,
  startMoneyMovement,
  switchExclude,
  totalsByMonth,
  transferAnswerViews,
} from "./index.ts";

// One-sided Transfer cards and remembered answers (spec 03, Review list items), through the
// Matching follow-up step on Transactions the fake adapter syncs, and the Review list.

const NOW = () => new Date("2026-11-01T14:00:00.000Z");
const BANK = "fake-first-bank";
const CHECKING = fakeAccount({ id: "acc-checking", name: "Everyday Checking", mask: "3333" });
const SAVINGS = fakeAccount({
  id: "acc-savings",
  name: "Rainy Day Savings",
  subtype: "savings",
  mask: "4444",
});
const MEMBER = "member-1";

describe("one-sided Transfer cards", () => {
  let bank: TestBank;
  let stops: (() => void)[];
  let connectionId: string;

  const sync = async (added: TxnRecord[], accounts = [CHECKING, SAVINGS]) => {
    bank.fake.addPages(BANK, { accounts, added, historyLoaded: true });
    await syncConnection(connectionId, NOW);
    await runFollowUp(NOW);
  };
  const out = (id: string, amount: number, postedDate: string, description: string) =>
    fakeTxn({ id, accountId: CHECKING.id, amount, postedDate, description, category: null });
  const sql = (statement: string, args: (string | number)[] = []) =>
    bank.database.$client.execute({ sql: statement, args });
  const idOf = async (providerId: string) =>
    String(
      (await sql("SELECT id FROM transactions WHERE provider_transaction_id = ?", [providerId]))
        .rows[0]?.id,
    );
  const idsOf = (providerIds: string[]) => Promise.all(providerIds.map(idOf));
  const cards = () => openReviewItemsOfKind(bank.database, ONE_SIDED_KIND);
  const cardOf = async (providerId: string): Promise<ReviewItem | undefined> => {
    const id = await idOf(providerId);
    return (await cards()).find(
      (item) => item.subject.type === "transactions" && item.subject.transactionIds.includes(id),
    );
  };
  const transactionsOf = (item: ReviewItem | undefined) =>
    item?.subject.type === "transactions" ? item.subject.transactionIds : [];
  const closedReason = async (itemId: string) =>
    (await sql("SELECT closed_reason FROM review_items WHERE id = ?", [itemId])).rows[0]
      ?.closed_reason;
  // The Transactions the follow-up job will handle again.
  const unhandled = async () =>
    new Set(
      (await sql("SELECT DISTINCT transaction_id FROM follow_up_changes")).rows.map((row) =>
        String(row.transaction_id),
      ),
    );
  const answer = async (item: ReviewItem | undefined, value: string) =>
    answerReviewItem(bank.database, item?.id ?? "", value, MEMBER);
  const decisionOf = async (providerId: string) =>
    readTransactionDecision(bank.database, await idOf(providerId));

  beforeEach(async () => {
    bank = await newTestBank();
    stops = [startMoneyMovement({ database: bank.database }).stop];
    await sql(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES (?, 'Jamie', 'jamie@example.com', '2026-10-01T00:00:00.000Z',
         '2026-10-01T00:00:00.000Z')`,
      [MEMBER],
    );
    connectionId = await bank.connect(BANK);
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  it("groups one key on a card, newest first: a new Transaction joins, a row set by hand leaves, and the empty card closes", async () => {
    await sync([
      out("a", -1_000, "2026-10-01", "ONLINE TRANSFER REF 1001"),
      out("b", -2_000, "2026-10-02", "ONLINE TRANSFER REF 1002"),
    ]);
    const card = await cardOf("a");
    expect(transactionsOf(card)).toEqual(await idsOf(["b", "a"]));
    expect(card?.decided).toBe(
      "They name no account, so they count as Transfers. Which account is this?",
    );

    await sync([out("c", -3_000, "2026-10-03", "ONLINE TRANSFER REF 1003")]);
    const joined = await cardOf("c");
    expect(joined?.id).toBe(card?.id);
    expect(transactionsOf(joined)).toEqual(await idsOf(["c", "b", "a"]));

    // "Change" on a row sets that Transaction's type by hand, and it leaves the card.
    await setTransactionType(bank.database, await idOf("b"), "Spending");
    await runFollowUp(NOW);
    expect(transactionsOf(await cardOf("a"))).toEqual(await idsOf(["c", "a"]));

    await setTransactionType(bank.database, await idOf("a"), "Transfer");
    await setTransactionType(bank.database, await idOf("c"), "Spending");
    await runFollowUp(NOW);
    expect(await cards()).toEqual([]);
    expect(await closedReason(card?.id ?? "")).toBe("decided again");
  });

  it("takes the newest Transaction's best answer", async () => {
    await sync([
      out("a", -1_000, "2026-10-01", "ONLINE TRANSFER REF 1001"),
      out("b", -2_000, "2026-10-02", "ONLINE TRANSFER REF 1002"),
    ]);
    expect((await cardOf("a"))?.bestAnswer.value).toBe("keep");
    const only = await addUnconnectedAccount(bank.database, {
      name: "Pinecrest savings",
      kind: "savings",
      institutionName: "Pinecrest Bank",
      mask: "6014",
    });
    // Only the new Transaction is decided with the new account, and it is the newest.
    await sync([out("c", -3_000, "2026-10-03", "ONLINE TRANSFER REF 1003")]);
    const card = await cardOf("a");
    expect(transactionsOf(card)).toHaveLength(3);
    expect(card?.bestAnswer).toEqual({
      value: `account ${only.id}`,
      label: "Yes, Pinecrest savings",
    });
    expect(card?.decided).toBe(
      "They name no account, so the app put them in Pinecrest savings, the only one.",
    );
  });

  it("groups items from before cards once, and a second run changes nothing", async () => {
    await sync([
      out("a", -1_000, "2026-10-01", "ONLINE TRANSFER REF 1001"),
      out("b", -2_000, "2026-10-02", "ONLINE TRANSFER REF 1002"),
      out("c", -3_000, "2026-10-03", "ONLINE TRANSFER REF 1003"),
    ]);
    // The items as they were before cards: one per Transaction.
    await sql("UPDATE review_items SET closed_at = ?, closed_reason = 'test'", [
      NOW().toISOString(),
    ]);
    const old = await openReviewItemBatch(
      bank.database,
      (await idsOf(["a", "b", "c"])).map((id) => ({
        kind: ONE_SIDED_KIND,
        subject: { type: "transactions" as const, transactionIds: [id] },
        decided: "It names no account, so it counts as a Transfer. Which account is this?",
        bestAnswer: { value: "keep", label: "Keep it as a Transfer" },
      })),
    );

    await runMatching(bank.database, []);
    const [card, ...others] = await cards();
    expect(others).toEqual([]);
    expect(old).toContain(card?.id);
    expect(transactionsOf(card)).toEqual(await idsOf(["c", "b", "a"]));
    for (const id of old.filter((each) => each !== card?.id)) {
      expect(await closedReason(id)).toBe("grouped");
    }

    await runMatching(bank.database, []);
    expect(await cards()).toEqual([card]);
  });

  it("answers for only the Transactions still on the card, and never takes an account that may no longer be picked", async () => {
    await sync([
      out("a", -1_000, "2026-10-01", "ONLINE TRANSFER REF 1001"),
      out("hidden", -2_000, "2026-10-02", "ONLINE TRANSFER REF 1002"),
      out("typed", -3_000, "2026-10-03", "ONLINE TRANSFER REF 1003"),
      out("picked", -4_000, "2026-10-04", "ONLINE TRANSFER REF 1004"),
      out("decided", -5_000, "2026-10-05", "ONLINE TRANSFER REF 1005"),
      out("a2", -6_000, "2026-10-06", "ONLINE TRANSFER REF 1006"),
      out("other", -7_000, "2026-10-07", "ONLINE TRANSFER TO SAV XXXX5678"),
    ]);
    const card = await cardOf("a");
    // What changed since the card's last update, which the card's list does not know yet.
    await sql("UPDATE transactions SET hidden_reason = 'removed' WHERE id = ?", [
      await idOf("hidden"),
    ]);
    await setHandSetFields(bank.database, await idOf("typed"), { type: "Spending" });
    await setHandSetFields(bank.database, await idOf("picked"), { unconnectedAccount: "x" });
    await sql("UPDATE transaction_decisions SET step = '5.7' WHERE transaction_id = ?", [
      await idOf("decided"),
    ]);
    // A Transaction of another key on the card, which only a race leaves.
    await sql("UPDATE review_items SET subject_ids = ? WHERE id = ?", [
      JSON.stringify([...transactionsOf(card), await idOf("other")]),
      card?.id ?? "",
    ]);
    await sql("DELETE FROM follow_up_changes");

    // A best answer whose account may no longer be picked: a connected checking Account.
    const [checking] = (
      await sql("SELECT id FROM household_accounts WHERE provider_account_id = ?", [CHECKING.id])
    ).rows;
    await sql("UPDATE review_items SET best_answer = ? WHERE id = ?", [
      JSON.stringify({ value: `account ${String(checking?.id)}`, label: "Yes, checking" }),
      card?.id ?? "",
    ]);
    expect(await answer(card, `account ${String(checking?.id)}`)).toBe("not a choice");
    expect(await transferAnswerViews(bank.database)).toEqual([]);
    expect(await unhandled()).toEqual(new Set());

    expect(await answer(card, "not a transfer")).toBe("answered");
    // The other key's Transaction goes back through the follow-up job too, so it joins its own
    // key's card and never drops off the list, but the answer does not cover it.
    expect(await unhandled()).toEqual(new Set(await idsOf(["a", "a2", "other"])));
    expect(await transferAnswerViews(bank.database)).toEqual([
      expect.objectContaining({
        merchantName: "Online Transfer Ref",
        lastFours: [],
        answer: "Not a Transfer",
      }),
    ]);
    await runFollowUp(NOW);
    expect(await decisionOf("a")).toMatchObject({ step: "5.6", parts: [{ type: "Spending" }] });
    // The other key still asks.
    expect(await cardOf("other")).toBeDefined();
    expect(await decisionOf("other")).toMatchObject({ parts: [{ type: "Transfer" }] });
  });

  it("deletes a remembered answer, and only its key's Transactions not set by hand ask again", async () => {
    await sync([
      out("a1", -1_000, "2026-10-01", "ONLINE TRANSFER REF 1001"),
      out("a2", -2_000, "2026-10-02", "ONLINE TRANSFER REF 1002"),
      out("typed", -2_500, "2026-10-02", "ONLINE TRANSFER REF 1007"),
      out("gone", -2_600, "2026-10-02", "ONLINE TRANSFER REF 1008"),
      out("b1", -3_000, "2026-10-03", "ONLINE TRANSFER TO SAV XXXX5678"),
    ]);
    expect(await answer(await cardOf("a1"), "keep")).toBe("answered");
    expect(await answer(await cardOf("b1"), "keep")).toBe("answered");
    await runFollowUp(NOW);
    expect(await cards()).toEqual([]);
    await setHandSetFields(bank.database, await idOf("typed"), { type: "Transfer" });
    await sql("UPDATE transactions SET hidden_reason = 'removed' WHERE id = ?", [
      await idOf("gone"),
    ]);
    await sql("DELETE FROM follow_up_changes");

    const views = await transferAnswerViews(bank.database);
    expect(views.map((view) => view.lastFours)).toEqual([[], ["5678"]]);
    expect(await deleteTransferAnswer(bank.database, "no-such-answer")).toBe(false);
    expect(await deleteTransferAnswer(bank.database, views[0]?.id ?? "")).toBe(true);
    expect(await unhandled()).toEqual(new Set(await idsOf(["a1", "a2"])));
    await runFollowUp(NOW);
    expect(transactionsOf(await cardOf("a1"))).toEqual(await idsOf(["a2", "a1"]));
    expect(await cardOf("b1")).toBeUndefined();
    expect(await transferAnswerViews(bank.database)).toHaveLength(1);
  });

  it("never ends a hand link or an app link through a remembered answer and its delete, and totals come back", async () => {
    const into = (id: string, amount: number, postedDate: string, description: string) =>
      fakeTxn({ id, accountId: SAVINGS.id, amount, postedDate, description, category: null });
    await sync([
      // A hand link, made below: a month apart, so the app never pairs them.
      out("hand-out", -50_000, "2026-09-01", "ONLINE TRANSFER XXXX4444"),
      into("hand-in", 50_000, "2026-10-01", "ONLINE TRANSFER XXXX4444"),
      // An app link: the same day, naming the savings Account's last 4.
      out("app-out", -20_000, "2026-10-10", "ONLINE TRANSFER XXXX4444"),
      into("app-in", 20_000, "2026-10-10", "ONLINE TRANSFER XXXX4444"),
      // The card, with the same key.
      out("q1", -1_000, "2026-10-12", "ONLINE TRANSFER XXXX4444"),
      out("q2", -2_000, "2026-10-13", "ONLINE TRANSFER XXXX4444"),
    ]);
    expect(
      await linkByHand(
        bank.database,
        {
          kind: "Transfer",
          outTransactionId: await idOf("hand-out"),
          inTransactionId: await idOf("hand-in"),
        },
        MEMBER,
        NOW(),
      ),
    ).toMatchObject({ outcome: "linked" });
    await runFollowUp(NOW);
    const linked = ["hand-out", "hand-in", "app-out", "app-in"];
    const before = await Promise.all(linked.map(decisionOf));
    expect(before.map((decision) => decision?.step)).not.toContain("5.6");
    expect(transactionsOf(await cardOf("q1"))).toEqual(await idsOf(["q2", "q1"]));
    const totals = await totalsByMonth(bank.database);

    expect(await answer(await cardOf("q1"), "not a transfer")).toBe("answered");
    await runFollowUp(NOW);
    expect(await Promise.all(linked.map(decisionOf))).toEqual(before);
    expect(await decisionOf("q1")).toMatchObject({ parts: [{ type: "Spending" }] });
    expect(await totalsByMonth(bank.database)).not.toEqual(totals);

    const [remembered] = await transferAnswerViews(bank.database);
    expect(await deleteTransferAnswer(bank.database, remembered?.id ?? "")).toBe(true);
    await runFollowUp(NOW);
    expect(await Promise.all(linked.map(decisionOf))).toEqual(before);
    expect(await totalsByMonth(bank.database)).toEqual(totals);
  });

  it("drops a remembered answer with its Account when Delete history deletes it", async () => {
    // A second Connection whose Account is excluded, so it counts as an Unconnected account.
    const other = await bank.connect("fake-second-bank");
    const BROKERAGE = fakeAccount({ id: "acc-other", name: "Other Savings", mask: "8888" });
    bank.fake.addPages("fake-second-bank", {
      accounts: [BROKERAGE],
      added: [],
      historyLoaded: true,
    });
    await syncConnection(other, NOW);
    const [excluded] = (
      await sql("SELECT id FROM household_accounts WHERE provider_account_id = ?", [BROKERAGE.id])
    ).rows;
    const excludedId = String(excluded?.id);
    expect(await switchExclude(bank.database, excludedId, true)).toBe(true);
    await sync([
      out("a", -1_000, "2026-10-01", "ONLINE TRANSFER REF 1001"),
      out("b", -2_000, "2026-10-02", "ONLINE TRANSFER REF 1002"),
    ]);
    expect(await answer(await cardOf("a"), `account ${excludedId}`)).toBe("answered");
    await runFollowUp(NOW);
    expect(await transferAnswerViews(bank.database)).toHaveLength(1);

    await markConnectionRemoved(bank.database, other, NOW());
    expect(await deleteRemovedConnection(bank.database, other, NOW())).toBeDefined();
    expect(await transferAnswerViews(bank.database)).toEqual([]);
    await runFollowUp(NOW);
    // They ask again, with no account.
    expect(transactionsOf(await cardOf("a"))).toEqual(await idsOf(["b", "a"]));
  });

  it("passes over a remembered account that may no longer be picked, so its Transactions ask again", async () => {
    const other = await bank.connect("fake-second-bank");
    const KEPT = fakeAccount({ id: "acc-other", name: "Other Savings", mask: "8888" });
    bank.fake.addPages("fake-second-bank", { accounts: [KEPT], added: [], historyLoaded: true });
    await syncConnection(other, NOW);
    const accountId = String(
      (await sql("SELECT id FROM household_accounts WHERE provider_account_id = ?", [KEPT.id]))
        .rows[0]?.id,
    );
    await switchExclude(bank.database, accountId, true);
    await sync([out("a", -1_000, "2026-10-01", "ONLINE TRANSFER REF 1001")]);
    expect(await answer(await cardOf("a"), `account ${accountId}`)).toBe("answered");
    await runFollowUp(NOW);
    expect(await cardOf("a")).toBeUndefined();

    // The Account counts as its own again, so it is no Unconnected account.
    await switchExclude(bank.database, accountId, false);
    await runFollowUp(NOW);
    expect((await cardOf("a"))?.bestAnswer.value).toBe("keep");
  });

  // Each Transaction's Unconnected account, or undefined.
  const assignedTo = async (providerId: string) =>
    (
      await sql("SELECT account_id FROM unconnected_assignments WHERE transaction_id = ?", [
        await idOf(providerId),
      ])
    ).rows[0]?.account_id;
  const typeOf = async (providerId: string) => (await decisionOf(providerId))?.parts[0]?.type;
  const saver = (id: string, postedDate: string, description: string) =>
    fakeTxn({
      id,
      accountId: CHECKING.id,
      amount: -4_000,
      postedDate,
      description,
      category: {
        name: "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS",
        confidence: "VERY_HIGH",
        version: null,
        mcc: null,
      },
    });

  it("puts a remembered answer after an account a Member picked and an account the line names, and before a Saving code", async () => {
    const line = "ONLINE TRANSFER TO BROKERAGE XXXX4821";
    await sync([out("a", -1_000, "2026-10-01", line), saver("coded", "2026-10-02", line)]);
    expect(await answer(await cardOf("a"), "not a transfer")).toBe("answered");
    await runFollowUp(NOW);
    expect(await typeOf("a")).toBe("Spending");
    // A remembered answer beats a Saving code: decided again, the coded line is Spending.
    expect(await typeOf("coded")).toBe("Saving");
    await runMatching(bank.database, [await idOf("coded")]);
    expect(await typeOf("coded")).toBe("Spending");

    // A Member picks an account by hand on one Transaction: the account wins.
    const picked = await addUnconnectedAccount(bank.database, {
      name: "Credit union savings",
      kind: "savings",
      institutionName: "Credit union",
      mask: "1111",
    });
    await setHandSetFields(bank.database, await idOf("a"), { unconnectedAccount: picked.id });
    await runMatching(bank.database, [await idOf("a")]);
    expect(await typeOf("a")).toBe("Transfer");
    expect(await assignedTo("a")).toBe(picked.id);

    // The line names a new account by its last 4: the account wins over the remembered answer.
    const named = await addUnconnectedAccount(bank.database, {
      name: "Brokerage cash",
      kind: "savings",
      institutionName: "Brokerage",
      mask: "4821",
    });
    await sync([out("b", -2_000, "2026-10-03", line)]);
    expect(await typeOf("b")).toBe("Transfer");
    expect(await assignedTo("b")).toBe(named.id);
    expect(await cardOf("b")).toBeUndefined();
  });

  it("keys a card on the line's rules name, so an AI rename after Matching neither splits the card nor misses the answer", async () => {
    const line = (code: string, date: string) =>
      `ONLINE TRANSFER REF #${code} TO PINECREST SAVINGS XXXXXX4821 ON ${date}`;
    const rename = (name: string) =>
      sql("UPDATE transactions SET merchant_clean_name = ?, merchant_needs_ai = 0", [name]);
    // Each line holds its own reference code and date, which never split the card.
    await sync([
      out("a", -1_000, "2026-10-01", line("IB0QQ7XWZ4", "10/01/26")),
      out("b", -2_000, "2026-10-02", line("K22MZP09QA", "10/02/26")),
    ]);
    // AI cleanup renames the lines after Matching decided them, as categorization does.
    await rename("Pinecrest Savings");
    const card = await cardOf("a");
    expect(transactionsOf(card)).toEqual(await idsOf(["b", "a"]));
    expect(await answer(card, "not a transfer")).toBe("answered");
    await runFollowUp(NOW);
    expect(await typeOf("a")).toBe("Spending");
    expect(await typeOf("b")).toBe("Spending");
    expect(await transferAnswerViews(bank.database)).toEqual([
      expect.objectContaining({
        merchantName: "Online Transfer Ref To Pinecrest Savings On",
        lastFours: ["4821"],
      }),
    ]);

    // A later line with the same key takes the answer, renamed before Matching or after.
    bank.fake.addPages(BANK, {
      added: [out("c", -3_000, "2026-10-05", line("ZZ81QK7710", "10/05/26"))],
    });
    await syncConnection(connectionId, NOW);
    await rename("Savings Transfer");
    await runFollowUp(NOW);
    expect(await typeOf("c")).toBe("Spending");
    expect(await cardOf("c")).toBeUndefined();
    expect(await cards()).toEqual([]);
  });

  it("sends a card's Transaction of another key back through the follow-up job, so it asks on its own card", async () => {
    await sync([
      out("a", -1_000, "2026-10-01", "ONLINE TRANSFER TO SAV XXXX5678"),
      out("b", -2_000, "2026-10-02", "ONLINE TRANSFER TO SAV XXXX5678"),
      out("d", -2_500, "2026-10-03", "ONLINE TRANSFER TO SAV XXXX5678"),
    ]);
    const card = await cardOf("a");
    // A provider change gives b another key after the card's last update.
    await sql("UPDATE transactions SET description = ? WHERE id = ?", [
      "ONLINE TRANSFER TO CHK XXXX9012",
      await idOf("b"),
    ]);
    expect(await answer(card, "not a transfer")).toBe("answered");
    await runFollowUp(NOW);
    expect(await typeOf("a")).toBe("Spending");
    expect(await typeOf("d")).toBe("Spending");
    expect(await typeOf("b")).toBe("Transfer");
    expect(transactionsOf(await cardOf("b"))).toEqual([await idOf("b")]);
  });
});
