import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { connectionRemoving, syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { startCategorization } from "../categorization/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { setTransactionType, startMoneyMovement } from "../money-movement/index.ts";
import {
  addMonths,
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
      // Streamly fits the 29th and the 30th with 3 days off each; a tie takes the earlier day.
      expect(all.map((each) => [each.fixedDay, each.nextExpectedDate])).toEqual([
        [29, "2024-04-29"],
        [29, "2026-04-29"],
      ]);
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

    // Card interest, in Interest and fees: monthly, near one amount, with a rise of more than 5%.
    const interest = (id: string, postedDate: string, spent: number, merchantName: string) =>
      charge(id, postedDate, spent, {
        merchantName,
        description: "INTEREST CHARGE ON PURCHASES",
        category: {
          name: "BANK_FEES_INTEREST_CHARGE",
          confidence: "VERY_HIGH",
          version: "v2",
          mcc: null,
        },
      });

    it("forms no Recurring charge from Spending in Interest and fees, so no Price increase", async () => {
      await sync(
        interest("i1", "2026-06-28", 2_889, "Interest Charge On Purchases"),
        interest("i2", "2026-07-28", 3_057, "Interest Charge On Purchases"),
        interest("i3", "2026-08-28", 2_934, "Interest Charge On Purchases"),
        interest("i4", "2026-09-28", 2_747, "Interest Charge On Purchases"),
        interest("i5", "2026-10-28", 3_227, "Interest Charge On Purchases"),
        // An ATM fee a year apart, at one amount: a yearly pair, in Interest and fees too.
        ...["2025-11-02", "2026-10-27"].map((date) =>
          charge(`atm-${date}`, date, 350, {
            merchantName: "ATM Fee",
            category: { name: "BANK_FEES_ATM_FEES", confidence: "HIGH", version: "v2", mcc: null },
          }),
        ),
      );

      // Price increase reads only Recurring charges' price histories.
      expect(await charges()).toEqual([]);
    });

    it("keeps a subscription at a Merchant that also has interest lines", async () => {
      await sync(
        charge("s1", "2026-08-03", 999, { merchantName: "Everyday Card" }),
        charge("s2", "2026-09-03", 999, { merchantName: "Everyday Card" }),
        charge("s3", "2026-10-03", 999, { merchantName: "Everyday Card" }),
        interest("i1", "2026-08-25", 2_889, "Everyday Card"),
        interest("i2", "2026-09-25", 3_057, "Everyday Card"),
        interest("i3", "2026-10-25", 2_934, "Everyday Card"),
      );

      expect(await found()).toEqual([
        ["monthly", "active", ["2026-08-03 999", "2026-09-03 999", "2026-10-03 999"]],
      ]);
    });
  });

  describe("a frequent shop", () => {
    const grocer = (id: string, postedDate: string, spent: number) =>
      charge(id, postedDate, spent, { merchantName: "Green Grocer" });

    it("forms no series at a weekly grocery shop, even in the first weeks of a history", async () => {
      // The history starts on Aug 1. Three Saturdays within 7.5% make a weekly chain, but the
      // Tuesday visits fall in the 60 days after its first Transaction, at any amount.
      await sync(
        grocer("sat-1", "2026-08-01", 5_000),
        grocer("tue-1", "2026-08-04", 2_310),
        grocer("sat-2", "2026-08-08", 5_100),
        grocer("tue-2", "2026-08-11", 8_840),
        grocer("sat-3", "2026-08-15", 5_200),
        grocer("tue-3", "2026-08-18", 1_525),
        grocer("sat-4", "2026-08-22", 9_610),
        grocer("sat-5", "2026-08-29", 12_700),
      );

      expect(await charges()).toEqual([]);
    });

    it("forms no series after 3 other visits in the 60 days before, at any amount", async () => {
      await sync(
        grocer("one-1", "2026-06-20", 1_200),
        grocer("one-2", "2026-07-11", 7_450),
        grocer("one-3", "2026-07-30", 3_100),
        grocer("m-1", "2026-08-05", 4_000),
        grocer("m-2", "2026-09-05", 4_100),
        grocer("m-3", "2026-10-05", 4_000),
      );

      expect(await charges()).toEqual([]);
    });

    it("still finds a subscription at varied amounts at a Merchant with no other visits", async () => {
      await sync(
        charge("meal-1", "2026-08-01", 6_000, { merchantName: "Meal Kit" }),
        charge("meal-2", "2026-08-08", 6_200, { merchantName: "Meal Kit" }),
        charge("meal-3", "2026-08-15", 6_400, { merchantName: "Meal Kit" }),
        // Later ones continue it at any amount: they are part of the series, not other visits.
        ...["08-22", "08-29", "09-05", "09-12", "09-19", "09-26"].map((day, index) =>
          charge(`meal-${index + 4}`, `2026-${day}`, 4_500 + index * 900, {
            merchantName: "Meal Kit",
          }),
        ),
        charge("power-1", "2026-07-03", 10_000, { merchantName: "Power Co" }),
        charge("power-2", "2026-08-03", 10_400, { merchantName: "Power Co" }),
        charge("power-3", "2026-09-03", 10_600, { merchantName: "Power Co" }),
        charge("power-4", "2026-10-03", 13_900, { merchantName: "Power Co" }),
      );

      expect(
        (await charges()).map((each) => [
          each.merchant.name,
          each.schedule,
          each.priceHistory.length,
        ]),
      ).toEqual([
        ["Meal Kit", "weekly", 9],
        ["Power Co", "monthly", 4],
      ]);
    });

    // The 5th of each month, or another day, from January 2026 for `count` months.
    const monthly = (count: number, day = "05") =>
      Array.from(
        { length: count },
        (_, index) => `2026-${String(index + 1).padStart(2, "0")}-${day}`,
      );
    const summary = async () =>
      (await charges())
        .map(
          (each) =>
            `${each.merchant.name} ${each.schedule} ${each.latestAmount} ${each.priceHistory.length}`,
        )
        .sort();

    it("keeps two subscriptions at one Merchant that start on the same day", async () => {
      await sync(
        ...monthly(9).map((date, index) =>
          charge(`small-${index}`, date, 99, { merchantName: "Apple" }),
        ),
        ...monthly(9).map((date, index) =>
          charge(`large-${index}`, date, 999, { merchantName: "Apple" }),
        ),
      );

      expect(await summary()).toEqual(["Apple monthly 99 9", "Apple monthly 999 9"]);
    });

    it("keeps two subscriptions at one Merchant that start 1 day apart", async () => {
      await sync(
        ...monthly(9).map((date, index) =>
          charge(`small-${index}`, date, 99, { merchantName: "Apple" }),
        ),
        ...monthly(9, "06").map((date, index) =>
          charge(`large-${index}`, date, 999, { merchantName: "Apple" }),
        ),
      );

      expect(await summary()).toEqual(["Apple monthly 99 9", "Apple monthly 999 9"]);
    });

    it("keeps two subscriptions at one Merchant whose prices both rise a year later", async () => {
      // 2025 to 2026: $0.99 on the 5th and $9.99 on the 6th, which rise to $1.29 and $12.99 in their
      // 13th month. Each is steady around the other's start.
      const monthOf = (index: number, day: number) =>
        new Date(Date.UTC(2025, index, day)).toISOString().slice(0, 10);
      await sync(
        ...Array.from({ length: 24 }, (_, index) =>
          charge(`small-${index}`, monthOf(index, 5), index < 12 ? 99 : 129, {
            merchantName: "Apple",
          }),
        ),
        ...Array.from({ length: 24 }, (_, index) =>
          charge(`large-${index}`, monthOf(index, 6), index < 12 ? 999 : 1_299, {
            merchantName: "Apple",
          }),
        ),
      );

      expect(await summary()).toEqual(["Apple monthly 129 24", "Apple monthly 1299 24"]);
    });

    it("keeps a monthly and a weekly subscription at one Merchant that start a month apart", async () => {
      const weekly = Array.from({ length: 30 }, (_, index) =>
        new Date(Date.UTC(2026, 1, 3 + 7 * index)).toISOString().slice(0, 10),
      );
      await sync(
        ...monthly(9).map((date, index) =>
          charge(`prime-${index}`, date, 1_499, { merchantName: "Amazon" }),
        ),
        ...weekly.map((date, index) =>
          charge(`box-${index}`, date, 4_000, { merchantName: "Amazon" }),
        ),
      );

      expect(await summary()).toEqual(["Amazon monthly 1499 9", "Amazon weekly 4000 30"]);
    });

    it("forms nothing at a daily coffee, a fixed-day weekly grocer with extra visits, or a restaurant", async () => {
      // A fixed seed, so the amounts are the same each run.
      let seed = 7;
      const random = () => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed / 2_147_483_648;
      };
      const txns: TxnRecord[] = [];
      for (let day = 0; day < 300; day += 1) {
        const date = new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10);
        const at = (id: string, spent: number, merchantName: string) =>
          txns.push(charge(`${id}-${day}`, date, spent, { merchantName }));
        at("coffee", 325 + Math.floor(random() * 550), "Daily Grind");
        // Each Saturday within 7.5% of each other, plus visits now and then.
        if (day % 7 === 2) at("week", 12_000 + Math.floor(random() * 800), "Green Grocer");
        if (random() < 0.08) at("extra", 1_000 + Math.floor(random() * 5_000), "Green Grocer");
        if (random() < 0.15) at("dinner", 900 + Math.floor(random() * 5_900), "Pine Tavern");
      }
      await sync(...txns);

      expect(await summary()).toEqual([]);
    });

    it("counts another chain at the same amount as visits: a daily coffee at one price", async () => {
      await sync(
        ...Array.from({ length: 120 }, (_, day) =>
          charge(
            `latte-${day}`,
            new Date(Date.UTC(2026, 5, 1 + day)).toISOString().slice(0, 10),
            475,
            {
              merchantName: "Corner Bean",
            },
          ),
        ),
      );

      expect(await summary()).toEqual([]);
    });

    it("counts another chain as visits when it continues at changing amounts", async () => {
      await sync(
        grocer("sat-1", "2026-08-01", 5_000),
        grocer("sat-2", "2026-08-08", 5_100),
        grocer("sat-3", "2026-08-15", 5_200),
        // Tuesdays: a chain within 7.5%, then visits at any amount that continue it.
        grocer("tue-1", "2026-08-04", 2_000),
        grocer("tue-2", "2026-08-11", 2_100),
        grocer("tue-3", "2026-08-18", 2_150),
        grocer("tue-4", "2026-08-25", 9_000),
        grocer("tue-5", "2026-09-01", 9_500),
        grocer("tue-6", "2026-09-08", 1_500),
        // Visits in the Tuesday chain's window, but not the Saturday one's.
        grocer("extra-1", "2026-10-01", 3_300),
        grocer("extra-2", "2026-10-02", 7_700),
        grocer("extra-3", "2026-10-03", 1_100),
      );

      expect(await summary()).toEqual([]);
    });

    it("forms no yearly series at a shop visited for years", async () => {
      // A fixed seed. Over 5 years many visits fall a year apart within 15%, by chance.
      let seed = 11;
      const random = () => {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
        return seed / 2_147_483_648;
      };
      const txns: TxnRecord[] = [];
      for (let day = 0; day < 5 * 365; day += 1) {
        if (random() < 0.11) {
          const date = new Date(Date.UTC(2022, 0, 1 + day)).toISOString().slice(0, 10);
          txns.push(grocer(`visit-${day}`, date, 1_300 + Math.floor(random() * 22_600)));
        }
      }
      await sync(...txns);

      expect(await summary()).toEqual([]);
    });

    it("forms no yearly series at a monthly bill whose amount moves, and finds one monthly one", async () => {
      // A utility bill on the 11th. Each month is a year from one within 15%, but the months
      // between differ by more than 7.5%, until the last three.
      const firstYear = [
        8_000, 16_000, 10_000, 20_000, 12_000, 18_000, 9_000, 15_000, 11_000, 21_000, 13_000,
        17_000,
      ];
      const amounts = [
        ...firstYear,
        ...firstYear.slice(0, 9).map((amount) => Math.round(amount * 1.05)),
        19_000,
        19_500,
        19_200,
      ];
      await sync(
        ...amounts.map((amount, index) => {
          const date = addMonths("2024-11-11", index);
          return charge(`power-${date}`, date, amount, { merchantName: "Power Co" });
        }),
      );

      expect(await found()).toEqual([
        ["monthly", "active", ["2026-08-11 19000", "2026-09-11 19500", "2026-10-11 19200"]],
      ]);
    });

    it("keeps a yearly subscription at a Merchant with a monthly one, and a second yearly one", async () => {
      const suite = (id: string, postedDate: string, spent: number) =>
        charge(id, postedDate, spent, { merchantName: "Cloud Suite" });
      await sync(
        // A monthly plan: its Transactions between the yearly ones belong to another series.
        ...Array.from({ length: 22 }, (_, index) => {
          const date = addMonths("2025-01-05", index);
          return suite(`plan-${date}`, date, 999);
        }),
        suite("year-1", "2025-03-01", 9_900),
        suite("year-2", "2026-03-01", 9_900),
        suite("add-on-1", "2025-09-15", 4_900),
        suite("add-on-2", "2026-09-15", 4_900),
      );

      const firsts = (await found()).map(([schedule, status, prices]) => [
        schedule,
        status,
        prices?.[0],
      ]);
      expect(firsts).toEqual([
        ["monthly", "active", "2025-01-05 999"],
        ["yearly", "active", "2025-03-01 9900"],
        ["yearly", "active", "2025-09-15 4900"],
      ]);
    });

    // Yearly plans at one Merchant, such as an app store, at prices more than 15% apart.
    const plans = (prices: [string, number][]) =>
      prices.flatMap(([day, spent]) =>
        ["2025", "2026"].map((year) =>
          charge(`plan-${year}-${day}`, `${year}-${day}`, spent, { merchantName: "App Store" }),
        ),
      );
    const yearlyFirsts = async () =>
      (await found()).map(([schedule, status, prices]) => [schedule, status, prices?.[0]]);

    it("keeps 4 yearly subscriptions at different prices at one Merchant", async () => {
      // Between each plan's two Transactions fall the other 3 plans' Transactions, but each of those
      // plans' prices shows up only once in the year: they are another series' Transactions.
      await sync(
        ...plans([
          ["01-10", 2_999],
          ["03-05", 5_999],
          ["05-20", 9_999],
          ["08-14", 14_999],
        ]),
      );

      expect(await yearlyFirsts()).toEqual([
        ["yearly", "active", "2025-01-10 2999"],
        ["yearly", "active", "2025-03-05 5999"],
        ["yearly", "active", "2025-05-20 9999"],
        ["yearly", "active", "2025-08-14 14999"],
      ]);
    });

    it("keeps 3 yearly subscriptions at one Merchant with 1 other purchase between", async () => {
      await sync(
        ...plans([
          ["01-10", 2_999],
          ["05-05", 5_999],
          ["09-20", 9_999],
        ]),
        charge("one-off", "2025-07-01", 499, { merchantName: "App Store" }),
      );

      expect(await yearlyFirsts()).toEqual([
        ["yearly", "active", "2025-01-10 2999"],
        ["yearly", "active", "2025-05-05 5999"],
        ["yearly", "active", "2025-09-20 9999"],
      ]);
    });

    it("counts a yearly pair whose price shows up again in the year as visits", async () => {
      // The 59.99 plan's price shows up twice more in the year between, so it is not a series of
      // its own, and with them the 29.99 plan has 3 other Transactions between its two.
      await sync(
        ...plans([
          ["01-10", 2_999],
          ["03-05", 5_999],
        ]),
        charge("again-1", "2025-06-12", 6_100, { merchantName: "App Store" }),
        charge("again-2", "2025-09-12", 5_900, { merchantName: "App Store" }),
      );

      expect(await yearlyFirsts()).toEqual([["yearly", "active", "2025-03-05 5999"]]);
    });

    it("ends a series once later Transactions show a frequent shop", async () => {
      await sync(
        grocer("g-1", "2026-08-01", 5_000),
        grocer("g-2", "2026-08-08", 5_100),
        grocer("g-3", "2026-08-15", 5_200),
      );
      expect(await charges()).toHaveLength(1);

      await sync(
        grocer("g-4", "2026-08-04", 2_000),
        grocer("g-5", "2026-08-11", 7_500),
        grocer("g-6", "2026-08-18", 900),
      );

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
      // A day late does not move the fixed day, the 3rd.
      expect((await charges())[0]).toMatchObject({
        latestAmount: 1_999,
        fixedDay: 3,
        nextExpectedDate: "2026-11-03",
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

  describe("a monthly series", () => {
    // Each Recurring charge's fixed day, next expected date, and status.
    const dates = async () =>
      (await charges()).map((each) => [each.fixedDay, each.nextExpectedDate, each.status]);

    it("keeps a bill on the 15th that posts the Tuesday after a Monday holiday", async () => {
      // Saturday Feb 15, 2025 is followed by Washington's Birthday on Monday Feb 17, so Tuesday Feb
      // 18 is the business day after: the business-day shift allows Feb 16 to Feb 20.
      now = new Date("2025-02-20T14:00:00.000Z");
      await sync(
        charge("h1", "2024-10-15", 8_500, { merchantName: "Power Co" }),
        charge("h2", "2024-11-15", 8_500, { merchantName: "Power Co" }),
        charge("h3", "2024-12-16", 8_500, { merchantName: "Power Co" }),
        charge("h4", "2025-01-15", 8_500, { merchantName: "Power Co" }),
        charge("h5", "2025-02-18", 8_500, { merchantName: "Power Co" }),
      );

      expect((await charges())[0]?.priceHistory.length).toBe(5);
      expect(await dates()).toEqual([[15, "2025-03-15", "active"]]);
      // Saturday Mar 15 shifts to Friday Mar 14 or Monday Mar 17: active through Mar 19.
      now = new Date("2025-03-19T14:00:00.000Z");
      expect(await dates()).toEqual([[15, "2025-03-15", "active"]]);
      now = new Date("2025-03-20T14:00:00.000Z");
      expect(await dates()).toEqual([[15, "2025-03-15", "inactive"]]);
    });

    it("does not drift with early and late months: the 13th, the 17th, then the 15th", async () => {
      now = new Date("2026-08-14T14:00:00.000Z");
      await sync(
        charge("d1", "2026-05-15", 1_549),
        charge("d2", "2026-06-15", 1_549),
        charge("d3", "2026-07-15", 1_549),
        charge("d4", "2026-08-13", 1_549),
      );
      expect(await dates()).toEqual([[15, "2026-09-15", "active"]]);

      now = new Date("2026-09-18T14:00:00.000Z");
      await sync(charge("d5", "2026-09-17", 1_549));
      expect(await dates()).toEqual([[15, "2026-10-15", "active"]]);

      now = new Date("2026-10-16T14:00:00.000Z");
      await sync(charge("d6", "2026-10-15", 1_549));
      expect(await dates()).toEqual([[15, "2026-11-15", "active"]]);
      expect((await charges())[0]?.priceHistory.length).toBe(6);
    });

    it("keeps a fixed day of 31 through February and a 30-day month", async () => {
      now = new Date("2025-03-01T14:00:00.000Z");
      await sync(
        charge("e1", "2024-12-31", 2_000),
        charge("e2", "2025-01-31", 2_000),
        charge("e3", "2025-02-28", 2_000),
      );
      expect(await dates()).toEqual([[31, "2025-03-31", "active"]]);

      now = new Date("2025-04-01T14:00:00.000Z");
      await sync(charge("e4", "2025-03-31", 2_000));
      expect(await dates()).toEqual([[31, "2025-04-30", "active"]]);

      now = new Date("2025-05-01T14:00:00.000Z");
      await sync(charge("e5", "2025-04-30", 2_000));
      expect(await dates()).toEqual([[31, "2025-05-31", "active"]]);
      expect((await charges())[0]?.priceHistory.length).toBe(5);
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
      // The fixed day stays the 5th. Sep 5 is a Saturday and Monday Sep 7 is Labor Day, so the
      // latest date the business-day shift allows is Tuesday Sep 8: active until 2 days after it.
      now = new Date("2026-09-10T14:00:00.000Z");
      expect((await charges())[0]).toMatchObject({
        fixedDay: 5,
        nextExpectedDate: "2026-09-05",
        status: "active",
      });
      now = new Date("2026-09-11T14:00:00.000Z");
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
