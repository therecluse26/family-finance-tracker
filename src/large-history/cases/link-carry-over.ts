import { expect } from "vitest";
import { syncConnection, type TxnRecord } from "../../bank/index.ts";
import { addConnection, markConnectionRemoved } from "../../db/index.ts";
import { runFollowUp } from "../../follow-up/index.ts";
import { timedCase } from "../index.ts";

const NOW = () => new Date("2026-11-02T14:00:00.000Z");
// Day D: the removed Connection's last successful sync, a year before the history ends.
const LAST_SYNCED = "2025-11-01T14:00:00.000Z";

// Lakeshore Bank removed and linked again (spec 02, Carrying Accounts over): its checking and
// savings Accounts carry over, a year of old Transactions is hidden as "replaced by re-link", and
// each hand-made link on them moves to its new copy in the follow-up job.
timedCase("a re-link that carries hand-made links over", async (history, time) => {
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

  // The new Connection's history: the same records under new provider IDs.
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
  history.fake.addPages(
    relinked,
    ...bank.pages.map((page) => ({
      ...page,
      accounts: page.accounts?.map((account) => ({ ...account, id: `${account.id}-again` })),
      added: page.added?.map(copy),
      changed: page.changed?.map(copy),
      removed: page.removed?.map((removed) => ({ ...removed, id: `${removed.id}-again` })),
    })),
  );

  await time.job("Sync of a re-linked Connection's full history", 30_000, () =>
    syncConnection(relinked, NOW),
  );
  await time.job("Follow-up after a re-link", 30_000, () => runFollowUp(NOW));

  // Each hand-made link now uses the new copies, and none ended.
  const onOld = await sql.execute({
    sql: `SELECT count(*) AS n FROM transfer_links l JOIN transactions t
            ON t.id IN (l.out_transaction_id, l.in_transaction_id)
          WHERE l.made_by = 'Member' AND t.connection_id = ?`,
    args: [old],
  });
  expect(Number(onOld.rows[0]?.n)).toBe(0);
  expect(await handLinks()).toBe(before);
});
