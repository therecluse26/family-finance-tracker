import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { type Category, categoryGroupOf } from "../categories/index.ts";
import {
  type NewBudget,
  type NewPart,
  replaceRecurringCharges,
  storeDecisions,
  storeFirstDraft,
} from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import {
  type Alert,
  alertList,
  checkOverspending,
  OVERSPENDING_CHECKS_CAP,
  OVERSPENDING_CHECKS_STOPPED,
  startOverspendingChecks,
} from "./index.ts";

// The Overspending checks (spec 06, Overspending; The projection; Overspending Alerts), through the
// anomalies module's interface. Transactions arrive through the fake adapter, with their parts
// stored as Money movement and Categorization would store them. The Household time zone is unset,
// so Household time is UTC.

const BANK = "fake-overspending-bank";
const CHECKING = fakeAccount({ id: "acc-checking", name: "Checking" });
const CARD = fakeAccount({
  id: "acc-card",
  name: "Visa Card",
  type: "credit",
  subtype: "credit card",
});
const MORTGAGE = fakeAccount({
  id: "acc-mortgage",
  name: "Mortgage",
  type: "loan",
  subtype: "mortgage",
});

const $ = (dollars: number) => Math.round(dollars * 100);
const at = (date: string) => new Date(`${date}T15:00:00.000Z`);

type TxnSpec = {
  id: string;
  date: string;
  parts: NewPart[];
  account?: string;
  merchant?: string;
  code?: string;
  // The purchase date, when it differs from the posted date.
  authorized?: string;
  pending?: boolean;
};

const spend = (
  id: string,
  date: string,
  dollars: number,
  category: Category,
  merchant?: string,
): TxnSpec => ({
  id,
  date,
  parts: [{ type: "Spending", amount: -$(dollars), category }],
  merchant,
});

// A Transaction in Interest and fees, with Plaid's code.
const fee = (
  id: string,
  date: string,
  dollars: number,
  code: string,
  fields: Partial<TxnSpec> = {},
): TxnSpec => ({
  id,
  date,
  parts: [{ type: "Spending", amount: -$(dollars), category: "Interest and fees" }],
  code,
  ...fields,
});

const monthly = (category: Category, dollars: number): NewBudget => ({
  category,
  amount: $(dollars),
  period: "monthly",
  takesEffect: "2026-01",
  source: "formula",
  setBy: null,
  pinned: categoryGroupOf(category) === "Bills" ? false : null,
  setAt: at("2026-01-02"),
});

const yearly = (category: Category, dollars: number): NewBudget => ({
  ...monthly(category, dollars),
  period: "yearly",
  takesEffect: "2026",
  pinned: null,
});

describe("the Overspending checks", () => {
  let bank: TestBank;
  let connectionId: string;
  const ids = new Map<string, string>();

  const load = async (txns: TxnSpec[]) => {
    bank.fake.addPages(BANK, {
      accounts: [CHECKING, CARD, MORTGAGE],
      added: txns.map((txn) =>
        fakeTxn({
          id: txn.id,
          accountId: txn.account ?? CHECKING.id,
          amount: txn.parts.reduce((sum, part) => sum + part.amount, 0),
          postedDate: txn.date,
          authorizedDate: txn.authorized ?? null,
          pending: txn.pending ?? false,
          category:
            txn.code === undefined
              ? null
              : { name: txn.code, confidence: null, version: null, mcc: null },
        }),
      ),
    });
    await syncConnection(connectionId, () => at("2026-11-10"));
    const rows = await bank.database.$client.execute(
      "SELECT id, provider_transaction_id FROM transactions",
    );
    for (const row of rows.rows) ids.set(String(row.provider_transaction_id), String(row.id));
    // The Merchant as identity knows it; none, as for a bank's own fee, when the spec names none.
    for (const txn of txns) {
      await bank.database.$client.execute({
        sql: "UPDATE transactions SET merchant_clean_name = ? WHERE id = ?",
        args: [txn.merchant ?? null, ids.get(txn.id) ?? ""],
      });
    }
    await storeDecisions(
      bank.database,
      txns.map((txn) => ({
        transactionId: ids.get(txn.id) ?? "",
        step: "5.7",
        provisionalUntil: null,
        decidedAt: at("2026-11-10"),
        parts: txn.parts,
      })),
    );
  };

  const draft = (budgets: NewBudget[]) =>
    storeFirstDraft(bank.database, {
      inputs: {
        steadyIncome: $(6_000),
        ceDataYear: 2024,
        sampleBenchmarks: false,
        firstDraftMonth: "2026-01",
        fixedCostsPassIncome: false,
        recordedAt: at("2026-01-02"),
      },
      budgets,
    });

  // Runs the checks on every Transaction on `today`, and returns the texts of every Alert of
  // `kinds`, oldest first.
  const check = async (today: string) =>
    checkOverspending(bank.database, [...ids.values()], at(today));
  const texts = async (...kinds: Alert["kind"][]) =>
    (await alertList(bank.database))
      .filter((alert) => kinds.length === 0 || kinds.includes(alert.kind))
      .reverse()
      .map((alert) => alert.text);

  beforeEach(async () => {
    ids.clear();
    bank = await newTestBank();
    connectionId = await bank.connect(BANK);
  });

  afterEach(() => {
    bank.close();
  });

  describe("On pace", () => {
    it("fires for Restaurants on October 12 at $620 against $500, 24% over", async () => {
      await draft([monthly("Restaurants", 500)]);
      await load([
        spend("dinner-1", "2026-10-02", 90, "Restaurants"),
        spend("dinner-2", "2026-10-06", 70, "Restaurants"),
        spend("lunch-1", "2026-10-11", 80, "Restaurants"),
      ]);

      expect(await check("2026-10-12")).toBe(1);
      expect(await texts()).toEqual([
        "Restaurants is on pace for $620 in Oct 2026, 24% over its $500 Budget. Spent so far: $240.",
      ]);
      const [alert] = await alertList(bank.database);
      expect(alert).toMatchObject({ kind: "On pace", category: "Restaurants", state: null });

      // At most once per Category per month: P is now $664, 33% over.
      await load([spend("lunch-2", "2026-10-13", 60, "Restaurants")]);
      expect(await check("2026-10-14")).toBe(0);
    });

    it("does not fire for Home and garden at $160 against $150: under 20% over", async () => {
      await draft([monthly("Home and garden", 150)]);
      await load([
        spend("home-depot", "2026-11-04", 100, "Home and garden", "Home Depot"),
        spend("hooks", "2026-11-08", 20, "Home and garden"),
      ]);

      expect(await check("2026-11-10")).toBe(0);
    });

    it("waits until the 8th: nothing on day 7, then the Alert on day 8", async () => {
      await draft([monthly("Restaurants", 500)]);
      await load([
        spend("dinner-1", "2026-10-02", 150, "Restaurants"),
        spend("dinner-2", "2026-10-05", 100, "Restaurants"),
      ]);

      expect(await check("2026-10-07")).toBe(0);
      expect(await check("2026-10-08")).toBe(1);
      expect(await texts()).toEqual([
        "Restaurants is on pace for $969 in Oct 2026, 94% over its $500 Budget. Spent so far: $250.",
      ]);
    });

    it("never fires for a yearly Budget", async () => {
      await draft([yearly("Travel", 1_000)]);
      await load([spend("flight", "2026-11-09", 900, "Travel", "Skyway Air")]);

      expect(await check("2026-11-10")).toBe(0);
    });
  });

  describe("Over Budget", () => {
    it("fires once per Category per month, with the latest Spending, and no On pace beside it", async () => {
      await draft([monthly("Restaurants", 500)]);
      await load([
        spend("dinner-1", "2026-11-02", 300, "Restaurants", "Harbor Grill"),
        spend("dinner-2", "2026-11-09", 220, "Restaurants", "Blue Door Cafe"),
      ]);

      expect(await check("2026-11-10")).toBe(1);
      expect(await texts()).toEqual([
        "Restaurants is over Budget for Nov 2026: $520 of $500. Latest: $220.00 at Blue Door Cafe on Nov 9.",
      ]);
      const [alert] = await alertList(bank.database);
      expect(alert).toMatchObject({ kind: "Over Budget", category: "Restaurants" });
      expect(alert?.transactionIds).toEqual([ids.get("dinner-2")]);

      await load([spend("dinner-3", "2026-11-11", 40, "Restaurants", "Harbor Grill")]);
      expect(await check("2026-11-12")).toBe(0);
      // The next month starts again.
      await load([spend("dinner-4", "2026-12-03", 600, "Restaurants", "Harbor Grill")]);
      expect(await check("2026-12-04")).toBe(1);
      expect((await texts()).at(-1)).toBe(
        "Restaurants is over Budget for Dec 2026: $600 of $500. Latest: $600.00 at Harbor Grill on Dec 3.",
      );
    });

    it("fires once a year for a yearly Budget, on the year's Spending", async () => {
      await draft([yearly("Travel", 1_000)]);
      await load([
        spend("old-trip", "2025-12-20", 900, "Travel", "Skyway Air"),
        spend("flight", "2026-03-14", 600, "Travel", "Skyway Air"),
        spend("hotel", "2026-11-03", 500, "Travel", "Harbor Hotel"),
      ]);

      expect(await check("2026-11-10")).toBe(1);
      expect(await texts()).toEqual([
        "Travel is over its 2026 Budget: $1,100 of $1,000. Latest: $500.00 at Harbor Hotel on Nov 3.",
      ]);

      await load([spend("taxi", "2026-12-02", 40, "Travel", "City Cab")]);
      expect(await check("2026-12-03")).toBe(0);
    });

    it("sends nothing when a late post pushes a past month over", async () => {
      await draft([monthly("Restaurants", 500)]);
      await load([spend("dinner-1", "2026-10-05", 450, "Restaurants")]);
      expect(await check("2026-11-01")).toBe(0);

      await load([
        { ...spend("dinner-2", "2026-11-02", 100, "Restaurants"), authorized: "2026-10-30" },
        fee("late-fee", "2026-11-02", 25, "BANK_FEES_LATE_FEES", { authorized: "2026-10-31" }),
      ]);
      expect(await check("2026-11-03")).toBe(0);
      expect(await texts()).toEqual([]);
    });
  });

  describe("a Bills price rise", () => {
    // Fiber Co's monthly Recurring charge went from $70 to $85 in November: a Price increase, a
    // $15 rise. With `cell`, Cell Co's monthly charge at that many dollars is still due on Nov 20,
    // so it counts in P as R_due.
    const fiber = async (options: { budget?: number; cell?: number; extra?: TxnSpec[] } = {}) => {
      const { budget = 80, cell, extra = [] } = options;
      await draft([monthly("Phone and internet", budget)]);
      const charges: { name: string; next: string; paid: [string, string, number][] }[] = [
        {
          name: "Fiber Co",
          next: "2026-12-05",
          paid: [
            ["fiber-aug", "2026-08-05", 70],
            ["fiber-sep", "2026-09-05", 70],
            ["fiber-oct", "2026-10-05", 70],
            ["fiber-nov", "2026-11-05", 85],
          ],
        },
      ];
      if (cell !== undefined) {
        charges.push({
          name: "Cell Co",
          next: "2026-11-20",
          paid: [
            ["cell-aug", "2026-08-20", cell],
            ["cell-sep", "2026-09-20", cell],
            ["cell-oct", "2026-10-20", cell],
          ],
        });
      }
      await load([
        ...charges.flatMap(({ name, paid }) =>
          paid.map(([id, date, dollars]) => spend(id, date, dollars, "Phone and internet", name)),
        ),
        ...extra,
      ]);
      const accountId = await accountIdOf("fiber-nov");
      await replaceRecurringCharges(
        bank.database,
        charges.map(({ name, next, paid }) => ({
          id: `charge-${name}`,
          merchantId: null,
          merchantName: name,
          category: "Phone and internet",
          schedule: "monthly" as const,
          nextExpectedDate: next,
          latestAmount: $(paid.at(-1)?.[2] ?? 0),
          priceHistory: paid.map(([id, date, dollars]) => ({
            transactionId: ids.get(id) ?? id,
            date,
            amount: $(dollars),
          })),
          accountId,
          status: "active" as const,
          foundAt: at("2026-11-05"),
          endedAt: null,
          endedBy: null,
        })),
      );
    };
    const accountIdOf = async (providerId: string) =>
      String(
        (
          await bank.database.$client.execute({
            sql: "SELECT account_id FROM transactions WHERE provider_transaction_id = ?",
            args: [providerId],
          })
        ).rows[0]?.account_id,
      );

    it("sends only the Price increase Alert when the rise explains the overage", async () => {
      // $85 is over $80, but $85 less the $15 rise is $70, within the Budget.
      await fiber();
      expect(await check("2026-11-10")).toBe(0);
    });

    it("sends Over Budget when Spending outside the rise runs high", async () => {
      // $105 less the $15 rise is $90, over $80. The router has no Merchant.
      await fiber({ extra: [spend("router", "2026-11-08", 20, "Phone and internet")] });
      expect(await check("2026-11-10")).toBe(1);
      expect(await texts()).toEqual([
        "Phone and internet is over Budget for Nov 2026: $105 of $80. Latest: $20.00 on Nov 8.",
      ]);
    });

    it("sends no On pace when P less the rise is under 20% over", async () => {
      // P = $85 posted + $80 Cell Co due = $165, 27% over $130. Less the $15 rise, $150 is 15% over.
      await fiber({ budget: 130, cell: 80 });
      expect(await check("2026-11-10")).toBe(0);
    });

    it("sends On pace when P less the rise is still 20% or more over", async () => {
      // P = $85 posted + $100 Cell Co due = $185. Less the $15 rise, $170 is still 31% over $130.
      await fiber({ budget: 130, cell: 100 });
      expect(await check("2026-11-10")).toBe(1);
      expect(await texts()).toEqual([
        "Phone and internet is on pace for $185 in Nov 2026, 42% over its $130 Budget. Spent so far: $85.",
      ]);
    });
  });

  describe("card interest or a fee", () => {
    it("fires once per Transaction, and Interest and fees sends no Over Budget", async () => {
      await draft([monthly("Interest and fees", 0)]);
      await load([
        fee("late-fee", "2026-11-05", 25, "BANK_FEES_LATE_FEES"),
        fee("interest", "2026-11-06", 31.2, "BANK_FEES_INTEREST_CHARGE", { account: CARD.id }),
        fee("fx-fee", "2026-11-07", 3, "BANK_FEES_FOREIGN_TRANSACTION_FEES", {
          account: CARD.id,
          merchant: "Skyway Air",
        }),
        // Interest charged on a checking Account is not card interest.
        fee("overdraft-interest", "2026-11-08", 4.1, "BANK_FEES_INTEREST_CHARGE"),
      ]);

      expect(await check("2026-11-10")).toBe(4);
      expect((await texts()).sort()).toEqual(
        [
          "Fee: $25.00 on Checking on Nov 5.",
          "Card interest: $31.20 on Visa Card on Nov 6.",
          "Fee: $3.00 at Skyway Air on Visa Card on Nov 7.",
          "Fee: $4.10 on Checking on Nov 8.",
        ].sort(),
      );
      const alerts = await alertList(bank.database);
      expect(alerts.every((alert) => alert.kind === "Card interest or fee")).toBe(true);
      expect(
        alerts.find((alert) => alert.text.startsWith("Card interest"))?.transactionIds,
      ).toEqual([ids.get("interest")]);

      expect(await check("2026-11-11")).toBe(0);
    });

    it("never fires for loan interest, a pending fee, or before the first draft", async () => {
      await load([
        fee("early-fee", "2026-11-03", 12, "BANK_FEES_ATM_FEES"),
        spend("dinner", "2026-11-04", 900, "Restaurants"),
      ]);
      // Overspending checks start after the first Budget draft.
      expect(await check("2026-11-10")).toBe(0);

      await draft([monthly("Interest and fees", 0), monthly("Restaurants", 100)]);
      await load([
        // A tracked loan payment: its interest part keeps Money movement's Category.
        {
          id: "mortgage-payment",
          date: "2026-11-01",
          parts: [
            {
              type: "Spending",
              amount: -$(400),
              category: "Interest and fees",
              keepsCategory: true,
            },
            { type: "Spending", amount: -$(1_100), category: "Housing", keepsCategory: true },
          ],
        },
        // An untracked loan payment a Member put in Interest and fees.
        fee("car-payment", "2026-11-02", 300, "LOAN_PAYMENTS_CAR_PAYMENT"),
        // Interest on the loan's own Account.
        fee("loan-interest", "2026-11-02", 200, "BANK_FEES_INTEREST_CHARGE", {
          account: MORTGAGE.id,
        }),
        fee("pending-fee", "2026-11-09", 35, "BANK_FEES_OVERDRAFT_FEES", { pending: true }),
      ]);
      expect(await check("2026-11-10")).toBe(2);
      expect((await texts()).sort()).toEqual([
        "Fee: $12.00 on Checking on Nov 3.",
        "Restaurants is over Budget for Nov 2026: $900 of $100. Latest: $900.00 on Nov 4.",
      ]);
    });

    it("skips a fee or Spending the provider removed, and a Refund of a fee", async () => {
      await draft([monthly("Interest and fees", 0), monthly("Restaurants", 100)]);
      await load([
        fee("removed-fee", "2026-11-05", 35, "BANK_FEES_OVERDRAFT_FEES"),
        spend("dinner", "2026-11-04", 150, "Restaurants", "Harbor Grill"),
        spend("removed-dinner", "2026-11-06", 40, "Restaurants", "Blue Door Cafe"),
        // A $35 late fee with $10 of an earlier fee given back on the same line: the Refund part
        // is no Spending, so the fee is $35.
        {
          id: "fee-and-refund",
          date: "2026-11-07",
          parts: [
            { type: "Spending", amount: -$(35), category: "Interest and fees" },
            { type: "Refund", amount: $(10), category: "Interest and fees" },
          ],
          code: "BANK_FEES_LATE_FEES",
        },
      ]);
      bank.fake.addPages(BANK, { removed: [{ id: "removed-fee" }, { id: "removed-dinner" }] });
      await syncConnection(connectionId, () => at("2026-11-10"));

      expect(await check("2026-11-10")).toBe(2);
      expect((await texts()).sort()).toEqual([
        "Fee: $35.00 on Checking on Nov 7.",
        "Restaurants is over Budget for Nov 2026: $150 of $100. Latest: $150.00 at Harbor Grill on Nov 4.",
      ]);
    });

    it("skips a $0 interest line, and a later $0 line is not Latest", async () => {
      await draft([monthly("Interest and fees", 0), monthly("Restaurants", 100)]);
      await load([
        fee("zero-interest", "2026-11-06", 0, "BANK_FEES_INTEREST_CHARGE", { account: CARD.id }),
        spend("dinner", "2026-11-04", 150, "Restaurants", "Harbor Grill"),
        spend("zero-dinner", "2026-11-08", 0, "Restaurants", "Blue Door Cafe"),
      ]);

      expect(await check("2026-11-10")).toBe(1);
      expect(await texts()).toEqual([
        "Restaurants is over Budget for Nov 2026: $150 of $100. Latest: $150.00 at Harbor Grill on Nov 4.",
      ]);
    });
  });

  describe("as a follow-up step", () => {
    let stop: () => void;
    const clock = () => at("2026-11-10");

    beforeEach(() => {
      stop = startOverspendingChecks({ database: bank.database, now: clock }).stop;
    });

    afterEach(() => {
      stop();
    });

    it("checks the new Transactions after each sync", async () => {
      await draft([monthly("Interest and fees", 0)]);
      await load([fee("late-fee", "2026-11-05", 25, "BANK_FEES_LATE_FEES")]);
      await runFollowUp(clock);
      expect(await texts()).toEqual(["Fee: $25.00 on Checking on Nov 5."]);
    });

    it("stops at its cap with one System notice, and the next run that succeeds ends it", async () => {
      await draft([monthly("Interest and fees", 0)]);
      await load([fee("late-fee", "2026-11-05", 25, "BANK_FEES_LATE_FEES")]);
      await bank.database.$client.execute("ALTER TABLE alerts RENAME TO alerts_away");
      for (let run = 1; run < OVERSPENDING_CHECKS_CAP; run += 1) {
        await expect(runFollowUp(clock)).rejects.toThrow("The Overspending checks failed.");
      }
      // The run at the cap gives up on the Transaction, and the job goes on.
      await expect(runFollowUp(clock)).resolves.toBeUndefined();
      const open = async () =>
        (
          await bank.database.$client.execute({
            sql: "SELECT text FROM system_notices WHERE condition = ? AND closed_at IS NULL",
            args: [OVERSPENDING_CHECKS_STOPPED],
          })
        ).rows;
      expect(await open()).toHaveLength(1);

      await bank.database.$client.execute("ALTER TABLE alerts_away RENAME TO alerts");
      await load([fee("atm-fee", "2026-11-06", 3, "BANK_FEES_ATM_FEES")]);
      await runFollowUp(clock);
      expect(await open()).toEqual([]);
      expect(await texts()).toEqual(["Fee: $3.00 on Checking on Nov 6."]);
    });
  });
});
