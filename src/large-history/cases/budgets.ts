import { expect } from "vitest";
import { draftFirstBudgets } from "../../budgets/index.ts";
import type { BudgetsView } from "../../server/budgets-views.ts";
import { HISTORY_NOW } from "../history.ts";
import { timedCase } from "../index.ts";

// The first Budget draft, the First run step, over the full history, then the month's Budgets.
timedCase("Budget draft", async (history, time) => {
  await time.job("First Budget draft on the full history", 10_000, async () => {
    expect(await draftFirstBudgets(history.database, HISTORY_NOW())).toBe(true);
  });

  const { budgets } = (await time.request("GET /api/budgets?month=", () =>
    history.browser.get("/api/budgets?month=2026-11"),
  )) as BudgetsView;
  expect(budgets.length).toBeGreaterThan(5);
});
