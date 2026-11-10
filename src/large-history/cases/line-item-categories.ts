import { expect } from "vitest";
import { followUpAgain, runFollowUp } from "../../follow-up/index.ts";
import { addTestLineItems, type TestLineItem } from "../../line-items/testing.ts";
import type { ItemRuleView } from "../../server/line-item-category-views.ts";
import { timedCase } from "../index.ts";

// 20,000 made-up Line items over five years, 2,000 Spending Transactions split by them (spec 14,
// Splits from Line items), then the Transactions page and the reports with those parts, a Line
// item Category change whose Item rule covers 1,000 Line items, and deleting the rule.

const ITEMS = 20_000;
const LINKED = 2_000;
const CATEGORIES = ["Groceries", "Home and garden", "Pets", "Hobbies", "Clothing"] as const;

timedCase("20,000 Line items with their Categories and splits", async (history, time) => {
  const bought = await history.database.$client.execute({
    sql: `SELECT t.id, t.amount FROM transactions t
     JOIN transaction_parts p ON p.transaction_id = t.id AND p.type = 'Spending'
       AND p.keeps_category = 0 AND p.linked = 0 AND p.category_source IS NOT 'hand-set'
     WHERE t.hidden_reason IS NULL AND t.amount < -300 AND t.hand_set = '{}'
       AND (SELECT count(*) FROM transaction_parts o WHERE o.transaction_id = t.id) = 1
     ORDER BY t.id LIMIT ?`,
    args: [LINKED],
  });
  expect(bought.rows).toHaveLength(LINKED);
  const linked = bought.rows.map((row) => ({ id: String(row.id), amount: -Number(row.amount) }));

  // Each linked Transaction has 2 Line items of different Categories; the rest have none. One
  // product in 20 is the paper towels, so 1,000 Line items share it.
  const items: TestLineItem[] = Array.from({ length: ITEMS }, (_, index) => {
    const transaction = index < LINKED * 2 ? linked[Math.floor(index / 2)] : undefined;
    const towels = index % 20 === 0;
    return {
      id: `lh-item-${String(index).padStart(5, "0")}`,
      name: towels ? "Paper towels, 12 rolls" : `Made-up product ${index % 4_000}`,
      productId: towels ? "B000000012" : `B${String(100 + (index % 4_000)).padStart(9, "0")}`,
      total: transaction === undefined ? 1_000 + (index % 500) : Math.ceil(transaction.amount / 2),
      orderId: `111-${String(Math.floor(index / 3)).padStart(7, "0")}-0000001`,
      transactionId: transaction?.id ?? null,
      // Hand links: these made-up Transactions are not Amazon charges, so the app's linking step
      // would end app links whose amounts do not match.
      linkKind: "hand",
      category: CATEGORIES[index % CATEGORIES.length],
      categorySource: "AI",
      categoryConfidence: "high",
    };
  });
  await addTestLineItems(history.database, items);
  await followUpAgain(
    history.database,
    linked.map((txn) => txn.id),
  );

  await time.job("Follow-up: 2,000 Transactions split by their Line items", 10_000, () =>
    runFollowUp(),
  );
  const split = await history.database.$client.execute(
    "SELECT count(DISTINCT transaction_id) AS n FROM transaction_parts WHERE category_source = 'Line items'",
  );
  expect(Number(split.rows[0]?.n)).toBe(LINKED);

  await time.request("GET /api/transactions?limit=100 (2,000 split by Line items)", () =>
    history.browser.get("/api/transactions?limit=100"),
  );
  await time.request("GET /api/transactions (all, 2,000 split by Line items)", () =>
    history.browser.get("/api/transactions"),
  );
  await time.request("GET /api/reports/spending?range=all (with Line item parts)", () =>
    history.browser.get("/api/reports/spending?range=all"),
  );
  await time.request("GET /api/totals (with Line item parts)", () =>
    history.browser.get("/api/totals"),
  );

  // A Member's change makes the paper towels' Item rule, which covers its 1,000 Line items.
  await time.request("PUT /api/line-items/:id/category (an Item rule over 1,000 Line items)", () =>
    history.browser.send("PUT", "/api/line-items/lh-item-00000/category", {
      category: "Home and garden",
      onlyThisItem: false,
    }),
  );
  await time.job("Follow-up after an Item rule", 10_000, () => runFollowUp());
  const ruled = await history.database.$client.execute(
    "SELECT count(*) AS n FROM line_items WHERE product_id = 'B000000012' AND category = 'Home and garden'",
  );
  expect(Number(ruled.rows[0]?.n)).toBe(ITEMS / 20);

  const { rules } = (await time.request("GET /api/item-rules", () =>
    history.browser.get("/api/item-rules"),
  )) as { rules: ItemRuleView[] };
  expect(rules).toHaveLength(1);
  await time.request("DELETE /api/item-rules/:id (1,000 Line items go down the steps again)", () =>
    history.browser.send("DELETE", `/api/item-rules/${rules[0]?.id}`),
  );
  await time.job("Follow-up after deleting an Item rule", 10_000, () => runFollowUp());
});
