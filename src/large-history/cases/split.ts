import { expect } from "vitest";
import { runFollowUp } from "../../follow-up/index.ts";
import { timedCase } from "../index.ts";

// A Member splits a grocery bill across two Categories, over 5 years of Transactions, then the
// totals, and removing the split again.
timedCase("a split and its removal", async (history, time) => {
  const bills = await history.database.$client.execute(
    `SELECT t.id, t.amount FROM transactions t
     JOIN transaction_parts p ON p.transaction_id = t.id AND p.type = 'Spending'
     WHERE t.description LIKE 'GREEN GROCER%' AND t.hidden_reason IS NULL AND t.amount < -1
     ORDER BY t.id DESC LIMIT 1`,
  );
  const bill = String(bills.rows[0]?.id);
  const spent = -Number(bills.rows[0]?.amount);
  const half = Math.floor(spent / 2);
  const parts = [
    { amount: half, category: "Groceries" },
    { amount: spent - half, category: "General goods" },
  ];

  const split = (await time.request("PUT /api/transactions/:id/split", () =>
    history.browser.send("PUT", `/api/transactions/${bill}/split`, { parts }),
  )) as { decision: { parts: unknown[] } };
  expect(split.decision.parts).toHaveLength(2);
  await time.job("Follow-up after a split", 10_000, () => runFollowUp());
  await time.request("GET /api/totals (with a split)", () => history.browser.get("/api/totals"));

  await time.request("DELETE /api/transactions/:id/split", () =>
    history.browser.send("DELETE", `/api/transactions/${bill}/split`),
  );
  await time.job("Follow-up after removing a split", 10_000, () => runFollowUp());
});
