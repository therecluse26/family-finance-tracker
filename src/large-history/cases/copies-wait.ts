import { expect } from "vitest";
import { connectionRemoving, endLongCopyWaits, syncConnection } from "../../bank/index.ts";
import { COPIES_WAIT_CAP_DAYS } from "../../bank/sync-times.ts";
import { addConnection, markConnectionRemoved } from "../../db/index.ts";
import { runFollowUp } from "../../follow-up/index.ts";
import { timedCase } from "../index.ts";

const NOW = () => new Date("2026-11-02T14:00:00.000Z");
const CAP = () => new Date(NOW().getTime() + COPIES_WAIT_CAP_DAYS * 24 * 60 * 60 * 1000);
// Day D: the removed Connection's last successful sync, a year before the history ends.
const LAST_SYNCED = "2025-11-01T14:00:00.000Z";

// Lakeshore Bank removed and linked again, but the new Connection's first history load never ends
// (spec 02, Link carry-over): its first page carries the Accounts over and brings no Transactions,
// then it stays Broken. A year of hand-made links waits for copies until the cap, then ends in the
// follow-up job. Then the Member removes the new Connection.
timedCase("a re-link whose history never loads", async (history, time) => {
  const bank = history.generated.banks.find((each) => each.bankId === "fake-lh-lakeshore");
  const old = history.connectionIds.get("fake-lh-lakeshore") ?? "";
  if (bank === undefined) throw new Error("The history has no Lakeshore Bank.");

  // Untimed setup: every link on Lakeshore's Transactions from day D on was made by the Member.
  const sql = history.database.$client;
  await sql.execute({
    sql: "UPDATE connections SET last_synced_at = ? WHERE id = ?",
    args: [LAST_SYNCED, old],
  });
  const onLakeshore = `IN (SELECT id FROM transactions WHERE connection_id = ? AND posted_date >= '2025-11-01')`;
  for (const [table, columns] of [
    ["transfer_links", ["out_transaction_id", "in_transaction_id"]],
    ["spending_links", ["transaction_id", "spending_transaction_id"]],
  ] as const) {
    await sql.execute({
      sql: `UPDATE ${table} SET made_by = 'Member', member_id = ?
            WHERE ${columns[0]} ${onLakeshore} OR ${columns[1]} ${onLakeshore}`,
      args: [history.memberId, old, old],
    });
  }
  const handLinks = async () =>
    Number(
      (
        await sql.execute({
          sql: `SELECT (SELECT count(*) FROM transfer_links WHERE made_by = 'Member')
                  + (SELECT count(*) FROM spending_links WHERE made_by = 'Member') AS n`,
          args: [],
        })
      ).rows[0]?.n,
    );
  const before = await handLinks();
  expect(before).toBeGreaterThan(100);
  expect(await markConnectionRemoved(history.database, old)).toMatchObject({ removed: true });

  const relinked = await addConnection(history.database, {
    provider: "fake",
    bankId: bank.bankId,
    bankName: bank.bankName,
    origin: "linked",
    syncMinute: 17,
  });
  const accounts = bank.pages.flatMap((page) => page.accounts ?? []);
  history.fake.addPages(relinked, {
    accounts: accounts.map((account) => ({ ...account, id: `${account.id}-again` })),
  });
  await syncConnection(relinked, NOW);
  await runFollowUp(NOW);
  await sql.execute({
    sql: "UPDATE connections SET health = 'broken' WHERE id = ?",
    args: [relinked],
  });
  expect(await handLinks()).toBe(before);

  expect(
    await time.job("Sync schedule's end of a wait for copies past the cap", 5_000, () =>
      endLongCopyWaits(CAP()),
    ),
  ).toBe("ended");
  await time.job("Follow-up after a wait for copies ends", 30_000, () => runFollowUp(CAP));
  const left = await handLinks();
  expect(left).toBeLessThan(before);

  // Remove asks for a code first; this times the removal itself.
  expect(
    await time.job("Remove of a re-linked Connection (without the code check)", 1_000, () =>
      connectionRemoving().remove(relinked),
    ),
  ).toEqual({ outcome: "removed" });
  expect(await handLinks()).toBe(left);
});
