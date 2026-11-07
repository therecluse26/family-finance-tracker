import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { addReviewItem } from "../db/index.ts";
import { PAIR_GUESS_KIND, startMoneyMovement, UNCLEAR_PAIR_KIND } from "../money-movement/index.ts";
import { reviewRoutes } from "./review.ts";

// Transfer pair guesses between the same two Accounts show as one group, for display only, and the
// count counts a group once (spec 07, Review list page): the group the page reads and the count
// the main menu reads agree.

const NOW = () => new Date("2026-11-20T14:00:00.000Z");
const BANK = "fake-first-bank";
const ACCOUNTS = ["checking", "savings", "brokerage"].map((id) => fakeAccount({ id }));

describe("the Review list's groups", () => {
  let bank: TestBank;
  let stop: () => void;
  const ids = new Map<string, string>();

  beforeEach(async () => {
    bank = await newTestBank();
    stop = startMoneyMovement({ database: bank.database }).stop;
    const connectionId = await bank.connect(BANK);
    const moves: [string, string][] = [
      ["a", "checking"],
      ["b", "savings"],
      ["c", "savings"],
      ["d", "checking"],
      ["e", "checking"],
      ["f", "brokerage"],
      ["g", "checking"],
      ["h", "savings"],
    ];
    bank.fake.addPages(BANK, {
      accounts: ACCOUNTS,
      added: moves.map(([id, accountId], i) =>
        fakeTxn({ id, accountId, amount: i % 2 === 0 ? -5_000 : 5_000, postedDate: "2026-11-02" }),
      ),
      historyLoaded: true,
    });
    await syncConnection(connectionId, NOW);
    const rows = await bank.database.$client.execute(
      "SELECT id, provider_transaction_id FROM transactions",
    );
    ids.clear();
    for (const row of rows.rows) ids.set(String(row.provider_transaction_id), String(row.id));
  });

  afterEach(() => {
    stop();
    bank.close();
  });

  const pair = (kind: string, out: string, into: string) =>
    addReviewItem(
      bank.database,
      {
        kind,
        subjectType: "transactions",
        subjectIds: [ids.get(out) ?? "", ids.get(into) ?? ""],
        decided: "The app paired them.",
        bestAnswer: { value: "link", label: "Yes, it is a Transfer" },
      },
      NOW(),
    );

  it("groups pair guesses by their two Accounts in either order, and counts each group once", async () => {
    const ab = await pair(PAIR_GUESS_KIND, "a", "b");
    const dc = await pair(PAIR_GUESS_KIND, "c", "d");
    const ef = await pair(PAIR_GUESS_KIND, "e", "f");
    // Another kind between the same two Accounts shows alone.
    const unclear = await pair(UNCLEAR_PAIR_KIND, "g", "h");
    const routes = reviewRoutes(bank.database);

    const groups = new Map((await routes.open()).map((item) => [item.id, item.group]));
    expect(groups.get(ab)).not.toBeNull();
    expect(groups.get(dc)).toBe(groups.get(ab));
    expect(groups.get(ef)).not.toBeNull();
    expect(groups.get(ef)).not.toBe(groups.get(ab));
    expect(groups.get(unclear)).toBeNull();
    expect(await routes.count()).toBe(3);

    // A pair with a side that no longer shows is not grouped, on the page or in the count.
    await bank.database.$client.execute({
      sql: "UPDATE transactions SET hidden_reason = 'removed' WHERE id = ?",
      args: [ids.get("c") ?? ""],
    });
    const after = new Map((await routes.open()).map((item) => [item.id, item.group]));
    expect(after.get(dc)).toBeNull();
    expect(await routes.count()).toBe(4);
  });
});
