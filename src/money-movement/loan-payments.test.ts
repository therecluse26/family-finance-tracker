import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { answerReviewItem, openReviewItems } from "../review/index.ts";
import {
  addManualLoan,
  editManualLoan,
  linkByHand,
  listManualLoanViews,
  type ManualLoanInput,
  MISSED_PAYMENT_KIND,
  POSSIBLE_PAYMENT_KIND,
  readTransactionDecision,
  registerUnclearLoanPaymentJudge,
  startMoneyMovement,
  switchExclude,
  totalsByMonth,
  type UnclearLoanPaymentAnswer,
  undoLink,
  updateMissedLoanPayments,
} from "./index.ts";

// Finding a Manual loan's payments, and its balance and payoff (spec 02, Finding payments, Balance
// and payoff; spec 03, Tiers), through the Matching follow-up step on Transactions the fake
// adapter syncs.

const NOW = () => new Date("2026-11-20T14:00:00.000Z");
const BANK = "fake-first-bank";
const CHECKING = "acc-checking";
const SAVINGS = "acc-savings";
const MEMBER = "member-1";

describe("Manual loan payments", () => {
  let bank: TestBank;
  let stops: (() => void)[];
  let connectionId: string;

  const sync = async (added: TxnRecord[], changed: TxnRecord[] = []) => {
    bank.fake.addPages(BANK, {
      accounts: [fakeAccount({ id: CHECKING }), fakeAccount({ id: SAVINGS, subtype: "savings" })],
      added,
      changed,
      historyLoaded: true,
    });
    await syncConnection(connectionId, NOW);
    await runFollowUp(NOW);
  };
  const idOf = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT id FROM transactions WHERE provider_transaction_id = ?",
      args: [providerId],
    });
    return String(rows.rows[0]?.id);
  };
  const accountIdOf = async (providerAccountId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT id FROM household_accounts WHERE provider_account_id = ?",
      args: [providerAccountId],
    });
    return String(rows.rows[0]?.id);
  };
  // A payment to the lender, money out.
  const payment = (
    id: string,
    amount: number,
    postedDate: string,
    fields: Partial<TxnRecord> = {},
  ) =>
    fakeTxn({
      id,
      accountId: CHECKING,
      amount: -amount,
      postedDate,
      description: "LAKESIDE CREDIT PMT",
      merchantName: "Lakeside Credit",
      ...fields,
    });
  const loan = (fields: Partial<ManualLoanInput>): ManualLoanInput => ({
    lender: "Lakeside Credit",
    kind: "car",
    balance: 1_000_000,
    balanceDate: "2026-07-01",
    apr: 7.3,
    regularPayment: 50_000,
    escrow: null,
    loanType: null,
    ...fields,
  });
  const add = async (fields: Partial<ManualLoanInput> = {}) => {
    const added = await addManualLoan(bank.database, loan(fields), MEMBER);
    await runFollowUp(NOW);
    return added.id;
  };
  const view = async (loanId: string) => (await listManualLoanViews(bank.database, [loanId]))[0];
  // Each loan link, by its payment's provider ID, with who made it and its evidence.
  const links = async () => {
    const rows = await bank.database.$client.execute(
      `SELECT t.provider_transaction_id AS payment, l.made_by AS madeBy, l.tier, l.signals
       FROM loan_links l JOIN transactions t ON t.id = l.transaction_id
       ORDER BY t.posted_date, payment`,
    );
    return rows.rows.map((row) => ({ ...row }));
  };
  const linkedPayments = async () => (await links()).map((link) => link.payment);
  const items = async (kind: string) =>
    (await openReviewItems(bank.database)).filter((item) => item.kind === kind);
  const stepOf = async (providerId: string) =>
    (await readTransactionDecision(bank.database, await idOf(providerId)))?.step;

  beforeEach(async () => {
    bank = await newTestBank();
    stops = [startMoneyMovement({ database: bank.database }).stop];
    connectionId = await bank.connect(BANK);
    await bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('${MEMBER}', 'Jamie', 'jamie@example.com', '2026-10-01T00:00:00.000Z',
         '2026-10-01T00:00:00.000Z')`,
    );
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  it("finds a loan's payments among 2,500 lines in a few seconds", async () => {
    // Loans, links and refusals are read once for the batch, never once for each payment.
    const day = (n: number) => new Date(Date.UTC(2024, 6, 2 + n)).toISOString().slice(0, 10);
    await sync(
      Array.from({ length: 2_500 }, (_, n) =>
        n % 40 === 0
          ? payment(`pay-${n}`, 50_000, day(Math.floor(n / 40) * 30))
          : fakeTxn({
              id: `buy-${n}`,
              accountId: CHECKING,
              amount: -(1_000 + n),
              postedDate: day(Math.floor(n / 40) * 30 + (n % 28)),
              description: `HARDWARE STORE ${n % 30}`,
              merchantName: `Hardware Store ${n % 30}`,
            }),
      ),
    );
    await addManualLoan(bank.database, loan({ balanceDate: "2024-07-01" }), MEMBER);
    // CPU time, which a busy host does not stretch.
    const started = process.cpuUsage();
    await runFollowUp(NOW);
    const used = process.cpuUsage(started);
    const took = (used.user + used.system) / 1_000;

    expect(await linkedPayments()).toHaveLength(63);
    expect(took).toBeLessThan(5_000);
  }, 120_000);

  it("links a confident first payment at once, then later ones by the same Merchant or Account, and lowers the balance", async () => {
    await sync([
      payment("aug", 50_000, "2026-08-01"),
      // Not the lender: it never links.
      payment("other", 50_000, "2026-08-02", {
        description: "HILLTOP AUTO PMT",
        merchantName: "Hilltop Auto",
      }),
    ]);
    const car = await add();

    // The lender's name and the regular payment amount agree.
    expect(await links()).toEqual([
      { payment: "aug", madeBy: "app", tier: "Strong", signals: '["lender","amount"]' },
    ]);
    expect(await stepOf("aug")).toBe("4");
    expect(await stepOf("other")).toBe("5.7");

    // A larger payment, from the same Account to the same Merchant, is a later payment.
    await sync([payment("sep", 80_000, "2026-08-31", { accountId: SAVINGS })]);
    expect(await links()).toEqual([
      { payment: "aug", madeBy: "app", tier: "Strong", signals: '["lender","amount"]' },
      { payment: "sep", madeBy: "app", tier: "Strong", signals: '["same Merchant"]' },
    ]);
    // 31 days on $10,000 at 7.3%: $62.00, and $438.00 of principal. Then 30 days on $9,562.00:
    // $57.37, and $742.63 of principal.
    expect((await view(car))?.currentBalance).toBe(1_000_000 - 43_800 - 74_263);
    expect((await readTransactionDecision(bank.database, await idOf("sep")))?.parts).toEqual([
      { type: "Spending", amount: -5_737, category: "Interest and fees" },
      { type: "Spending", amount: -74_263, category: "Car" },
    ]);
    expect(await items(POSSIBLE_PAYMENT_KIND)).toEqual([]);
  });

  it("links a first payment by a monthly rhythm when no regular payment is given", async () => {
    await sync([
      payment("jul", 42_000, "2026-07-15"),
      payment("aug", 45_000, "2026-08-14"),
      // A payment 10 days later is no rhythm on its own, but it is a later payment.
      payment("extra", 10_000, "2026-08-24"),
    ]);
    await add({ regularPayment: null });

    expect(await links()).toEqual([
      { payment: "jul", madeBy: "app", tier: "Strong", signals: '["lender","monthly rhythm"]' },
      { payment: "aug", madeBy: "app", tier: "Strong", signals: '["lender","monthly rhythm"]' },
      {
        payment: "extra",
        madeBy: "app",
        tier: "Strong",
        signals: '["same Merchant","same Account"]',
      },
    ]);
  });

  it("asks about an unsure first payment, which counts by the normal rules until a Member links it", async () => {
    await sync([payment("odd", 31_500, "2026-08-01")]);
    const car = await add();

    // The lender matches, but neither the amount nor a rhythm does.
    expect(await links()).toEqual([]);
    expect(await stepOf("odd")).toBe("5.7");
    expect((await view(car))?.currentBalance).toBe(1_000_000);
    const [item] = await items(POSSIBLE_PAYMENT_KIND);
    expect(item).toMatchObject({
      subject: { type: "transactions", transactionIds: [await idOf("odd")] },
      decided: "This may be a payment on the Lakeside Credit loan. It counts by the normal rules.",
      bestAnswer: { value: `link ${car}`, label: "Link to this loan" },
    });
    // The app asks once.
    await editManualLoan(bank.database, car, loan({}), MEMBER);
    await runFollowUp(NOW);
    expect(await items(POSSIBLE_PAYMENT_KIND)).toHaveLength(1);

    expect(await answerReviewItem(bank.database, item?.id ?? "", `link ${car}`, MEMBER)).toBe(
      "answered",
    );
    await runFollowUp(NOW);
    expect(await links()).toEqual([
      { payment: "odd", madeBy: "Member", tier: "Unclear", signals: "[]" },
    ]);
    expect(await stepOf("odd")).toBe("2");
    expect((await view(car))?.currentBalance).toBeLessThan(1_000_000);
  });

  it("never links a payment a Member said is not on the loan, and never again after an undo", async () => {
    await sync([payment("odd", 31_500, "2026-08-01")]);
    const car = await add();
    const [item] = await items(POSSIBLE_PAYMENT_KIND);
    expect(await answerReviewItem(bank.database, item?.id ?? "", "not this", MEMBER)).toBe(
      "answered",
    );
    await runFollowUp(NOW);
    // A confident first payment arrives later; the refused one stays out, and is not asked again.
    await sync([payment("aug", 50_000, "2026-08-31")]);
    await editManualLoan(bank.database, car, loan({}), MEMBER);
    await runFollowUp(NOW);
    expect(await linkedPayments()).toEqual(["aug"]);
    expect(await items(POSSIBLE_PAYMENT_KIND)).toEqual([]);
    expect(await stepOf("odd")).toBe("5.7");

    const [row] = (await bank.database.$client.execute("SELECT id FROM loan_links")).rows;
    expect(await undoLink(bank.database, String(row?.id), MEMBER, NOW())).toBe(true);
    await runFollowUp(NOW);
    await editManualLoan(bank.database, car, loan({}), MEMBER);
    await runFollowUp(NOW);
    expect(await linkedPayments()).toEqual([]);
    expect((await view(car))?.currentBalance).toBe(1_000_000);
  });

  it("sends an Unclear payment to the AI when one answers, and to the Review list when none does", async () => {
    await sync([payment("aug", 50_000, "2026-08-01")]);
    await add();
    const unclear = (id: string, postedDate: string) =>
      payment(id, 50_000, postedDate, {
        accountId: SAVINGS,
        description: "LAKESIDE CREDIT UNION LOAN",
        merchantName: "Lakeside Credit Union",
      });

    // Another Account and another Merchant: no strong signal.
    await sync([unclear("asked", "2026-08-31")]);
    expect(await linkedPayments()).toEqual(["aug"]);
    expect((await items(POSSIBLE_PAYMENT_KIND)).map((item) => item.subject)).toEqual([
      { type: "transactions", transactionIds: [await idOf("asked")] },
    ]);

    const answers = new Map<string, UnclearLoanPaymentAnswer>([
      ["yes", { answer: "yes", confidence: "high" }],
      ["no", { answer: "no", confidence: "high" }],
    ]);
    stops.push(
      registerUnclearLoanPaymentJudge(async (candidates) =>
        candidates.map(({ payment: asked }) =>
          answers.get(asked.postedDate === "2026-09-30" ? "yes" : "no"),
        ),
      ),
    );
    await sync([unclear("ai-yes", "2026-09-30"), unclear("ai-no", "2026-10-30")]);
    expect(await links()).toContainEqual({
      payment: "ai-yes",
      madeBy: "AI",
      tier: "Unclear",
      signals: "[]",
    });
    expect(await linkedPayments()).not.toContain("ai-no");
    const refused = await bank.database.$client.execute(
      "SELECT refused_by FROM refused_links WHERE kind = 'loan'",
    );
    expect(refused.rows.map((row) => row.refused_by)).toEqual(["AI"]);
    expect(await items(POSSIBLE_PAYMENT_KIND)).toHaveLength(1);
  });

  it("asks about a loan with no payment linked for 2 months after the last one, once for each gap", async () => {
    await sync([payment("aug", 50_000, "2026-08-14")]);
    const car = await add();

    await updateMissedLoanPayments(bank.database, new Date("2026-10-14T12:00:00.000Z"));
    expect(await items(MISSED_PAYMENT_KIND)).toEqual([]);
    await updateMissedLoanPayments(bank.database, new Date("2026-10-15T12:00:00.000Z"));
    await updateMissedLoanPayments(bank.database, new Date("2026-10-16T12:00:00.000Z"));
    const [missed, ...more] = await items(MISSED_PAYMENT_KIND);
    expect(more).toEqual([]);
    expect(missed).toMatchObject({
      subject: { type: "loan", accountId: car },
      decided: "No payment to Lakeside Credit has linked since 2026-08-14.",
    });
    // Kept open by a Member: it is not asked again for this gap.
    expect(await answerReviewItem(bank.database, missed?.id ?? "", "keep", MEMBER)).toBe(
      "answered",
    );
    await updateMissedLoanPayments(bank.database, new Date("2026-10-20T12:00:00.000Z"));
    expect(await items(MISSED_PAYMENT_KIND)).toEqual([]);

    // A later payment ends the gap. When payments stop again, the app asks again.
    await sync([payment("nov", 50_000, "2026-10-21")]);
    expect(await linkedPayments()).toEqual(["aug", "nov"]);
    await updateMissedLoanPayments(bank.database, new Date("2026-12-22T12:00:00.000Z"));
    expect((await items(MISSED_PAYMENT_KIND)).map((item) => item.decided)).toEqual([
      "No payment to Lakeside Credit has linked since 2026-10-21.",
    ]);
    // It settles when a payment links.
    await sync([payment("dec", 50_000, "2026-12-01")]);
    await updateMissedLoanPayments(bank.database, new Date("2026-12-23T12:00:00.000Z"));
    expect(await items(MISSED_PAYMENT_KIND)).toEqual([]);
  });

  it("links payments on or before the balance date with interest worked backward, which never change the balance", async () => {
    await sync([
      payment("sep", 50_000, "2026-09-15"),
      payment("oct", 50_000, "2026-10-15"),
      payment("nov", 50_000, "2026-11-14"),
    ]);
    const car = await add({ balanceDate: "2026-10-15" });

    expect(await linkedPayments()).toEqual(["sep", "oct", "nov"]);
    const parts = async (id: string) =>
      (await readTransactionDecision(bank.database, await idOf(id)))?.parts.map(
        (part) => part.amount,
      );
    // On the balance date: $10,000 is what it left, so $10,437.38 was owed 30 days before:
    // $62.62 of interest. A month earlier, $10,872.15 was owed: $65.23.
    expect(await parts("oct")).toEqual([-6_262, -43_738]);
    expect(await parts("sep")).toEqual([-6_523, -43_477]);
    // After the balance date: 30 days on $10,000.
    expect(await parts("nov")).toEqual([-6_000, -44_000]);
    expect((await view(car))?.currentBalance).toBe(956_000);

    // A Member corrects the balance with a new date; later payments count from it.
    await editManualLoan(
      bank.database,
      car,
      loan({ balance: 960_000, balanceDate: "2026-11-16" }),
      MEMBER,
    );
    await runFollowUp(NOW);
    expect((await view(car))?.currentBalance).toBe(960_000);
    await sync([payment("late", 50_000, "2026-11-19")]);
    // 3 days on $9,600: $5.76.
    expect(await parts("late")).toEqual([-576, -49_424]);
    expect((await view(car))?.currentBalance).toBe(960_000 - 49_424);
    // The earlier payments keep their parts.
    expect(await parts("nov")).toEqual([-6_000, -44_000]);
  });

  it("closes the loan as paid off at $0, and asks about payments to it after that", async () => {
    await sync([payment("aug", 50_000, "2026-08-01")]);
    const car = await add({ balance: 30_000 });

    expect(await linkedPayments()).toEqual(["aug"]);
    expect(await view(car)).toMatchObject({ currentBalance: 0, closed: true });
    const closed = await bank.database.$client.execute({
      sql: "SELECT closed_reason FROM household_accounts WHERE id = ?",
      args: [car],
    });
    expect(closed.rows[0]?.closed_reason).toBe("paid off");

    await sync([payment("after", 50_000, "2026-09-01")]);
    expect(await linkedPayments()).toEqual(["aug"]);
    expect(await stepOf("after")).toBe("5.7");
    expect((await items(POSSIBLE_PAYMENT_KIND)).map((item) => item.decided)).toEqual([
      "This may be a payment to Lakeside Credit, whose loan is Closed. It counts by the normal rules.",
    ]);
  });

  // K12: re-matching never ends a hand link, nor an app link, for the wrong reason.
  it("keeps a hand link and an app link through Exclude and back, with the same totals", async () => {
    await sync([
      payment("aug", 50_000, "2026-08-01"),
      payment("by-hand", 20_000, "2026-08-20", {
        description: "PAYMENT 2231",
        merchantName: null,
      }),
    ]);
    const car = await add();
    const made = await linkByHand(
      bank.database,
      { kind: "loan", transactionId: await idOf("by-hand"), loanAccountId: car },
      MEMBER,
      NOW(),
    );
    expect(made.outcome).toBe("linked");
    await runFollowUp(NOW);
    const both = [
      { payment: "aug", madeBy: "app", tier: "Strong", signals: '["lender","amount"]' },
      { payment: "by-hand", madeBy: "Member", tier: "Unclear", signals: "[]" },
    ];
    expect(await links()).toEqual(both);
    const before = await totalsByMonth(bank.database);
    const balance = (await view(car))?.currentBalance;

    const savings = await accountIdOf(SAVINGS);
    expect(await switchExclude(bank.database, savings, true)).toBe(true);
    await runFollowUp(NOW);
    expect(await links()).toEqual(both);
    expect(await totalsByMonth(bank.database)).toEqual(before);
    expect(await switchExclude(bank.database, savings, false)).toBe(true);
    await runFollowUp(NOW);
    expect(await links()).toEqual(both);
    expect(await totalsByMonth(bank.database)).toEqual(before);
    expect((await view(car))?.currentBalance).toBe(balance);

    // A provider change to the app link's amount keeps it: the amount may change.
    await sync([], [payment("aug", 51_000, "2026-08-01")]);
    expect(await links()).toEqual(both);
  });
});
