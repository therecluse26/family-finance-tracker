import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { connectionRemoving, syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { startCategorization } from "../categorization/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { setTransactionType, startMoneyMovement } from "../money-movement/index.ts";
import {
  endCharge,
  findRecurringCharges,
  recurringCharges,
  startRecurringCharges,
} from "./index.ts";

// Recurring charges (spec 06, Recurring charges; When checks run), through the recurring module's
// interface. Transactions arrive through the fake adapter, and the follow-up job runs Matching,
// Categorization, then the checks.

const BANK = "fake-first-bank";
const MEMBER = "member-1";
const CARD = fakeAccount({
  id: "acc-card",
  name: "Everyday Card",
  type: "credit",
  subtype: "credit card",
});

describe("Recurring charges", () => {
  let bank: TestBank;
  let stops: (() => void)[];
  let connectionId: string;
  // The Household's clock: the checks and the list read it.
  let now: Date;
  const clock = () => now;

  // A posted charge from one Merchant on the card, in whole cents spent.
  const charge = (
    id: string,
    postedDate: string,
    spent: number,
    fields: Partial<TxnRecord> = {},
  ): TxnRecord =>
    fakeTxn({
      id,
      accountId: CARD.id,
      amount: -spent,
      postedDate,
      merchantName: "Streamly",
      category: {
        name: "ENTERTAINMENT_TV_AND_MOVIES",
        confidence: "HIGH",
        version: "v2",
        mcc: null,
      },
      ...fields,
    });
  const sync = async (...txns: TxnRecord[]) => {
    bank.fake.addPages(BANK, { added: txns });
    await syncConnection(connectionId, clock);
    await runFollowUp(clock);
  };
  const charges = () => recurringCharges(bank.database, now);
  // Each Recurring charge's schedule, status, and price history as date and amount.
  const found = async () =>
    (await charges()).map((each) => [
      each.schedule,
      each.status,
      each.priceHistory.map((entry) => `${entry.date} ${entry.amount}`),
    ]);

  beforeEach(async () => {
    now = new Date("2026-11-01T14:00:00.000Z");
    bank = await newTestBank();
    stops = [
      startMoneyMovement({ database: bank.database }).stop,
      startCategorization({ database: bank.database }).stop,
      startRecurringCharges({ database: bank.database, now: clock }).stop,
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

  describe("finding a series", () => {
    it("finds a weekly series, and stores what spec 06 lists", async () => {
      await sync(
        charge("w1", "2026-10-15", 1_200),
        charge("w2", "2026-10-22", 1_200),
        // 2 days late is within the margin.
        charge("w3", "2026-10-31", 1_250),
      );

      const [weekly] = await charges();
      expect(weekly).toMatchObject({
        merchant: { id: null, name: "Streamly" },
        category: "Entertainment",
        schedule: "weekly",
        nextExpectedDate: "2026-11-07",
        latestAmount: 1_250,
        accountId: expect.any(String),
        status: "active",
      });
      expect(weekly?.priceHistory.map((entry) => [entry.date, entry.amount])).toEqual([
        ["2026-10-15", 1_200],
        ["2026-10-22", 1_200],
        ["2026-10-31", 1_250],
      ]);
    });

    it("finds a series every 2 weeks, and none 3 days off the margin", async () => {
      await sync(
        charge("a1", "2026-09-22", 5_000),
        charge("a2", "2026-10-06", 5_000),
        charge("a3", "2026-10-20", 5_000),
        charge("b1", "2026-09-23", 7_000, { merchantName: "Lawn Crew" }),
        charge("b2", "2026-10-07", 7_000, { merchantName: "Lawn Crew" }),
        charge("b3", "2026-10-24", 7_000, { merchantName: "Lawn Crew" }),
      );

      expect(await found()).toEqual([
        ["every 2 weeks", "active", ["2026-09-22 5000", "2026-10-06 5000", "2026-10-20 5000"]],
      ]);
    });

    it("finds a monthly series from Jan 31 to Feb 28, and to Feb 29 in a leap year", async () => {
      await sync(
        charge("n1", "2026-01-31", 1_549),
        charge("n2", "2026-02-28", 1_549),
        charge("n3", "2026-03-28", 1_549),
        charge("l1", "2024-01-31", 999, { merchantName: "Leap Gym" }),
        charge("l2", "2024-02-29", 999, { merchantName: "Leap Gym" }),
        charge("l3", "2024-03-29", 999, { merchantName: "Leap Gym" }),
      );

      const all = await charges();
      expect(
        all.map((each) => [each.merchant.name, each.schedule, each.priceHistory.length]),
      ).toEqual([
        ["Leap Gym", "monthly", 3],
        ["Streamly", "monthly", 3],
      ]);
      expect(all.map((each) => each.nextExpectedDate)).toEqual(["2024-04-29", "2026-04-28"]);
    });

    it("needs 3 Transactions on a weekly, 2-week, or monthly schedule", async () => {
      await sync(charge("m1", "2026-09-05", 1_549), charge("m2", "2026-10-05", 1_549));

      expect(await charges()).toEqual([]);
    });

    it("needs amounts within 7.5% of each other: the largest at most the smallest × 1.075", async () => {
      await sync(
        charge("in1", "2026-08-03", 10_000),
        charge("in2", "2026-09-03", 10_750),
        charge("in3", "2026-10-03", 10_000),
        charge("out1", "2026-08-04", 10_000, { merchantName: "Power Co" }),
        charge("out2", "2026-09-04", 10_751, { merchantName: "Power Co" }),
        charge("out3", "2026-10-04", 10_000, { merchantName: "Power Co" }),
      );

      expect((await charges()).map((each) => each.merchant.name)).toEqual(["Streamly"]);
    });

    it("finds a yearly series from 2 Transactions 11 to 13 months apart, within 15%", async () => {
      await sync(
        charge("y1", "2025-02-10", 10_000, { merchantName: "Domain Host" }),
        charge("y2", "2026-01-15", 11_500, { merchantName: "Domain Host" }),
        charge("over1", "2025-03-01", 10_000, { merchantName: "Cloud Drive" }),
        charge("over2", "2026-03-01", 11_501, { merchantName: "Cloud Drive" }),
        charge("late1", "2025-01-01", 10_000, { merchantName: "Car Club" }),
        charge("late2", "2026-02-02", 10_000, { merchantName: "Car Club" }),
      );

      expect(await found()).toEqual([
        ["yearly", "active", ["2025-02-10 10000", "2026-01-15 11500"]],
      ]);
      expect((await charges())[0]?.nextExpectedDate).toBe("2027-01-15");
    });

    it("never counts a Transfer, and finds more than one series at different amounts", async () => {
      await sync(
        charge("s1", "2026-08-03", 999),
        charge("s2", "2026-09-03", 999),
        charge("s3", "2026-10-03", 999),
        charge("p1", "2026-08-12", 1_999),
        charge("p2", "2026-09-12", 1_999),
        charge("p3", "2026-10-12", 1_999),
      );
      expect((await charges()).map((each) => each.latestAmount)).toEqual([999, 1_999]);

      const rows = await bank.database.$client.execute(
        "SELECT id FROM transactions WHERE provider_transaction_id IN ('p1', 'p2', 'p3')",
      );
      for (const row of rows.rows) {
        await setTransactionType(bank.database, String(row.id), "Transfer");
      }
      await runFollowUp(clock);

      expect((await charges()).map((each) => each.latestAmount)).toEqual([999]);
    });

    it("leaves out a Transaction that no longer shows", async () => {
      await sync(
        charge("v1", "2026-08-03", 999),
        charge("v2", "2026-09-03", 999),
        charge("v3", "2026-10-03", 999),
      );
      expect(await charges()).toHaveLength(1);

      // The provider removes the middle one, which leaves 2. The checks leave it out even before
      // Matching drops its result.
      bank.fake.addPages(BANK, { removed: [{ id: "v2" }] });
      await syncConnection(connectionId, clock);
      await findRecurringCharges(bank.database, now);

      expect(await charges()).toEqual([]);
    });

    it("uses posted Transactions only", async () => {
      await sync(charge("h1", "2026-08-03", 999), charge("h2", "2026-09-03", 999), {
        ...charge("h3", "2026-10-03", 999),
        pending: true,
      });

      expect(await charges()).toEqual([]);
    });
  });

  describe("continuing a series", () => {
    const monthly = [
      charge("c1", "2026-07-03", 1_549),
      charge("c2", "2026-08-03", 1_549),
      charge("c3", "2026-09-03", 1_549),
    ];

    it("continues at any amount within the margin, so a rise above 7.5% continues it", async () => {
      await sync(...monthly);

      await sync(charge("c4", "2026-10-04", 1_999));

      expect(await found()).toEqual([
        [
          "monthly",
          "active",
          ["2026-07-03 1549", "2026-08-03 1549", "2026-09-03 1549", "2026-10-04 1999"],
        ],
      ]);
      expect((await charges())[0]).toMatchObject({
        latestAmount: 1_999,
        nextExpectedDate: "2026-11-04",
      });
    });

    it("continues with the one nearest the latest amount when two fit", async () => {
      await sync(
        ...monthly,
        charge("other", "2026-10-02", 4_000),
        charge("c4", "2026-10-04", 1_599),
      );

      expect((await charges()).map((each) => each.priceHistory.at(-1))).toEqual([
        { transactionId: expect.any(String), date: "2026-10-04", amount: 1_599 },
      ]);
    });
  });

  describe("inactive and ended", () => {
    it("goes inactive once the next expected date plus 2 days passes", async () => {
      now = new Date("2026-10-01T14:00:00.000Z");
      await sync(
        charge("i1", "2026-07-20", 1_549),
        charge("i2", "2026-08-20", 1_549),
        charge("i3", "2026-09-20", 1_549),
      );
      // The next expected date is Oct 20.
      now = new Date("2026-10-22T14:00:00.000Z");
      expect((await charges())[0]?.status).toBe("active");

      now = new Date("2026-10-23T14:00:00.000Z");
      expect((await charges())[0]?.status).toBe("inactive");
    });

    it("goes inactive 13 months after a yearly one's last Transaction", async () => {
      now = new Date("2025-06-01T14:00:00.000Z");
      await sync(
        charge("y1", "2024-05-10", 9_900, { merchantName: "Domain Host" }),
        charge("y2", "2025-05-12", 9_900, { merchantName: "Domain Host" }),
      );

      now = new Date("2026-06-12T14:00:00.000Z");
      expect((await charges())[0]?.status).toBe("active");
      now = new Date("2026-06-13T14:00:00.000Z");
      expect((await charges())[0]?.status).toBe("inactive");
    });

    it("revives within 7.5% of the latest amount, on the last date plus whole intervals", async () => {
      now = new Date("2026-08-10T14:00:00.000Z");
      await sync(
        charge("r1", "2026-03-05", 1_549),
        charge("r2", "2026-04-05", 1_549),
        charge("r3", "2026-05-05", 1_549),
        // June and July are missed. This one is off the schedule.
        charge("off", "2026-07-20", 1_549),
      );
      expect((await charges())[0]?.status).toBe("inactive");

      await sync(charge("back", "2026-08-06", 1_600));

      expect(await found()).toEqual([
        [
          "monthly",
          "active",
          ["2026-03-05 1549", "2026-04-05 1549", "2026-05-05 1549", "2026-08-06 1600"],
        ],
      ]);
      // Active until the next expected date, Sep 6, plus 2 days.
      now = new Date("2026-09-08T14:00:00.000Z");
      expect((await charges())[0]?.status).toBe("active");
      now = new Date("2026-09-09T14:00:00.000Z");
      expect((await charges())[0]?.status).toBe("inactive");
    });

    it("keeps the first end when a Member ends a Recurring charge again", async () => {
      await sync(
        charge("f1", "2026-08-05", 1_549),
        charge("f2", "2026-09-05", 1_549),
        charge("f3", "2026-10-05", 1_549),
      );
      const [first] = await charges();
      await endCharge(bank.database, first?.id ?? "", MEMBER, now);
      await bank.database.$client.execute(
        `INSERT INTO members (id, name, email, created_at, updated_at)
         VALUES ('member-2', 'Sam', 'sam@example.com', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
      );

      await endCharge(bank.database, first?.id ?? "", "member-2", new Date("2026-11-03T14:00:00Z"));

      const rows = await bank.database.$client.execute(
        "SELECT ended_by, ended_at FROM recurring_charges",
      );
      expect(rows.rows.map((row) => [row.ended_by, row.ended_at])).toEqual([
        [MEMBER, now.toISOString()],
      ]);
    });

    it("keeps an ended one ended, and later Transactions start a new series", async () => {
      await sync(
        charge("e1", "2026-05-05", 1_549),
        charge("e2", "2026-06-05", 1_549),
        charge("e3", "2026-07-05", 1_549),
      );
      const [first] = await charges();

      expect(await endCharge(bank.database, first?.id ?? "", MEMBER, now)).toMatchObject({
        status: "ended",
      });
      expect(await endCharge(bank.database, "no-such-id", MEMBER, now)).toBeUndefined();
      await sync(charge("e4", "2026-08-05", 1_549), charge("e5", "2026-09-05", 1_549));
      expect(await found()).toEqual([
        ["monthly", "ended", ["2026-05-05 1549", "2026-06-05 1549", "2026-07-05 1549"]],
      ]);

      await sync(charge("e6", "2026-10-05", 1_549));
      const [ended, renewed] = await charges();
      expect(ended).toMatchObject({ id: first?.id, status: "ended" });
      expect(renewed?.id).not.toBe(first?.id);
      expect(renewed?.priceHistory.map((entry) => entry.date)).toEqual([
        "2026-08-05",
        "2026-09-05",
        "2026-10-05",
      ]);
    });

    it("keeps a Recurring charge's ID as later checks continue it", async () => {
      await sync(
        charge("k1", "2026-07-03", 1_549),
        charge("k2", "2026-08-03", 1_549),
        charge("k3", "2026-09-03", 1_549),
      );
      const [before] = await charges();

      await sync(charge("k4", "2026-10-03", 1_549));

      expect((await charges()).map((each) => each.id)).toEqual([before?.id]);
    });
  });

  describe("Delete history", () => {
    it("deletes the Recurring charges on a removed Connection's Accounts, active and ended", async () => {
      // Another Connection's Recurring charge stays.
      const otherCard = fakeAccount({ id: "acc-other", type: "credit", subtype: "credit card" });
      const otherId = await bank.connect("fake-other-bank", "Other Bank");
      bank.fake.addPages("fake-other-bank", {
        accounts: [otherCard],
        added: ["2026-08-20", "2026-09-20", "2026-10-20"].map((postedDate, index) =>
          charge(`o${index}`, postedDate, 2_000, {
            accountId: otherCard.id,
            merchantName: "Cloud Drive",
          }),
        ),
      });
      await syncConnection(otherId, clock);
      await sync(
        charge("a1", "2026-08-03", 1_549),
        charge("a2", "2026-09-03", 1_549),
        charge("a3", "2026-10-03", 1_549),
        charge("g1", "2026-08-10", 4_000, { merchantName: "Lift Gym" }),
        charge("g2", "2026-09-10", 4_000, { merchantName: "Lift Gym" }),
        charge("g3", "2026-10-10", 4_000, { merchantName: "Lift Gym" }),
      );
      // Ended ones are never found again, so only the delete's own filter keeps Cloud Drive.
      for (const name of ["Lift Gym", "Cloud Drive"]) {
        const ended = (await charges()).find((each) => each.merchant.name === name);
        await endCharge(bank.database, ended?.id ?? "", MEMBER, now);
      }
      expect((await charges()).map((each) => [each.merchant.name, each.status])).toEqual([
        ["Streamly", "active"],
        ["Lift Gym", "ended"],
        ["Cloud Drive", "ended"],
      ]);
      const removing = connectionRemoving();
      expect(await removing.remove(connectionId)).toMatchObject({ outcome: "removed" });

      expect(await removing.deleteHistory(connectionId)).toMatchObject({ outcome: "deleted" });
      await runFollowUp(clock);

      expect((await charges()).map((each) => [each.merchant.name, each.status])).toEqual([
        ["Cloud Drive", "ended"],
      ]);
      const accounts = await bank.database.$client.execute("SELECT id FROM household_accounts");
      expect(accounts.rows).toHaveLength(1);
      // The removed Connection's row goes too, after its Recurring charges and Accounts.
      const left = await bank.database.$client.execute({
        sql: "SELECT id FROM connections WHERE id = ?",
        args: [connectionId],
      });
      expect(left.rows).toEqual([]);
    });
  });
});
