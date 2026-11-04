import { expect } from "vitest";
import { runFollowUp } from "../../follow-up/index.ts";
import type { CategoryCorrectionView, CategoryRuleView } from "../../server/category-views.ts";
import { timedCase } from "../index.ts";

// A Member's Category for a grocery bill, which makes a Category rule for its Merchant over 5 years
// of its Transactions, then Settings → Categories, and deleting the rule again.
timedCase("a Category correction and its rule", async (history, time) => {
  const bills = await history.database.$client.execute(
    "SELECT id FROM transactions WHERE description LIKE 'GREEN GROCER%' AND hidden_reason IS NULL " +
      "ORDER BY id DESC LIMIT 1",
  );
  const bill = String(bills.rows[0]?.id);

  const corrected = (await time.request("PUT /api/transactions/:id/category", () =>
    history.browser.send("PUT", `/api/transactions/${bill}/category`, { category: "Restaurants" }),
  )) as CategoryCorrectionView;
  expect(corrected.rule).not.toBeNull();
  await time.job("Follow-up after a Category correction", 10_000, () => runFollowUp());

  const { rules } = (await time.request("GET /api/category-rules", () =>
    history.browser.get("/api/category-rules"),
  )) as { rules: CategoryRuleView[] };
  expect(rules.map((rule) => rule.id)).toContain(corrected.rule?.id);
  await time.request("DELETE /api/category-rules/:id", () =>
    history.browser.send("DELETE", `/api/category-rules/${corrected.rule?.id}`),
  );
  await time.job("Follow-up after deleting a Category rule", 10_000, () => runFollowUp());
});
