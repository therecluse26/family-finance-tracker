import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startCategorization } from "../categorization/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import {
  addManualLoan,
  editManualLoan,
  linkByHand,
  type ManualLoanInput,
  startMoneyMovement,
  totalsByMonth,
  undoLink,
} from "../money-movement/index.ts";
import { type FakePage, fakeAccount, fakeTxn } from "./fake.ts";
import { connectionRemoving, type SyncReport, syncConnection, type TxnRecord } from "./index.ts";
import { newTestBank, type TestBank } from "./testing.ts";

// Refusals through a re-link (spec 02, Link carry-over; spec 03, Undo and hand links): after an
// undo, the app never makes that same link again. A bank removed and linked again hides its old
// Transactions dated on or after day D, and each refusal on one of them moves to its new copy with
// the hand-made links, so the app does not make the undone link again on the copy. A refusal whose
// old Transaction gets no copy ends with the wait for copies, as a hand-made link does. Through the
// fake adapter's syncs and the follow-up job.

const NOW = () => new Date("2026-11-20T14:00:00.000Z");
// The old Connections' last successful sync: day D is 2026-10-12.
const OLD_SYNC = () => new Date("2026-10-12T18:00:00.000Z");
const D = "2026-10-12";
const MEMBER = "member-1";
const CLOTHING = "GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES";
const RESTAURANT = "FOOD_AND_DRINK_RESTAURANT";
const OUT = "TRANSFER_OUT_ACCOUNT_TRANSFER";
const IN = "TRANSFER_IN_ACCOUNT_TRANSFER";

const CHECKING = fakeAccount({ id: "maple-checking", mask: "1111" });
// The same checking Account under the new Connection's provider ID.
const NEW_CHECKING = { ...CHECKING, id: "maple-checking-2" };
const CARD = fakeAccount({
  id: "birch-card",
  type: "credit",
  subtype: "credit card",
  mask: "3333",
});
const SAVINGS = fakeAccount({ id: "birch-savings", subtype: "savings", mask: "2222" });
// Birch's Accounts under a new Connection's provider IDs.
const NEW_CARD = { ...CARD, id: "birch-card-2" };
const NEW_SAVINGS = { ...SAVINGS, id: "birch-savings-2" };

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
    description: `LINE ${id.toUpperCase()}`,
    category:
      code === undefined ? null : { name: code, confidence: "HIGH", version: "v2", mcc: null },
    ...rest,
  });
};

// The new copy of an old Transaction: the same amount, posted date, and description.
const copyOf = (old: TxnRecord, id: string, account: { id: string }): TxnRecord => ({
  ...old,
  id,
  accountId: account.id,
});

// A purchase on Maple checking before day D, and its Refund on day D, which the app links.
const SHOES = txn("m-shoes", CHECKING, -10_000, "2026-09-10", {
  code: CLOTHING,
  merchantName: "Shoe Barn",
});
const REFUND = txn("m-refund", CHECKING, 4_000, D, {
  code: CLOTHING,
  merchantName: "Shoe Barn",
  description: "SHOE BARN REFUND",
});
const REFUND_COPY = copyOf(REFUND, "n-refund", NEW_CHECKING);
// A Transfer pair the app makes, Maple checking to Birch savings on day D, and one the other way.
const PAIR_OUT = txn("m-out", CHECKING, -30_000, D, { code: OUT });
const PAIR_IN = txn("b-in", SAVINGS, 30_000, D, { code: IN });
const PAIR_OUT_COPY = copyOf(PAIR_OUT, "n-out", NEW_CHECKING);
const BACK_OUT = txn("b-back-out", SAVINGS, -20_000, D, { code: OUT });
const BACK_IN = txn("m-back-in", CHECKING, 20_000, D, { code: IN });
const BACK_IN_COPY = copyOf(BACK_IN, "n-back-in", NEW_CHECKING);
// A lunch on Maple checking and its Refund, both on day D, which the app links.
const LUNCH = txn("m-lunch", CHECKING, -4_000, D, {
  code: RESTAURANT,
  merchantName: "Corner Cafe",
});
const LUNCH_REFUND = txn("m-lunch-refund", CHECKING, 4_000, D, {
  code: RESTAURANT,
  merchantName: "Corner Cafe",
  description: "CORNER CAFE REFUND",
});

describe("refusals through a re-link", () => {
  let bank: TestBank;
  let stops: (() => void)[];
  let maple: string;
  let birch: string;
  let relinked: string;

  beforeEach(async () => {
    bank = await newTestBank();
    stops = [
      startMoneyMovement({ database: bank.database }).stop,
      startCategorization({ database: bank.database }).stop,
    ];
    await bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('${MEMBER}', 'Jamie', 'jamie@example.com', '2026-10-01T00:00:00.000Z',
         '2026-10-01T00:00:00.000Z')`,
    );
    maple = await bank.connect("maple", "Maple Bank");
    birch = await bank.connect("birch", "Birch Bank");
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  const rows = async (sql: string, args: string[] = []) =>
    (await bank.database.$client.execute({ sql, args })).rows.map((row) => ({ ...row }));

  // The old Connections' history as of day D, and the follow-up job.
  async function oldHistory(mapleAdded: TxnRecord[], birchAdded: TxnRecord[]) {
    bank.fake.addPages(maple, { accounts: [CHECKING], added: mapleAdded, historyLoaded: true });
    await syncConnection(maple, OLD_SYNC);
    bank.fake.addPages(birch, {
      accounts: [CARD, SAVINGS],
      added: birchAdded,
      historyLoaded: true,
    });
    await syncConnection(birch, OLD_SYNC);
    await runFollowUp(NOW);
  }

  // The Member removes Maple Bank, then links it again: a new Connection, not synced yet.
  async function linkAgain() {
    expect(await connectionRemoving().remove(maple)).toEqual({ outcome: "removed" });
    relinked = await bank.connect("maple", "Maple Bank");
  }

  // One sync of the new Connection, with the carried checking Account, then the follow-up job.
  async function syncNew(page: FakePage): Promise<SyncReport> {
    bank.fake.addPages(relinked, { accounts: [NEW_CHECKING], ...page });
    const report = await syncConnection(relinked, NOW);
    await runFollowUp(NOW);
    return report;
  }

  // Every link, by its sides' provider IDs, with its maker.
  const links = () =>
    rows(
      `SELECT 'Transfer' AS kind, o.provider_transaction_id || ' → ' || i.provider_transaction_id
         AS pair, l.made_by AS madeBy
       FROM transfer_links l
       JOIN transactions o ON o.id = l.out_transaction_id
       JOIN transactions i ON i.id = l.in_transaction_id
       UNION ALL
       SELECT l.kind, m.provider_transaction_id || ' → ' || s.provider_transaction_id, l.made_by
       FROM spending_links l
       JOIN transactions m ON m.id = l.transaction_id
       JOIN transactions s ON s.id = l.spending_transaction_id
       UNION ALL
       SELECT 'loan', t.provider_transaction_id || ' → loan', l.made_by
       FROM loan_links l JOIN transactions t ON t.id = l.transaction_id
       ORDER BY 1, 2`,
    );

  // Every refusal, by its sides' provider IDs. A loan's side is "loan".
  const refusals = () =>
    rows(
      `SELECT 'Transfer' AS kind, o.provider_transaction_id || ' → ' || i.provider_transaction_id
         AS pair
       FROM refused_transfer_links r
       JOIN transactions o ON o.id = r.out_transaction_id
       JOIN transactions i ON i.id = r.in_transaction_id
       UNION ALL
       SELECT r.kind, t.provider_transaction_id || ' → ' ||
         coalesce(o.provider_transaction_id, 'loan')
       FROM refused_links r
       JOIN transactions t ON t.id = r.transaction_id
       LEFT JOIN transactions o ON o.id = r.other_id
       ORDER BY 1, 2`,
    );

  // A Member undoes the app's link that uses this Transaction.
  async function undoAppLink(providerId: string) {
    const [link] = await rows(
      `SELECT l.id FROM transactions t
       JOIN (SELECT id, out_transaction_id AS a, in_transaction_id AS b FROM transfer_links
             UNION ALL SELECT id, transaction_id, spending_transaction_id FROM spending_links
             UNION ALL SELECT id, transaction_id, transaction_id FROM loan_links) l
         ON t.id IN (l.a, l.b)
       WHERE t.provider_transaction_id = ?`,
      [providerId],
    );
    expect(await undoLink(bank.database, String(link?.id), MEMBER, NOW())).toBe(true);
    await runFollowUp(NOW);
  }

  const month = async (name: string) =>
    (await totalsByMonth(bank.database)).find((totals) => totals.month === name);
  const totals = async () => ({
    september: await month("2026-09"),
    october: await month("2026-10"),
  });

  it("never makes an undone app Refund link again on the new copy", async () => {
    await oldHistory([SHOES, REFUND], []);
    expect(await links()).toEqual([{ kind: "Refund", pair: "m-refund → m-shoes", madeBy: "app" }]);
    await undoAppLink("m-refund");
    expect(await links()).toEqual([]);
    const before = await totals();

    await linkAgain();
    await syncNew({ added: [REFUND_COPY], historyLoaded: true });

    expect(await links()).toEqual([]);
    expect(await refusals()).toEqual([{ kind: "Refund", pair: "n-refund → m-shoes" }]);
    expect(await totals()).toEqual(before);
  });

  it("never pairs an undone app Transfer again on the new copies, on either side", async () => {
    await oldHistory([PAIR_OUT, BACK_IN], [PAIR_IN, BACK_OUT]);
    expect(await links()).toEqual([
      { kind: "Transfer", pair: "b-back-out → m-back-in", madeBy: "app" },
      { kind: "Transfer", pair: "m-out → b-in", madeBy: "app" },
    ]);
    await undoAppLink("m-out");
    await undoAppLink("m-back-in");

    await linkAgain();
    await syncNew({ added: [PAIR_OUT_COPY, BACK_IN_COPY], historyLoaded: true });

    expect(await links()).toEqual([]);
    expect(await refusals()).toEqual([
      { kind: "Transfer", pair: "b-back-out → n-back-in" },
      { kind: "Transfer", pair: "n-out → b-in" },
    ]);
  });

  it("never links an undone app payment to a Manual loan again on its new copy", async () => {
    const lender: ManualLoanInput = {
      lender: "Lakeside Credit",
      kind: "car",
      balance: 1_000_000,
      balanceDate: "2026-07-01",
      apr: 7.3,
      regularPayment: 45_000,
      escrow: null,
      loanType: null,
    };
    const payment = txn("m-payment", CHECKING, -45_000, D, {
      description: "LAKESIDE CREDIT PMT",
      merchantName: "Lakeside Credit",
    });
    await oldHistory([payment], []);
    const loan = await addManualLoan(bank.database, lender, MEMBER);
    await runFollowUp(NOW);
    expect(await links()).toEqual([{ kind: "loan", pair: "m-payment → loan", madeBy: "app" }]);
    await undoAppLink("m-payment");

    await linkAgain();
    await syncNew({ added: [copyOf(payment, "n-payment", NEW_CHECKING)], historyLoaded: true });
    // An edit of the loan looks for its payments again.
    await editManualLoan(bank.database, loan.id, lender, MEMBER);
    await runFollowUp(NOW);

    expect(await links()).toEqual([]);
    expect(await refusals()).toEqual([{ kind: "loan", pair: "n-payment → loan" }]);
  });

  it("moves a refusal whose two sides both get copies", async () => {
    await oldHistory([LUNCH, LUNCH_REFUND], []);
    expect(await links()).toEqual([
      { kind: "Refund", pair: "m-lunch-refund → m-lunch", madeBy: "app" },
    ]);
    await undoAppLink("m-lunch-refund");

    await linkAgain();
    await syncNew({
      added: [
        copyOf(LUNCH, "n-lunch", NEW_CHECKING),
        copyOf(LUNCH_REFUND, "n-lunch-refund", NEW_CHECKING),
      ],
      historyLoaded: true,
    });

    expect(await links()).toEqual([]);
    expect(await refusals()).toEqual([{ kind: "Refund", pair: "n-lunch-refund → n-lunch" }]);
  });

  it("leaves a refusal the copy already holds on the old Transaction", async () => {
    await oldHistory([SHOES, REFUND], []);
    await undoAppLink("m-refund");
    await linkAgain();
    bank.fake.addPages(relinked, {
      accounts: [NEW_CHECKING],
      added: [REFUND_COPY],
      historyLoaded: true,
    });
    await syncConnection(relinked, NOW);
    // The same refusal is on the copy before the follow-up job moves the old one.
    await bank.database.$client.execute(
      `INSERT INTO refused_links (kind, transaction_id, other_id, refused_by, member_id, refused_at)
       SELECT kind, (SELECT id FROM transactions WHERE provider_transaction_id = 'n-refund'),
         other_id, refused_by, member_id, refused_at FROM refused_links`,
    );

    await runFollowUp(NOW);

    expect(await links()).toEqual([]);
    expect(await refusals()).toEqual([
      { kind: "Refund", pair: "m-refund → m-shoes" },
      { kind: "Refund", pair: "n-refund → m-shoes" },
    ]);
  });

  it("leaves a Transfer refusal the copy already holds on the old Transaction", async () => {
    await oldHistory([PAIR_OUT], [PAIR_IN]);
    await undoAppLink("m-out");
    await linkAgain();
    bank.fake.addPages(relinked, {
      accounts: [NEW_CHECKING],
      added: [PAIR_OUT_COPY],
      historyLoaded: true,
    });
    await syncConnection(relinked, NOW);
    // The same refusal is on the copy before the follow-up job moves the old one.
    await bank.database.$client.execute(
      `INSERT INTO refused_transfer_links
         (out_transaction_id, in_transaction_id, refused_by, member_id, refused_at)
       SELECT (SELECT id FROM transactions WHERE provider_transaction_id = 'n-out'),
         in_transaction_id, refused_by, member_id, refused_at FROM refused_transfer_links`,
    );

    await runFollowUp(NOW);

    expect(await links()).toEqual([]);
    expect(await refusals()).toEqual([
      { kind: "Transfer", pair: "m-out → b-in" },
      { kind: "Transfer", pair: "n-out → b-in" },
    ]);
  });

  // K5: the copy is stored, then the sync fails. The follow-up job moves the refusal from what was
  // stored, and it holds through the retry.
  it("moves a refusal when the first history load fails partway, and keeps it through the retry", async () => {
    await oldHistory([SHOES, REFUND, PAIR_OUT], [PAIR_IN]);
    await undoAppLink("m-refund");
    await undoAppLink("m-out");
    await linkAgain();
    bank.fake.addPages(
      relinked,
      { accounts: [NEW_CHECKING], added: [REFUND_COPY] },
      { added: [PAIR_OUT_COPY], historyLoaded: true },
    );
    bank.fake.failAt(relinked, 1, "temporary");

    await expect(syncConnection(relinked, NOW)).rejects.toThrow("temporary");
    await runFollowUp(NOW);
    expect(await links()).toEqual([]);
    expect(await refusals()).toEqual([
      { kind: "Refund", pair: "n-refund → m-shoes" },
      { kind: "Transfer", pair: "m-out → b-in" },
    ]);

    await syncConnection(relinked, NOW);
    await runFollowUp(NOW);
    expect(await links()).toEqual([]);
    expect(await refusals()).toEqual([
      { kind: "Refund", pair: "n-refund → m-shoes" },
      { kind: "Transfer", pair: "n-out → b-in" },
    ]);
  });

  // K12: a hand link, an app link, and a refusal through the re-link, with the totals before,
  // during, and after.
  it("keeps a hand link, an app link, and a refusal through the re-link, with the same totals", async () => {
    const out2 = txn("m-out2", CHECKING, -20_000, D, { code: OUT });
    const in2 = txn("b-in2", SAVINGS, 20_000, D, { code: IN });
    const boots = txn("b-boots", CARD, -8_000, "2026-09-12", {
      code: CLOTHING,
      merchantName: "Boot Hut",
    });
    const bootsRefund = txn("m-boots-refund", CHECKING, 3_000, D, {
      code: CLOTHING,
      description: "BOOT HUT REFUND",
    });
    await oldHistory([SHOES, REFUND, PAIR_OUT, out2, bootsRefund], [PAIR_IN, in2, boots]);
    await undoAppLink("m-refund");
    const ids = async (providerId: string) =>
      String(
        (
          await rows("SELECT id FROM transactions WHERE provider_transaction_id = ?", [providerId])
        )[0]?.id,
      );
    const made = await linkByHand(
      bank.database,
      {
        kind: "Refund",
        transactionId: await ids("m-boots-refund"),
        spendingTransactionId: await ids("b-boots"),
      },
      MEMBER,
      NOW(),
    );
    expect(made.outcome).toBe("linked");
    await runFollowUp(NOW);
    const shapes = [
      { kind: "Refund", pair: "m-boots-refund → b-boots", madeBy: "Member" },
      { kind: "Transfer", pair: "m-out → b-in", madeBy: "app" },
      { kind: "Transfer", pair: "m-out2 → b-in2", madeBy: "app" },
    ];
    expect(await links()).toEqual(shapes);
    expect(await refusals()).toEqual([{ kind: "Refund", pair: "m-refund → m-shoes" }]);
    const before = await totals();
    expect(before.september).toMatchObject({ byCategory: { Clothing: 15_000 } });

    // During: the hand link and the refusal wait, and the app links have ended.
    await linkAgain();
    await syncNew({ added: [] });
    expect(await links()).toEqual([shapes[0]]);
    expect(await refusals()).toEqual([{ kind: "Refund", pair: "m-refund → m-shoes" }]);
    expect(await month("2026-09")).toMatchObject({ byCategory: { Clothing: 18_000 } });

    // After: the hand link and the refusal moved, the app pairs the copies again, and the totals
    // are as before.
    await syncNew({
      added: [
        REFUND_COPY,
        PAIR_OUT_COPY,
        copyOf(out2, "n-out2", NEW_CHECKING),
        copyOf(bootsRefund, "n-boots-refund", NEW_CHECKING),
      ],
      historyLoaded: true,
    });
    expect(await links()).toEqual([
      { kind: "Refund", pair: "n-boots-refund → b-boots", madeBy: "Member" },
      { kind: "Transfer", pair: "n-out → b-in", madeBy: "app" },
      { kind: "Transfer", pair: "n-out2 → b-in2", madeBy: "app" },
    ]);
    expect(await refusals()).toEqual([{ kind: "Refund", pair: "n-refund → m-shoes" }]);
    expect(await totals()).toEqual(before);
  });

  describe("a refusal whose old Transaction gets no copy", () => {
    // Kept: dated before day D, so the re-link hides neither side.
    const keptLunch = { ...LUNCH, id: "m-early-lunch", postedDate: "2026-10-01" };
    const keptRefund = { ...LUNCH_REFUND, id: "m-early-refund", postedDate: "2026-10-02" };

    beforeEach(async () => {
      await oldHistory([SHOES, REFUND, keptLunch, keptRefund], []);
      await undoAppLink("m-refund");
      await undoAppLink("m-early-refund");
      await linkAgain();
      await syncNew({ added: [] });
      expect(await refusals()).toEqual([
        { kind: "Refund", pair: "m-early-refund → m-early-lunch" },
        { kind: "Refund", pair: "m-refund → m-shoes" },
      ]);
    });

    it("ends when the first history load ends, so a copy that comes later takes none", async () => {
      await syncNew({ historyLoaded: true });
      expect(await refusals()).toEqual([
        { kind: "Refund", pair: "m-early-refund → m-early-lunch" },
      ]);

      await syncNew({ added: [REFUND_COPY] });
      expect(await refusals()).toEqual([
        { kind: "Refund", pair: "m-early-refund → m-early-lunch" },
      ]);
      expect(await links()).toEqual([
        { kind: "Refund", pair: "n-refund → m-shoes", madeBy: "app" },
      ]);
    });

    it("ends when the new Connection is removed before its history loads", async () => {
      expect(await connectionRemoving().remove(relinked)).toEqual({ outcome: "removed" });

      expect(await refusals()).toEqual([
        { kind: "Refund", pair: "m-early-refund → m-early-lunch" },
      ]);
    });

    // K6: a delete with a moved refusal present.
    it("goes with the new Connection's Delete history after it moved", async () => {
      await syncNew({ added: [REFUND_COPY], historyLoaded: true });
      expect(await refusals()).toContainEqual({ kind: "Refund", pair: "n-refund → m-shoes" });

      // The carried Account keeps the old Connection's Transactions before day D, and the moved
      // refusal stays.
      expect(await connectionRemoving().deleteHistory(maple)).toMatchObject({ outcome: "deleted" });
      expect(await refusals()).toEqual([
        { kind: "Refund", pair: "m-early-refund → m-early-lunch" },
        { kind: "Refund", pair: "n-refund → m-shoes" },
      ]);

      expect(await connectionRemoving().remove(relinked)).toEqual({ outcome: "removed" });
      expect(await connectionRemoving().deleteHistory(relinked)).toMatchObject({
        outcome: "deleted",
      });
      await runFollowUp(NOW);
      expect(await rows("SELECT * FROM refused_links")).toEqual([]);
      expect(await links()).toEqual([]);
    });
  });

  // Only the Connection whose wait ends loses its refusals with no copy. Birch, linked again too,
  // still waits for its history, and its refusal moves when its copies come.
  it("ends only the refusals of the Connection whose wait ends", async () => {
    const birchRefund = txn("b-shoes-refund", CARD, 4_000, D, {
      code: CLOTHING,
      merchantName: "Shoe Barn",
    });
    const birchShoes = { ...SHOES, id: "b-shoes", accountId: CARD.id, postedDate: D };
    await oldHistory([], [birchShoes, birchRefund]);
    await undoAppLink("b-shoes-refund");
    expect(await refusals()).toEqual([{ kind: "Refund", pair: "b-shoes-refund → b-shoes" }]);
    expect(await connectionRemoving().remove(birch)).toEqual({ outcome: "removed" });
    const birchAgain = await bank.connect("birch", "Birch Bank");
    bank.fake.addPages(birchAgain, { accounts: [NEW_CARD, NEW_SAVINGS] });
    await syncConnection(birchAgain, NOW);

    // Maple, linked again, loads all its history with no copy of anything.
    await linkAgain();
    await syncNew({ historyLoaded: true });
    expect(await refusals()).toEqual([{ kind: "Refund", pair: "b-shoes-refund → b-shoes" }]);

    bank.fake.addPages(birchAgain, {
      added: [
        copyOf(birchShoes, "nb-shoes", NEW_CARD),
        copyOf(birchRefund, "nb-shoes-refund", NEW_CARD),
      ],
      historyLoaded: true,
    });
    await syncConnection(birchAgain, NOW);
    await runFollowUp(NOW);
    expect(await refusals()).toEqual([{ kind: "Refund", pair: "nb-shoes-refund → nb-shoes" }]);
    expect(await links()).toEqual([]);
  });
});
