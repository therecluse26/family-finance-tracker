import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_BANKS, DEMO_PINECREST, demoRecords, seedDemoHousehold } from "../bank/demo.ts";
import { type FakePage, fakeAccount, fakeTxn } from "../bank/fake.ts";
import {
  addUnconnectedAccount,
  listUnconnectedAccounts,
  syncConnection,
  type TxnRecord,
  type UnconnectedAccountInput,
} from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { listConnections } from "../db/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { answerReviewItem, openReviewItems } from "../review/index.ts";
import {
  decideOneSidedAgain,
  type MonthTotals,
  readTransactionDecision,
  startMoneyMovement,
  totalsByMonth,
} from "./index.ts";

// One-sided Transfers and Saving, steps 5.6 and 6.7 (spec 03, Unconnected accounts, Saving), on
// the demo Household, through the Matching follow-up step on Transactions the fake adapter syncs.

const NOW = () => new Date("2026-11-01T14:00:00.000Z");
const ALLY = DEMO_BANKS.find((demo) => demo.bankId === "fake-ally");
const CHECKING = ALLY?.accounts[0]?.id ?? "";
const ONE_SIDED = "one-sided Transfer";

const PINECREST: UnconnectedAccountInput = {
  name: "Pinecrest savings",
  kind: "savings",
  institutionName: DEMO_PINECREST.name,
  mask: DEMO_PINECREST.mask,
};
const HSA: UnconnectedAccountInput = {
  name: "Family HSA",
  kind: "HSA",
  institutionName: "HealthEquity",
  mask: "7781",
};
const RETIREMENT: UnconnectedAccountInput = {
  name: "Jamie's 401(k)",
  kind: "investment or retirement",
  institutionName: "Fidelity",
  mask: "3321",
};

// The demo's transfers to Pinecrest.
const TO_PINECREST = demoRecords().filter((record) =>
  record.description.includes("PINECREST"),
);

describe("one-sided Transfers and Saving", () => {
  let bank: TestBank;
  let stops: (() => void)[];

  const idOf = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT id FROM transactions WHERE provider_transaction_id = ? AND hidden_reason IS NULL",
      args: [providerId],
    });
    return String(rows.rows[0]?.id);
  };
  const decisionOf = async (providerId: string) =>
    readTransactionDecision(bank.database, await idOf(providerId));
  // The Unconnected account a Transaction is assigned to, or null.
  const assignedTo = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT account_id FROM unconnected_assignments WHERE transaction_id = ?",
      args: [await idOf(providerId)],
    });
    return rows.rows[0] === undefined ? null : String(rows.rows[0].account_id);
  };
  // The open one-sided Transfer item about a Transaction.
  const itemOf = async (providerId: string) => {
    const id = await idOf(providerId);
    return (await openReviewItems(bank.database)).find(
      (item) =>
        item.kind === ONE_SIDED &&
        item.subject.type === "transactions" &&
        item.subject.transactionIds.includes(id),
    );
  };
  const oneSidedItems = async () =>
    (await openReviewItems(bank.database)).filter((item) => item.kind === ONE_SIDED);
  const addAccount = async (input: UnconnectedAccountInput) =>
    (await addUnconnectedAccount(bank.database, input)).id;
  // Syncs one more page into a demo bank, then runs the follow-up job.
  const syncMore = async (bankId: string, page: FakePage, now = NOW) => {
    bank.fake.addPages(bankId, page);
    const connection = (await listConnections(bank.database)).find((c) => c.bankId === bankId);
    await syncConnection(connection?.id ?? (await bank.connect(bankId)), now);
    await runFollowUp(now);
  };
  const inChecking = (
    id: string,
    amount: number,
    postedDate: string,
    description: string,
    code: string | null = null,
  ): TxnRecord =>
    fakeTxn({
      id,
      accountId: CHECKING,
      amount,
      postedDate,
      description,
      category: code === null ? null : { name: code, confidence: "HIGH", version: "v2", mcc: null },
    });
  const estimateOf = async (accountId: string) =>
    (await listUnconnectedAccounts(bank.database)).find((account) => account.id === accountId)
      ?.estimate;
  const month = (totals: MonthTotals[], name: string) => totals.find((t) => t.month === name);

  beforeEach(async () => {
    // The follow-up job reads the clock for the Household's date.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW());
    bank = await newTestBank();
    stops = [startMoneyMovement({ database: bank.database }).stop];
    // The Member who answers the Review list.
    await bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('member-1', 'Jamie', 'jamie@example.com', '2026-10-01T00:00:00.000Z',
         '2026-10-01T00:00:00.000Z')`,
    );
    await seedDemoHousehold(bank.database, bank.fake, NOW);
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
    vi.useRealTimers();
  });

  it("ties each transfer to Pinecrest to that Unconnected account, with no Review list item, and moves its balance estimate", async () => {
    const pinecrest = await addAccount(PINECREST);
    await addAccount(HSA);

    await runFollowUp(NOW);

    expect(TO_PINECREST.length).toBeGreaterThan(10);
    for (const record of TO_PINECREST) {
      expect(await decisionOf(record.id)).toEqual({
        step: "5.6",
        provisionalUntil: null,
        parts: [{ type: "Transfer", amount: record.amount, category: null }],
      });
      expect(await assignedTo(record.id)).toBe(pinecrest);
    }
    expect(await oneSidedItems()).toEqual([]);
    const moved = TO_PINECREST.reduce((sum, record) => sum - record.amount, 0);
    expect(await estimateOf(pinecrest)).toEqual({
      balance: moved,
      state: "estimated",
      typedOn: null,
    });
  });

  it("ties a transfer by the institution name when it holds no last 4 digits", async () => {
    const pinecrest = await addAccount({ ...PINECREST, mask: null });
    await addAccount(HSA);
    await syncMore("fake-ally", {
      added: [inChecking("named", -30_000, "2026-10-20", "Transfer to Pinecrest")],
    });

    expect(await assignedTo("named")).toBe(pinecrest);
    expect(await itemOf("named")).toBeUndefined();
  });

  it("asks which account when a Member adds the account later, then ties the transfers to it", async () => {
    await runFollowUp(NOW);
    const [first] = TO_PINECREST;
    if (first === undefined) throw new Error("The demo has no transfer to Pinecrest.");
    // No Unconnected account: a Transfer with no account, on the Review list.
    expect((await decisionOf(first.id))?.parts).toEqual([
      { type: "Transfer", amount: first.amount, category: null },
    ]);
    expect(await assignedTo(first.id)).toBeNull();
    expect(await itemOf(first.id)).toMatchObject({
      decided: expect.stringContaining("Which account is this?"),
      bestAnswer: { value: "keep", label: "Keep it as a Transfer" },
    });
    expect(await oneSidedItems()).toHaveLength(TO_PINECREST.length);

    // "Add one": the Member adds it; the transfers name it, so each goes to it and its item closes.
    const pinecrest = await addAccount(PINECREST);
    await decideOneSidedAgain(bank.database);
    expect(bank.followUpsAsked()).toBe(1);
    await runFollowUp(NOW);

    expect(await assignedTo(first.id)).toBe(pinecrest);
    expect(await oneSidedItems()).toEqual([]);
  });

  it("makes an investment code with no account Saving, and money back reduces Saving, never Income", async () => {
    await addAccount(PINECREST);
    await runFollowUp(NOW);
    const before = await totalsByMonth(bank.database);

    await syncMore("fake-ally", {
      added: [
        inChecking(
          "to-brokerage",
          -50_000,
          "2026-09-14",
          "BROKERAGE BUY 88",
          "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS",
        ),
        inChecking("to-crypto", -5_000, "2026-09-15", "COINS 88", "TRANSFER_OUT_CRYPTO"),
        inChecking(
          "from-brokerage",
          20_000,
          "2026-10-16",
          "BROKERAGE SELL 88",
          "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS",
        ),
      ],
    });

    for (const [id, amount, step] of [
      ["to-brokerage", -50_000, "5.6"],
      ["to-crypto", -5_000, "5.6"],
      ["from-brokerage", 20_000, "6.7"],
    ] as const) {
      expect(await decisionOf(id)).toEqual({
        step,
        provisionalUntil: null,
        parts: [{ type: "Saving", amount, category: null }],
      });
      // Saving with no account, even with one Unconnected account, and nothing to ask.
      expect(await assignedTo(id)).toBeNull();
      expect(await itemOf(id)).toBeUndefined();
    }
    const after = await totalsByMonth(bank.database);
    expect(month(after, "2026-09")?.saving).toBe((month(before, "2026-09")?.saving ?? 0) + 55_000);
    expect(month(after, "2026-10")?.saving).toBe((month(before, "2026-10")?.saving ?? 0) - 20_000);
    expect(month(after, "2026-10")?.income).toBe(month(before, "2026-10")?.income);
  });

  it("lets the kind decide the type: money to an HSA is a Transfer, to a retirement account Saving, and back from it reduces Saving", async () => {
    await addAccount(PINECREST);
    const hsa = await addAccount(HSA);
    const retirement = await addAccount(RETIREMENT);
    await runFollowUp(NOW);
    const before = await totalsByMonth(bank.database);

    await syncMore("fake-ally", {
      added: [
        inChecking("to-hsa", -30_000, "2026-10-06", "ONLINE TRANSFER TO HEALTHEQUITY"),
        inChecking("to-401k", -40_000, "2026-10-07", "XFER TO ACCT 3321"),
        inChecking("from-401k", 25_000, "2026-10-08", "Xfer from acct 3321"),
      ],
    });

    expect((await decisionOf("to-hsa"))?.parts).toEqual([
      { type: "Transfer", amount: -30_000, category: null },
    ]);
    expect(await assignedTo("to-hsa")).toBe(hsa);
    expect((await decisionOf("to-401k"))?.parts).toEqual([
      { type: "Saving", amount: -40_000, category: null },
    ]);
    expect(await decisionOf("from-401k")).toMatchObject({
      step: "6.7",
      parts: [{ type: "Saving", amount: 25_000, category: null }],
    });
    expect(await assignedTo("to-401k")).toBe(retirement);
    expect(await assignedTo("from-401k")).toBe(retirement);
    expect(await oneSidedItems()).toEqual([]);

    const after = await totalsByMonth(bank.database);
    expect(month(after, "2026-10")?.saving).toBe((month(before, "2026-10")?.saving ?? 0) + 15_000);
    expect(month(after, "2026-10")?.income).toBe(month(before, "2026-10")?.income);
    expect(month(after, "2026-10")?.spending).toBe(month(before, "2026-10")?.spending);
    expect((await estimateOf(retirement))?.balance).toBe(15_000);
  });

  it("puts the only Unconnected account on the Review list to confirm, and settles it when a Member says yes", async () => {
    const pinecrest = await addAccount(PINECREST);
    await syncMore("fake-ally", {
      added: [inChecking("plain", -12_000, "2026-10-20", "ONLINE TRANSFER REF 5521")],
    });

    expect((await decisionOf("plain"))?.parts).toEqual([
      { type: "Transfer", amount: -12_000, category: null },
    ]);
    expect(await assignedTo("plain")).toBe(pinecrest);
    const item = await itemOf("plain");
    expect(item?.bestAnswer).toEqual({
      value: `account ${pinecrest}`,
      label: `Yes, ${PINECREST.name}`,
    });

    await answerReviewItem(bank.database, item?.id ?? "", item?.bestAnswer.value ?? "", "member-1");
    await runFollowUp(NOW);

    expect(await assignedTo("plain")).toBe(pinecrest);
    expect(await itemOf("plain")).toBeUndefined();
  });

  it("asks which account with two Unconnected accounts, and takes a Member's pick or Not a Transfer", async () => {
    await addAccount(PINECREST);
    const hsa = await addAccount(HSA);
    await syncMore("fake-ally", {
      added: [
        inChecking("rent", -180_000, "2026-10-01", "ONLINE TRANSFER REF 1001"),
        inChecking("to-hsa", -15_000, "2026-10-09", "ONLINE TRANSFER REF 1002"),
      ],
    });

    for (const id of ["rent", "to-hsa"]) {
      expect((await decisionOf(id))?.parts).toEqual([
        { type: "Transfer", amount: id === "rent" ? -180_000 : -15_000, category: null },
      ]);
      expect(await assignedTo(id)).toBeNull();
      expect((await itemOf(id))?.decided).toContain("Which account is this?");
    }

    await answerReviewItem(
      bank.database,
      (await itemOf("to-hsa"))?.id ?? "",
      `account ${hsa}`,
      "member-1",
    );
    await answerReviewItem(
      bank.database,
      (await itemOf("rent"))?.id ?? "",
      "not a transfer",
      "member-1",
    );
    await runFollowUp(NOW);

    expect(await decisionOf("to-hsa")).toEqual({
      step: "5.6",
      provisionalUntil: null,
      parts: [{ type: "Transfer", amount: -15_000, category: null }],
    });
    expect(await assignedTo("to-hsa")).toBe(hsa);
    // Not a Transfer sets the type to Spending by hand.
    expect(await decisionOf("rent")).toMatchObject({
      step: "1",
      parts: [{ type: "Spending", amount: -180_000 }],
    });
    expect(await assignedTo("rent")).toBeNull();
    expect(await oneSidedItems()).toEqual([]);
  });

  it("keeps a one-sided result provisional for 5 business days, and a pair found on day 3 replaces it", async () => {
    // A brokerage Account that syncs: Plaid type investment.
    const brokerage = fakeAccount({
      id: "brokerage",
      name: "Brokerage",
      type: "investment",
      subtype: "brokerage",
      mask: "9090",
    });
    const pinecrest = await addAccount(PINECREST);
    // Wednesday the 28th. Today is Sunday, Nov 1.
    await syncMore("fake-ally", {
      added: [
        inChecking("to-brokerage", -60_000, "2026-10-28", "ONLINE TRANSFER TO BROKERAGE 9090"),
      ],
    });
    expect(await decisionOf("to-brokerage")).toEqual({
      step: "5.6",
      provisionalUntil: "2026-11-04",
      parts: [{ type: "Transfer", amount: -60_000, category: null }],
    });
    expect(await assignedTo("to-brokerage")).toBe(pinecrest);
    expect(await itemOf("to-brokerage")).toBeDefined();

    // The brokerage connects, and its side posted on Friday the 30th: day 3.
    await syncMore("fake-vanguard", {
      accounts: [brokerage],
      added: [
        fakeTxn({ id: "got", accountId: brokerage.id, amount: 60_000, postedDate: "2026-10-30" }),
        // Its own Transactions count nowhere, but are kept.
        fakeTxn({
          id: "dividend",
          accountId: brokerage.id,
          amount: 1_250,
          postedDate: "2026-10-30",
        }),
      ],
    });

    // Money into a synced investment Account is Saving. The pair ends the assignment and the item.
    expect(await decisionOf("to-brokerage")).toEqual({
      step: "3",
      provisionalUntil: null,
      parts: [{ type: "Saving", amount: -60_000, category: null }],
    });
    expect(await assignedTo("to-brokerage")).toBeNull();
    expect(await itemOf("to-brokerage")).toBeUndefined();
    for (const [id, amount] of [
      ["got", 60_000],
      ["dividend", 1_250],
    ] as const) {
      expect(await decisionOf(id)).toEqual({
        step: "3",
        provisionalUntil: null,
        parts: [{ type: "Transfer", amount, category: null }],
      });
    }
  });

  it("ties a one-sided transfer to a synced investment Account by its last 4 digits", async () => {
    const brokerage = fakeAccount({
      id: "brokerage",
      type: "investment",
      subtype: "ira",
      mask: "9090",
    });
    await syncMore("fake-vanguard", { accounts: [brokerage] });
    await syncMore("fake-ally", {
      added: [inChecking("to-ira", -70_000, "2026-09-01", "ONLINE TRANSFER TO IRA 9090")],
    });

    expect((await decisionOf("to-ira"))?.parts).toEqual([
      { type: "Saving", amount: -70_000, category: null },
    ]);
    expect(await assignedTo("to-ira")).toBe(await accountIdOf("brokerage"));
    expect(await itemOf("to-ira")).toBeUndefined();
  });

  const accountIdOf = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT id FROM household_accounts WHERE provider_account_id = ?",
      args: [providerId],
    });
    return String(rows.rows[0]?.id);
  };
});
