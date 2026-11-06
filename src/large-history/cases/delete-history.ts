import { expect } from "vitest";
import { markConnectionRemoved } from "../../db/index.ts";
import { runFollowUp } from "../../follow-up/index.ts";
import { timedCase } from "../index.ts";

// Delete history for a removed Connection: the Harbor card, with 5 years of charges and payments,
// then the follow-up job that decides the checking side of its card payments again.
timedCase("deleting a removed Connection's history", async (history, time) => {
  // Removing a Connection asks for a code and the provider; this case times only Delete history.
  const harbor = history.connectionIds.get("fake-lh-harbor") ?? "";
  expect(await markConnectionRemoved(history.database, harbor)).toMatchObject({ removed: true });

  const deleted = (await time.request("POST /api/connections/:id/delete-history", () =>
    history.browser.post(`/api/connections/${harbor}/delete-history`, { confirmed: true }),
  )) as { transactions: number };
  expect(deleted.transactions).toBeGreaterThan(1_000);
  await time.job("Follow-up after Delete history", 10_000, () => runFollowUp());
});
