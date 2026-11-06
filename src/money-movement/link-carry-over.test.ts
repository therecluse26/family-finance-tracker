import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FakePage, fakeAccount, fakeTxn } from "../bank/fake.ts";
import {
  connectionRemoving,
  endLongCopyWaits,
  type SyncReport,
  syncConnection,
  type TxnRecord,
} from "../bank/index.ts";
import { COPIES_WAIT_CAP_DAYS, COPIES_WAIT_END_TRIES } from "../bank/sync-times.ts";
import {
  newTestBank,
  SyncConnectionJob,
  TEST_BANK_JOB_LIST,
  type TestBank,
} from "../bank/testing.ts";
import { startCategorization } from "../categorization/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { startJob, startJobs } from "../jobs/index.ts";
import {
  addManualLoan,
  type HandLink,
  linkByHand,
  type MoneyToPick,
  readTransactionDecision,
  registerReimbursementPicker,
  startMoneyMovement,
  totalsByMonth,
  undoLink,
} from "./index.ts";

// Link carry-over (spec 02, Carrying Accounts over; spec 03, Undo and hand links): a bank removed
// and linked again carries its checking Account over, and history splits at day D. Each hand-made
// link on an old Transaction hidden as "replaced by re-link" moves to its new copy, through the
// fake adapter's syncs and the follow-up job.

const NOW = () => new Date("2026-11-20T14:00:00.000Z");
// The old Connection's last successful sync: day D is 2026-10-12.
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
// An Account at the same bank that only the new Connection has.
const NEW_SAVINGS = fakeAccount({ id: "maple-savings-2", subtype: "savings", mask: "5555" });
const CARD = fakeAccount({
  id: "birch-card",
  type: "credit",
  subtype: "credit card",
  mask: "3333",
});
const SAVINGS = fakeAccount({ id: "birch-savings", subtype: "savings", mask: "2222" });

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

// The purchase at Birch, and the Refund on Maple checking on day D that a Member links to it.
const SHOES = txn("b-shoes", CARD, -10_000, "2026-09-10", { code: CLOTHING });
const REFUND = txn("m-refund", CHECKING, 4_000, D, {
  code: CLOTHING,
  description: "SHOE BARN REFUND",
});
// Its new copy: the same Account, amount, posted date, and description.
const REFUND_COPY = { ...REFUND, id: "n-refund", accountId: NEW_CHECKING.id };
// A Transfer pair the app makes, Maple checking to Birch savings on day D.
const PAIR_OUT = txn("m-out", CHECKING, -30_000, D, { code: OUT });
const PAIR_IN = txn("b-in", SAVINGS, 30_000, D, { code: IN });
const PAIR_OUT_COPY = { ...PAIR_OUT, id: "n-out", accountId: NEW_CHECKING.id };

describe("Link carry-over after a bank is linked again", () => {
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
  const idOf = async (providerId: string) =>
    String(
      (await rows("SELECT id FROM transactions WHERE provider_transaction_id = ?", [providerId]))[0]
        ?.id,
    );

  // The old Connection's history and Birch's, as of day D, and the follow-up job.
  async function oldHistory(oldAdded: TxnRecord[], birchAdded: TxnRecord[]) {
    bank.fake.addPages(maple, { accounts: [CHECKING], added: oldAdded, historyLoaded: true });
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

  // Every link, by its sides' provider IDs, with its ID, maker, and Member.
  const links = () =>
    rows(
      `SELECT 'Transfer' AS kind, o.provider_transaction_id || ' → ' || i.provider_transaction_id
         AS pair, l.id, l.made_by AS madeBy, l.member_id AS memberId
       FROM transfer_links l
       JOIN transactions o ON o.id = l.out_transaction_id
       JOIN transactions i ON i.id = l.in_transaction_id
       UNION ALL
       SELECT l.kind, m.provider_transaction_id || ' → ' || s.provider_transaction_id, l.id,
         l.made_by, l.member_id
       FROM spending_links l
       JOIN transactions m ON m.id = l.transaction_id
       JOIN transactions s ON s.id = l.spending_transaction_id
       ORDER BY 1, 2`,
    );
  const shapes = async () =>
    (await links()).map(({ kind, pair, madeBy }) => ({ kind, pair, madeBy }));

  const linkHand = async (link: HandLink): Promise<string> => {
    const made = await linkByHand(bank.database, link, MEMBER, NOW());
    if (made.outcome !== "linked") throw new Error(`Not linked: ${made.outcome}`);
    await runFollowUp(NOW);
    return made.linkId;
  };
  const refundByHand = async (money: string, spending: string) =>
    linkHand({
      kind: "Refund",
      transactionId: await idOf(money),
      spendingTransactionId: await idOf(spending),
    });
  // The app pairs these; the Member's hand link takes the pair over, as from the Transactions page.
  const transferByHand = async (out: string, into: string) =>
    linkHand({
      kind: "Transfer",
      outTransactionId: await idOf(out),
      inTransactionId: await idOf(into),
    });

  const month = async (name: string) =>
    (await totalsByMonth(bank.database)).find((totals) => totals.month === name);
  const totals = async () => ({
    september: await month("2026-09"),
    october: await month("2026-10"),
  });
  const decisionOf = async (providerId: string) =>
    readTransactionDecision(bank.database, await idOf(providerId));

  it("moves a hand Refund link on a Transaction dated D to its new copy, and keeps the totals", async () => {
    await oldHistory([REFUND], [SHOES]);
    const linkId = await refundByHand("m-refund", "b-shoes");
    const [made] = await links();
    expect(await month("2026-09")).toMatchObject({
      spending: 6_000,
      byCategory: { Clothing: 6_000 },
    });
    const shoes = await decisionOf("b-shoes");

    // The first page of the new Connection's history has no copy yet. The Refund is hidden and
    // counts nowhere meanwhile, but its link waits, so the purchase keeps its linked state.
    await linkAgain();
    await syncNew({ added: [txn("n-coffee", NEW_CHECKING, -500, "2026-10-05")] });

    expect(await links()).toEqual([made]);
    expect(await decisionOf("b-shoes")).toEqual(shoes);
    expect(await month("2026-09")).toMatchObject({ byCategory: { Clothing: 10_000 } });

    // The copy arrives as the history finishes loading.
    await syncNew({ added: [REFUND_COPY], historyLoaded: true });

    expect(await links()).toEqual([
      { ...made, pair: "n-refund → b-shoes", id: linkId, madeBy: "Member", memberId: MEMBER },
    ]);
    expect(await month("2026-09")).toMatchObject({
      spending: 6_000,
      byCategory: { Clothing: 6_000 },
    });
    expect((await month("2026-10"))?.byCategory.Clothing ?? 0).toBe(0);
    expect(await decisionOf("n-refund")).toMatchObject({
      parts: [{ type: "Refund", amount: 4_000, category: "Clothing", linked: true }],
    });
    // The new Connection records the old one whose Account it carries on.
    expect(
      await rows("SELECT connection_id, old_connection_id FROM connection_carry_overs"),
    ).toEqual([{ connection_id: relinked, old_connection_id: maple }]);
  });

  it("ends an app-made Transfer pair on a replaced Transaction at once, and pairs its copy again", async () => {
    await oldHistory([PAIR_OUT], [PAIR_IN]);
    const [app] = await links();
    expect(app).toMatchObject({ pair: "m-out → b-in", madeBy: "app" });

    await linkAgain();
    await syncNew({ added: [] });
    expect(await links()).toEqual([]);

    await syncNew({ added: [PAIR_OUT_COPY], historyLoaded: true });
    const [again] = await links();
    expect(again).toMatchObject({ kind: "Transfer", pair: "n-out → b-in", madeBy: "app" });
    expect(again?.id).not.toBe(app?.id);
  });

  it("ends a hand link once when the first history load ends with no copy, and matches again", async () => {
    await oldHistory([REFUND], [SHOES]);
    await refundByHand("m-refund", "b-shoes");
    await linkAgain();

    expect(await syncNew({ added: [] })).toMatchObject({ copiesNoLongerAwaited: false });
    expect(await shapes()).toEqual([
      { kind: "Refund", pair: "m-refund → b-shoes", madeBy: "Member" },
    ]);

    expect(await syncNew({ historyLoaded: true })).toMatchObject({ copiesNoLongerAwaited: true });
    expect(await links()).toEqual([]);
    expect(await month("2026-09")).toMatchObject({ byCategory: { Clothing: 10_000 } });

    // An end state: a copy that comes later finds nothing to take, and no later sync asks again.
    expect(await syncNew({ added: [REFUND_COPY] })).toMatchObject({ copiesNoLongerAwaited: false });
    expect(await links()).toEqual([]);
    expect(await decisionOf("n-refund")).toMatchObject({ parts: [{ type: "Refund" }] });
  });

  it("pairs two old Transactions with two copies one to one, the same description first", async () => {
    const boots = txn("b-boots", CARD, -8_000, "2026-09-12", { code: CLOTHING });
    const bootsRefund = txn("m-boots-refund", CHECKING, 4_000, D, {
      code: CLOTHING,
      description: "BOOT HUT REFUND",
    });
    await oldHistory([REFUND, bootsRefund], [SHOES, boots]);
    await refundByHand("m-refund", "b-shoes");
    await refundByHand("m-boots-refund", "b-boots");
    await linkAgain();

    // The bank wrote one copy's description another way, so it pairs after the other one.
    await syncNew({
      added: [
        { ...bootsRefund, id: "n-1", accountId: NEW_CHECKING.id },
        { ...REFUND, id: "n-2", accountId: NEW_CHECKING.id, description: "ACH CREDIT" },
      ],
      historyLoaded: true,
    });

    expect(await shapes()).toEqual([
      { kind: "Refund", pair: "n-1 → b-boots", madeBy: "Member" },
      { kind: "Refund", pair: "n-2 → b-shoes", madeBy: "Member" },
    ]);
  });

  it("still moves the links when the first history load fails partway, then a retry finishes it", async () => {
    await oldHistory([REFUND, PAIR_OUT], [SHOES, PAIR_IN]);
    await refundByHand("m-refund", "b-shoes");
    await transferByHand("m-out", "b-in");
    await linkAgain();
    bank.fake.addPages(
      relinked,
      { accounts: [NEW_CHECKING], added: [REFUND_COPY] },
      { added: [PAIR_OUT_COPY], historyLoaded: true },
    );
    bank.fake.failAt(relinked, 1, "temporary");

    // The first page is stored, then the sync fails. The follow-up job runs on what it stored.
    await expect(syncConnection(relinked, NOW)).rejects.toThrow("temporary");
    await runFollowUp(NOW);
    expect(await shapes()).toEqual([
      { kind: "Refund", pair: "n-refund → b-shoes", madeBy: "Member" },
      { kind: "Transfer", pair: "m-out → b-in", madeBy: "Member" },
    ]);

    await syncConnection(relinked, NOW);
    await runFollowUp(NOW);
    expect(await shapes()).toEqual([
      { kind: "Refund", pair: "n-refund → b-shoes", madeBy: "Member" },
      { kind: "Transfer", pair: "n-out → b-in", madeBy: "Member" },
    ]);
  });

  it("moves a hand link to a Manual loan to the payment's new copy", async () => {
    const payment = txn("m-loan-payment", CHECKING, -45_000, D, { description: "LOAN PMT" });
    await oldHistory([payment], []);
    const loan = await addManualLoan(
      bank.database,
      {
        lender: "Lakeside Credit",
        kind: "car",
        balance: 1_000_000,
        balanceDate: "2026-09-01",
        apr: 7.3,
        regularPayment: null,
        escrow: null,
        loanType: null,
      },
      MEMBER,
    );
    const linkId = await linkHand({
      kind: "loan",
      transactionId: await idOf("m-loan-payment"),
      loanAccountId: loan.id,
    });
    await linkAgain();

    await syncNew({
      added: [{ ...payment, id: "n-loan-payment", accountId: NEW_CHECKING.id }],
      historyLoaded: true,
    });

    expect(
      await rows(
        `SELECT l.id, t.provider_transaction_id AS payment, l.made_by AS madeBy
         FROM loan_links l JOIN transactions t ON t.id = l.transaction_id`,
      ),
    ).toEqual([{ id: linkId, payment: "n-loan-payment", madeBy: "Member" }]);
  });

  // K12: totals before, during, and after the re-link, then an undo after the move.
  it("keeps a hand link through the re-link and an undo after it, and pairs an app link again", async () => {
    const out2 = txn("m-out2", CHECKING, -20_000, D, { code: OUT });
    const in2 = txn("b-in2", SAVINGS, 20_000, D, { code: IN });
    await oldHistory([REFUND, PAIR_OUT, out2], [SHOES, PAIR_IN, in2]);
    await refundByHand("m-refund", "b-shoes");
    await transferByHand("m-out", "b-in");
    expect(await shapes()).toEqual([
      { kind: "Refund", pair: "m-refund → b-shoes", madeBy: "Member" },
      { kind: "Transfer", pair: "m-out → b-in", madeBy: "Member" },
      { kind: "Transfer", pair: "m-out2 → b-in2", madeBy: "app" },
    ]);
    const beforeTotals = await totals();
    expect(beforeTotals.september).toMatchObject({
      spending: 6_000,
      byCategory: { Clothing: 6_000 },
    });
    expect(beforeTotals.october).toMatchObject({ spending: 0, income: 0, saving: 0 });

    // During: the hand links wait, and the app link has ended.
    await linkAgain();
    await syncNew({ added: [] });
    expect(await shapes()).toEqual([
      { kind: "Refund", pair: "m-refund → b-shoes", madeBy: "Member" },
      { kind: "Transfer", pair: "m-out → b-in", madeBy: "Member" },
    ]);
    expect(await month("2026-09")).toMatchObject({ spending: 10_000 });
    expect(await decisionOf("b-in")).toMatchObject({ parts: [{ type: "Transfer" }] });

    // After: the hand links moved, the app pairs the copy again, and the totals are as before.
    await syncNew({
      added: [REFUND_COPY, PAIR_OUT_COPY, { ...out2, id: "n-out2", accountId: NEW_CHECKING.id }],
      historyLoaded: true,
    });
    expect(await shapes()).toEqual([
      { kind: "Refund", pair: "n-refund → b-shoes", madeBy: "Member" },
      { kind: "Transfer", pair: "n-out → b-in", madeBy: "Member" },
      { kind: "Transfer", pair: "n-out2 → b-in2", madeBy: "app" },
    ]);
    expect(await totals()).toEqual(beforeTotals);

    // An undo after the move works as any undo: the app never makes that pair again.
    const moved = (await links()).find((link) => link.pair === "n-out → b-in");
    expect(await undoLink(bank.database, String(moved?.id), MEMBER, NOW())).toBe(true);
    await runFollowUp(NOW);
    expect(await shapes()).toEqual([
      { kind: "Refund", pair: "n-refund → b-shoes", madeBy: "Member" },
      { kind: "Transfer", pair: "n-out2 → b-in2", madeBy: "app" },
    ]);
    expect(await month("2026-09")).toEqual(beforeTotals.september);
  });

  it("ends a waiting hand Transfer when the provider removes its other side", async () => {
    await oldHistory([PAIR_OUT], [PAIR_IN]);
    await transferByHand("m-out", "b-in");
    await linkAgain();
    await syncNew({ added: [] });
    expect(await shapes()).toEqual([{ kind: "Transfer", pair: "m-out → b-in", madeBy: "Member" }]);

    bank.fake.addPages(birch, { removed: [{ id: "b-in" }] });
    await syncConnection(birch, NOW);
    await runFollowUp(NOW);

    expect(await shapes()).toEqual([]);
  });

  // K4: the wait for copies has an end state when the first history load never ends.
  describe("a wait for copies that the first history load does not end", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    // The carry-over happened in the new Connection's first sync, at NOW.
    const afterCarryOver = (ms: number) => new Date(NOW().getTime() + ms);
    const CAP = afterCarryOver(COPIES_WAIT_CAP_DAYS * DAY_MS);
    const waitRow = () =>
      rows(
        "SELECT copies_wait_end_tries AS tries, copies_wait_ended_at AS endedAt FROM connection_carry_overs",
      );

    // A hand Refund waits: the new Connection's first sync brought no copy, and its history has
    // not loaded.
    beforeEach(async () => {
      await oldHistory([REFUND], [SHOES]);
      await refundByHand("m-refund", "b-shoes");
      await linkAgain();
      await syncNew({ added: [] });
      expect(await shapes()).toEqual([
        { kind: "Refund", pair: "m-refund → b-shoes", madeBy: "Member" },
      ]);
    });

    it("ends the hand link once when the new Connection is removed before its history loads", async () => {
      const asked = bank.followUpsAsked();

      expect(await connectionRemoving().remove(relinked)).toEqual({ outcome: "removed" });

      expect(bank.followUpsAsked()).toBe(asked + 1);
      await runFollowUp(NOW);
      expect(await links()).toEqual([]);
      expect(await month("2026-09")).toMatchObject({ byCategory: { Clothing: 10_000 } });
      // Removed once: a second Remove asks for nothing.
      expect(await connectionRemoving().remove(relinked)).toEqual({ outcome: "removed" });
      expect(bank.followUpsAsked()).toBe(asked + 1);
    });

    it("ends the hand link once when the new Connection stays Broken past the cap", async () => {
      await bank.database.$client.execute({
        sql: "UPDATE connections SET health = 'broken' WHERE id = ?",
        args: [relinked],
      });
      const asked = bank.followUpsAsked();

      // A minute before the cap, the link still waits.
      expect(await endLongCopyWaits(new Date(CAP.getTime() - 60_000))).toBe("none");
      await runFollowUp(NOW);
      expect(await shapes()).toEqual([
        { kind: "Refund", pair: "m-refund → b-shoes", madeBy: "Member" },
      ]);
      expect(await waitRow()).toEqual([{ tries: 0, endedAt: null }]);

      expect(await endLongCopyWaits(CAP)).toBe("ended");
      expect(bank.followUpsAsked()).toBe(asked + 1);
      await runFollowUp(() => CAP);
      expect(await links()).toEqual([]);
      expect(await month("2026-09")).toMatchObject({ byCategory: { Clothing: 10_000 } });
      expect(await waitRow()).toEqual([{ tries: 1, endedAt: CAP.toISOString() }]);

      // Once: the next minute, and a day later, change nothing and ask for nothing.
      expect(await endLongCopyWaits(new Date(CAP.getTime() + 60_000))).toBe("none");
      expect(await endLongCopyWaits(new Date(CAP.getTime() + DAY_MS))).toBe("none");
      expect(bank.followUpsAsked()).toBe(asked + 1);
      expect(await waitRow()).toEqual([{ tries: 1, endedAt: CAP.toISOString() }]);
    });

    it("stops trying to end the wait after its last try, when every try fails", async () => {
      await bank.database.$client.execute(
        `CREATE TRIGGER always_fails BEFORE INSERT ON follow_up_changes
         BEGIN SELECT RAISE(ABORT, 'always fails'); END`,
      );
      const asked = bank.followUpsAsked();

      for (let minute = 0; minute < COPIES_WAIT_END_TRIES; minute += 1) {
        expect(await endLongCopyWaits(new Date(CAP.getTime() + minute * 60_000))).toBe("failed");
      }
      expect(await endLongCopyWaits(new Date(CAP.getTime() + DAY_MS))).toBe("none");

      expect(await waitRow()).toEqual([{ tries: COPIES_WAIT_END_TRIES, endedAt: null }]);
      expect(bank.followUpsAsked()).toBe(asked);
      // The wait has ended, so the link ends when Matching next handles either side.
      await bank.database.$client.execute("DROP TRIGGER always_fails");
      await runFollowUp(NOW);
      expect(await shapes()).toEqual([
        { kind: "Refund", pair: "m-refund → b-shoes", madeBy: "Member" },
      ]);
      bank.fake.addPages(birch, { changed: [{ ...SHOES, description: "SHOE BARN 2" }] });
      await syncConnection(birch, NOW);
      await runFollowUp(NOW);
      expect(await links()).toEqual([]);
    });
  });

  // K5: the sync job starts the follow-up job once the first history load's end commits, even when
  // recording the sync's success fails after it.
  describe("the sync job that ends the first history load", () => {
    let dir: string;
    let stopJobs: () => Promise<void>;

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), "fft-link-carry-over-jobs-"));
      stopJobs = (
        await startJobs({
          jobsDb: join(dir, "jobs.db"),
          jobList: TEST_BANK_JOB_LIST,
          tasks: [],
          database: bank.database,
        })
      ).stop;
    });

    afterEach(async () => {
      await stopJobs();
      rmSync(dir, { recursive: true, force: true });
    });

    it("starts the follow-up job that ends a hand link with no copy, though recording success fails", async () => {
      await oldHistory([REFUND], [SHOES]);
      await refundByHand("m-refund", "b-shoes");
      await linkAgain();
      await syncNew({ added: [] });
      // Recording the sync's success writes failed_syncs; nothing before it does.
      await bank.database.$client.execute(
        `CREATE TRIGGER success_fails BEFORE UPDATE OF failed_syncs ON connections
         BEGIN SELECT RAISE(ABORT, 'success fails'); END`,
      );
      bank.fake.addPages(relinked, { historyLoaded: true });

      await startJob(SyncConnectionJob, [relinked]);

      // Sidequest polls for jobs on real timers.
      let left = await links();
      for (let tries = 0; left.length > 0 && tries < 500; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        left = await links();
      }
      expect(left).toEqual([]);
      expect(await rows("SELECT history_loaded FROM connections WHERE id = ?", [relinked])).toEqual(
        [{ history_loaded: 1 }],
      );
    });
  });

  describe("only a hand-made link on an old Transaction moves, and only to its copy", () => {
    it("moves nothing to a Transaction on another Account, of another amount, or on another day", async () => {
      await oldHistory([REFUND], [SHOES]);
      await refundByHand("m-refund", "b-shoes");
      await linkAgain();

      await syncNew({
        accounts: [NEW_CHECKING, NEW_SAVINGS],
        added: [
          { ...REFUND, id: "n-other-account", accountId: NEW_SAVINGS.id },
          { ...REFUND_COPY, id: "n-other-amount", amount: 4_001 },
          { ...REFUND_COPY, id: "n-other-day", postedDate: "2026-10-13" },
        ],
        historyLoaded: true,
      });

      expect(await links()).toEqual([]);
    });

    it("ends a hand link on an old Transaction hidden for another reason", async () => {
      await oldHistory([REFUND], [SHOES]);
      await refundByHand("m-refund", "b-shoes");
      // The provider removes it in the old Connection's last sync, before the follow-up job runs.
      bank.fake.addPages(maple, { removed: [{ id: "m-refund" }] });
      await syncConnection(maple, OLD_SYNC);
      await linkAgain();

      await syncNew({ added: [REFUND_COPY], historyLoaded: true });

      expect(await links()).toEqual([]);
    });

    it("ends at once a hand link on a new Transaction that a later change hides before day D", async () => {
      await oldHistory([], [SHOES]);
      await linkAgain();
      const late = txn("n-late", NEW_CHECKING, 4_000, "2026-10-15", { code: CLOTHING });
      await syncNew({ added: [late] });
      await refundByHand("n-late", "b-shoes");

      // While the history loads, the provider moves it before day D, where the old Connection's
      // Transactions count. It is no old Transaction, so no copy of it comes.
      await syncNew({ changed: [{ ...late, postedDate: "2026-10-08" }] });

      expect(
        await rows("SELECT hidden_reason FROM transactions WHERE provider_transaction_id = ?", [
          "n-late",
        ]),
      ).toEqual([{ hidden_reason: "replaced by re-link" }]);
      expect(await links()).toEqual([]);
    });

    it("lets an app-made link take no copy from a hand-made one", async () => {
      // A purchase on Maple checking, which the app links to its Refund on the same Account.
      const lunch = txn("m-lunch", CHECKING, -4_000, "2026-10-01", {
        code: RESTAURANT,
        merchantName: "Corner Cafe",
      });
      const lunchRefund = txn("m-lunch-refund", CHECKING, 4_000, D, {
        code: RESTAURANT,
        merchantName: "Corner Cafe",
        description: REFUND.description,
      });
      const other = { ...REFUND, description: "BOOT HUT REFUND" };
      await oldHistory([lunch, lunchRefund, other], [SHOES]);
      await refundByHand("m-refund", "b-shoes");
      expect(await shapes()).toEqual([
        { kind: "Refund", pair: "m-lunch-refund → m-lunch", madeBy: "app" },
        { kind: "Refund", pair: "m-refund → b-shoes", madeBy: "Member" },
      ]);
      await linkAgain();

      // The app-made link ends at once, while the hand-made one waits.
      await syncNew({ added: [] });
      expect(await shapes()).toEqual([
        { kind: "Refund", pair: "m-refund → b-shoes", madeBy: "Member" },
      ]);

      // One copy, whose description is the app-linked one's.
      await syncNew({ added: [REFUND_COPY], historyLoaded: true });

      expect(await shapes()).toEqual([
        { kind: "Refund", pair: "n-refund → b-shoes", madeBy: "Member" },
      ]);
    });

    it("ends an AI-made link on the same old Transaction as a hand-made one that moves", async () => {
      const dinner = txn("m-dinner", CHECKING, -6_000, D, { code: RESTAURANT });
      const sam = txn("b-sam", SAVINGS, 2_000, "2026-10-14", { description: "VENMO *SAM RIVERA" });
      const lee = txn("b-lee", SAVINGS, 1_500, "2026-10-14", {
        description: "VENMO *MORGAN LEE",
      });
      let dinnerId = "";
      const picks = (money: readonly MoneyToPick[]) =>
        new Map(
          money
            .filter((each) => each.money.description === sam.description)
            .map((each) => [
              each.money.id,
              { spendingTransactionId: dinnerId, confidence: "high" as const, justAsked: true },
            ]),
        );
      const unregister = registerReimbursementPicker(async (money) => picks(money));
      try {
        bank.fake.addPages(maple, { accounts: [CHECKING], added: [dinner], historyLoaded: true });
        await syncConnection(maple, OLD_SYNC);
        await runFollowUp(NOW);
        dinnerId = await idOf("m-dinner");
        await oldHistory([], [sam, lee]);
        await linkHand({
          kind: "Reimbursement",
          transactionId: await idOf("b-lee"),
          spendingTransactionId: dinnerId,
        });
        expect(await shapes()).toEqual([
          { kind: "Reimbursement", pair: "b-lee → m-dinner", madeBy: "Member" },
          { kind: "Reimbursement", pair: "b-sam → m-dinner", madeBy: "AI" },
        ]);
        await linkAgain();

        await syncNew({
          added: [{ ...dinner, id: "n-dinner", accountId: NEW_CHECKING.id }],
          historyLoaded: true,
        });

        expect(await shapes()).toEqual([
          { kind: "Reimbursement", pair: "b-lee → n-dinner", madeBy: "Member" },
        ]);
      } finally {
        unregister();
      }
    });

    it("moves no link to a copy that a Member linked elsewhere first", async () => {
      const boots = txn("b-boots", CARD, -8_000, "2026-09-12", { code: CLOTHING });
      await oldHistory([REFUND], [SHOES, boots]);
      await refundByHand("m-refund", "b-shoes");
      await linkAgain();
      bank.fake.addPages(relinked, {
        accounts: [NEW_CHECKING],
        added: [REFUND_COPY],
        historyLoaded: true,
      });
      await syncConnection(relinked, NOW);

      // Before the follow-up job runs, the Member links the copy to another purchase.
      await refundByHand("n-refund", "b-boots");

      expect(await shapes()).toEqual([
        { kind: "Refund", pair: "n-refund → b-boots", madeBy: "Member" },
      ]);
    });
  });

  // K6: each delete with the old Connection recorded and a moved link present.
  describe("deleting history after a carry-over", () => {
    beforeEach(async () => {
      await oldHistory([txn("m-coffee", CHECKING, -500, "2026-10-05"), REFUND], [SHOES]);
      await refundByHand("m-refund", "b-shoes");
      await linkAgain();
      await syncNew({ added: [REFUND_COPY], historyLoaded: true });
      expect(await shapes()).toEqual([
        { kind: "Refund", pair: "n-refund → b-shoes", madeBy: "Member" },
      ]);
    });

    it("keeps the old Connection's row, its record, and the moved link after its Delete history", async () => {
      expect(await connectionRemoving().deleteHistory(maple)).toEqual({
        outcome: "deleted",
        accounts: 0,
        transactions: 0,
      });

      // The carried Account holds the old Connection's Transactions before day D.
      expect(await rows("SELECT id FROM connections WHERE id = ?", [maple])).toEqual([
        { id: maple },
      ]);
      expect(await rows("SELECT old_connection_id FROM connection_carry_overs")).toEqual([
        { old_connection_id: maple },
      ]);
      expect(await shapes()).toEqual([
        { kind: "Refund", pair: "n-refund → b-shoes", madeBy: "Member" },
      ]);
    });

    it("deletes both Connections, the record, and the moved link with the new Connection's history", async () => {
      expect(await connectionRemoving().remove(relinked)).toEqual({ outcome: "removed" });
      expect(await connectionRemoving().deleteHistory(relinked)).toMatchObject({
        outcome: "deleted",
        accounts: 1,
      });
      await runFollowUp(NOW);

      expect(
        await rows("SELECT id FROM connections WHERE id IN (?, ?)", [maple, relinked]),
      ).toEqual([]);
      expect(await rows("SELECT * FROM connection_carry_overs")).toEqual([]);
      expect(await links()).toEqual([]);
      expect(await month("2026-09")).toMatchObject({ byCategory: { Clothing: 10_000 } });
    });
  });

  it("empties the record of an old Connection whose row goes with its Delete history", async () => {
    // The old Connection's checking Account has no Transactions, so none stays behind after D.
    await oldHistory([], [SHOES]);
    await linkAgain();
    await syncNew({ added: [REFUND_COPY], historyLoaded: true });
    expect(await rows("SELECT old_connection_id FROM connection_carry_overs")).toEqual([
      { old_connection_id: maple },
    ]);

    expect(await connectionRemoving().deleteHistory(maple)).toMatchObject({ outcome: "deleted" });

    expect(await rows("SELECT id FROM connections WHERE id = ?", [maple])).toEqual([]);
    expect(
      await rows("SELECT connection_id, old_connection_id FROM connection_carry_overs"),
    ).toEqual([{ connection_id: relinked, old_connection_id: null }]);
  });
});
