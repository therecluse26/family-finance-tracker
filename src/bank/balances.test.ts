import { afterEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "./fake.ts";
import { accountBalances, syncConnection } from "./index.ts";
import { newTestBank, type TestBank } from "./testing.ts";

// Daily balances and the estimates before the first sync (spec 02, Balances), through syncs of
// the fake adapter.

const BANK = "fake-first-bank";

const CHECKING = fakeAccount({
  id: "acc-checking",
  name: "Everyday Checking",
  currentBalance: 100_000,
  availableBalance: 99_500,
});

const CARD = fakeAccount({
  id: "acc-card",
  name: "Rewards Card",
  type: "credit",
  subtype: "credit card",
  currentBalance: -61_250,
  availableBalance: 438_750,
  creditLimit: 500_000,
  card: {
    aprs: [
      { type: "purchase_apr", apr: 24.99 },
      { type: "cash_apr", apr: 29.99 },
    ],
    statementBalance: -48_000,
    minimumPayment: 3_500,
    dueDate: "2026-11-21",
  },
});

const LOAN = fakeAccount({
  id: "acc-loan",
  name: "Car Loan",
  type: "loan",
  subtype: "auto",
  currentBalance: -1_250_000,
  loan: {
    apr: 6.5,
    principal: 1_250_000,
    interestPaidThisYear: 62_000,
    minimumPayment: 41_000,
    dueDate: "2026-11-15",
  },
});

// A sync on 2026-10-03, in the afternoon in UTC.
const OCT_3 = () => new Date("2026-10-03T15:00:00.000Z");

describe("daily balances", () => {
  let bank: TestBank;

  const rows = async (sql: string) => (await bank.database.$client.execute(sql)).rows;
  const accountId = async (providerId: string) =>
    String(
      (
        await rows(`SELECT id FROM household_accounts WHERE provider_account_id = '${providerId}'`)
      )[0]?.id,
    );

  afterEach(() => {
    bank.close();
  });

  it("works a checking Account backward from the first saved balance, and marks it estimated", async () => {
    bank = await newTestBank();
    const connectionId = await bank.connect(BANK);
    bank.fake.addPages(
      BANK,
      {
        accounts: [CHECKING],
        added: [
          fakeTxn({ id: "pay", accountId: CHECKING.id, amount: 250_000, postedDate: "2026-09-30" }),
          fakeTxn({
            id: "rent",
            accountId: CHECKING.id,
            amount: -180_000,
            postedDate: "2026-10-01",
          }),
          fakeTxn({ id: "food", accountId: CHECKING.id, amount: -2_000, postedDate: "2026-10-02" }),
          // A pending Transaction and a removed one never move an estimate.
          fakeTxn({
            id: "held",
            accountId: CHECKING.id,
            amount: -500,
            postedDate: "2026-10-02",
            pending: true,
          }),
          fakeTxn({ id: "gone", accountId: CHECKING.id, amount: -999, postedDate: "2026-10-02" }),
          fakeTxn({ id: "gas", accountId: CHECKING.id, amount: -1_000, postedDate: "2026-10-03" }),
        ],
      },
      { removed: [{ id: "gone" }] },
    );

    await syncConnection(connectionId, OCT_3);

    expect(await accountBalances(bank.database, await accountId(CHECKING.id))).toEqual({
      points: [
        // 100,000 + 1,000 + 2,000 + 180,000: the day before rent and food and gas.
        {
          date: "2026-09-30",
          currentBalance: 283_000,
          availableBalance: null,
          estimated: true,
        },
        { date: "2026-10-01", currentBalance: 103_000, availableBalance: null, estimated: true },
        { date: "2026-10-02", currentBalance: 101_000, availableBalance: null, estimated: true },
        { date: "2026-10-03", currentBalance: 100_000, availableBalance: 99_500, estimated: false },
      ],
      monthEnds: [
        { month: "2026-09", date: "2026-09-30", currentBalance: 283_000, estimated: true },
        { month: "2026-10", date: "2026-10-03", currentBalance: 100_000, estimated: false },
      ],
    });
  });

  it("works a credit card backward: purchases raise what was owed, payments lower it", async () => {
    bank = await newTestBank();
    const connectionId = await bank.connect(BANK);
    bank.fake.addPages(BANK, {
      accounts: [CARD],
      added: [
        fakeTxn({ id: "shoes", accountId: CARD.id, amount: -1_599, postedDate: "2026-10-01" }),
        fakeTxn({ id: "payment", accountId: CARD.id, amount: 20_000, postedDate: "2026-10-02" }),
        fakeTxn({ id: "dinner", accountId: CARD.id, amount: -8_120, postedDate: "2026-10-03" }),
      ],
    });

    await syncConnection(connectionId, OCT_3);

    const { points } = await accountBalances(bank.database, await accountId(CARD.id));
    expect(points.map((point) => [point.date, point.currentBalance, point.estimated])).toEqual([
      ["2026-10-01", -73_130, true],
      ["2026-10-02", -53_130, true],
      ["2026-10-03", -61_250, false],
    ]);
  });

  it("keeps one balance per Account per day: the day's last sync wins", async () => {
    bank = await newTestBank();
    const connectionId = await bank.connect(BANK);
    bank.fake.addPages(BANK, { accounts: [CHECKING] });
    await syncConnection(connectionId, () => new Date("2026-10-03T09:00:00.000Z"));

    bank.fake.addPages(BANK, { accounts: [{ ...CHECKING, currentBalance: 97_000 }] });
    await syncConnection(connectionId, () => new Date("2026-10-03T21:00:00.000Z"));
    bank.fake.addPages(BANK, { accounts: [{ ...CHECKING, currentBalance: 95_000 }] });
    await syncConnection(connectionId, () => new Date("2026-10-04T03:00:00.000Z"));

    expect(
      await rows("SELECT date, current_balance, synced_at FROM daily_balances ORDER BY date"),
    ).toEqual([
      { date: "2026-10-03", current_balance: 97_000, synced_at: "2026-10-03T21:00:00.000Z" },
      { date: "2026-10-04", current_balance: 95_000, synced_at: "2026-10-04T03:00:00.000Z" },
    ]);
  });

  it("takes the day in the Household's time zone", async () => {
    bank = await newTestBank({ timeZone: "America/New_York" });
    const connectionId = await bank.connect(BANK);
    bank.fake.addPages(BANK, { accounts: [CHECKING] });

    // 11 PM on October 3 in New York.
    await syncConnection(connectionId, () => new Date("2026-10-04T03:00:00.000Z"));

    expect(await rows("SELECT date FROM daily_balances")).toEqual([{ date: "2026-10-03" }]);
  });

  it("saves card and loan details with the daily balance", async () => {
    bank = await newTestBank();
    const connectionId = await bank.connect(BANK);
    bank.fake.addPages(BANK, { accounts: [CARD, LOAN] });

    await syncConnection(connectionId, OCT_3);

    expect(
      await rows(
        "SELECT a.provider_account_id AS account, b.date, b.current_balance, b.available_balance, b.credit_limit, b.card_aprs, b.statement_balance, b.minimum_payment, b.payment_due_date, b.loan_apr, b.loan_principal, b.interest_paid_this_year FROM daily_balances b JOIN household_accounts a ON a.id = b.account_id ORDER BY account",
      ),
    ).toEqual([
      {
        account: "acc-card",
        date: "2026-10-03",
        current_balance: -61_250,
        available_balance: 438_750,
        credit_limit: 500_000,
        card_aprs: '[{"type":"purchase_apr","apr":24.99},{"type":"cash_apr","apr":29.99}]',
        statement_balance: -48_000,
        minimum_payment: 3_500,
        payment_due_date: "2026-11-21",
        loan_apr: null,
        loan_principal: null,
        interest_paid_this_year: null,
      },
      {
        account: "acc-loan",
        date: "2026-10-03",
        current_balance: -1_250_000,
        available_balance: null,
        credit_limit: null,
        card_aprs: null,
        statement_balance: null,
        minimum_payment: 41_000,
        payment_due_date: "2026-11-15",
        loan_apr: 6.5,
        loan_principal: 1_250_000,
        interest_paid_this_year: 62_000,
      },
    ]);
  });

  it("saves no balance for a sync that fails partway", async () => {
    bank = await newTestBank();
    const connectionId = await bank.connect(BANK);
    bank.fake.addPages(BANK, { accounts: [CHECKING] }, { added: [] });
    bank.fake.failAt(BANK, 1, "temporary");

    await expect(syncConnection(connectionId, OCT_3)).rejects.toMatchObject({ kind: "temporary" });

    expect(await rows("SELECT * FROM daily_balances")).toEqual([]);
  });

  it("returns only the days in the range, and their month ends", async () => {
    bank = await newTestBank();
    const connectionId = await bank.connect(BANK);
    bank.fake.addPages(BANK, {
      accounts: [CHECKING],
      added: [
        fakeTxn({ id: "a", accountId: CHECKING.id, amount: -1_000, postedDate: "2026-09-29" }),
        fakeTxn({ id: "b", accountId: CHECKING.id, amount: -2_000, postedDate: "2026-10-02" }),
      ],
    });
    await syncConnection(connectionId, OCT_3);

    const balances = await accountBalances(bank.database, await accountId(CHECKING.id), {
      from: "2026-09-30",
      to: "2026-10-02",
    });

    expect(balances.points.map((point) => point.date)).toEqual([
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
    ]);
    expect(balances.monthEnds.map((end) => [end.month, end.date])).toEqual([
      ["2026-09", "2026-09-30"],
      ["2026-10", "2026-10-02"],
    ]);
  });
});
