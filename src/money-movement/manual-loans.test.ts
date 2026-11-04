import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { runFollowUp } from "../follow-up/index.ts";
import {
  addManualLoan,
  editManualLoan,
  linkByHand,
  listManualLoanViews,
  type ManualLoanInput,
  readTransactionDecision,
  startMoneyMovement,
  totalsByMonth,
  undoLink,
} from "./index.ts";

// Manual loans (spec 02, Manual loans and Interest; spec 03, Payments on a tracked loan and Loan
// payouts), through the Matching follow-up step on Transactions the fake adapter syncs.

const NOW = () => new Date("2026-11-20T14:00:00.000Z");
const BANK = "fake-first-bank";
const CHECKING = "acc-checking";
const code = (name: string) => ({ name, confidence: "HIGH", version: "v2", mcc: null });

describe("Manual loans", () => {
  let bank: TestBank;
  let stops: (() => void)[];
  let connectionId: string;

  const sync = async (added: TxnRecord[]) => {
    bank.fake.addPages(BANK, {
      accounts: [fakeAccount({ id: CHECKING })],
      added,
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
  const payment = (id: string, amount: number, postedDate: string) =>
    fakeTxn({ id, accountId: CHECKING, amount: -amount, postedDate, description: "LOAN PMT" });
  const payout = (id: string, amount: number, postedDate: string, description: string) =>
    fakeTxn({
      id,
      accountId: CHECKING,
      amount,
      postedDate,
      description,
      category: code("LOAN_DISBURSEMENTS_OTHER"),
    });
  const loan = (fields: Partial<ManualLoanInput>): ManualLoanInput => ({
    lender: "Lakeside Credit",
    kind: "car",
    balance: 1_000_000,
    balanceDate: "2026-09-01",
    apr: 7.3,
    regularPayment: null,
    escrow: null,
    loanType: null,
    ...fields,
  });
  // Links payments to the loan by hand, then runs the follow-up job.
  const link = async (loanAccountId: string, ...providerIds: string[]) => {
    for (const providerId of providerIds) {
      const linked = await linkByHand(
        bank.database,
        { kind: "loan", transactionId: await idOf(providerId), loanAccountId },
        "member-1",
        NOW(),
      );
      expect(linked.outcome).toBe("linked");
    }
    await runFollowUp(NOW);
  };
  const partsOf = async (providerId: string) =>
    (await readTransactionDecision(bank.database, await idOf(providerId)))?.parts;
  const loanLinks = () =>
    bank.database.$client
      .execute("SELECT transaction_id, loan_account_id, made_by FROM loan_links")
      .then((result) => result.rows.map((row) => ({ ...row })));

  beforeEach(async () => {
    bank = await newTestBank();
    stops = [startMoneyMovement({ database: bank.database }).stop];
    connectionId = await bank.connect(BANK);
    await bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('member-1', 'Jamie', 'jamie@example.com', '2026-10-01T00:00:00.000Z',
         '2026-10-01T00:00:00.000Z')`,
    );
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  it("is an Account with no Connection, added at once with no payment linked", async () => {
    const added = await addManualLoan(bank.database, loan({ regularPayment: 50_000 }), "member-1");

    expect(added).toEqual({
      id: expect.any(String),
      lender: "Lakeside Credit",
      kind: "car",
      balance: 1_000_000,
      balanceDate: "2026-09-01",
      apr: 7.3,
      regularPayment: 50_000,
      escrow: null,
      loanType: "purchase loan",
      setBy: "app",
      currentBalance: 1_000_000,
      closed: false,
    });
    const rows = await bank.database.$client.execute({
      sql: "SELECT kind, connection_id FROM household_accounts WHERE id = ?",
      args: [added.id],
    });
    expect({ ...rows.rows[0] }).toEqual({ kind: "loan", connection_id: null });
    // A personal loan starts as a Cash loan, and a Member may switch any loan.
    const personal = await addManualLoan(bank.database, loan({ kind: "personal" }), "member-1");
    expect(personal.loanType).toBe("cash loan");
    const switched = await editManualLoan(
      bank.database,
      added.id,
      loan({ loanType: "cash loan" }),
      "member-1",
    );
    expect(switched).toMatchObject({ loanType: "cash loan", setBy: "Member" });
    expect(await editManualLoan(bank.database, "no-such-loan", loan({}), "member-1")).toBe(
      undefined,
    );
  });

  it("accrues daily interest over 31 days from the balance date, then from the previous payment", async () => {
    await sync([payment("oct", 50_000, "2026-10-02"), payment("nov", 50_000, "2026-11-01")]);
    const car = await addManualLoan(bank.database, loan({}), "member-1");

    await link(car.id, "oct", "nov");

    // $10,000 × 7.3% ÷ 365 × 31 days = $62.00. A car loan is a Purchase loan: the principal is
    // Spending in Car.
    expect(await partsOf("oct")).toEqual([
      { type: "Spending", amount: -6_200, category: "Interest and fees" },
      { type: "Spending", amount: -43_800, category: "Car" },
    ]);
    // 30 days from the October payment, on the $9,562 that it left: $57.37.
    expect(await partsOf("nov")).toEqual([
      { type: "Spending", amount: -5_737, category: "Interest and fees" },
      { type: "Spending", amount: -44_263, category: "Car" },
    ]);

    // A Cash loan's principal is a Transfer.
    await editManualLoan(bank.database, car.id, loan({ loanType: "cash loan" }), "member-1");
    await runFollowUp(NOW);
    expect(await partsOf("oct")).toEqual([
      { type: "Spending", amount: -6_200, category: "Interest and fees" },
      { type: "Transfer", amount: -43_800, category: null },
    ]);
  });

  it("divides a mortgage payment into monthly interest, escrow in Housing, and principal", async () => {
    await sync([payment("mortgage", 200_000, "2026-10-01")]);
    const mortgage = await addManualLoan(
      bank.database,
      loan({ kind: "mortgage", balance: 24_000_000, apr: 6, escrow: 40_000 }),
      "member-1",
    );

    await link(mortgage.id, "mortgage");

    // $240,000 × 6% ÷ 12 = $1,200 interest, $400 escrow, and $400 principal.
    expect(await partsOf("mortgage")).toEqual([
      { type: "Spending", amount: -120_000, category: "Interest and fees" },
      { type: "Spending", amount: -40_000, category: "Housing" },
      { type: "Spending", amount: -40_000, category: "Housing" },
    ]);
  });

  it("never takes the principal below $0", async () => {
    await sync([payment("short", 130_000, "2026-10-01"), payment("small", 5_000, "2026-10-02")]);
    const mortgage = await addManualLoan(
      bank.database,
      loan({ kind: "mortgage", balance: 24_000_000, apr: 6, escrow: 40_000 }),
      "member-1",
    );
    const car = await addManualLoan(bank.database, loan({}), "member-1");

    await link(mortgage.id, "short");
    await link(car.id, "small");

    // $1,200 interest leaves $100 of the $400 escrow, and no principal.
    expect(await partsOf("short")).toEqual([
      { type: "Spending", amount: -120_000, category: "Interest and fees" },
      { type: "Spending", amount: -10_000, category: "Housing" },
    ]);
    // $62 of interest is due on a $50 payment: all of it is interest.
    expect(await partsOf("small")).toEqual([
      { type: "Spending", amount: -5_000, category: "Interest and fees" },
    ]);
  });

  it("links a Cash loan's payout as a Transfer from the loan, and never again once undone", async () => {
    await sync([
      payout("payout", 1_000_000, "2026-08-20", "LAKESIDE CREDIT LOAN DISBURSEMENT"),
      payout("other-payout", 500_000, "2026-08-21", "RIVERBANK LOAN DISBURSEMENT"),
    ]);
    const car = await addManualLoan(bank.database, loan({ lender: "Hilltop Auto" }), "member-1");
    const personal = await addManualLoan(bank.database, loan({ kind: "personal" }), "member-1");

    await runFollowUp(NOW);

    // Each loan looks only for a payout that names its lender.
    expect(await loanLinks()).toEqual([
      { transaction_id: await idOf("payout"), loan_account_id: personal.id, made_by: "app" },
    ]);
    expect(await readTransactionDecision(bank.database, await idOf("payout"))).toEqual({
      step: "4",
      provisionalUntil: null,
      parts: [{ type: "Transfer", amount: 1_000_000, category: null }],
    });
    expect((await partsOf("other-payout"))?.map((part) => part.type)).toEqual(["Transfer"]);

    // A Member undoes it: the app never links it again.
    const [linkId] = (await bank.database.$client.execute("SELECT id FROM loan_links")).rows.map(
      (row) => String(row.id),
    );
    expect(await undoLink(bank.database, linkId ?? "", "member-1", NOW())).toBe(true);
    await editManualLoan(bank.database, personal.id, loan({ kind: "personal" }), "member-1");
    await runFollowUp(NOW);
    expect(await loanLinks()).toEqual([]);

    // A payout a Member links to a Purchase loan makes it a Cash loan.
    await link(car.id, "payout");
    expect((await listManualLoanViews(bank.database, [car.id]))[0]).toMatchObject({
      loanType: "cash loan",
      setBy: "app",
    });
  });

  it("makes a loan whose type the app decides a Cash loan once its payout links, unless a Member chose Purchase loan", async () => {
    await sync([
      payout("payout", 2_000_000, "2026-08-15", "LAKESIDE CREDIT LOAN DISBURSEMENT"),
      payment("oct", 50_000, "2026-10-02"),
    ]);
    const chosen = await addManualLoan(
      bank.database,
      loan({ lender: "Hilltop Auto", loanType: "purchase loan" }),
      "member-1",
    );
    await sync([payout("hilltop", 1_500_000, "2026-08-16", "HILLTOP AUTO LOAN DISBURSEMENT")]);
    const car = await addManualLoan(bank.database, loan({}), "member-1");
    await runFollowUp(NOW);

    // The car loan starts as a Purchase loan; its payout makes it a Cash loan.
    expect(await loanLinks()).toEqual([
      { transaction_id: await idOf("payout"), loan_account_id: car.id, made_by: "app" },
    ]);
    expect(await partsOf("payout")).toEqual([
      { type: "Transfer", amount: 2_000_000, category: null },
    ]);
    expect(
      (await listManualLoanViews(bank.database, [car.id, chosen.id])).map((view) => [
        view.lender,
        view.loanType,
        view.setBy,
      ]),
    ).toEqual([
      ["Hilltop Auto", "purchase loan", "Member"],
      ["Lakeside Credit", "cash loan", "app"],
    ]);
    // So a payment's principal is a Transfer, and counts once.
    await link(car.id, "oct");
    expect(await partsOf("oct")).toEqual([
      { type: "Spending", amount: -6_200, category: "Interest and fees" },
      { type: "Transfer", amount: -43_800, category: null },
    ]);
    // The Member's Purchase loan takes no payout.
    expect((await partsOf("hilltop"))?.map((part) => part.type)).toEqual(["Transfer"]);
    expect((await loanLinks()).filter((row) => row.loan_account_id === chosen.id)).toEqual([]);
  });

  it("never takes a payout a Member linked by hand", async () => {
    await sync([
      payment("dinner", 1_000_000, "2026-08-10"),
      payout("payout", 1_000_000, "2026-08-20", "LAKESIDE CREDIT LOAN DISBURSEMENT"),
    ]);
    const linked = await linkByHand(
      bank.database,
      {
        kind: "Reimbursement",
        transactionId: await idOf("payout"),
        spendingTransactionId: await idOf("dinner"),
      },
      "member-1",
      NOW(),
    );
    expect(linked.outcome).toBe("linked");
    await runFollowUp(NOW);
    const before = await totalsByMonth(bank.database);

    const personal = await addManualLoan(bank.database, loan({ kind: "personal" }), "member-1");
    await editManualLoan(bank.database, personal.id, loan({ kind: "personal" }), "member-1");
    await runFollowUp(NOW);

    expect(await loanLinks()).toEqual([]);
    const spending = await bank.database.$client.execute(
      "SELECT kind, made_by FROM spending_links",
    );
    expect(spending.rows.map((row) => ({ ...row }))).toEqual([
      { kind: "Reimbursement", made_by: "Member" },
    ]);
    expect(await totalsByMonth(bank.database)).toEqual(before);
  });
});
