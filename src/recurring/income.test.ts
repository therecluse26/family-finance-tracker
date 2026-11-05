import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { connectionRemoving, syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { startCategorization } from "../categorization/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import {
  findIncomeSeries,
  paydays,
  startRecurringCharges,
  steadyIncome,
  typeSteadyIncome,
} from "./index.ts";

// Steady Income and paydays (spec 05, Steady Income), through the recurring module's interface.
// Income arrives through the fake adapter, and the follow-up job runs Matching, Categorization,
// then the checks, which find the Income series.

const BANK = "fake-first-bank";
const MEMBER = "member-1";
const CHECKING = fakeAccount({ id: "acc-checking", name: "Everyday Checking" });
const SAVINGS = fakeAccount({ id: "acc-savings", name: "Rainy Day", subtype: "savings" });
const CARD = fakeAccount({
  id: "acc-card",
  name: "Everyday Card",
  type: "credit",
  subtype: "credit card",
});

describe("Steady Income", () => {
  let bank: TestBank;
  let stops: (() => void)[];
  let connectionId: string;
  // The Household's clock: the checks and the reads use it.
  let now: Date;
  const clock = () => now;

  // A posted deposit from one payer on checking, in whole cents received.
  const pay = (
    id: string,
    postedDate: string,
    received: number,
    payer = "Acme Corp",
    fields: Partial<TxnRecord> = {},
  ): TxnRecord =>
    fakeTxn({
      id,
      accountId: CHECKING.id,
      amount: received,
      postedDate,
      merchantName: payer,
      description: `${payer.toUpperCase()} PAYROLL`,
      ...fields,
    });
  const sync = async (...txns: TxnRecord[]) => {
    bank.fake.addPages(BANK, { added: txns });
    await syncConnection(connectionId, clock);
    await runFollowUp(clock);
  };
  const income = () => steadyIncome(bank.database, now);
  const predicted = async () =>
    (await paydays(bank.database, now)).map((payday) => [
      payday.payer.name,
      payday.schedule,
      payday.date,
      payday.amount,
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
    bank.fake.addPages(BANK, { accounts: [CHECKING, SAVINGS, CARD] });
    await bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('${MEMBER}', 'Jamie', 'jamie@example.com', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    );
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  it("works the spec's example: Acme every 2 weeks, a monthly second job, a tax refund left out", async () => {
    await sync(
      pay("a1", "2026-09-25", 200_000),
      pay("a2", "2026-10-09", 205_000),
      pay("a3", "2026-10-23", 200_000),
      pay("j1", "2026-08-28", 166_700, "Corner Bakery"),
      pay("j2", "2026-09-28", 166_700, "Corner Bakery"),
      pay("j3", "2026-10-28", 166_700, "Corner Bakery"),
      pay("refund", "2026-10-15", 150_000, "IRS Treas 310"),
    );

    // $2,000 × 26 ÷ 12 = $4,333, plus $1,667: the $1,500 tax refund fits no series.
    expect(await income()).toEqual({
      amount: 600_000,
      detected: 600_000,
      detectedFrom: "Income series",
      typed: null,
    });
    expect(await predicted()).toEqual([
      ["Acme Corp", "every 2 weeks", "2026-11-06", 200_000],
      ["Corner Bakery", "monthly", "2026-11-28", 166_700],
    ]);
  });

  it("finds a twice-a-month series on the 1st and the 15th, each within 2 days", async () => {
    now = new Date("2026-11-03T14:00:00.000Z");
    await sync(
      pay("p1", "2026-09-01", 250_000),
      pay("p2", "2026-09-15", 250_000),
      pay("p3", "2026-10-01", 250_000),
      // Sunday the 15th is paid on Friday the 13th, and Sunday Nov 1 on Friday Oct 30.
      pay("p4", "2026-10-13", 250_000),
      pay("p5", "2026-10-30", 250_000),
    );

    expect(await predicted()).toEqual([["Acme Corp", "twice a month", "2026-11-15", 250_000]]);
    expect((await income()).detected).toBe(500_000);
  });

  it("finds a twice-a-month series on the 15th and the last day, through February", async () => {
    now = new Date("2026-04-20T14:00:00.000Z");
    await sync(
      pay("p1", "2026-01-15", 180_000),
      pay("p2", "2026-01-31", 180_000),
      pay("p3", "2026-02-15", 180_000),
      pay("p4", "2026-02-28", 180_000),
      pay("p5", "2026-03-15", 180_000),
      pay("p6", "2026-03-31", 180_000),
      pay("p7", "2026-04-15", 180_000),
    );

    expect(await predicted()).toEqual([["Acme Corp", "twice a month", "2026-04-30", 180_000]]);
    expect((await income()).detected).toBe(360_000);
  });

  const fixedDays = async () =>
    (await bank.database.$client.execute("SELECT fixed_days FROM income_series")).rows.map((row) =>
      JSON.parse(String(row.fixed_days)),
    );

  it("reads a series found in February as the 15th and the last day, not the 28th", async () => {
    now = new Date("2026-04-01T14:00:00.000Z");
    await sync(
      pay("p1", "2026-02-15", 180_000),
      pay("p2", "2026-02-28", 180_000),
      pay("p3", "2026-03-15", 180_000),
      pay("p4", "2026-03-31", 180_000),
    );
    expect(await predicted()).toEqual([["Acme Corp", "twice a month", "2026-04-15", 180_000]]);

    now = new Date("2026-08-20T14:00:00.000Z");
    await sync(
      ...["04-15", "04-30", "05-15", "05-31", "06-15", "06-30", "07-15", "07-31", "08-15"].map(
        (day, index) => pay(`q${index}`, `2026-${day}`, 180_000),
      ),
    );

    expect(await fixedDays()).toEqual([[15, 31]]);
    expect(await predicted()).toEqual([["Acme Corp", "twice a month", "2026-08-31", 180_000]]);
    expect((await income()).detected).toBe(360_000);
  });

  it("reads a series found in a 30-day month as the last day, so Saturday the 31st paid Monday fits", async () => {
    now = new Date("2026-11-10T14:00:00.000Z");
    await sync(
      pay("p1", "2026-09-15", 180_000),
      pay("p2", "2026-09-30", 180_000),
      pay("p3", "2026-10-15", 180_000),
      // Saturday October 31st, paid on Monday.
      pay("p4", "2026-11-02", 180_000),
    );

    expect(await fixedDays()).toEqual([[15, 31]]);
    expect(await predicted()).toEqual([["Acme Corp", "twice a month", "2026-11-15", 180_000]]);
    expect((await income()).detected).toBe(360_000);
  });

  it("picks the schedule whose expected dates are fewer days off, when both fit", async () => {
    now = new Date("2026-02-03T14:00:00.000Z");
    await sync(
      // Every 2 weeks is 0 days off; the 16th and the last day would be 1 day off.
      pay("a1", "2026-01-02", 200_000),
      pay("a2", "2026-01-16", 200_000),
      pay("a3", "2026-01-30", 200_000),
      // The 15th and the last day is 0 days off; every 2 weeks would be 3 days off.
      pay("b1", "2025-12-31", 150_000, "Blue Lake Clinic"),
      pay("b2", "2026-01-15", 150_000, "Blue Lake Clinic"),
      pay("b3", "2026-01-31", 150_000, "Blue Lake Clinic"),
    );

    expect(await predicted()).toEqual([
      ["Acme Corp", "every 2 weeks", "2026-02-13", 200_000],
      ["Blue Lake Clinic", "twice a month", "2026-02-15", 150_000],
    ]);
  });

  it("finds weekly series, and amounts within 15% of each other but not 20%", async () => {
    await sync(
      pay("w1", "2026-10-09", 40_000, "Day Shift Staffing"),
      pay("w2", "2026-10-16", 45_000, "Day Shift Staffing"),
      pay("w3", "2026-10-23", 40_000, "Day Shift Staffing"),
      pay("w4", "2026-10-30", 41_000, "Day Shift Staffing"),
      // 20% apart: no series.
      pay("x1", "2026-08-20", 100_000),
      pay("x2", "2026-09-20", 120_000),
      pay("x3", "2026-10-20", 100_000),
    );

    expect(await predicted()).toEqual([["Day Shift Staffing", "weekly", "2026-11-06", 41_000]]);
    // The median of 40,000, 45,000, 40,000, 41,000 is 40,500: × 52 ÷ 12 is $1,755.
    expect((await income()).detected).toBe(175_500);
  });

  it("uses checking and savings Accounts only, posted Income only, grouped by payer", async () => {
    await sync(
      // Card rewards are Income on a card: they make no series.
      ...["2026-08-05", "2026-09-05", "2026-10-05"].map((postedDate, index) =>
        pay(`card${index}`, postedDate, 2_500, "Card Rewards", { accountId: CARD.id }),
      ),
      // Savings counts.
      ...["2026-08-10", "2026-09-10", "2026-10-10"].map((postedDate, index) =>
        pay(`save${index}`, postedDate, 50_000, "Rental Tenant", { accountId: SAVINGS.id }),
      ),
      // A pending third deposit makes no series.
      pay("p1", "2026-08-20", 90_000, "Side Gig"),
      pay("p2", "2026-09-20", 90_000, "Side Gig"),
      pay("p3", "2026-10-20", 90_000, "Side Gig", { pending: true }),
      // Two payers at one amount do not make one series.
      pay("m1", "2026-09-03", 30_000, "North Shop"),
      pay("m2", "2026-10-03", 30_000, "South Shop"),
      pay("m3", "2026-11-01", 30_000, "North Shop"),
    );

    expect(await predicted()).toEqual([["Rental Tenant", "monthly", "2026-11-10", 50_000]]);
    expect(await income()).toMatchObject({ detected: 50_000, detectedFrom: "Income series" });
  });

  it("uses Income only, and leaves out a Transaction that no longer shows", async () => {
    await sync(
      // A monthly Transfer from savings into checking is not Income.
      ...["2026-08-01", "2026-09-01", "2026-10-01"].flatMap((postedDate, index) => [
        fakeTxn({
          id: `out${index}`,
          accountId: SAVINGS.id,
          amount: -100_000,
          postedDate,
          description: "ONLINE TRANSFER TO CHECKING",
        }),
        fakeTxn({
          id: `in${index}`,
          accountId: CHECKING.id,
          amount: 100_000,
          postedDate,
          description: "ONLINE TRANSFER FROM SAVINGS",
        }),
      ]),
      pay("m1", "2026-08-15", 300_000),
      pay("m2", "2026-09-15", 300_000),
      pay("m3", "2026-10-15", 300_000),
    );
    expect(await predicted()).toEqual([["Acme Corp", "monthly", "2026-11-15", 300_000]]);

    // Hidden, and left out even before Matching drops its parts.
    bank.fake.addPages(BANK, { removed: [{ id: "m3" }] });
    await syncConnection(connectionId, clock);
    await findIncomeSeries(bank.database, now);
    expect(await predicted()).toEqual([]);

    await runFollowUp(clock);
    expect(await predicted()).toEqual([]);
  });

  it("takes each series' median amount over the last 3 months only", async () => {
    await sync(
      pay("m1", "2026-05-15", 280_000),
      pay("m2", "2026-06-15", 280_000),
      pay("m3", "2026-07-15", 280_000),
      pay("m4", "2026-08-15", 300_000),
      pay("m5", "2026-09-15", 300_000),
      pay("m6", "2026-10-15", 300_000),
    );

    expect((await income()).detected).toBe(300_000);
  });

  it("never counts a yearly series", async () => {
    await sync(
      pay("y1", "2025-10-20", 500_000, "Acme Corp Bonus"),
      pay("y2", "2026-10-20", 500_000, "Acme Corp Bonus"),
      pay("m1", "2026-08-15", 300_000),
      pay("m2", "2026-09-15", 300_000),
      pay("m3", "2026-10-15", 300_000),
    );

    expect(await predicted()).toEqual([["Acme Corp", "monthly", "2026-11-15", 300_000]]);
    expect((await income()).detected).toBe(300_000);
  });

  it("counts a series only while it is active with Income in the last 3 months", async () => {
    now = new Date("2026-10-10T14:00:00.000Z");
    await sync(
      pay("m1", "2026-07-15", 300_000),
      pay("m2", "2026-08-15", 300_000),
      pay("m3", "2026-09-15", 300_000),
    );
    expect((await income()).detectedFrom).toBe("Income series");

    // Oct 15 plus 2 days passes with no pay: the series is inactive, so the median takes over.
    now = new Date("2026-10-18T14:00:00.000Z");
    expect(await income()).toMatchObject({ detectedFrom: "median" });
    expect(await predicted()).toEqual([]);
  });

  it("uses the median of total Income over the last 3 complete months when no series counts", async () => {
    now = new Date("2026-11-20T14:00:00.000Z");
    await sync(
      // Months before the last 3 complete ones, and the current month, are left out.
      pay("jul", "2026-07-10", 900_000, "Old Client"),
      pay("aug", "2026-08-12", 300_000, "Client A"),
      pay("sep1", "2026-09-03", 200_000, "Client B"),
      pay("sep2", "2026-09-25", 300_000, "Client C"),
      // Income counts in the month of its purchase date.
      pay("oct", "2026-11-02", 400_000, "Client D", { authorizedDate: "2026-10-30" }),
      pay("nov", "2026-11-05", 800_000, "Client E"),
      // Total Income takes in Income on every Account.
      pay("rewards", "2026-08-31", 5_000, "Card Rewards", { accountId: CARD.id }),
      // Pending Income, Spending, and a Transfer are not.
      pay("pending", "2026-10-20", 200_000, "Client F", { pending: true }),
      fakeTxn({
        id: "groceries",
        accountId: CHECKING.id,
        amount: -150_000,
        postedDate: "2026-09-10",
        merchantName: "Fresh Grocer",
      }),
      fakeTxn({
        id: "out",
        accountId: SAVINGS.id,
        amount: -500_000,
        postedDate: "2026-08-03",
        description: "ONLINE TRANSFER TO CHECKING",
      }),
      fakeTxn({
        id: "in",
        accountId: CHECKING.id,
        amount: 500_000,
        postedDate: "2026-08-03",
        description: "ONLINE TRANSFER FROM SAVINGS",
      }),
    );

    // August $3,050, September $5,000, October $4,000: the median is $4,000.
    expect(await income()).toEqual({
      amount: 400_000,
      detected: 400_000,
      detectedFrom: "median",
      typed: null,
    });
    expect(await predicted()).toEqual([]);

    // A hidden Transaction is left out, even before Matching drops its parts: September is $2,000.
    bank.fake.addPages(BANK, { removed: [{ id: "sep2" }] });
    await syncConnection(connectionId, clock);
    expect((await income()).detected).toBe(305_000);
  });

  it("recomputes I after each sync", async () => {
    await sync(
      pay("m1", "2026-08-15", 300_000),
      pay("m2", "2026-09-15", 300_000),
      pay("m3", "2026-10-15", 300_000),
    );
    expect((await income()).detected).toBe(300_000);

    await sync(
      pay("j1", "2026-08-28", 100_000, "Corner Bakery"),
      pay("j2", "2026-09-28", 100_000, "Corner Bakery"),
      pay("j3", "2026-10-28", 100_000, "Corner Bakery"),
    );

    expect((await income()).detected).toBe(400_000);
  });

  it("uses a typed figure in place of the detected one until a Member clears it", async () => {
    await sync(
      pay("m1", "2026-08-15", 300_000),
      pay("m2", "2026-09-15", 300_000),
      pay("m3", "2026-10-15", 300_000),
    );

    expect(await typeSteadyIncome(bank.database, 450_000, MEMBER, now)).toEqual({
      amount: 450_000,
      detected: 300_000,
      detectedFrom: "Income series",
      typed: 450_000,
    });
    // A later sync changes the detected figure, not the typed one.
    await sync(pay("m4", "2026-10-31", 330_000, "Corner Bakery"));
    expect(await income()).toMatchObject({ amount: 450_000, typed: 450_000 });

    expect(await typeSteadyIncome(bank.database, null, MEMBER, now)).toEqual({
      amount: 300_000,
      detected: 300_000,
      detectedFrom: "Income series",
      typed: null,
    });
  });

  it("deletes the Income series on a removed Connection's Accounts with its history", async () => {
    await sync(
      pay("m1", "2026-08-15", 300_000),
      pay("m2", "2026-09-15", 300_000),
      pay("m3", "2026-10-15", 300_000),
    );
    expect(await predicted()).toHaveLength(1);
    const removing = connectionRemoving();
    expect(await removing.remove(connectionId)).toMatchObject({ outcome: "removed" });

    expect(await removing.deleteHistory(connectionId)).toMatchObject({ outcome: "deleted" });

    expect(await predicted()).toEqual([]);
    const left = await bank.database.$client.execute("SELECT id FROM income_series");
    expect(left.rows).toEqual([]);
  });

  it("finds the series in 5 years of Income quickly, with 2,500 one-offs from one payer", {
    timeout: 120_000,
  }, async () => {
    const day = (index: number) =>
      new Date(Date.UTC(2021, 10, 1) + index * 86_400_000).toISOString().slice(0, 10);
    // A paycheck every 2 weeks, one on the 1st and the 15th, and 2,500 payments from friends over
    // the same 5 years, at amounts all over the place.
    const added = [
      ...Array.from({ length: 131 }, (_, index) => pay(`a${index}`, day(index * 14 + 3), 200_000)),
      ...Array.from({ length: 60 }, (_, index) => {
        const month = new Date(Date.UTC(2021, 10 + index, 1)).toISOString().slice(0, 8);
        return [
          pay(`s${index}a`, `${month}01`, 150_000, "Blue Lake Clinic"),
          pay(`s${index}b`, `${month}15`, 150_000, "Blue Lake Clinic"),
        ];
      }).flat(),
      ...Array.from({ length: 2_500 }, (_, index) =>
        pay(
          `v${index}`,
          day(Math.floor(index * 0.73)),
          1_000 + ((index * 7_919) % 50_000),
          "Venmo",
        ),
      ),
    ];
    bank.fake.addPages(BANK, { added });
    await syncConnection(connectionId, clock);
    await runFollowUp(clock);

    // CPU time, which a busy host does not stretch.
    const cpuMs = (used: NodeJS.CpuUsage) => (used.user + used.system) / 1_000;
    const started = process.cpuUsage();
    await findIncomeSeries(bank.database, now);
    const found = cpuMs(process.cpuUsage(started));
    const read = process.cpuUsage();
    const figure = await income();
    const next = await predicted();
    const reading = cpuMs(process.cpuUsage(read));

    expect(next.filter(([payer]) => payer !== "Venmo")).toEqual([
      ["Blue Lake Clinic", "twice a month", "2026-11-01", 150_000],
      ["Acme Corp", "every 2 weeks", "2026-11-12", 200_000],
    ]);
    expect(figure.detectedFrom).toBe("Income series");
    expect(found).toBeLessThan(3_000);
    expect(reading).toBeLessThan(500);
  });
});
