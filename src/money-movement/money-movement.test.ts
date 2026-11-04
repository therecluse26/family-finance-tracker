import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_BANKS, seedDemoHousehold } from "../bank/demo.ts";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { listConnections } from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { scheduledTasks } from "../jobs/list.ts";
import {
  type DecisionInput,
  decideProvisionalAgain,
  type MonthTotals,
  readTransactionDecision,
  registerDecisionRule,
  runMatching,
  setTransactionType,
  startMoneyMovement,
  totalsByMonth,
  whole,
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
  const register = (...args: Parameters<typeof registerDecisionRule>) => {
    stops.push(registerDecisionRule(...args));
  };
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
      // 6.7, and the loan payout at step 6.2. The demo has no Member, so no Zelle line names one.
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
                AND t.provider_category GLOB 'LOAN_DISBURSEMENTS_*')`,
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

    it("lets the first step that fits win, and skips an empty step", async () => {
      // Step 5.2 comes before the built-in cash rule at step 5.3, and claims every withdrawal.
      register("5.2", (txn) =>
        txn.providerCategory === "TRANSFER_OUT_WITHDRAWAL" ? whole(txn, "Saving") : undefined,
      );

      await runFollowUp(NOW);

      const at = (step: string) =>
        count(`SELECT count(*) AS n FROM transaction_decisions WHERE step = '${step}'`);
      expect(await at("5.2")).toBeGreaterThan(0);
      expect(await at("5.3")).toBe(0);
      // Steps 6.4 and 6.8 are empty, so money in passes them by.
      expect(await at("6.4")).toBe(0);
      expect(await at("6.8")).toBe(0);
      expect(await at("6.9")).toBeGreaterThan(0);
      // Steps 5.x never see money in, and steps 6.x never see money out.
      expect(
        await count(
          `SELECT count(*) AS n FROM transaction_decisions d JOIN transactions t ON t.id = d.transaction_id
           WHERE (t.amount > 0 AND d.step GLOB '5.*') OR (t.amount <= 0 AND d.step GLOB '6.*')`,
        ),
      ).toBe(0);
      expect(() => register("5.7", (txn) => whole(txn, "Income"))).toThrow(/already has a rule/);
      expect(() => register("5.3", (txn) => whole(txn, "Income"))).toThrow(/already has a rule/);
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

      // A rule that would claim it, and a sync that changes its description and then its amount.
      register("5.2", (txn) => whole(txn, "Saving"));
      await syncMore("fake-chase", { changed: [{ ...dinner, description: "CHANGED" }] });
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

    // A one-sided Transfer that waits 3 days for its pair. Once the window has passed, the rule no
    // longer fits, and the Transaction falls through to Spending.
    const oneSided = (txn: DecisionInput) => {
      if (!txn.description.startsWith("SWEEP")) return undefined;
      const end = new Date(`${txn.postedDate}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 3);
      const until = end.toISOString().slice(0, 10);
      return txn.today <= until
        ? { ...whole(txn, "Transfer"), provisionalUntil: until }
        : undefined;
    };

    it("decides a provisional result again once its window has passed, with no sync", async () => {
      register("5.2", oneSided);
      const connectionId = await bank.connect("fake-first-bank");
      bank.fake.addPages("fake-first-bank", {
        accounts: [CHECKING],
        added: [
          fakeTxn({
            id: "xfer",
            accountId: CHECKING.id,
            amount: -20_000,
            postedDate: "2026-10-09",
            description: "SWEEP TO SAVINGS",
          }),
        ],
      });
      await syncConnection(connectionId, () => new Date("2026-10-10T15:00:00Z"));
      // Matching, on the day after the Transfer posted.
      await runMatching(bank.database, [await idOf("xfer")], new Date("2026-10-10T15:00:00Z"));
      expect(await decisionOf("xfer")).toEqual({
        step: "5.2",
        provisionalUntil: "2026-10-12",
        parts: [{ type: "Transfer", amount: -20_000, category: null }],
      });

      // On the window's last day it stays.
      expect(await decideProvisionalAgain(bank.database, new Date("2026-10-12T23:00:00Z"))).toBe(0);
      expect((await decisionOf("xfer"))?.step).toBe("5.2");

      expect(await decideProvisionalAgain(bank.database, new Date("2026-10-13T12:00:00Z"))).toBe(1);
      expect(await decisionOf("xfer")).toEqual({
        step: "5.7",
        provisionalUntil: null,
        parts: [{ type: "Spending", amount: -20_000, category: null }],
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
      // Rules for the test, keyed on the description: what later tickets will decide.
      register("5.2", (txn) => {
        if (txn.description === "BROKERAGE") return whole(txn, "Saving");
        return txn.description === "GROCER"
          ? { parts: [{ type: "Spending", amount: txn.amount, category: "Groceries" }] }
          : undefined;
      });
      register("6.4", (txn) =>
        txn.description === "GROCER REFUND"
          ? { parts: [{ type: "Refund", amount: txn.amount, category: "Groceries" }] }
          : undefined,
      );
      register("6.8", (txn) =>
        txn.description === "BROKERAGE" ? whole(txn, "Saving") : undefined,
      );
      const connectionId = await bank.connect("fake-first-bank");
      const txn = (id: string, amount: number, postedDate: string, description: string) =>
        fakeTxn({ id, accountId: CHECKING.id, amount, postedDate, description });
      bank.fake.addPages("fake-first-bank", {
        accounts: [CHECKING],
        added: [
          txn("pay", 300_000, "2026-09-01", "PAYROLL"),
          txn("grocer", -10_000, "2026-09-03", "GROCER"),
          txn("refund", 2_000, "2026-09-05", "GROCER REFUND"),
          txn("other", -4_000, "2026-09-06", "SOMETHING"),
          txn("save", -50_000, "2026-09-10", "BROKERAGE"),
          txn("take-out", 80_000, "2026-09-20", "BROKERAGE"),
          txn("move", -7_000, "2026-10-01", "MOVE"),
        ],
      });
      await syncConnection(connectionId, () => new Date("2026-10-02T15:00:00Z"));
      await runFollowUp(() => new Date("2026-10-02T15:00:00Z"));
      await setTransactionType(bank.database, await idOf("move"), "Transfer");
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
        byCategory: { Groceries: 8_000 },
      });
      expect(totals[0]?.byCategoryGroup.Shopping).toBe(8_000);
      // A Transfer counts in nothing.
      expect(totals[1]).toMatchObject({ spending: 0, income: 0, saving: 0, byCategory: {} });
    });
  });
});
