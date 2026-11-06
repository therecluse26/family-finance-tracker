import { expect } from "vitest";
import { CursorRejectedError, syncConnection } from "../../bank/index.ts";
import { timedCase } from "../index.ts";

const NOW = () => new Date("2026-11-02T14:00:00.000Z");

// A sync after a restore whose saved cursors the provider no longer takes: each Connection starts
// again from an empty cursor, so the whole history comes again and each Transaction is matched to
// its stored row, with none added twice.
timedCase("a sync that starts again from an empty cursor", async (history, time) => {
  const count = async () =>
    Number(
      (await history.database.$client.execute("SELECT count(*) AS n FROM transactions")).rows[0]?.n,
    );
  const before = await count();
  const cursors = await history.database.$client.execute(
    "SELECT bank_id, sync_cursor FROM connections WHERE removed_at IS NULL",
  );
  for (const row of cursors.rows) {
    const bankId = String(row.bank_id);
    const index = Number(String(row.sync_cursor).split(":").at(-1));
    history.fake.failAt(bankId, index, new CursorRejectedError());
  }

  history.fake.calls.length = 0;
  await time.job("Sync from an empty cursor (5 Connections)", 30_000, async () => {
    for (const id of history.connectionIds.values()) await syncConnection(id, NOW);
  });

  const restarts = history.fake.calls.filter((call) => call.cursor === null);
  expect(restarts).toHaveLength(cursors.rows.length);
  expect(await count()).toBe(before);
});
