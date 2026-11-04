import { expect } from "vitest";
import { runFollowUp } from "../../follow-up/index.ts";
import { timedCase } from "../index.ts";

// The Transactions page's reads, and a hand-set type with the follow-up job it starts.
timedCase("the Transactions page", async (history, time) => {
  await time.request("GET /api/accounts", () => history.browser.get("/api/accounts"));
  const { transactions } = (await time.request("GET /api/transactions (all)", () =>
    history.browser.get("/api/transactions"),
  )) as { transactions: { id: string; description: string }[] };
  expect(transactions.length).toBeGreaterThan(19_000);

  const checking = history.connectionIds.get("fake-lh-lakeshore");
  const accounts = await history.database.$client.execute({
    sql: "SELECT id FROM household_accounts WHERE connection_id = ? ORDER BY name",
    args: [checking ?? ""],
  });
  const account = String(accounts.rows[0]?.id);
  await time.request("GET /api/transactions?account=&from=&to= (one Account, one month)", () =>
    history.browser.get(`/api/transactions?account=${account}&from=2026-09-01&to=2026-09-30`),
  );

  const meal = transactions.find((txn) => txn.description === "NOODLE HOUSE #12");
  if (meal === undefined) throw new Error("The history has no Noodle House meal.");
  await time.request("GET /api/transactions/:id", () =>
    history.browser.get(`/api/transactions/${meal.id}`),
  );
  await time.request("PUT /api/transactions/:id/type", () =>
    history.browser.send("PUT", `/api/transactions/${meal.id}/type`, { type: "Transfer" }),
  );
  await time.job("Follow-up after a hand-set type", 10_000, () => runFollowUp());
});
