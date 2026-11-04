import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_BANKS, demoRecords, seedDemoHousehold } from "../bank/demo.ts";
import { type FakePage, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { type AccountSnapshot, syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { listConnections } from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import {
  decideProvisionalAgain,
  type MonthTotals,
  readLoanSettings,
  readTransactionDecision,
  setLoanSettings,
  startMoneyMovement,
  totalsByMonth,
} from "./index.ts";

// Payments on a connected loan and loan payouts (spec 02, Connected loans; spec 03, Loans), on the
// demo Household, through the Matching follow-up step on Transactions the fake adapter syncs.

const NOW = () => new Date("2026-11-01T14:00:00.000Z");
const at = (date: string) => () => new Date(`${date}T14:00:00.000Z`);
const ALLY = DEMO_BANKS.find((demo) => demo.bankId === "fake-ally");
const CHECKING = ALLY?.accounts[0]?.id ?? "";
const LARKSPUR = DEMO_BANKS.find((demo) => demo.bankId === "fake-larkspur")?.accounts[0];
const PAYMENT = 45_218;

// The demo's payments to Larkspur from checking, by month.
const larkspurPayment = (month: string) => {
  const record = demoRecords().find(
    (each) =>
      each.description.startsWith("LARKSPUR LOAN PMT") && each.postedDate.startsWith(month),
  );
  if (record === undefined) throw new Error(`The demo has no Larkspur payment in ${month}.`);
  return record;
};

describe("connected loans", () => {
  let bank: TestBank;
  let stops: (() => void)[];

  const idOf = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT id FROM transactions WHERE provider_transaction_id = ? AND hidden_reason IS NULL",
      args: [providerId],
    });
    return String(rows.rows[0]?.id);
  };
  const accountIdOf = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT id FROM household_accounts WHERE provider_account_id = ?",
      args: [providerId],
    });
    return String(rows.rows[0]?.id);
  };
  const decisionOf = async (providerId: string) =>
    readTransactionDecision(bank.database, await idOf(providerId));
  const partsOf = async (providerId: string) => (await decisionOf(providerId))?.parts;
  // Syncs pages into banks on a day, then runs the follow-up job that day.
  const syncOn = async (date: string, pages: Record<string, FakePage>) => {
    vi.setSystemTime(at(date)());
    for (const [bankId, page] of Object.entries(pages)) {
      bank.fake.addPages(bankId, page);
      const connection = (await listConnections(bank.database)).find((c) => c.bankId === bankId);
      await syncConnection(connection?.id ?? (await bank.connect(bankId)), at(date));
    }
    await runFollowUp(at(date));
  };
  const inChecking = (id: string, amount: number, postedDate: string, fields: Partial<TxnRecord>) =>
    fakeTxn({ id, accountId: CHECKING, amount, postedDate, ...fields });
  const code = (name: string) => ({ name, confidence: "HIGH", version: "v2", mcc: null });
  const month = (totals: MonthTotals[], name: string) => totals.find((t) => t.month === name);
  // What the demo's Larkspur loan owes after the seed, as its saved balance: negative.
  const owedAtSeed = async () => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT current_balance FROM daily_balances WHERE account_id = ? ORDER BY date LIMIT 1",
      args: [await accountIdOf(LARKSPUR?.id ?? "")],
    });
    return Number(rows.rows[0]?.current_balance);
  };
  const larkspurWith = (currentBalance: number): AccountSnapshot => {
    if (LARKSPUR === undefined) throw new Error("The demo has no Larkspur loan.");
    return { ...LARKSPUR, currentBalance };
  };
  // A loan-side Transaction: money into the loan.
  const intoLoan = (id: string, accountId: string, amount: number, postedDate: string) =>
    fakeTxn({ id, accountId, amount, postedDate, description: "PAYMENT RECEIVED" });

  beforeEach(async () => {
    // The follow-up job reads the clock for the Household's date.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW());
    bank = await newTestBank();
    stops = [startMoneyMovement({ database: bank.database }).stop];
    await seedDemoHousehold(bank.database, bank.fake, NOW);
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
    vi.useRealTimers();
  });

  it("counts Larkspur's payout as a Transfer, never Income, and makes it a Cash loan", async () => {
    await runFollowUp(NOW);

    const payout = demoRecords().find((each) => each.description.includes("DISBURSEMENT"));
    expect(await decisionOf(payout?.id ?? "")).toEqual({
      step: "6.2",
      provisionalUntil: null,
      parts: [{ type: "Transfer", amount: 1_500_000, category: null }],
    });
    expect(await readLoanSettings(bank.database, await accountIdOf(LARKSPUR?.id ?? ""))).toEqual(
      {
        accountId: await accountIdOf(LARKSPUR?.id ?? ""),
        loanType: "cash loan",
        setBy: "app",
        apr: null,
      },
    );
  });

  it("takes Larkspur's interest from the drop in its balance, and a payment before the first saved balance from the first measured share", async () => {
    const loan = LARKSPUR?.id ?? "";
    const owed = await owedAtSeed();
    const september = larkspurPayment("2026-09");
    const october = larkspurPayment("2026-10");
    await runFollowUp(NOW);

    // The loan's side of September's payment, before the first saved balance. Nothing is measured
    // yet, so its interest is $0 for now.
    await syncOn("2026-11-10", {
      "fake-larkspur": {
        accounts: [larkspurWith(owed)],
        added: [intoLoan("ls-sep", loan, PAYMENT, september.postedDate)],
      },
    });
    expect(await decisionOf(september.id)).toEqual({
      step: "3",
      provisionalUntil: "2026-11-10",
      parts: [{ type: "Transfer", amount: -PAYMENT, category: null }],
    });
    // The loan's own side counts nowhere.
    expect(await partsOf("ls-sep")).toEqual([
      { type: "Transfer", amount: PAYMENT, category: null },
    ]);

    // November's payment, and the sync after it: what is owed fell by $331.18 of the $452.18.
    const novemberPaid = inChecking("ally-nov", -PAYMENT, "2026-11-16", {
      description: "LARKSPUR LOAN PMT WEB ID: 9900213344",
      category: code("LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT"),
    });
    const before = await totalsByMonth(bank.database);
    await syncOn("2026-11-17", {
      "fake-ally": { added: [novemberPaid] },
      "fake-larkspur": {
        accounts: [larkspurWith(owed + 33_118)],
        added: [
          intoLoan("ls-oct", loan, PAYMENT, october.postedDate),
          intoLoan("ls-nov", loan, PAYMENT, "2026-11-16"),
        ],
      },
    });

    // The parts go on the paying Account's Transaction. Principal on a Cash loan is a Transfer.
    const measured = [
      { type: "Spending", amount: -12_100, category: "Interest and fees" },
      { type: "Transfer", amount: -33_118, category: null },
    ];
    expect(await decisionOf("ally-nov")).toEqual({
      step: "3",
      provisionalUntil: null,
      parts: measured,
    });
    expect(await partsOf("ls-nov")).toEqual([
      { type: "Transfer", amount: PAYMENT, category: null },
    ]);
    // Only the interest counts as Spending.
    expect(month(await totalsByMonth(bank.database), "2026-11")?.spending).toBe(
      (month(before, "2026-11")?.spending ?? 0) + 12_100,
    );
    // October's payment is before the first saved balance: it takes the measured share.
    expect(await decisionOf(october.id)).toEqual({
      step: "3",
      provisionalUntil: null,
      parts: measured,
    });
    // September's provisional $0 is decided again the next day.
    await decideProvisionalAgain(bank.database, at("2026-11-18")());
    expect(await partsOf(september.id)).toEqual(measured);
  });

  it("takes a mortgage's interest from the rise in interest paid this year, and the new value when a new year starts", async () => {
    const mortgage = (currentBalance: number, interestPaidThisYear: number) =>
      fakeAccount({
        id: "mortgage",
        type: "loan",
        subtype: "mortgage",
        mask: "4321",
        currentBalance,
        loan: {
          apr: 6.5,
          principal: -currentBalance,
          interestPaidThisYear,
          minimumPayment: null,
          dueDate: null,
        },
      });
    const paid = (id: string, date: string) =>
      inChecking(id, -250_000, date, {
        description: "HOMELOAN SVC MORTGAGE PMT 4321",
        category: code("LOAN_PAYMENTS_MORTGAGE_PAYMENT"),
      });
    await syncOn("2026-11-25", {
      "fake-homeloan": { accounts: [mortgage(-30_000_000, 1_400_000)] },
    });
    await syncOn("2026-12-03", {
      "fake-ally": { added: [paid("ally-dec", "2026-12-01")] },
      "fake-homeloan": {
        accounts: [mortgage(-29_912_000, 1_562_000)],
        added: [intoLoan("home-dec", "mortgage", 250_000, "2026-12-01")],
      },
    });
    await syncOn("2027-01-05", {
      "fake-ally": { added: [paid("ally-jan", "2027-01-02")] },
      "fake-homeloan": {
        accounts: [mortgage(-29_823_500, 161_500)],
        added: [intoLoan("home-jan", "mortgage", 250_000, "2027-01-04")],
      },
    });

    // A mortgage is a Purchase loan: principal is Spending in Housing.
    expect(await partsOf("ally-dec")).toEqual([
      { type: "Spending", amount: -162_000, category: "Interest and fees" },
      { type: "Spending", amount: -88_000, category: "Housing" },
    ]);
    // The value fell as the year started, so the interest is the new value. The payment landed
    // on the loan on Jan 4.
    expect(await partsOf("ally-jan")).toEqual([
      { type: "Spending", amount: -161_500, category: "Interest and fees" },
      { type: "Spending", amount: -88_500, category: "Housing" },
    ]);
  });

  it("keeps interest between $0 and the payment", async () => {
    const loan = (id: string, subtype: string, currentBalance: number, ytd: number | null) =>
      fakeAccount({
        id,
        type: "loan",
        subtype,
        currentBalance,
        loan:
          ytd === null
            ? null
            : {
                apr: null,
                principal: null,
                interestPaidThisYear: ytd,
                minimumPayment: null,
                dueDate: null,
              },
      });
    await syncOn("2026-10-19", {
      "fake-lender": {
        accounts: [
          loan("car", "auto", -1_000_000, null),
          loan("school", "student", -800_000, 10_000),
        ],
      },
    });
    // The car loan's balance fell by more than the payment; the student loan's interest rose by
    // more than the payment.
    await syncOn("2026-10-22", {
      "fake-lender": {
        accounts: [
          loan("car", "auto", -900_000, null),
          loan("school", "student", -800_000, 60_000),
        ],
        added: [
          intoLoan("car-paid", "car", 30_000, "2026-10-21"),
          intoLoan("school-paid", "school", 30_000, "2026-10-21"),
        ],
      },
    });

    // Neither has a paying Account, so the parts go on the loan's own Transaction, with the paying
    // side's sign.
    expect(await decisionOf("car-paid")).toEqual({
      step: "3",
      provisionalUntil: null,
      parts: [{ type: "Spending", amount: -30_000, category: "Car" }],
    });
    expect(await partsOf("school-paid")).toEqual([
      { type: "Spending", amount: -30_000, category: "Interest and fees" },
    ]);
  });

  it("makes an auto loan a Cash loan when its payout lands in checking, and lets a Member's switch and APR win", async () => {
    const car = fakeAccount({
      id: "car",
      type: "loan",
      subtype: "auto",
      mask: "7766",
      currentBalance: -2_000_000,
    });
    const paid = inChecking("ally-car", -50_000, "2026-10-14", {
      description: "SUMMIT AUTO PMT 7766",
      category: code("LOAN_PAYMENTS_CAR_PAYMENT"),
    });
    await syncOn("2026-10-12", { "fake-summit": { accounts: [car] } });
    await syncOn("2026-10-16", {
      "fake-ally": { added: [paid] },
      "fake-summit": {
        accounts: [{ ...car, currentBalance: -1_960_000 }],
        added: [intoLoan("summit-paid", "car", 50_000, "2026-10-15")],
      },
    });
    const carId = await accountIdOf("car");
    expect(await partsOf("ally-car")).toEqual([
      { type: "Spending", amount: -10_000, category: "Interest and fees" },
      { type: "Spending", amount: -40_000, category: "Car" },
    ]);
    expect((await readLoanSettings(bank.database, carId))?.loanType).toBe("purchase loan");

    // The payout lands later, naming the loan's last 4 digits.
    await syncOn("2026-10-20", {
      "fake-ally": {
        added: [
          inChecking("payout", 2_000_000, "2026-10-19", {
            description: "SUMMIT AUTO LOAN 7766 FUNDS",
            category: code("LOAN_DISBURSEMENTS_AUTO"),
          }),
        ],
      },
    });
    expect(await partsOf("payout")).toEqual([
      { type: "Transfer", amount: 2_000_000, category: null },
    ]);
    expect((await readLoanSettings(bank.database, carId))?.loanType).toBe("cash loan");
    expect(await partsOf("ally-car")).toEqual([
      { type: "Spending", amount: -10_000, category: "Interest and fees" },
      { type: "Transfer", amount: -40_000, category: null },
    ]);

    // A Member switches it back, and types an APR: 7.3% on $20,000 for the 3 days since the
    // balance date is $12.00.
    expect(
      await setLoanSettings(bank.database, carId, { loanType: "purchase loan", memberApr: 7.3 }),
    ).toEqual({ accountId: carId, loanType: "purchase loan", setBy: "Member", apr: 7.3 });
    expect(bank.followUpsAsked()).toBe(1);
    vi.setSystemTime(at("2026-10-21")());
    await runFollowUp(at("2026-10-21"));
    expect(await partsOf("ally-car")).toEqual([
      { type: "Spending", amount: -1_200, category: "Interest and fees" },
      { type: "Spending", amount: -48_800, category: "Car" },
    ]);
  });
});
