import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import type * as Db from "../db/index.ts";
import { listLoanPayouts } from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { answerReviewItem, openReviewItems, reviewListItems } from "../review/index.ts";
import { addDays } from "./business-days.ts";
import {
  addManualLoan,
  readTransactionDecision,
  startMoneyMovement,
  totalsByMonth,
  UNCLEAR_PAIR_KIND,
} from "./index.ts";

// Untracked loan payments (spec 03, Untracked loans) and their Review list item, through the
// Matching follow-up step on Transactions the fake adapter syncs.

// Counts how often a run reads the loan payouts, which it should read once.
vi.mock("../db/index.ts", async (original) => {
  const actual = await original<typeof Db>();
  return { ...actual, listLoanPayouts: vi.fn(actual.listLoanPayouts) };
});

const NOW = () => new Date("2026-11-20T14:00:00.000Z");
const BANK = "fake-first-bank";
const CHECKING = "acc-checking";
const code = (name: string) => ({ name, confidence: "HIGH", version: "v2", mcc: null });

describe("untracked loan payments", () => {
  let bank: TestBank;
  let stops: (() => void)[];
  const connections = new Map<string, string>();

  const sync = async (
    added: TxnRecord[],
    bankId = BANK,
    accounts = [fakeAccount({ id: CHECKING })],
  ) => {
    bank.fake.addPages(bankId, { accounts, added, historyLoaded: true });
    let connectionId = connections.get(bankId);
    if (connectionId === undefined) {
      connectionId = await bank.connect(bankId);
      connections.set(bankId, connectionId);
    }
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
  const decisionOf = async (providerId: string) =>
    readTransactionDecision(bank.database, await idOf(providerId));
  const paid = (id: string, codeName: string, fields: Partial<TxnRecord> = {}) =>
    fakeTxn({
      id,
      accountId: CHECKING,
      amount: -30_000,
      postedDate: "2026-10-05",
      category: code(codeName),
      ...fields,
    });
  const untrackedItems = async () =>
    (await openReviewItems(bank.database)).filter((item) => item.kind === "untracked loan");

  beforeEach(async () => {
    bank = await newTestBank();
    stops = [startMoneyMovement({ database: bank.database }).stop];
    connections.clear();
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

  it("counts the whole payment as Spending in its code's Category, which a Category rule may replace", async () => {
    await sync([
      paid("mortgage", "LOAN_PAYMENTS_MORTGAGE_PAYMENT"),
      paid("car", "LOAN_PAYMENTS_CAR_PAYMENT"),
      paid("student", "LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT"),
      paid("bnpl", "LOAN_PAYMENTS_BNPL"),
      paid("personal", "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT"),
      paid("other", "LOAN_PAYMENTS_OTHER_PAYMENT"),
      paid("card", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"),
    ]);

    for (const [id, category] of [
      ["mortgage", "Housing"],
      ["car", "Car"],
      ["student", "Books and education"],
      ["bnpl", "General goods"],
      ["personal", "Miscellaneous"],
      ["other", "Miscellaneous"],
    ]) {
      expect(await decisionOf(id ?? "")).toEqual({
        step: "5.2",
        provisionalUntil: null,
        parts: [{ type: "Spending", amount: -30_000, category }],
      });
    }
    // A card payment is never an untracked loan payment.
    expect((await decisionOf("card"))?.step).not.toBe("5.2");
    // The Category is named, not kept: a hand-set Category or a Category rule replaces it.
    const kept = await bank.database.$client.execute(
      "SELECT count(*) AS n FROM transaction_parts WHERE keeps_category = 1",
    );
    expect(Number(kept.rows[0]?.n)).toBe(0);
    expect(await untrackedItems()).toEqual([]);
  });

  it("counts each payment as a Transfer once the lender's payout landed, and offers to add a Manual loan once", async () => {
    await sync([
      fakeTxn({
        id: "payout",
        accountId: CHECKING,
        amount: 1_000_000,
        postedDate: "2026-08-03",
        merchantName: "Upstart",
        category: code("LOAN_DISBURSEMENTS_OTHER"),
      }),
      paid("sep", "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT", {
        merchantName: "UPSTART",
        postedDate: "2026-09-05",
      }),
      paid("oct", "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT", { merchantName: "Upstart" }),
      paid("elsewhere", "LOAN_PAYMENTS_CAR_PAYMENT", { merchantName: "Lakeside Auto" }),
    ]);

    for (const id of ["sep", "oct"]) {
      expect(await decisionOf(id)).toEqual({
        step: "5.2",
        provisionalUntil: null,
        parts: [{ type: "Transfer", amount: -30_000, category: null }],
      });
    }
    expect((await decisionOf("elsewhere"))?.parts).toEqual([
      { type: "Spending", amount: -30_000, category: "Car" },
    ]);
    const [item, ...more] = await untrackedItems();
    expect(more).toEqual([]);
    expect(item).toMatchObject({
      subject: { type: "transactions", transactionIds: [await idOf("payout")] },
      decided: "Payments to Upstart count as Transfers, so their interest cannot show.",
      bestAnswer: {
        value: "/settings/banks?lender=Upstart#manual-loans",
        label: "Add it as a Manual loan",
      },
    });

    // Once answered, a later payment asks no more.
    expect(await answerReviewItem(bank.database, item?.id ?? "", "leave", "member-1")).toBe(
      "answered",
    );
    await sync([paid("nov", "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT", { merchantName: "Upstart" })]);
    expect((await decisionOf("nov"))?.parts.map((part) => part.type)).toEqual(["Transfer"]);
    expect(await untrackedItems()).toEqual([]);
  });

  it("lists the items one run opens newest first, by their payouts' date", async () => {
    const payout = (id: string, merchantName: string, postedDate: string) =>
      fakeTxn({
        id,
        accountId: CHECKING,
        amount: 1_000_000,
        postedDate,
        merchantName,
        category: code("LOAN_DISBURSEMENTS_OTHER"),
      });
    const lenders = [
      ["upstart", "Upstart", "2026-08-03"],
      ["sofi", "SoFi", "2026-09-20"],
      ["lendingclub", "LendingClub", "2026-06-10"],
    ] as const;
    await sync(
      lenders.flatMap(([id, lender, postedDate]) => [
        payout(`${id}-payout`, lender, postedDate),
        paid(`${id}-oct`, "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT", { merchantName: lender }),
      ]),
    );

    const listed = (await reviewListItems(bank.database)).filter(
      (item) => item.kind === "untracked loan",
    );
    expect(listed.map((item) => item.subject)).toEqual([
      { type: "transactions", transactionIds: [await idOf("sofi-payout")] },
      { type: "transactions", transactionIds: [await idOf("upstart-payout")] },
      { type: "transactions", transactionIds: [await idOf("lendingclub-payout")] },
    ]);
    expect(new Set(listed.map((item) => item.createdAt.getTime())).size).toBe(1);
  });

  it("settles the item once a Manual loan for the lender links the payout", async () => {
    await sync([
      fakeTxn({
        id: "payout",
        accountId: CHECKING,
        amount: 1_000_000,
        postedDate: "2026-08-03",
        merchantName: "Upstart",
        description: "UPSTART LOAN DISBURSEMENT",
        category: code("LOAN_DISBURSEMENTS_OTHER"),
      }),
      paid("oct", "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT", { merchantName: "Upstart" }),
    ]);
    expect(await untrackedItems()).toHaveLength(1);

    await addManualLoan(
      bank.database,
      {
        lender: "Upstart",
        kind: "personal",
        balance: 900_000,
        balanceDate: "2026-11-01",
        apr: 9.9,
        regularPayment: null,
        escrow: null,
        loanType: null,
      },
      "member-1",
    );
    await runFollowUp(NOW);

    expect((await decisionOf("payout"))?.step).toBe("4");
    expect(await untrackedItems()).toEqual([]);
  });

  it("counts a payment in an Unclear pair with a connected loan once, on the loan's side, until a Member answers", async () => {
    const loan = fakeAccount({ id: "acc-loan", type: "loan", subtype: "auto", mask: "7777" });
    await sync([
      fakeTxn({
        id: "pay",
        accountId: CHECKING,
        amount: -30_000,
        postedDate: "2026-10-05",
        description: "ONLINE PAYMENT",
      }),
    ]);
    await sync(
      [
        fakeTxn({
          id: "received",
          accountId: loan.id,
          amount: 30_000,
          postedDate: "2026-10-06",
          description: "PAYMENT RECEIVED",
        }),
      ],
      "fake-other-bank",
      [loan],
    );

    const [pair, ...more] = (await openReviewItems(bank.database)).filter(
      (item) => item.kind === UNCLEAR_PAIR_KIND,
    );
    expect(more).toEqual([]);
    expect(pair).toBeDefined();
    expect(await decisionOf("pay")).toEqual({
      step: "3",
      provisionalUntil: null,
      parts: [{ type: "Transfer", amount: -30_000, category: null }],
    });
    // A car loan's principal is Spending in Car, on the loan's own Transaction, and counts once.
    expect((await decisionOf("received"))?.parts).toEqual([
      { type: "Spending", amount: -30_000, category: "Car" },
    ]);
    const october = (await totalsByMonth(bank.database)).find((m) => m.month === "2026-10");
    expect(october?.spending).toBe(30_000);

    // "Not this": the payment counts on its own again.
    expect(await answerReviewItem(bank.database, pair?.id ?? "", "not this", "member-1")).toBe(
      "answered",
    );
    await runFollowUp(NOW);
    expect((await decisionOf("pay"))?.parts).toEqual([
      { type: "Spending", amount: -30_000, category: null },
    ]);
  });

  it("decides 2,500 untracked loan payments from 250 lenders, and opens one item each, in a few seconds, reading the payouts once", async () => {
    const LENDERS = 250;
    const EACH = 10;
    const lender = (n: number) => `Lender ${n}`;
    const history = Array.from({ length: LENDERS }, (_, n) => [
      fakeTxn({
        id: `payout-${n}`,
        accountId: CHECKING,
        amount: 1_000_000,
        postedDate: "2021-12-01",
        merchantName: lender(n),
        category: code("LOAN_DISBURSEMENTS_OTHER"),
      }),
      ...Array.from({ length: EACH }, (_, k) =>
        paid(`pay-${n}-${k}`, "LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT", {
          merchantName: lender(n),
          postedDate: addDays("2021-12-15", k * 180 + n),
        }),
      ),
    ]).flat();

    bank.fake.addPages(BANK, {
      accounts: [fakeAccount({ id: CHECKING })],
      added: history,
      historyLoaded: true,
    });
    await syncConnection(await bank.connect(BANK), NOW);
    vi.mocked(listLoanPayouts).mockClear();

    // Only the follow-up job, which decides every payment and opens the items.
    // CPU time, which a busy host does not stretch.
    const started = process.cpuUsage();
    await runFollowUp(NOW);
    const used = process.cpuUsage(started);
    const took = (used.user + used.system) / 1_000;

    expect(await untrackedItems()).toHaveLength(LENDERS);
    const transfers = await bank.database.$client.execute(
      "SELECT count(*) AS n FROM transaction_decisions WHERE step = '5.2'",
    );
    expect(Number(transfers.rows[0]?.n)).toBe(LENDERS * EACH);
    // The time grows with the payments, not with payments × lenders: one read a run.
    expect(vi.mocked(listLoanPayouts).mock.calls.length).toBe(1);
    expect(took).toBeLessThan(8_000);
    process.stderr.write(
      `Untracked loans: ${LENDERS * EACH} payments decided in ${Math.round(took)} ms, payouts read ${vi.mocked(listLoanPayouts).mock.calls.length} times\n`,
    );
  }, 60_000);
});
