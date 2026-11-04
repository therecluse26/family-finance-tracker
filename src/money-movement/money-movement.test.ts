import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_BANKS, seedDemoHousehold } from "../bank/demo.ts";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { listConnections } from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { scheduledTasks } from "../jobs/list.ts";
import {
  decideProvisionalAgain,
  type MonthTotals,
  readTransactionDecision,
  runMatching,
  setTransactionType,
  startMoneyMovement,
  totalsByMonth,
} from "./index.ts";

// The order of decisions, the hand-set type, provisional results, and totals by type (spec 03,
// Order of decisions; spec 04, Which month a Transaction counts in). Most tests run on the demo
// Household, seeded through the fake adapter.

const NOW = () => new Date("2026-11-01T14:00:00.000Z");
const CHASE = DEMO_BANKS.find((demo) => demo.bankId === "fake-chase");
const CHASE_CARD = CHASE?.accounts[0]?.id ?? "";

describe("money movement", () => {
  let bank: TestBank;
  let stops: (() => void)[];

  const count = async (sql: string) =>
    Number((await bank.database.$client.execute(sql)).rows[0]?.n);
  // A Transaction's ID in app.db, by its provider ID.
  const idOf = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT id FROM transactions WHERE provider_transaction_id = ? AND hidden_reason IS NULL",
      args: [providerId],
    });
    return String(rows.rows[0]?.id);
  };
  const decisionOf = async (providerId: string) =>
    readTransactionDecision(bank.database, await idOf(providerId));
  // Syncs one more page into a demo bank, then runs the follow-up job.
  const syncMore = async (bankId: string, page: Parameters<TestBank["fake"]["addPages"]>[1]) => {
    bank.fake.addPages(bankId, page);
    const connection = (await listConnections(bank.database)).find((c) => c.bankId === bankId);
    await syncConnection(connection?.id ?? "", NOW);
    await runFollowUp(NOW);
  };
  const month = (totals: MonthTotals[], name: string) => totals.find((t) => t.month === name);

  beforeEach(async () => {
    bank = await newTestBank();
    stops = [startMoneyMovement({ database: bank.database }).stop];
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  describe("on the demo Household", () => {
    beforeEach(async () => {
      await seedDemoHousehold(bank.database, bank.fake, NOW);
    });

    it("makes money out Spending at step 5.7 and money in Income at step 6.9, unless an earlier step fits", async () => {
      await runFollowUp(NOW);

      const shown = "FROM transactions WHERE hidden_reason IS NULL";
      expect(await count("SELECT count(*) AS n FROM transaction_decisions")).toBe(
        await count(`SELECT count(*) AS n ${shown}`),
      );
      // Except the Transfer pairs that step 3 links, card payments at steps 5.1 and 6.6, cash at
      // step 5.3, payment-app lines at steps 5.5 and 6.5, the one-sided Transfers at steps 5.6 and
      // 6.7, the loan payout at step 6.2, the untracked loan payments at step 5.2, and the Refunds,
      // linked at step 6.4 or unlinked at step 6.8. The demo has no Member, so no Zelle line names
      // one.
      const transferWording = `(t.description LIKE '%transfer%' OR t.description LIKE '%xfer%'
        OR coalesce(t.provider_category, '') GLOB 'TRANSFER_IN_*'
        OR coalesce(t.provider_category, '') GLOB 'TRANSFER_OUT_*')`;
      const paymentApp = `(t.description LIKE '%venmo%' OR t.description LIKE '%zelle%'
        OR t.description LIKE '%paypal%' OR t.description LIKE '%cash app%')`;
      const cardPayment = "coalesce(t.provider_category, '') = 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT'";
      const linked = `EXISTS (SELECT 1 FROM transfer_links l
        WHERE t.id IN (l.out_transaction_id, l.in_transaction_id))`;
      const unpaired = `NOT ${linked} AND NOT ${cardPayment}`;
      expect(
        await count(
          `SELECT count(*) AS n FROM transaction_decisions d JOIN transactions t ON t.id = d.transaction_id
           JOIN transaction_parts p ON p.transaction_id = d.transaction_id
           WHERE (t.amount <= 0 AND d.step = '5.7' AND p.type = 'Spending' AND ${unpaired}
                AND NOT ${transferWording} AND NOT ${paymentApp})
              OR (t.amount > 0 AND d.step = '6.9' AND p.type = 'Income' AND ${unpaired}
                AND NOT ${transferWording} AND NOT ${paymentApp})
              OR (d.step = '3' AND p.type = 'Transfer' AND ${linked})
              OR (d.step IN ('5.1', '6.6') AND p.type = 'Transfer' AND ${cardPayment}
                AND NOT ${linked})
              OR (d.step = '5.3' AND p.type = 'Spending' AND p.category = 'Cash'
                AND t.provider_category = 'TRANSFER_OUT_WITHDRAWAL')
              OR (d.step = '5.5' AND p.type = 'Spending' AND p.category = 'Payments to people'
                AND ${paymentApp} AND NOT ${linked})
              OR (d.step = '6.5' AND p.type = 'Income' AND ${paymentApp} AND NOT ${linked})
              OR (d.step IN ('5.6', '6.7') AND p.type IN ('Transfer', 'Saving')
                AND ${transferWording} AND NOT ${paymentApp} AND NOT ${linked})
              OR (d.step = '6.2' AND p.type = 'Transfer'
                AND t.provider_category GLOB 'LOAN_DISBURSEMENTS_*')
              OR (d.step = '6.4' AND p.type = 'Refund' AND p.linked = 1 AND t.merchant_clean_name IS NOT NULL)
              OR (d.step = '6.8' AND p.type = 'Refund' AND p.linked = 0 AND t.merchant_clean_name IS NOT NULL)
              OR (d.step = '5.2' AND t.amount < 0 AND NOT ${linked}
                AND t.provider_category GLOB 'LOAN_PAYMENTS_*')`,
        ),
      ).toBe(await count(`SELECT count(*) AS n ${shown}`));
      expect(await count("SELECT count(*) AS n FROM transfer_links")).toBeGreaterThan(0);
      for (const step of ["5.3", "5.5", "6.5"]) {
        expect(
          await count(`SELECT count(*) AS n FROM transaction_decisions WHERE step = '${step}'`),
        ).toBeGreaterThan(0);
      }
      // One part each, for the whole amount. Only cash and payments to people name a Category.
      expect(
        await count(
          `SELECT count(*) AS n FROM transaction_parts p JOIN transactions t ON t.id = p.transaction_id
           WHERE p.part <> 0 OR p.amount <> t.amount
              OR (p.category IS NOT NULL AND p.category NOT IN ('Cash', 'Payments to people'))`,
        ),
      ).toBe(0);
    });

    it("lets the first step that fits win", async () => {
      await runFollowUp(NOW);

      const at = (step: string) =>
        count(`SELECT count(*) AS n FROM transaction_decisions WHERE step = '${step}'`);
      // Payment-app lines of money in are money from a person at step 6.5, before Income.
      expect(await at("6.5")).toBeGreaterThan(0);
      expect(await at("6.9")).toBeGreaterThan(0);
      // Steps 5.x never see money in, and steps 6.x never see money out.
      expect(
        await count(
          `SELECT count(*) AS n FROM transaction_decisions d JOIN transactions t ON t.id = d.transaction_id
           WHERE (t.amount > 0 AND d.step GLOB '5.*') OR (t.amount <= 0 AND d.step GLOB '6.*')`,
        ),
      ).toBe(0);
    });

    it("keeps a hand-set type through every re-run, even when a sync changes the Transaction", async () => {
      await runFollowUp(NOW);
      const dinner = CHASE?.pages[0]?.added?.find((txn) => txn.amount < 0);
      if (dinner === undefined) throw new Error("The demo has no Chase purchase.");
      expect((await decisionOf(dinner.id))?.step).toBe("5.7");

      const set = await setTransactionType(bank.database, await idOf(dinner.id), "Transfer");

      expect(set).toEqual({
        step: "1",
        provisionalUntil: null,
        parts: [{ type: "Transfer", amount: dinner.amount, category: null }],
      });
      // The follow-up job stores it, so Matching never runs beside a sync.
      expect(await decisionOf(dinner.id)).toMatchObject({ step: "5.7" });
      expect(bank.followUpsAsked()).toBe(1);
      await runFollowUp(NOW);
      expect(await decisionOf(dinner.id)).toEqual(set);

      // A sync that makes it a cash withdrawal, which step 5.3 would claim, and then changes its
      // amount.
      await syncMore("fake-chase", {
        changed: [
          {
            ...dinner,
            description: "ATM WITHDRAWAL",
            category: {
              name: "TRANSFER_OUT_WITHDRAWAL",
              confidence: "VERY_HIGH",
              version: "v2",
              mcc: null,
            },
          },
        ],
      });
      expect(await decisionOf(dinner.id)).toEqual(set);

      await syncMore("fake-chase", { changed: [{ ...dinner, amount: dinner.amount - 100 }] });
      expect(await decisionOf(dinner.id)).toEqual({
        step: "1",
        provisionalUntil: null,
        parts: [{ type: "Transfer", amount: dinner.amount - 100, category: null }],
      });
    });

    it("counts a dinner on Oct 31 that posts Nov 2 in October", async () => {
      await runFollowUp(NOW);
      const before = await totalsByMonth(bank.database);

      await syncMore("fake-chase", {
        added: [
          fakeTxn({
            id: "dinner-oct-31",
            accountId: CHASE_CARD,
            amount: -8_450,
            authorizedDate: "2026-10-31",
            postedDate: "2026-11-02",
            description: "TST* LATE DINNER",
          }),
        ],
      });
      const after = await totalsByMonth(bank.database);

      expect(month(after, "2026-10")?.spending).toBe(
        (month(before, "2026-10")?.spending ?? 0) + 8_450,
      );
      expect(month(after, "2026-11")).toBeUndefined();
    });

    it("leaves pending Transactions out of totals until they post", async () => {
      await runFollowUp(NOW);
      const before = await totalsByMonth(bank.database);
      const held = fakeTxn({
        id: "held",
        accountId: CHASE_CARD,
        amount: -5_000,
        postedDate: "2026-10-31",
        pending: true,
      });

      await syncMore("fake-chase", { added: [held] });
      // The pending Transaction is decided, so lists can show its type.
      expect((await decisionOf("held"))?.step).toBe("5.7");
      expect(await totalsByMonth(bank.database)).toEqual(before);

      await syncMore("fake-chase", {
        added: [{ ...held, id: "held-posted", pending: false, pendingTransactionId: "held" }],
      });
      expect(month(await totalsByMonth(bank.database), "2026-10")?.spending).toBe(
        (month(before, "2026-10")?.spending ?? 0) + 5_000,
      );
    });
  });

  describe("provisional results", () => {
    const CHECKING = fakeAccount({ id: "acc-checking", name: "Everyday Checking" });

    it("decides a provisional result again once its window has passed, with no sync", async () => {
      // A payment to a card the app does not track waits 4 business days for its pair, as a
      // Transfer. Then it is Spending in Miscellaneous.
      const connectionId = await bank.connect("fake-first-bank");
      bank.fake.addPages("fake-first-bank", {
        accounts: [CHECKING],
        added: [
          {
            ...fakeTxn({
              id: "card-payment",
              accountId: CHECKING.id,
              amount: -20_000,
              postedDate: "2026-10-09",
              description: "PAYMENT TO STORE CARD",
            }),
            category: {
              name: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
              confidence: "HIGH",
              version: "v2",
              mcc: null,
            },
          },
        ],
      });
      await syncConnection(connectionId, () => new Date("2026-10-10T15:00:00Z"));
      // Matching, on the day after the payment posted.
      await runMatching(
        bank.database,
        [await idOf("card-payment")],
        new Date("2026-10-10T15:00:00Z"),
      );
      // Monday, October 12, is a Federal Reserve holiday.
      expect(await decisionOf("card-payment")).toEqual({
        step: "5.1",
        provisionalUntil: "2026-10-16",
        parts: [{ type: "Transfer", amount: -20_000, category: null }],
      });

      // On the window's last day it stays.
      expect(await decideProvisionalAgain(bank.database, new Date("2026-10-16T23:00:00Z"))).toBe(0);
      expect((await decisionOf("card-payment"))?.parts[0]?.type).toBe("Transfer");

      expect(await decideProvisionalAgain(bank.database, new Date("2026-10-17T12:00:00Z"))).toBe(1);
      expect(await decisionOf("card-payment")).toEqual({
        step: "5.1",
        provisionalUntil: null,
        parts: [{ type: "Spending", amount: -20_000, category: "Miscellaneous" }],
      });
      // Nothing is left to decide again.
      expect(await decideProvisionalAgain(bank.database, new Date("2026-10-14T12:00:00Z"))).toBe(0);
    });

    it("runs as a daily scheduled task", () => {
      expect(scheduledTasks.map((task) => task.name)).toContain("provisional results");
    });
  });

  describe("totals by type", () => {
    const CHECKING = fakeAccount({ id: "acc-checking", name: "Everyday Checking" });

    it("sums Spending, Income, and Saving by month, by Category, and by Category group", async () => {
      // A buy now pay later payment is Spending in General goods at step 5.2, and the Refund from
      // the same Merchant links to it at step 6.4. Money in from a brokerage reduces Saving.
      const connectionId = await bank.connect("fake-first-bank");
      const txn = (id: string, amount: number, postedDate: string, description: string) =>
        fakeTxn({ id, accountId: CHECKING.id, amount, postedDate, description });
      const code = (name: string) => ({ name, confidence: "HIGH", version: "v2", mcc: null });
      bank.fake.addPages("fake-first-bank", {
        accounts: [CHECKING],
        added: [
          txn("pay", 300_000, "2026-09-01", "PAYROLL"),
          {
            ...txn("bnpl", -10_000, "2026-09-03", "PAY IN 4"),
            merchantName: "Pay In Four",
            category: code("LOAN_PAYMENTS_BNPL"),
          },
          { ...txn("refund", 2_000, "2026-09-05", "PAY IN 4 REFUND"), merchantName: "Pay In Four" },
          txn("other", -4_000, "2026-09-06", "SOMETHING"),
          txn("save", -50_000, "2026-09-10", "BROKERAGE"),
          {
            ...txn("take-out", 80_000, "2026-09-20", "BROKERAGE"),
            category: code("TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS"),
          },
          txn("move", -7_000, "2026-10-01", "MOVE"),
        ],
      });
      await syncConnection(connectionId, () => new Date("2026-10-02T15:00:00Z"));
      await runFollowUp(() => new Date("2026-10-02T15:00:00Z"));
      await setTransactionType(bank.database, await idOf("move"), "Transfer");
      await setTransactionType(bank.database, await idOf("save"), "Saving");
      await runFollowUp(() => new Date("2026-10-02T15:00:00Z"));

      const totals = await totalsByMonth(bank.database);

      expect(totals.map((t) => t.month)).toEqual(["2026-09", "2026-10"]);
      expect(totals[0]).toMatchObject({
        month: "2026-09",
        // 10,000 − 2,000 back, plus 4,000 with no Category yet.
        spending: 12_000,
        income: 300_000,
        // 50,000 in, 80,000 taken back out.
        saving: -30_000,
        byCategory: { "General goods": 8_000 },
      });
      expect(totals[0]?.byCategoryGroup.Shopping).toBe(8_000);
      // A Transfer counts in nothing.
      expect(totals[1]).toMatchObject({ spending: 0, income: 0, saving: 0, byCategory: {} });
    });
  });
});
