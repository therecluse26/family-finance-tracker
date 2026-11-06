import { expect } from "vitest";
import { budgetsForMonth, draftFirstBudgets, runMonthStart } from "../../budgets/index.ts";
import { saveHouseholdFacts } from "../../household/index.ts";
import { HISTORY_NOW } from "../history.ts";
import { timedCase } from "../index.ts";

// Groceries and Superstores share one figure, T (spec 05, Shopping: Groceries and Superstores).
// The history has Groceries Spending and no Superstores Spending, so the first draft on the full
// history gives Groceries all of T. Then a few October Groceries parts move to Superstores, as a
// Member's recategorization would. The next Month start gives Superstores its first Budget and
// sets Groceries' to its share of T in the same write.
timedCase("Shared T", async (history, time) => {
  const { database } = history;
  await saveHouseholdFacts(
    database,
    { zipCode: "10001", ages: [40, 38, 7], rentOrOwn: "rent" },
    history.memberId,
    HISTORY_NOW(),
  );
  expect(await draftFirstBudgets(database, HISTORY_NOW())).toBe(true);
  const shared = async (month: string) =>
    (await budgetsForMonth(database, month)).budgets.filter(
      ({ category }) => category === "Groceries" || category === "Superstores",
    );
  expect((await shared("2026-11")).map(({ category }) => category)).toEqual(["Groceries"]);
  await database.$client.execute(
    `UPDATE transaction_parts SET category = 'Superstores' WHERE rowid IN (
       SELECT transaction_parts.rowid FROM transaction_parts
       JOIN transactions ON transactions.id = transaction_parts.transaction_id
       WHERE transaction_parts.category = 'Groceries' AND transactions.posted_date >= '2026-10-01'
       LIMIT 3)`,
  );

  await time.job("Month start that splits T", 10_000, async () => {
    expect(await runMonthStart(database, new Date("2026-12-01T05:10:00.000Z"))).toBe("done");
  });

  const december = await shared("2026-12");
  expect(
    december.map(({ category, source, takesEffect }) => `${category} ${source} ${takesEffect}`),
  ).toEqual(["Groceries formula 2026-12", "Superstores formula 2026-12"]);
  expect(december[1]?.amount).toBeGreaterThan(0);
});
