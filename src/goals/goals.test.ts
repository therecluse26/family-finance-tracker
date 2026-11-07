import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountSnapshot } from "../bank/adapter.ts";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { addUnconnectedAccount, syncConnection } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { runMonthStart } from "../budgets/index.ts";
import {
  addGoal,
  addManualLoan,
  type ManualLoanFields,
  type NewGoal,
  readGoal,
  storeDecisions,
  storeFirstDraft,
  storeOtherLink,
  updateManualLoan,
} from "../db/index.ts";
import { registerFollowUpStep, runFollowUp } from "../follow-up/index.ts";
import { householdSummary } from "../summary/index.ts";
import { type Goal, listGoalsWithProgress, markGoal, startGoal, startGoals } from "./index.ts";

// Goals and their progress (spec 05, Goals; Progress; Done), on Transactions and balances the fake
// adapter synced. Each reading is written directly, with no AI. The Household time zone is unset,
// so Household time is UTC.

const BANK = "fake-goals-bank";
const CHECKING = fakeAccount({ id: "acc-checking" });

const $ = (dollars: number) => Math.round(dollars * 100);
const at = (date: string) => new Date(`${date}T15:00:00.000Z`);

const savings = (dollars: number) =>
  fakeAccount({ id: "acc-savings", subtype: "savings", currentBalance: $(dollars) });
const carLoan = (owed: number) =>
  fakeAccount({ id: "acc-car", type: "loan", subtype: "auto", currentBalance: -$(owed) });

// A Refund is money in; Spending and Saving are money out. `linkedTo` names the Spending a Refund
// is linked to.
type TxnSpec = {
  id: string;
  date: string;
  type: "Spending" | "Saving" | "Refund";
  dollars: number;
  merchant?: string;
  linkedTo?: string;
};

const spend = (id: string, date: string, dollars: number, merchant?: string): TxnSpec => ({
  id,
  date,
  type: "Spending",
  dollars,
  merchant,
});

describe("Goal progress", () => {
  let bank: TestBank;
  let connectionId: string;

  let stopGoals: () => void;
  let clock = at("2026-10-01");

  beforeEach(async () => {
    bank = await newTestBank();
    stopGoals = startGoals({ database: bank.database, now: () => clock }).stop;
    connectionId = await bank.connect(BANK);
    for (const id of ["member-a", "member-b"]) {
      await bank.database.$client.execute({
        sql: `INSERT INTO members (id, name, email, created_at, updated_at)
              VALUES (?, ?, ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
        args: [id, id, `${id}@example.com`],
      });
    }
  });

  afterEach(() => {
    stopGoals();
    bank.close();
  });

  // Syncs the Accounts and Transactions on `date`, and stores each Transaction's type, Merchant and
  // link, with Spending in Restaurants.
  const sync = async (date: string, accounts: AccountSnapshot[], txns: TxnSpec[] = []) => {
    const amount = (txn: TxnSpec) => (txn.type === "Refund" ? $(txn.dollars) : -$(txn.dollars));
    bank.fake.addPages(BANK, {
      accounts: [CHECKING, ...accounts],
      added: txns.map((txn) =>
        fakeTxn({ id: txn.id, accountId: CHECKING.id, amount: amount(txn), postedDate: txn.date }),
      ),
    });
    await syncConnection(connectionId, () => at(date));
    const rows = await bank.database.$client.execute(
      "SELECT id, provider_transaction_id FROM transactions",
    );
    const ids = new Map(
      rows.rows.map((row) => [String(row.provider_transaction_id), String(row.id)]),
    );
    const id = (provider: string) => ids.get(provider) ?? "";
    await storeDecisions(
      bank.database,
      txns.map((txn) => ({
        transactionId: id(txn.id),
        step: "5.7",
        provisionalUntil: null,
        decidedAt: at(date),
        parts: [
          {
            type: txn.type,
            amount: amount(txn),
            category: txn.type === "Spending" ? "Restaurants" : null,
            linked: txn.linkedTo !== undefined,
          },
        ],
      })),
    );
    for (const txn of txns) {
      if (txn.merchant !== undefined) {
        await bank.database.$client.execute({
          sql: "UPDATE transactions SET merchant_clean_name = ? WHERE id = ?",
          args: [txn.merchant, id(txn.id)],
        });
      }
      if (txn.linkedTo !== undefined) {
        await storeOtherLink(
          bank.database,
          { kind: "Refund", transactionId: id(txn.id), spendingTransactionId: id(txn.linkedTo) },
          {
            tier: "Strong",
            signals: [],
            aiAnswer: null,
            aiConfidence: null,
            madeBy: "app",
            memberId: null,
            createdAt: at(date),
          },
        );
      }
    }
  };

  const accountId = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT id FROM household_accounts WHERE provider_account_id = ?",
      args: [providerId],
    });
    return String(rows.rows[0]?.id);
  };

  const goal = (fields: Partial<NewGoal> & Pick<NewGoal, "date" | "target">) =>
    addGoal(bank.database, {
      words: "A Goal",
      authorId: null,
      change: null,
      deadline: null,
      ...fields,
    });

  const progressOn = async (date: string) => {
    const goals = await listGoalsWithProgress(bank.database, at(date));
    return new Map<string, Goal>(goals.map((each) => [each.id, each]));
  };

  describe("spend less", () => {
    // Spec 05's example: "I want to spend 20% less on restaurants." The baseline is $600.
    beforeEach(async () => {
      const history = ["07", "08", "09"].flatMap((month) =>
        [1, 2, 3, 4, 5, 6].map((day) => spend(`r-${month}-${day}`, `2026-${month}-0${day}`, 100)),
      );
      await sync("2026-10-01", [], history);
    });

    const restaurants = { kind: "Category", category: "Restaurants" };

    it("is Behind at 50% when P is $540 against a Goal amount of $480", async () => {
      const id = await goal({ date: "2026-10-01", target: restaurants, change: { percent: 20 } });
      // The Goal amount Proposal is $480, and a Member accepts it.
      expect(
        await startGoal(bank.database, id, { goalAmount: $(480), now: at("2026-10-01") }),
      ).toEqual({
        goalAmount: $(480),
        startsOn: "2026-10-01",
      });
      expect((await readGoal(bank.database, id))?.baseline).toBe($(600));
      // On October 15, F = $261.29, so P = $261.29 × 31 ÷ 15 = $540.
      await sync(
        "2026-10-15",
        [],
        [
          spend("o1", "2026-10-02", 87.1),
          spend("o2", "2026-10-05", 87.1),
          spend("o3", "2026-10-09", 87.09),
        ],
      );

      const found = (await progressOn("2026-10-15")).get(id);
      expect(found?.progress).toEqual({
        kind: "spend less",
        percentage: 50,
        state: "Behind",
        detail: "On pace for $540 this month; Goal is $480",
        estimated: false,
      });
      expect(found?.status).toBe("active");
    });

    it("needs a Goal amount from a Proposal, and shows none until it has one", async () => {
      const id = await goal({ date: "2026-10-01", target: restaurants, change: { percent: 20 } });
      expect(await startGoal(bank.database, id, { now: at("2026-10-01") })).toBe("no Goal amount");

      expect((await progressOn("2026-10-15")).get(id)?.progress).toEqual({
        kind: "spend less",
        percentage: null,
        state: null,
        detail: "Goal amount not set yet",
        estimated: false,
      });
    });

    it("is done when a complete calendar month ends at or under it, and shows Done for one month", async () => {
      const id = await goal({ date: "2026-10-01", target: restaurants });
      await startGoal(bank.database, id, { goalAmount: $(480), now: at("2026-10-01") });
      await sync(
        "2026-10-20",
        [],
        [spend("o1", "2026-10-02", 300), spend("o2", "2026-10-12", 150)],
      );
      // October has not ended yet.
      expect((await progressOn("2026-10-31")).get(id)?.status).toBe("active");

      const done = (await progressOn("2026-11-02")).get(id);
      expect(done).toMatchObject({ status: "done", endedOn: "2026-11-02", endedBy: null });
      expect(done).toMatchObject({ list: "active", progress: { state: "Done", percentage: 100 } });
      expect(await readGoal(bank.database, id)).toMatchObject({
        status: "done",
        endedOn: "2026-11-02",
      });

      expect((await progressOn("2026-12-01")).get(id)?.list).toBe("active");
      expect((await progressOn("2026-12-02")).get(id)).toMatchObject({
        list: "done",
        progress: null,
      });
    });

    // Spec 05, Done: the app checks every active Goal on the 1st, Household time.
    it("is done on the 1st, by the Month start job, with no Goals list read", async () => {
      await storeFirstDraft(bank.database, {
        inputs: {
          steadyIncome: $(6_000),
          ceDataYear: 2024,
          sampleBenchmarks: false,
          firstDraftMonth: "2026-10",
          fixedCostsPassIncome: false,
          recordedAt: at("2026-10-01"),
        },
        budgets: [],
      });
      const id = await goal({ date: "2026-10-01", target: restaurants });
      await startGoal(bank.database, id, { goalAmount: $(480), now: at("2026-10-01") });
      await sync(
        "2026-10-20",
        [],
        [spend("o1", "2026-10-02", 300), spend("o2", "2026-10-12", 150)],
      );

      expect(await runMonthStart(bank.database, at("2026-11-01"))).toBe("done");

      expect(await readGoal(bank.database, id)).toMatchObject({
        status: "done",
        endedOn: "2026-11-01",
        endedBy: null,
      });
    });

    it("is not done after a month over it", async () => {
      const id = await goal({ date: "2026-10-01", target: restaurants });
      await startGoal(bank.database, id, { goalAmount: $(480), now: at("2026-10-01") });
      await sync(
        "2026-10-20",
        [],
        [spend("o1", "2026-10-02", 300), spend("o2", "2026-10-12", 200)],
      );

      expect((await progressOn("2026-11-02")).get(id)?.status).toBe("active");
    });

    it("first counts the next full month when it starts after the 1st, so Spending before it never marks it done", async () => {
      await sync("2026-10-19", [], [spend("o1", "2026-10-05", 100)]);
      const id = await goal({ date: "2026-10-20", target: restaurants });
      await startGoal(bank.database, id, { goalAmount: $(480), now: at("2026-10-20") });
      await sync("2026-11-20", [], [spend("n1", "2026-11-10", 500)]);

      // October ended at $100, but the Goal was active for only part of it. November ended at $500.
      expect((await progressOn("2026-11-02")).get(id)?.status).toBe("active");
      expect((await progressOn("2026-12-02")).get(id)?.status).toBe("active");

      await sync("2026-12-20", [], [spend("d1", "2026-12-10", 200)]);
      expect((await progressOn("2027-01-02")).get(id)).toMatchObject({
        status: "done",
        endedOn: "2027-01-02",
      });
    });
  });

  describe("spend less at a Merchant", () => {
    const cornerBean = { kind: "Merchant", merchant: { id: null, name: "Corner Bean" } };

    // $90 a month at Corner Bean, and other Spending that is not.
    beforeEach(async () => {
      const history = ["07", "08", "09"].flatMap((month) => [
        ...[11, 18, 25].map((day) =>
          spend(`cb-${month}-${day}`, `2026-${month}-${day}`, 30, "Corner Bean"),
        ),
        spend(`bistro-${month}`, `2026-${month}-20`, 200, "Fancy Bistro"),
      ]);
      await sync("2026-10-01", [], history);
    });

    it("counts only that Merchant's Spending, net of a linked Refund, and is done once a month ends at or under it", async () => {
      const id = await goal({ date: "2026-10-01", target: cornerBean, change: { amount: $(30) } });
      await startGoal(bank.database, id, { goalAmount: $(60), now: at("2026-10-01") });
      expect((await readGoal(bank.database, id))?.baseline).toBe($(90));
      await sync(
        "2026-10-15",
        [],
        [
          spend("cb-1", "2026-10-03", 40, "Corner Bean"),
          spend("cb-2", "2026-10-10", 40, "Corner Bean"),
          spend("bistro", "2026-10-11", 200, "Fancy Bistro"),
        ],
      );

      // P = $80 × 31 ÷ 15 = $165.
      expect((await progressOn("2026-10-15")).get(id)?.progress).toEqual({
        kind: "spend less",
        percentage: 0,
        state: "Behind",
        detail: "On pace for $165 this month; Goal is $60",
        estimated: false,
      });
      // October ended at $80.
      expect((await progressOn("2026-11-02")).get(id)?.status).toBe("active");

      // A $25 Refund linked to the October 10 purchase counts in October, at Corner Bean: $55.
      await sync(
        "2026-11-04",
        [],
        [{ id: "cb-refund", date: "2026-11-03", type: "Refund", dollars: 25, linkedTo: "cb-2" }],
      );
      expect((await progressOn("2026-11-04")).get(id)).toMatchObject({
        status: "done",
        endedOn: "2026-11-04",
      });
    });

    it("leaves out a linked Refund while its purchase is pending or hidden, as the month totals do", async () => {
      const id = await goal({ date: "2026-10-01", target: cornerBean, change: { amount: $(30) } });
      await startGoal(bank.database, id, { goalAmount: $(60), now: at("2026-10-01") });
      await sync(
        "2026-10-15",
        [],
        [
          spend("cb-1", "2026-10-03", 70, "Corner Bean"),
          spend("cb-2", "2026-10-10", 10, "Corner Bean"),
        ],
      );
      const purchase = (set: string) =>
        bank.database.$client.execute(
          `UPDATE transactions SET ${set} WHERE provider_transaction_id = 'cb-2'`,
        );
      // A $25 Refund is linked to the October 10 purchase while that purchase is still pending.
      await purchase("pending = 1");
      await sync(
        "2026-11-04",
        [],
        [{ id: "cb-refund", date: "2026-11-03", type: "Refund", dollars: 25, linkedTo: "cb-2" }],
      );

      // October counts $70 at Corner Bean, over $60: the Refund waits for its purchase.
      expect((await progressOn("2026-11-04")).get(id)?.status).toBe("active");
      await purchase("pending = 0, hidden_reason = 'removed by provider'");
      expect((await progressOn("2026-11-05")).get(id)?.status).toBe("active");

      // Once the purchase posts and shows, October is $70 + $10 − $25 = $55.
      await purchase("hidden_reason = NULL");
      expect((await progressOn("2026-11-06")).get(id)).toMatchObject({
        status: "done",
        endedOn: "2026-11-06",
      });
    });
  });

  describe("save toward an amount", () => {
    // Spec 05's example: "Save $10,000 for a house by December 31, 2027." On January 1, 2027, the
    // account holds $2,000.
    const house = (savingsId: string, deadline: string | null = "2027-12-31") =>
      goal({
        date: "2027-01-01",
        target: { kind: "Accounts", accountIds: [savingsId] },
        change: { amount: $(10_000) },
        deadline,
      });

    beforeEach(async () => {
      await sync("2027-01-01", [savings(2_000)]);
    });

    it("is On track at 60% with $8,000 against a straight line of $7,000", async () => {
      const id = await house(await accountId("acc-savings"));
      expect(await startGoal(bank.database, id, { now: at("2027-01-01") })).toEqual({
        goalAmount: $(12_000),
        startsOn: "2027-01-01",
      });
      await sync("2027-07-02", [savings(8_000)]);

      expect((await progressOn("2027-07-02")).get(id)?.progress).toEqual({
        kind: "save toward an amount",
        percentage: 60,
        state: "On track",
        detail: "$8,000 of $12,000; $1,000 ahead of pace",
        estimated: false,
      });
    });

    it("takes a percent change on the balance at the start", async () => {
      const id = await goal({
        date: "2027-01-01",
        target: { kind: "Accounts", accountIds: [await accountId("acc-savings")] },
        change: { percent: 50 },
      });
      expect(await startGoal(bank.database, id, { now: at("2027-01-01") })).toEqual({
        goalAmount: $(3_000),
        startsOn: "2027-01-01",
      });
      expect((await readGoal(bank.database, id))?.startBalance).toBe($(2_000));
    });

    it("shows the percentage only with no deadline", async () => {
      const id = await house(await accountId("acc-savings"), null);
      await startGoal(bank.database, id, { now: at("2027-01-01") });
      await sync("2027-07-02", [savings(8_000)]);

      expect((await progressOn("2027-07-02")).get(id)?.progress).toEqual({
        kind: "save toward an amount",
        percentage: 60,
        state: null,
        detail: "$8,000 of $12,000",
        estimated: false,
      });
    });

    it("stays active and Behind after its deadline passes", async () => {
      const id = await house(await accountId("acc-savings"), "2027-03-31");
      await startGoal(bank.database, id, { now: at("2027-01-01") });
      await sync("2027-07-02", [savings(8_000)]);

      expect((await progressOn("2027-07-02")).get(id)).toMatchObject({
        status: "active",
        progress: { state: "Behind", detail: "$8,000 of $12,000; $4,000 behind pace" },
      });
    });

    it("shows estimated when its money sits in an Unconnected account", async () => {
      const hsa = await addUnconnectedAccount(bank.database, {
        name: "HSA",
        kind: "HSA",
        institutionName: null,
        mask: null,
      });
      const savingsId = await accountId("acc-savings");
      const id = await goal({
        date: "2027-01-01",
        target: { kind: "Accounts", accountIds: [savingsId, hsa.id] },
        change: { amount: $(10_000) },
        deadline: "2027-12-31",
      });
      await startGoal(bank.database, id, { now: at("2027-01-01") });
      const plain = await house(savingsId);
      await startGoal(bank.database, plain, { now: at("2027-01-01") });

      const found = await progressOn("2027-01-02");
      expect(found.get(id)?.progress).toMatchObject({
        estimated: true,
        detail: expect.stringMatching(/^\$2,000 of \$12,000;/),
      });
      expect(found.get(plain)?.progress?.estimated).toBe(false);
    });

    it("counts Saving since the start, from $0, with Saving as the target", async () => {
      await sync(
        "2026-12-31",
        [savings(2_000)],
        [{ id: "s0", date: "2026-12-20", type: "Saving", dollars: 500 }],
      );
      const id = await goal({
        date: "2027-01-01",
        target: { kind: "Saving" },
        change: { amount: $(6_000) },
        deadline: "2027-12-31",
      });
      expect(await startGoal(bank.database, id, { now: at("2027-01-01") })).toEqual({
        goalAmount: $(6_000),
        startsOn: "2027-01-01",
      });
      await sync(
        "2027-03-02",
        [savings(2_000)],
        [
          { id: "s1", date: "2027-02-01", type: "Saving", dollars: 3_000 },
          { id: "s2", date: "2027-03-01", type: "Saving", dollars: 1_000 },
        ],
      );

      expect((await progressOn("2027-07-02")).get(id)?.progress).toEqual({
        kind: "save toward an amount",
        percentage: 67,
        state: "On track",
        detail: "$4,000 of $6,000; $1,000 ahead of pace",
        estimated: false,
      });
    });

    it("starts Saving as the target at $0, even with Saving on the start day", async () => {
      await sync(
        "2027-01-01",
        [savings(2_000)],
        [{ id: "s0", date: "2027-01-01", type: "Saving", dollars: 500 }],
      );
      const id = await goal({
        date: "2027-01-01",
        target: { kind: "Saving" },
        change: { amount: $(6_000) },
      });
      expect(await startGoal(bank.database, id, { now: at("2027-01-01") })).toEqual({
        goalAmount: $(6_000),
        startsOn: "2027-01-01",
      });
      expect((await readGoal(bank.database, id))?.startBalance).toBe(0);

      expect((await progressOn("2027-01-02")).get(id)?.progress).toEqual({
        kind: "save toward an amount",
        percentage: 8,
        state: null,
        detail: "$500 of $6,000",
        estimated: false,
      });
    });

    it("is done when the balance reaches the Goal amount", async () => {
      const id = await house(await accountId("acc-savings"));
      await startGoal(bank.database, id, { now: at("2027-01-01") });
      await sync("2027-07-02", [savings(12_000)]);

      expect((await progressOn("2027-07-02")).get(id)).toMatchObject({
        status: "done",
        endedOn: "2027-07-02",
        list: "active",
        progress: { state: "Done", percentage: 100 },
      });
    });

    it("shows Goal amount not set yet with no change, until a Proposal sets it", async () => {
      const id = await goal({
        date: "2027-01-01",
        target: { kind: "Accounts", accountIds: [await accountId("acc-savings")] },
      });
      expect(await startGoal(bank.database, id, { now: at("2027-01-01") })).toBe("no Goal amount");

      expect((await progressOn("2027-01-02")).get(id)?.progress).toMatchObject({
        percentage: null,
        state: null,
        detail: "Goal amount not set yet",
      });
    });
  });

  describe("pay down a loan", () => {
    // Spec 05's example: "Pay off the car loan by the end of 2027." The balance on January 1, 2027
    // is $12,000.
    beforeEach(async () => {
      await sync("2027-01-01", [carLoan(12_000)]);
    });

    const payOff = async (change: NewGoal["change"] = null) =>
      goal({
        date: "2027-01-01",
        target: { kind: "loan", accountId: await accountId("acc-car") },
        change,
        deadline: "2027-12-31",
      });

    it("is Behind at 42% with $5,000 paid against a straight line of $6,000", async () => {
      const id = await payOff();
      expect(await startGoal(bank.database, id, { now: at("2027-01-01") })).toEqual({
        goalAmount: $(12_000),
        startsOn: "2027-01-01",
      });
      await sync("2027-07-02", [carLoan(7_000)]);

      expect((await progressOn("2027-07-02")).get(id)?.progress).toEqual({
        kind: "pay down a loan",
        percentage: 42,
        state: "Behind",
        detail: "$5,000 of $12,000 paid; $1,000 behind pace",
        estimated: false,
      });
    });

    it("is done when the loan's balance reaches $0", async () => {
      const id = await payOff({ amount: $(15_000) });
      await startGoal(bank.database, id, { now: at("2027-01-01") });
      await sync("2027-07-02", [carLoan(0)]);

      expect((await progressOn("2027-07-02")).get(id)?.status).toBe("done");
    });

    it("is done when the principal paid reaches the Goal amount", async () => {
      const id = await payOff({ amount: $(3_000) });
      await startGoal(bank.database, id, { now: at("2027-01-01") });
      await sync("2027-03-02", [carLoan(9_500)]);
      expect((await progressOn("2027-03-02")).get(id)?.status).toBe("active");
      await sync("2027-04-02", [carLoan(9_000)]);
      expect((await progressOn("2027-04-02")).get(id)?.status).toBe("done");
    });
  });

  describe("pay down a Manual loan", () => {
    const fields: ManualLoanFields = {
      lender: "Hometown Credit Union",
      subtype: "personal",
      apr: 0,
      regularPayment: null,
      escrow: null,
      loanType: null,
    };
    const typed = (date: string, owed: number) => ({
      date,
      balance: -$(owed),
      typedAt: at(date),
      typedBy: null,
    });

    it("takes a percent change on what it owes at the start, and counts each balance a Member types", async () => {
      const loanId = await addManualLoan(bank.database, fields, typed("2027-01-01", 10_000));
      const id = await goal({
        date: "2027-01-01",
        target: { kind: "loan", accountId: loanId },
        change: { percent: 50 },
        deadline: "2027-12-31",
      });
      expect(await startGoal(bank.database, id, { now: at("2027-01-01") })).toEqual({
        goalAmount: $(5_000),
        startsOn: "2027-01-01",
      });
      expect((await readGoal(bank.database, id))?.startBalance).toBe($(10_000));

      await updateManualLoan(bank.database, loanId, fields, typed("2027-07-02", 8_000));
      // Paid $2,000 of $5,000. The straight line on July 2 is $2,500.
      expect((await progressOn("2027-07-02")).get(id)?.progress).toEqual({
        kind: "pay down a loan",
        percentage: 40,
        state: "Behind",
        detail: "$2,000 of $5,000 paid; $500 behind pace",
        estimated: false,
      });

      await updateManualLoan(bank.database, loanId, fields, typed("2027-08-01", 5_000));
      expect((await progressOn("2027-08-01")).get(id)?.status).toBe("done");
    });
  });

  it("shows no progress for a reading with no target", async () => {
    const id = await goal({ date: "2027-01-01", target: null });
    expect(await startGoal(bank.database, id, { now: at("2027-01-01") })).toBe("no target");

    expect((await progressOn("2027-01-02")).get(id)).toMatchObject({
      list: "active",
      progress: null,
    });
  });

  // Spec 05, Done: the app checks every active Goal in each follow-up job.
  describe("the Done check in the follow-up job", () => {
    const WORDS = "Put money aside for the beach trip";
    const summaryText = async () =>
      (
        await householdSummary({
          database: bank.database,
          ai: { accountLabels: async () => new Map(), memberLabels: async () => new Map() },
          now: () => clock,
        }).today()
      ).text;

    // A Goal to save $500, with Saving as the target, from October 1.
    const saveGoal = async () => {
      const id = await goal({
        words: WORDS,
        date: "2026-10-01",
        target: { kind: "Saving" },
        change: { amount: $(500) },
      });
      await startGoal(bank.database, id, { now: at("2026-10-01") });
      return id;
    };

    it("sets a Goal met by a synced Transaction done, with no Goals list read, and it leaves the Household summary", async () => {
      const id = await saveGoal();
      clock = at("2026-11-04");
      expect(await summaryText()).toContain(WORDS);

      await sync(
        "2026-11-04",
        [],
        [{ id: "saved", date: "2026-11-03", type: "Saving", dollars: 500 }],
      );
      await runFollowUp(() => clock);

      expect(await readGoal(bank.database, id)).toMatchObject({
        status: "done",
        endedOn: "2026-11-04",
        endedBy: null,
      });
      expect(await summaryText()).not.toContain(WORDS);
      // The Goals page shows the same result.
      expect((await progressOn("2026-11-05")).get(id)).toMatchObject({
        status: "done",
        endedOn: "2026-11-04",
        list: "active",
      });
    });

    it("stops neither job when it fails, and runs again in the next follow-up job", async () => {
      const id = await saveGoal();
      const later: string[] = [];
      const stopAlerts = registerFollowUpStep("alerts", async (unhandled) => {
        later.push(...unhandled);
        return undefined;
      });
      try {
        // The Goal can no longer be read, so the check throws.
        const target = await bank.database.$client.execute({
          sql: "SELECT target FROM goals WHERE id = ?",
          args: [id],
        });
        await bank.database.$client.execute({
          sql: "UPDATE goals SET target = 'broken' WHERE id = ?",
          args: [id],
        });
        clock = at("2026-11-04");
        await sync(
          "2026-11-04",
          [],
          [{ id: "saved", date: "2026-11-03", type: "Saving", dollars: 500 }],
        );
        expect(await runFollowUp(() => clock)).toBeUndefined();
        // The step after it ran, and the check is not retried on its own.
        expect(later).toHaveLength(1);
        expect(await runFollowUp(() => clock)).toBeUndefined();
        expect(later).toHaveLength(1);

        // The Month start's result does not change.
        await storeFirstDraft(bank.database, {
          inputs: {
            steadyIncome: $(6_000),
            ceDataYear: 2024,
            sampleBenchmarks: false,
            firstDraftMonth: "2026-10",
            fixedCostsPassIncome: false,
            recordedAt: at("2026-10-01"),
          },
          budgets: [],
        });
        expect(await runMonthStart(bank.database, at("2026-11-01"))).toBe("done");

        // The next follow-up job checks again.
        await bank.database.$client.execute({
          sql: "UPDATE goals SET target = ? WHERE id = ?",
          args: [String(target.rows[0]?.target), id],
        });
        clock = at("2026-11-05");
        await sync("2026-11-05", [], [spend("coffee", "2026-11-05", 4)]);
        await runFollowUp(() => clock);
        expect(await readGoal(bank.database, id)).toMatchObject({
          status: "done",
          endedOn: "2026-11-05",
        });
      } finally {
        stopAlerts();
      }
    });
  });

  describe("a Member's mark", () => {
    it("marks an active Goal done or dropped, and the dropped one goes to the dropped list", async () => {
      await sync("2027-01-01", [savings(2_000)]);
      const target = { kind: "Accounts", accountIds: [await accountId("acc-savings")] };
      const done = await goal({ date: "2027-01-01", target, change: { amount: $(1_000) } });
      const dropped = await goal({ date: "2027-01-01", target, change: { amount: $(1_000) } });

      expect(await markGoal(bank.database, done, "done", "member-a", at("2027-02-01"))).toBe(
        "marked",
      );
      expect(await markGoal(bank.database, dropped, "dropped", "member-a", at("2027-02-01"))).toBe(
        "marked",
      );

      const found = await progressOn("2027-02-01");
      expect(found.get(done)).toMatchObject({
        status: "done",
        list: "active",
        endedOn: "2027-02-01",
      });
      expect(found.get(done)?.progress?.state).toBe("Done");
      expect(found.get(dropped)).toMatchObject({
        status: "dropped",
        list: "dropped",
        progress: null,
      });
      expect([...found.values()].map((each) => each.id)).toEqual([done, dropped]);
    });

    it("changes nothing on a Goal that is done or dropped already", async () => {
      const id = await goal({ date: "2027-01-01", target: { kind: "Saving" } });
      await markGoal(bank.database, id, "dropped", "member-a", at("2027-02-01"));
      const before = await readGoal(bank.database, id);

      expect(await markGoal(bank.database, id, "done", "member-b", at("2027-03-01"))).toBe(
        "not active",
      );
      expect(
        await startGoal(bank.database, id, { goalAmount: $(100), now: at("2027-03-01") }),
      ).toBe("no active Goal");
      expect(await readGoal(bank.database, id)).toEqual(before);
      expect(await markGoal(bank.database, "no-such-goal", "done", "member-a")).toBeUndefined();
    });

    it("keeps a Goal when the Member who wrote and ended it is deleted", async () => {
      const id = await goal({
        date: "2027-01-01",
        target: { kind: "Saving" },
        authorId: "member-a",
      });
      await markGoal(bank.database, id, "dropped", "member-a", at("2027-02-01"));
      expect(await readGoal(bank.database, id)).toMatchObject({
        authorId: "member-a",
        endedBy: "member-a",
      });

      await bank.database.$client.execute("DELETE FROM members WHERE id = 'member-a'");

      expect(await readGoal(bank.database, id)).toMatchObject({
        authorId: null,
        endedBy: null,
        status: "dropped",
        endedOn: "2027-02-01",
      });
    });
  });
});
