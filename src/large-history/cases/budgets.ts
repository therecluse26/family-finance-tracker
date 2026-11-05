import { expect } from "vitest";
import { draftFirstBudgets, followBills, runMonthStart } from "../../budgets/index.ts";
import { saveHouseholdFacts } from "../../household/index.ts";
import type { BudgetsView } from "../../server/budgets-views.ts";
import { HISTORY_NOW } from "../history.ts";
import { timedCase } from "../index.ts";

// The first Budget draft, the First run step, over the full history, then the month's Budgets, the
// Bills Budgets follow-up step, the next Month start, and a Member's changes. The Household facts
// are recorded, so the month's Budgets read each Bills Budget's Benchmark context too.
timedCase("Budget draft", async (history, time) => {
  await saveHouseholdFacts(
    history.database,
    { zipCode: "10001", ages: [40, 38, 7], rentOrOwn: "rent" },
    history.memberId,
    HISTORY_NOW(),
  );
  await time.job("First Budget draft on the full history", 10_000, async () => {
    expect(await draftFirstBudgets(history.database, HISTORY_NOW())).toBe(true);
  });

  const { budgets } = (await time.request("GET /api/budgets?month=", () =>
    history.browser.get("/api/budgets?month=2026-11"),
  )) as BudgetsView;
  expect(budgets.length).toBeGreaterThan(5);
  expect(budgets.some((budget) => budget.context !== null)).toBe(true);

  await time.job("Bills Budgets follow-up step after the first draft", 5_000, () =>
    followBills(history.database, HISTORY_NOW()),
  );
  await time.job("Month start on the full history", 10_000, async () => {
    expect(await runMonthStart(history.database, new Date("2026-12-01T05:10:00.000Z"))).toBe(
      "done",
    );
  });

  const bills = budgets.find((budget) => budget.categoryGroup === "Bills");
  expect(bills).toBeDefined();
  const path = `/api/budgets/${encodeURIComponent(bills?.category ?? "")}`;
  await time.request("PUT /api/budgets/:category", () =>
    history.browser.send("PUT", path, { amount: 12_300 }),
  );
  await time.request("POST /api/budgets/:category/follow-the-bill", () =>
    history.browser.send("POST", `${path}/follow-the-bill`, {}),
  );
  await time.request("POST /api/budgets/accept-all", () =>
    history.browser.send("POST", "/api/budgets/accept-all", {}),
  );
});
