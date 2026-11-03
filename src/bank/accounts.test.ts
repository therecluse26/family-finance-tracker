import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAccount, listTransactions, reopenAccount } from "../db/index.ts";
import { fakeAccount, fakeTxn } from "./fake.ts";
import { syncConnection } from "./index.ts";
import { newTestBank, type TestBank } from "./testing.ts";

// Closed Accounts and carrying Accounts over (spec 02, Closed Accounts, Changes to synced data,
// and Carrying Accounts over), through syncs of the fake adapter.

const BANK = "fake-first-bank";

const CHECKING = fakeAccount({
  id: "acc-checking",
  name: "Everyday Checking",
  mask: "4321",
  currentBalance: 248_000,
});

const CARD = fakeAccount({
  id: "acc-card",
  name: "Rewards Card",
  type: "credit",
  subtype: "credit card",
  mask: "9876",
  currentBalance: -61_250,
});

const at = (moment: string) => () => new Date(moment);

describe("closing and carrying over Accounts", () => {
  let bank: TestBank;
  let connectionId: string;

  const rows = async (sql: string) => (await bank.database.$client.execute(sql)).rows;
  const accountRows = () =>
    rows(
      "SELECT id, connection_id, provider_account_id, member_name, excluded, closed_at, closed_reason FROM household_accounts ORDER BY name, provider_account_id",
    );
  const transactionRows = () =>
    rows(
      "SELECT provider_transaction_id AS id, account_id, posted_date, hidden_reason FROM transactions ORDER BY posted_date, provider_transaction_id",
    );
  const cardRow = async () =>
    (await rows("SELECT * FROM household_accounts WHERE name = 'Rewards Card'"))[0];

  beforeEach(async () => {
    bank = await newTestBank();
    connectionId = await bank.connect(BANK, "First Fake Bank");
    bank.fake.addPages(BANK, {
      accounts: [CHECKING, CARD],
      added: [
        fakeTxn({ id: "c1", accountId: CARD.id, amount: -1_599, postedDate: "2026-10-01" }),
        fakeTxn({ id: "k1", accountId: CHECKING.id, amount: -4_500, postedDate: "2026-10-02" }),
      ],
    });
    await syncConnection(connectionId, at("2026-10-03T12:00:00.000Z"));
  });

  afterEach(() => {
    bank.close();
  });

  it("closes an Account the provider stops returning, with the date, and keeps its history", async () => {
    bank.fake.addPages(BANK, { accounts: [CHECKING] });

    await syncConnection(connectionId, at("2026-10-04T12:00:00.000Z"));

    expect(await cardRow()).toMatchObject({
      closed_at: "2026-10-04T12:00:00.000Z",
      closed_reason: "vanished",
    });
    expect((await listTransactions(bank.database)).map((txn) => txn.description)).toEqual([
      "FAKE k1",
      "FAKE c1",
    ]);
    // Its saved balances stay too.
    expect(await rows("SELECT date, current_balance FROM daily_balances")).toEqual(
      expect.arrayContaining([{ date: "2026-10-03", current_balance: -61_250 }]),
    );
  });

  it("keeps a Member's reopening while the provider still leaves the Account out", async () => {
    bank.fake.addPages(BANK, { accounts: [CHECKING] });
    await syncConnection(connectionId, at("2026-10-04T12:00:00.000Z"));
    const cardId = String((await cardRow())?.id);

    expect(await reopenAccount(bank.database, cardId)).toBe(true);
    bank.fake.addPages(BANK, { accounts: [CHECKING] });
    await syncConnection(connectionId, at("2026-10-05T12:00:00.000Z"));

    expect(await cardRow()).toMatchObject({ closed_at: null, closed_reason: null });
  });

  it("opens an Account again when the provider returns it under the same ID", async () => {
    bank.fake.addPages(BANK, { accounts: [CHECKING] });
    await syncConnection(connectionId, at("2026-10-04T12:00:00.000Z"));

    bank.fake.addPages(BANK, { accounts: [CHECKING, CARD] });
    await syncConnection(connectionId, at("2026-10-05T12:00:00.000Z"));

    expect(await cardRow()).toMatchObject({ closed_at: null, provider_missing: 0 });
  });

  it("keeps a Member's closing when the provider still returns the Account", async () => {
    const cardId = String((await cardRow())?.id);
    await closeAccount(bank.database, cardId, new Date("2026-10-04T08:00:00.000Z"));

    bank.fake.addPages(BANK, { accounts: [CHECKING, CARD] });
    await syncConnection(connectionId, at("2026-10-05T12:00:00.000Z"));

    expect(await cardRow()).toMatchObject({
      closed_at: "2026-10-04T08:00:00.000Z",
      closed_reason: "closed by a member",
    });
  });

  it("carries an Account that reappears under a new provider ID in the same sync", async () => {
    const before = await cardRow();
    await bank.database.$client.execute(
      `UPDATE household_accounts SET member_name = 'Travel card', excluded = 1 WHERE id = '${before?.id}'`,
    );
    const renumbered = { ...CARD, id: "acc-card-new", name: "Rewards Card" };
    bank.fake.addPages(BANK, {
      accounts: [CHECKING, renumbered],
      added: [
        fakeTxn({ id: "c2", accountId: renumbered.id, amount: -2_250, postedDate: "2026-10-04" }),
      ],
    });

    await syncConnection(connectionId, at("2026-10-05T12:00:00.000Z"));

    expect(await accountRows()).toEqual([
      expect.objectContaining({ provider_account_id: "acc-checking" }),
      {
        id: before?.id,
        connection_id: connectionId,
        provider_account_id: "acc-card-new",
        member_name: "Travel card",
        excluded: 1,
        closed_at: null,
        closed_reason: null,
      },
    ]);
    expect(
      (await transactionRows()).filter((row) => row.account_id === before?.id).map((r) => r.id),
    ).toEqual(["c1", "c2"]);
  });

  it("starts a new Account when the last 4 digits differ, and closes the old one", async () => {
    const replacement = { ...CARD, id: "acc-card-new", mask: "1111" };
    bank.fake.addPages(BANK, { accounts: [CHECKING, replacement] });

    await syncConnection(connectionId, at("2026-10-05T12:00:00.000Z"));

    expect(
      (await accountRows()).map((row) => [row.provider_account_id, row.closed_reason]),
    ).toEqual([
      ["acc-checking", null],
      ["acc-card", "vanished"],
      ["acc-card-new", null],
    ]);
  });

  it("never carries over an open Account that another Connection still returns", async () => {
    const other = await bank.connect(BANK, "First Fake Bank");
    bank.fake.addPages(other, { accounts: [{ ...CARD, id: "b-card" }] });

    await syncConnection(other, at("2026-10-05T12:00:00.000Z"));

    expect((await accountRows()).map((row) => [row.provider_account_id, row.closed_at])).toEqual([
      ["acc-checking", null],
      ["acc-card", null],
      ["b-card", null],
    ]);
  });

  it("splits history at day D when a new Connection to the same bank carries an Account over", async () => {
    // The old Connection's last successful sync is on 2026-10-10: day D.
    bank.fake.addPages(BANK, {
      added: [
        fakeTxn({ id: "c5", accountId: CARD.id, amount: -500, postedDate: "2026-10-05" }),
        fakeTxn({ id: "c10", accountId: CARD.id, amount: -1_000, postedDate: "2026-10-10" }),
      ],
    });
    await syncConnection(connectionId, at("2026-10-10T18:00:00.000Z"));
    const cardId = String((await cardRow())?.id);
    // Removing the old Connection closes its Accounts.
    for (const row of await accountRows()) await closeAccount(bank.database, String(row.id));

    // The bank, linked again: the same Accounts under new IDs, with history that overlaps.
    const relinked = await bank.connect(BANK, "First Fake Bank");
    const newCard = { ...CARD, id: "b-card" };
    bank.fake.addPages(relinked, {
      accounts: [{ ...CHECKING, id: "b-checking" }, newCard],
      added: [
        fakeTxn({ id: "b8", accountId: newCard.id, amount: -700, postedDate: "2026-10-08" }),
        fakeTxn({ id: "b10", accountId: newCard.id, amount: -1_000, postedDate: "2026-10-10" }),
        fakeTxn({ id: "b15", accountId: newCard.id, amount: -1_500, postedDate: "2026-10-15" }),
      ],
    });
    await syncConnection(relinked, at("2026-10-20T12:00:00.000Z"));

    expect(await cardRow()).toMatchObject({
      id: cardId,
      connection_id: relinked,
      provider_account_id: "b-card",
      closed_at: null,
      history_split_date: "2026-10-10",
    });
    const card = async () =>
      (await transactionRows())
        .filter((row) => row.account_id === cardId)
        .map((row) => [row.id, row.posted_date, row.hidden_reason]);
    expect(await card()).toEqual([
      ["c1", "2026-10-01", null],
      ["c5", "2026-10-05", null],
      ["b8", "2026-10-08", "replaced by re-link"],
      ["b10", "2026-10-10", null],
      ["c10", "2026-10-10", "replaced by re-link"],
      ["b15", "2026-10-15", null],
    ]);

    // A later sync of the new Connection that brings a day before D hides it too.
    bank.fake.addPages(relinked, {
      added: [fakeTxn({ id: "b9", accountId: newCard.id, amount: -900, postedDate: "2026-10-09" })],
    });
    await syncConnection(relinked, at("2026-10-21T12:00:00.000Z"));

    expect((await card()).find(([id]) => id === "b9")).toEqual([
      "b9",
      "2026-10-09",
      "replaced by re-link",
    ]);
  });
});
