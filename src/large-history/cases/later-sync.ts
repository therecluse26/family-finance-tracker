import { expect } from "vitest";
import { syncConnection } from "../../bank/index.ts";
import { runFollowUp } from "../../follow-up/index.ts";
import { timedCase } from "../index.ts";

const NOW = () => new Date("2026-11-02T14:00:00.000Z");

// A scheduled sync on top of the full history: one more day on each Connection, with a provider
// change and a removal, then the follow-up job (Matching, then Categorization) it starts.
timedCase("a later sync, and its follow-up", async (history, time) => {
  for (const bank of history.generated.banks) {
    history.fake.addPages(bank.bankId, bank.laterPage);
  }
  await time.job("Sync of one more day (5 Connections)", 5_000, async () => {
    for (const id of history.connectionIds.values()) await syncConnection(id, NOW);
  });
  await time.job("Follow-up after one more day", 10_000, () => runFollowUp(NOW));

  const later = await history.database.$client.execute(
    "SELECT count(*) AS n FROM transactions WHERE provider_transaction_id LIKE 'lh-later-%'",
  );
  expect(Number(later.rows[0]?.n)).toBeGreaterThan(0);
});
