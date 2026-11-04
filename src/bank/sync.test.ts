import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readConnection, setHandSetFields } from "../db/index.ts";
import { startJob, startJobs } from "../jobs/index.ts";
import { fakeAccount, fakeTxn } from "./fake.ts";
import { BankDataError, type SyncReport, syncConnection } from "./index.ts";
import { newTestBank, SyncConnectionJob, TEST_BANK_JOB_LIST, type TestBank } from "./testing.ts";

// Syncing a Connection through the fake adapter into Accounts and Transactions (spec 02, The
// bank-data adapter and Changes to synced data).

const BANK = "fake-first-bank";

const CHECKING = fakeAccount({
  id: "acc-checking",
  name: "Everyday Checking",
  mask: "4321",
  currentBalance: 248_000,
  availableBalance: 240_000,
});

const CARD = fakeAccount({
  id: "acc-card",
  name: "Rewards Card",
  type: "credit",
  subtype: "credit card",
  mask: "9876",
  currentBalance: -61_250,
  creditLimit: 500_000,
  card: {
    aprs: [{ type: "purchase_apr", apr: 24.99 }],
    statementBalance: -48_000,
    minimumPayment: 3_500,
    dueDate: "2026-11-21",
    statementIssueDate: "2026-10-27",
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
    principal: 1_500_000,
    interestPaidThisYear: 62_000,
    minimumPayment: 41_000,
    dueDate: "2026-11-15",
  },
});

// Three pages: 2 Accounts, and 6 Transactions across them.
function threePages(): Parameters<TestBank["fake"]["addPages"]> {
  return [
    BANK,
    {
      accounts: [CHECKING, CARD],
      added: [
        fakeTxn({ id: "t1", accountId: CHECKING.id, amount: 320_000, postedDate: "2026-10-01" }),
        fakeTxn({ id: "t2", accountId: CARD.id, amount: -1_599, postedDate: "2026-10-02" }),
      ],
    },
    {
      added: [
        fakeTxn({ id: "t3", accountId: CHECKING.id, amount: -4_500, postedDate: "2026-10-03" }),
        fakeTxn({ id: "t4", accountId: CARD.id, amount: -8_120, postedDate: "2026-10-04" }),
      ],
    },
    {
      added: [
        fakeTxn({ id: "t5", accountId: CHECKING.id, amount: -12_000, postedDate: "2026-10-05" }),
        fakeTxn({ id: "t6", accountId: CARD.id, amount: -2_250, postedDate: "2026-10-06" }),
      ],
      historyLoaded: true,
    },
  ];
}

const report = (added: number, changed: number, removed: number): SyncReport => ({
  added,
  changed,
  removed,
  changedTransactions: added + changed + removed > 0,
});

describe("syncing a fake Connection", () => {
  let bank: TestBank;
  let connectionId: string;

  const rows = async (sql: string) => (await bank.database.$client.execute(sql)).rows;
  const transactionRows = () =>
    rows(
      "SELECT provider_transaction_id AS id, amount, description, hand_set, hidden_reason FROM transactions ORDER BY provider_transaction_id",
    );

  beforeEach(async () => {
    bank = await newTestBank();
    connectionId = await bank.connect(BANK, "First Fake Bank");
  });

  afterEach(() => {
    bank.close();
  });

  it("stores 2 Accounts and their Transactions over 3 pages, then saves the cursor", async () => {
    bank.fake.addPages(...threePages());

    expect(await syncConnection(connectionId)).toEqual(report(6, 0, 0));

    expect(
      await rows(
        "SELECT provider_account_id, name, kind, mask, current_balance, credit_limit, card_aprs, statement_balance, minimum_payment, payment_due_date, institution_name FROM household_accounts ORDER BY provider_account_id",
      ),
    ).toEqual([
      expect.objectContaining({
        provider_account_id: "acc-card",
        name: "Rewards Card",
        kind: "credit",
        mask: "9876",
        current_balance: -61_250,
        credit_limit: 500_000,
        card_aprs: '[{"type":"purchase_apr","apr":24.99}]',
        statement_balance: -48_000,
        minimum_payment: 3_500,
        payment_due_date: "2026-11-21",
        institution_name: "First Fake Bank",
      }),
      expect.objectContaining({
        provider_account_id: "acc-checking",
        current_balance: 248_000,
        credit_limit: null,
        card_aprs: null,
      }),
    ]);
    const stored = await transactionRows();
    expect(stored.map((row) => row.id)).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
    // Integer cents; money into the Account is positive.
    expect(stored[0]).toMatchObject({ amount: 320_000 });
    expect(stored[1]).toMatchObject({ amount: -1_599 });
    // The raw record is kept with each one.
    expect(await rows("SELECT raw FROM transactions WHERE provider_transaction_id = 't3'")).toEqual(
      [{ raw: '{"transaction_id":"t3"}' }],
    );
    // The cursor after the last page, and the last page's history status.
    expect(await readConnection(bank.database, connectionId)).toMatchObject({
      syncCursor: `${BANK}:3`,
      historyLoaded: true,
    });
    expect(bank.fake.calls.map((call) => call.cursor)).toEqual([
      null,
      `${BANK}:1`,
      `${BANK}:2`,
      `${BANK}:3`,
    ]);
  });

  it("stores loan details", async () => {
    bank.fake.addPages(BANK, { accounts: [LOAN] });

    await syncConnection(connectionId);

    expect(
      await rows(
        "SELECT kind, subtype, loan_apr, loan_principal, interest_paid_this_year, minimum_payment, payment_due_date FROM household_accounts",
      ),
    ).toEqual([
      {
        kind: "loan",
        subtype: "auto",
        loan_apr: 6.5,
        loan_principal: 1_500_000,
        interest_paid_this_year: 62_000,
        minimum_payment: 41_000,
        payment_due_date: "2026-11-15",
      },
    ]);
  });

  it("restarts from its first cursor after a mid-run error, with no duplicates", async () => {
    bank.fake.addPages(...threePages());
    bank.fake.failAt(BANK, 2, "temporary");

    const failed = syncConnection(connectionId);
    await expect(failed).rejects.toBeInstanceOf(BankDataError);
    await expect(failed).rejects.toMatchObject({ kind: "temporary" });
    // The first 2 pages are stored, but the cursor is not saved.
    expect(await transactionRows()).toHaveLength(4);
    expect((await readConnection(bank.database, connectionId))?.syncCursor).toBeNull();

    // The next sync starts again from the first cursor. Pages it stored before change nothing.
    expect(await syncConnection(connectionId)).toEqual(report(2, 0, 0));
    expect((await transactionRows()).map((row) => row.id)).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
      "t5",
      "t6",
    ]);
    expect(await rows("SELECT id FROM household_accounts")).toHaveLength(2);
    expect((await readConnection(bank.database, connectionId))?.syncCursor).toBe(`${BANK}:3`);
  });

  it("updates a changed Transaction, and keeps every field a Member set by hand", async () => {
    bank.fake.addPages(...threePages());
    await syncConnection(connectionId);
    const [t3] = await rows("SELECT id FROM transactions WHERE provider_transaction_id = 't3'");
    await setHandSetFields(bank.database, String(t3?.id), { category: "Restaurants" });

    bank.fake.addPages(BANK, {
      changed: [
        fakeTxn({
          id: "t3",
          accountId: CHECKING.id,
          amount: -4_750,
          postedDate: "2026-10-03",
          description: "FAKE t3 with tip",
        }),
      ],
    });

    expect(await syncConnection(connectionId)).toEqual(report(0, 1, 0));
    expect((await transactionRows()).find((row) => row.id === "t3")).toMatchObject({
      amount: -4_750,
      description: "FAKE t3 with tip",
      hand_set: '{"category":"Restaurants"}',
      hidden_reason: null,
    });
  });

  it("hides a removed Transaction but keeps it, with the reason", async () => {
    bank.fake.addPages(...threePages());
    await syncConnection(connectionId);

    bank.fake.addPages(BANK, { removed: [{ id: "t4" }] });

    expect(await syncConnection(connectionId)).toEqual(report(0, 0, 1));
    expect((await transactionRows()).find((row) => row.id === "t4")).toMatchObject({
      hidden_reason: "removed by provider",
    });
    expect(await transactionRows()).toHaveLength(6);
  });

  it("moves hand-set fields from a pending Transaction to the posted one, and hides it", async () => {
    bank.fake.addPages(BANK, {
      accounts: [CARD],
      added: [fakeTxn({ id: "p1", accountId: CARD.id, amount: -2_500, pending: true })],
    });
    await syncConnection(connectionId);
    const [p1] = await rows("SELECT id FROM transactions WHERE provider_transaction_id = 'p1'");
    await setHandSetFields(bank.database, String(p1?.id), { category: "Coffee shops" });

    // The provider removes the pending record and adds a posted one that points back to it.
    bank.fake.addPages(BANK, {
      added: [
        fakeTxn({ id: "c1", accountId: CARD.id, amount: -2_850, pendingTransactionId: "p1" }),
      ],
      removed: [{ id: "p1" }],
    });

    expect(await syncConnection(connectionId)).toEqual(report(1, 0, 1));
    const byId = new Map((await transactionRows()).map((row) => [row.id, row]));
    expect(byId.get("p1")).toMatchObject({ hidden_reason: "posted" });
    expect(byId.get("c1")).toMatchObject({
      hand_set: '{"category":"Coffee shops"}',
      hidden_reason: null,
    });
  });

  it("gives the reason posted even when the removal comes in an earlier page", async () => {
    bank.fake.addPages(BANK, {
      accounts: [CARD],
      added: [fakeTxn({ id: "p1", accountId: CARD.id, amount: -2_500, pending: true })],
    });
    await syncConnection(connectionId);

    bank.fake.addPages(
      BANK,
      { removed: [{ id: "p1" }] },
      {
        added: [
          fakeTxn({ id: "c1", accountId: CARD.id, amount: -2_500, pendingTransactionId: "p1" }),
        ],
      },
    );
    await syncConnection(connectionId);

    expect((await transactionRows()).map((row) => [row.id, row.hidden_reason])).toEqual([
      ["c1", null],
      ["p1", "posted"],
    ]);
  });

  it("gives each Transaction its Merchant as it arrives, and again when it changes", async () => {
    bank.fake.addPages(BANK, {
      accounts: [CHECKING],
      added: [
        fakeTxn({
          id: "m1",
          accountId: CHECKING.id,
          amount: -650,
          description: "SQ *BLUE DOOR COFFEE",
          merchantName: "Blue Door Coffee Roasters",
          merchantId: "merchant-bdc",
        }),
        fakeTxn({
          id: "m2",
          accountId: CHECKING.id,
          amount: -4_210,
          description: "SHELL OIL 57444 AUSTIN TX",
        }),
        fakeTxn({ id: "m3", accountId: CHECKING.id, amount: -12_000, description: "CHECK 1042" }),
        // The rules leave nothing: no name, and AI cleanup finds one.
        fakeTxn({
          id: "m0",
          accountId: CHECKING.id,
          amount: -999,
          description: "4111111111111111",
        }),
        fakeTxn({
          id: "m4",
          accountId: CHECKING.id,
          amount: -3_300,
          description: "HAPPY VALLEY DOG GROOMING AND SPA #0042 SALT LAKE CITY UT",
        }),
      ],
    });
    const merchantRows = () =>
      rows(
        "SELECT provider_transaction_id AS id, merchant_id, merchant_clean_name, merchant_needs_ai FROM transactions ORDER BY provider_transaction_id",
      );

    await syncConnection(connectionId);

    expect(await merchantRows()).toEqual([
      { id: "m0", merchant_id: null, merchant_clean_name: null, merchant_needs_ai: 1 },
      {
        id: "m1",
        merchant_id: "merchant-bdc",
        merchant_clean_name: "Blue Door Coffee Roasters",
        merchant_needs_ai: 0,
      },
      { id: "m2", merchant_id: null, merchant_clean_name: "Shell Oil", merchant_needs_ai: 0 },
      { id: "m3", merchant_id: null, merchant_clean_name: null, merchant_needs_ai: 0 },
      {
        id: "m4",
        merchant_id: null,
        merchant_clean_name: "Happy Valley Dog Grooming And Spa",
        merchant_needs_ai: 1,
      },
    ]);

    // The provider names the Merchant later.
    bank.fake.addPages(BANK, {
      changed: [
        fakeTxn({
          id: "m4",
          accountId: CHECKING.id,
          amount: -3_300,
          description: "HAPPY VALLEY DOG GROOMING AND SPA #0042 SALT LAKE CITY UT",
          merchantName: "Happy Valley Grooming",
        }),
      ],
    });
    expect(await syncConnection(connectionId)).toEqual(report(0, 1, 0));
    expect((await merchantRows()).at(-1)).toMatchObject({
      merchant_clean_name: "Happy Valley Grooming",
      merchant_needs_ai: 0,
    });
  });

  it("reports no change for a sync that brings nothing new", async () => {
    bank.fake.addPages(...threePages());
    await syncConnection(connectionId);

    expect(await syncConnection(connectionId)).toEqual(report(0, 0, 0));
  });

  it.each([
    [
      "a Transaction amount",
      { added: [fakeTxn({ id: "t1", accountId: CHECKING.id, amount: 12.5 })] },
    ],
    ["a balance", { accounts: [{ ...CHECKING, currentBalance: 248_000.4 }] }],
  ])("refuses %s that is not whole cents, and stores nothing", async (_name, page) => {
    bank.fake.addPages(BANK, { accounts: [CHECKING], ...page });

    await expect(syncConnection(connectionId)).rejects.toThrow("An amount must be whole cents");
    expect(await rows("SELECT id FROM transactions")).toEqual([]);
    expect(await rows("SELECT id FROM household_accounts")).toEqual([]);
  });

  it("runs one sync at a time for each Connection", async () => {
    bank.fake.addPages(...threePages());

    const [first, second] = await Promise.all([
      syncConnection(connectionId),
      syncConnection(connectionId),
    ]);

    expect(first).toEqual(report(6, 0, 0));
    expect(second).toEqual(report(0, 0, 0));
    // The second sync starts only after the first saved its cursor.
    expect(bank.fake.calls.map((call) => call.cursor)).toEqual([
      null,
      `${BANK}:1`,
      `${BANK}:2`,
      `${BANK}:3`,
      `${BANK}:3`,
    ]);
  });

  it("stops a sync on each error kind, and saves no cursor", async () => {
    for (const kind of ["temporary", "needs a member", "gone"] as const) {
      const other = await bank.connect(`fake-${kind}`);
      bank.fake.addPages(`fake-${kind}`, { accounts: [CHECKING] });
      bank.fake.failAt(`fake-${kind}`, 0, kind);

      await expect(syncConnection(other)).rejects.toMatchObject({ kind });
      expect((await readConnection(bank.database, other))?.syncCursor).toBeNull();
    }
  });
});

describe("the sync job", () => {
  let bank: TestBank;
  let dir: string;
  let stop: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    bank = await newTestBank();
    dir = mkdtempSync(join(tmpdir(), "fft-bank-jobs-"));
  });

  afterEach(async () => {
    await stop?.();
    bank.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("syncs each Connection as its own job, by the Connection's ID", async () => {
    const jobs = await startJobs({
      jobsDb: join(dir, "jobs.db"),
      jobList: TEST_BANK_JOB_LIST,
      tasks: [],
      database: bank.database,
    });
    stop = jobs.stop;
    const first = await bank.connect("fake-a");
    const second = await bank.connect("fake-b");
    bank.fake.addPages("fake-a", {
      accounts: [CHECKING],
      added: [fakeTxn({ id: "a1", accountId: CHECKING.id, amount: 100 })],
    });
    bank.fake.addPages("fake-b", {
      accounts: [CARD],
      added: [fakeTxn({ id: "b1", accountId: CARD.id, amount: -100 })],
    });

    await startJob(SyncConnectionJob, [first]);
    await startJob(SyncConnectionJob, [second]);

    // Sidequest polls for jobs on real timers.
    let synced = 0;
    for (let tries = 0; synced < 2 && tries < 500; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const done = await bank.database.$client.execute(
        "SELECT id FROM connections WHERE sync_cursor IS NOT NULL",
      );
      synced = done.rows.length;
    }
    expect(synced).toBe(2);
    const stored = await bank.database.$client.execute(
      "SELECT provider_transaction_id FROM transactions ORDER BY provider_transaction_id",
    );
    expect(stored.rows.map((row) => row.provider_transaction_id)).toEqual(["a1", "b1"]);
  });
});
