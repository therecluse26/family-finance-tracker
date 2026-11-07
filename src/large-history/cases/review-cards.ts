import { expect } from "vitest";
import { categorize } from "../../categorization/index.ts";
import { updateCategoryCards } from "../../categorization/review-cards.ts";
import { runFollowUp } from "../../follow-up/index.ts";
import type { ReviewItemView } from "../../server/review-views.ts";
import { timedCase } from "../index.ts";

const CATEGORY_KINDS = new Set(["best guess made without AI", "Category the AI was unsure of"]);

// The Category cards on the Review list (spec 04, Review list items): "Change" on one row of the
// largest card, which sets that Transaction alone and takes it off the card at once, then the
// follow-up job it starts. Then the cards from items made one per Transaction, as before cards:
// the first Categorization run groups them, and a second finds nothing to change. Last, "Yes" on
// the largest card five years can make: every Spending Transaction of the Merchant with the most,
// each a best guess, as with no AI.
timedCase("Category cards on the Review list", async (history, time) => {
  const opened = await history.browser.get("/api/review-list");
  const { items } = (await opened.json()) as { items: ReviewItemView[] };
  const card = items
    .filter((item) => CATEGORY_KINDS.has(item.kind))
    .sort((a, b) => b.transactions.length - a.transactions.length)[0];
  const row = card?.transactions[0];
  expect(card?.transactions.length).toBeGreaterThan(1);

  await time.request("PUT /api/transactions/:id/category (a card's row, only this)", () =>
    history.browser.send("PUT", `/api/transactions/${row?.id}/category`, {
      category: "Hobbies",
      onlyThisTransaction: true,
    }),
  );
  const after = (await time.request("GET /api/review-list (after a row's change)", () =>
    history.browser.get("/api/review-list"),
  )) as { items: ReviewItemView[] };
  const left = after.items.find((item) => item.id === card?.id);
  expect(left?.transactions.map((txn) => txn.id)).not.toContain(row?.id);
  await time.job("Follow-up after a row's change", 10_000, () => runFollowUp());

  // Every open card's Transactions as items of one Transaction each, as before cards.
  const client = history.database.$client;
  const open = await client.execute(
    `SELECT id, kind, subject_ids, decided, best_answer, created_at FROM review_items
     WHERE closed_at IS NULL AND kind IN ('best guess made without AI', 'Category the AI was unsure of')`,
  );
  let before = 0;
  for (const item of open.rows) {
    for (const id of JSON.parse(String(item.subject_ids)) as string[]) {
      before += 1;
      await client.execute({
        sql: `INSERT INTO review_items (id, kind, subject_type, subject_ids, decided, best_answer, created_at)
              VALUES (?, ?, 'transactions', ?, ?, ?, ?)`,
        args: [
          crypto.randomUUID(),
          String(item.kind),
          JSON.stringify([id]),
          String(item.decided),
          String(item.best_answer),
          String(item.created_at),
        ],
      });
    }
  }
  await client.execute({
    sql: `UPDATE review_items SET closed_at = created_at, closed_reason = 'test'
          WHERE id IN (${open.rows.map(() => "?").join(", ")})`,
    args: open.rows.map((item) => String(item.id)),
  });
  expect(before).toBeGreaterThan(open.rows.length);

  await time.job(`Grouping ${before} items from before cards`, 3_000, () =>
    categorize(history.database, []),
  );
  await time.job("Categorization with the cards grouped", 1_000, () =>
    categorize(history.database, []),
  );
  const grouped = await client.execute(
    `SELECT count(*) AS n FROM review_items
     WHERE closed_at IS NULL AND kind IN ('best guess made without AI', 'Category the AI was unsure of')`,
  );
  expect(Number(grouped.rows[0]?.n)).toBe(open.rows.length);

  // Every Spending Transaction of the Merchant with the most, a best guess.
  const top = await client.execute(
    `SELECT t.merchant_clean_name AS name, count(*) AS n FROM transactions t
     JOIN transaction_parts p ON p.transaction_id = t.id
     WHERE t.hidden_reason IS NULL AND p.type = 'Spending' AND t.merchant_clean_name IS NOT NULL
       AND t.hand_set = '{}'
     GROUP BY t.merchant_clean_name ORDER BY n DESC LIMIT 1`,
  );
  const name = String(top.rows[0]?.name);
  const largest = await client.execute({
    sql: `SELECT DISTINCT t.id FROM transactions t JOIN transaction_parts p ON p.transaction_id = t.id
          WHERE t.hidden_reason IS NULL AND p.type = 'Spending' AND t.merchant_clean_name = ?
            AND t.hand_set = '{}'`,
    args: [name],
  });
  const ids = largest.rows.map((row) => String(row.id));
  await client.execute({
    sql: `UPDATE transaction_parts SET category_source = 'best guess', category_confidence = NULL
          WHERE type = 'Spending' AND transaction_id IN (
            SELECT id FROM transactions WHERE hidden_reason IS NULL AND merchant_clean_name = ?
              AND hand_set = '{}')`,
    args: [name],
  });
  await updateCategoryCards(history.database, ids);
  const cards = (await (await history.browser.get("/api/review-list")).json()) as {
    items: ReviewItemView[];
  };
  const big = cards.items
    .filter((item) => CATEGORY_KINDS.has(item.kind))
    .sort((a, b) => b.transactions.length - a.transactions.length)[0];
  expect(big?.transactions.length).toBeGreaterThan(100);
  await time.request(
    `POST /api/review-list/:id/answer (a card of ${big?.transactions.length} Transactions)`,
    () =>
      history.browser.post(`/api/review-list/${big?.id}/answer`, {
        value: big?.bestAnswer.value,
      }),
  );
  await time.job("Follow-up after answering the largest card", 10_000, () => runFollowUp());
  const handSet = await client.execute({
    sql: `SELECT count(*) AS n FROM transactions WHERE json_extract(hand_set, '$.category') = ?
          AND id IN (${big?.transactions.map(() => "?").join(", ")})`,
    args: [String(big?.bestAnswer.value), ...(big?.transactions.map((txn) => txn.id) ?? [])],
  });
  expect(Number(handSet.rows[0]?.n)).toBe(big?.transactions.length);
});
