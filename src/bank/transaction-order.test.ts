import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listTransactionPage, listTransactions, searchTransactions } from "../db/index.ts";
import { fakeAccount, fakeTxn } from "./fake.ts";
import { syncConnection } from "./index.ts";
import { newTestBank, type TestBank } from "./testing.ts";

// The Transactions list, its pages, and its search run newest first by the date each row shows:
// the purchase date when the bank gives one, else the posted date. Ties run by the posted date,
// newest first, then by ID (spec 07, Transactions page). Transactions come from the fake adapter.

const BANK = "fake-first-bank";
const CHECKING = fakeAccount({ id: "acc-checking", name: "Everyday Checking" });

const txn = (id: string, postedDate: string, authorizedDate: string | null, pending = false) =>
  fakeTxn({ id, accountId: CHECKING.id, amount: -1_000, postedDate, authorizedDate, pending });

describe("the order of the Transactions list", () => {
  let bank: TestBank;
  // Provider IDs by Transaction ID.
  let providerIds: Map<string, string>;

  beforeEach(async () => {
    bank = await newTestBank();
    const connectionId = await bank.connect(BANK);
    bank.fake.addPages(BANK, {
      accounts: [CHECKING],
      added: [
        // Bought on Nov 1 and posted last, so the posted date would run it first.
        txn("late-post", "2026-11-05", "2026-11-01"),
        txn("pending", "2026-11-04", "2026-11-04", true),
        txn("plain", "2026-11-03", null),
        // The same purchase date: the later posted date runs first.
        txn("tie-a", "2026-11-03", "2026-11-02"),
        txn("tie-b", "2026-11-04", "2026-11-02"),
        // The same dates: the ID decides.
        txn("same-c", "2026-10-30", null),
        txn("same-d", "2026-10-30", null),
      ],
    });
    await syncConnection(connectionId, () => new Date("2026-11-05T12:00:00.000Z"));
    const rows = await bank.database.$client.execute(
      "SELECT id, provider_transaction_id FROM transactions",
    );
    providerIds = new Map(
      rows.rows.map((row) => [String(row.id), String(row.provider_transaction_id)]),
    );
  });

  afterEach(() => {
    bank.close();
  });

  const named = (rows: readonly { id: string }[]) => rows.map((row) => providerIds.get(row.id));

  // The two with the same dates run by their app IDs.
  const expected = () => {
    const same = [...providerIds.entries()]
      .filter(([, provider]) => provider.startsWith("same-"))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([, provider]) => provider);
    return ["pending", "plain", "tie-b", "tie-a", "late-post", ...same];
  };

  it("lists newest first by the date each row shows, then by posted date, then by ID", async () => {
    expect(named(await listTransactions(bank.database))).toEqual(expected());
  });

  it("reads the same order page by page", async () => {
    const seen: { id: string }[] = [];
    let after: string | undefined;
    for (let pages = 0; pages < 10; pages += 1) {
      const page = await listTransactionPage(
        bank.database,
        {},
        after === undefined ? { limit: 2 } : { limit: 2, after },
      );
      if (page === undefined) throw new Error("The anchor is gone.");
      seen.push(...page.transactions);
      if (page.next === null) break;
      after = page.next;
    }

    expect(named(seen)).toEqual(expected());
  });

  it("finds Transactions in the same order, each with the date its row shows", async () => {
    const found = await searchTransactions(bank.database, {}, 50);

    expect(named(found.transactions)).toEqual(expected());
    expect(found.transactions.slice(0, 5).map((row) => row.shownDate)).toEqual([
      "2026-11-04",
      "2026-11-03",
      "2026-11-02",
      "2026-11-02",
      "2026-11-01",
    ]);
  });
});
