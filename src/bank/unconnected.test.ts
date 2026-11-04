import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assignToUnconnectedAccount, loginTables } from "../db/index.ts";
import { fakeAccount, fakeTxn } from "./fake.ts";
import {
  addUnconnectedAccount,
  editUnconnectedAccount,
  estimateBalance,
  listUnconnectedAccounts,
  syncConnection,
} from "./index.ts";
import { newTestBank, type TestBank } from "./testing.ts";

// Unconnected accounts and their balance estimates (spec 02, Balance estimate). The test writes
// each assignment directly, as T36's matching will.

const BANK = "fake-first-bank";
const CHECKING = fakeAccount({ id: "acc-checking", name: "Everyday Checking" });
const MEMBER = "member-a";

const SAVINGS = {
  name: "Pinecrest savings",
  kind: "savings",
  institutionName: "Pinecrest",
  mask: "4321",
} as const;

describe("the balance estimate", () => {
  it("is $0 plus money moved in, minus money moved out, with no typed balance", () => {
    // Money out of the connected Account, into the Unconnected account, is negative.
    expect(estimateBalance(undefined, [-50_000, -25_000, 10_000])).toEqual({
      balance: 65_000,
      state: "estimated",
      typedOn: null,
    });
    expect(estimateBalance(undefined, [])).toEqual({
      balance: 0,
      state: "estimated",
      typedOn: null,
    });
  });

  it("shows the typed balance with its date until an assigned Transfer moves it", () => {
    const typed = { date: "2026-10-05", balance: 1_000_000 };

    expect(estimateBalance(typed, [])).toEqual({
      balance: 1_000_000,
      state: "typed",
      typedOn: "2026-10-05",
    });
    expect(estimateBalance(typed, [-20_000])).toEqual({
      balance: 1_020_000,
      state: "estimated",
      typedOn: "2026-10-05",
    });
  });
});

describe("Unconnected accounts", () => {
  let bank: TestBank;
  // Each made-up Transaction's ID in app.db, by its provider ID.
  let ids: Map<string, string>;

  beforeEach(async () => {
    bank = await newTestBank({ timeZone: "America/New_York" });
    const at = new Date("2026-10-01T12:00:00Z");
    await bank.database.insert(loginTables.user).values({
      id: MEMBER,
      name: "Alice",
      email: "alice@example.com",
      createdAt: at,
      updatedAt: at,
    });
    const connectionId = await bank.connect(BANK);
    const txn = (id: string, amount: number, postedDate: string, pending = false) =>
      fakeTxn({ id, accountId: CHECKING.id, amount, postedDate, pending, description: "XFER" });
    bank.fake.addPages(
      BANK,
      {
        accounts: [CHECKING],
        added: [
          txn("before", -30_000, "2026-10-02"),
          txn("same-day", -40_000, "2026-10-05"),
          txn("out", -50_000, "2026-10-07"),
          txn("back", 15_000, "2026-10-09"),
          txn("held", -99_000, "2026-10-10", true),
          txn("gone", -88_000, "2026-10-10"),
          txn("other", -77_000, "2026-10-10"),
        ],
      },
      { removed: [{ id: "gone" }] },
    );
    await syncConnection(connectionId, () => new Date("2026-10-10T15:00:00Z"));
    const rows = await bank.database.$client.execute(
      "SELECT id, provider_transaction_id FROM transactions",
    );
    ids = new Map(rows.rows.map((row) => [String(row.provider_transaction_id), String(row.id)]));
  });

  afterEach(() => {
    bank.close();
  });

  const assign = async (accountId: string, ...providerIds: string[]) => {
    for (const providerId of providerIds) {
      await assignToUnconnectedAccount(bank.database, ids.get(providerId) ?? "", accountId);
    }
  };
  const estimateOf = async (id: string) =>
    (await listUnconnectedAccounts(bank.database)).find((account) => account.id === id)?.estimate;

  it("adds an Unconnected account with its fields, and an optional balance saved with today's date", async () => {
    const account = await addUnconnectedAccount(bank.database, SAVINGS, {
      balance: 1_000_000,
      today: "2026-10-05",
      memberId: MEMBER,
    });

    expect(account).toEqual({
      id: account.id,
      ...SAVINGS,
      closed: false,
      estimate: { balance: 1_000_000, state: "typed", typedOn: "2026-10-05" },
    });
    expect(await listUnconnectedAccounts(bank.database)).toEqual([account]);
  });

  it("counts only the posted Transfers assigned after the typed balance's date", async () => {
    const { id } = await addUnconnectedAccount(bank.database, SAVINGS, {
      balance: 1_000_000,
      today: "2026-10-05",
      memberId: MEMBER,
    });
    // "other" stays unassigned. "before" and "same-day" are on or before the typed date.
    await assign(id, "before", "same-day");
    expect(await estimateOf(id)).toEqual({
      balance: 1_000_000,
      state: "typed",
      typedOn: "2026-10-05",
    });

    await assign(id, "out", "back", "held", "gone");

    // 1,000,000 + 50,000 in − 15,000 back out. The pending and removed ones never count.
    expect(await estimateOf(id)).toEqual({
      balance: 1_035_000,
      state: "estimated",
      typedOn: "2026-10-05",
    });
  });

  it("starts at $0 on the first day of loaded history with no typed balance, and always shows estimated", async () => {
    const { id } = await addUnconnectedAccount(bank.database, { ...SAVINGS, kind: "HSA" });
    expect(await estimateOf(id)).toEqual({ balance: 0, state: "estimated", typedOn: null });

    await assign(id, "before", "same-day", "out", "back");

    expect(await estimateOf(id)).toEqual({ balance: 105_000, state: "estimated", typedOn: null });
  });

  it("lets a Member edit the account and type the true balance, which overrides the estimate", async () => {
    const { id } = await addUnconnectedAccount(bank.database, SAVINGS);
    await assign(id, "before", "out");
    expect(await estimateOf(id)).toMatchObject({ balance: 80_000, state: "estimated" });

    const edited = await editUnconnectedAccount(
      bank.database,
      id,
      { name: "Retirement", kind: "investment or retirement", institutionName: null, mask: null },
      { balance: 2_500_000, today: "2026-10-08", memberId: MEMBER },
    );

    expect(edited).toEqual({
      id,
      name: "Retirement",
      kind: "investment or retirement",
      institutionName: null,
      mask: null,
      closed: false,
      estimate: { balance: 2_500_000, state: "typed", typedOn: "2026-10-08" },
    });

    // A second balance typed the same day replaces the first.
    await editUnconnectedAccount(
      bank.database,
      id,
      { name: "Retirement", kind: "investment or retirement", institutionName: null, mask: null },
      { balance: 2_400_000, today: "2026-10-08", memberId: MEMBER },
    );
    await assign(id, "back");
    expect(await estimateOf(id)).toEqual({
      balance: 2_385_000,
      state: "estimated",
      typedOn: "2026-10-08",
    });
  });

  it("edits only Unconnected accounts", async () => {
    const rows = await bank.database.$client.execute("SELECT id FROM household_accounts");
    const checkingId = String(rows.rows[0]?.id);

    expect(
      await editUnconnectedAccount(bank.database, checkingId, { ...SAVINGS, kind: "other" }),
    ).toBeUndefined();
    expect(await editUnconnectedAccount(bank.database, "no-such-id", SAVINGS)).toBeUndefined();
    expect(await listUnconnectedAccounts(bank.database)).toEqual([]);
  });
});
