import { expect } from "vitest";
import { syncConnection, type TxnRecord } from "../../bank/index.ts";
import { addConnection, markConnectionRemoved } from "../../db/index.ts";
import { runFollowUp } from "../../follow-up/index.ts";
import { timedCase } from "../index.ts";

const NOW = () => new Date("2026-11-02T14:00:00.000Z");
// Day D: the removed Connection's last successful sync, a year before the history ends.
const LAST_SYNCED = "2025-11-01T14:00:00.000Z";
// The new Connection brings no copy of an old Transaction posted on or after this date.
const COPIES_END = "2026-05-01";

// Lakeshore Bank removed and linked again (spec 02, Link carry-over): a year of refusals on the
// old Transactions from day D on. The first history load ends in the sync, which ends each refusal
// whose old Transaction got no copy; the follow-up job then moves the rest to the new copies.
timedCase("a re-link that carries refusals over", async (history, time) => {
  const bank = history.generated.banks.find((each) => each.bankId === "fake-lh-lakeshore");
  const old = history.connectionIds.get("fake-lh-lakeshore") ?? "";
  if (bank === undefined) throw new Error("The history has no Lakeshore Bank.");

  // Untimed setup: the Member undid every link on Lakeshore's Transactions from day D on.
  const sql = history.database.$client;
  await sql.execute({
    sql: "UPDATE connections SET last_synced_at = ? WHERE id = ?",
    args: [LAST_SYNCED, old],
  });
  const onLakeshore = `IN (SELECT id FROM transactions WHERE connection_id = ? AND posted_date >= '2025-11-01')`;
  const transfers = `FROM transfer_links
    WHERE out_transaction_id ${onLakeshore} OR in_transaction_id ${onLakeshore}`;
  const spending = `FROM spending_links
    WHERE transaction_id ${onLakeshore} OR spending_transaction_id ${onLakeshore}`;
  await sql.execute({
    sql: `INSERT INTO refused_transfer_links
            (out_transaction_id, in_transaction_id, refused_by, member_id, refused_at)
          SELECT out_transaction_id, in_transaction_id, 'Member', ?, ? ${transfers}`,
    args: [history.memberId, NOW().toISOString(), old, old],
  });
  await sql.execute({
    sql: `INSERT INTO refused_links (kind, transaction_id, other_id, refused_by, member_id, refused_at)
          SELECT kind, transaction_id, spending_transaction_id, 'Member', ?, ? ${spending}`,
    args: [history.memberId, NOW().toISOString(), old, old],
  });
  await sql.execute({ sql: `DELETE ${transfers}`, args: [old, old] });
  await sql.execute({ sql: `DELETE ${spending}`, args: [old, old] });
  const refusalsOn = async (connectionId: string) =>
    Number(
      (
        await sql.execute({
          sql: `SELECT
                  (SELECT count(*) FROM refused_transfer_links
                   WHERE out_transaction_id IN (SELECT id FROM transactions WHERE connection_id = ?1)
                      OR in_transaction_id IN (SELECT id FROM transactions WHERE connection_id = ?1))
                + (SELECT count(*) FROM refused_links
                   WHERE transaction_id IN (SELECT id FROM transactions WHERE connection_id = ?1)
                      OR other_id IN (SELECT id FROM transactions WHERE connection_id = ?1)) AS n`,
          args: [connectionId],
        })
      ).rows[0]?.n,
    );
  const before = await refusalsOn(old);
  expect(before).toBeGreaterThan(100);
  expect(await markConnectionRemoved(history.database, old)).toMatchObject({ removed: true });

  // The new Connection's history: the same records under new provider IDs, up to COPIES_END.
  const relinked = await addConnection(history.database, {
    provider: "fake",
    bankId: bank.bankId,
    bankName: bank.bankName,
    origin: "linked",
    syncMinute: 17,
  });
  const copy = (txn: TxnRecord): TxnRecord => ({
    ...txn,
    id: `${txn.id}-again`,
    accountId: `${txn.accountId}-again`,
  });
  const copied = (txns: TxnRecord[] | undefined) =>
    txns?.filter((txn) => txn.postedDate < COPIES_END).map(copy);
  history.fake.addPages(
    relinked,
    ...bank.pages.map((page) => ({
      ...page,
      accounts: page.accounts?.map((account) => ({ ...account, id: `${account.id}-again` })),
      added: copied(page.added),
      changed: copied(page.changed),
      removed: page.removed?.map((removed) => ({ ...removed, id: `${removed.id}-again` })),
    })),
  );

  await time.job(
    "Sync of a re-linked Connection's history, ending refusals with no copy",
    30_000,
    () => syncConnection(relinked, NOW),
  );
  await time.job("Follow-up that moves refusals to the copies", 30_000, () => runFollowUp(NOW));

  // Each refusal on an old Transaction from day D on moved to its copy or ended.
  const leftOnOld = await sql.execute({
    sql: `SELECT count(*) AS n FROM refused_links r JOIN transactions t
            ON t.id IN (r.transaction_id, r.other_id)
          WHERE t.connection_id = ? AND t.posted_date >= '2025-11-01'`,
    args: [old],
  });
  expect(Number(leftOnOld.rows[0]?.n)).toBe(0);
  // Those with copies moved, and those without ended.
  const moved = await refusalsOn(relinked);
  expect(moved).toBeGreaterThan(0);
  expect(moved).toBeLessThan(before);
});
