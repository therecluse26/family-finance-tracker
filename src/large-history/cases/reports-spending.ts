import { expect } from "vitest";
import { draftFirstBudgets } from "../../budgets/index.ts";
import type { CashFlowReportView, SpendingReportView } from "../../server/reports-views.ts";
import { HISTORY_NOW } from "../history.ts";
import { timedCase } from "../index.ts";

// Spending over time and Cash flow on the Reports page over the full history, with the first
// Budget draft stored, so each month's Budget line is read too.
timedCase("Spending over time and Cash flow reports", async (history, time) => {
  expect(await draftFirstBudgets(history.database, HISTORY_NOW())).toBe(true);

  const all = (await time.request("GET /api/reports/spending?range=all", () =>
    history.browser.get("/api/reports/spending?range=all"),
  )) as SpendingReportView;
  expect(all.bars.length).toBeGreaterThanOrEqual(60);
  expect(all.bars.some((bar) => bar.budget !== null)).toBe(true);

  const group = (await time.request("GET /api/reports/spending?range=all&group=", () =>
    history.browser.get("/api/reports/spending?range=all&group=Shopping"),
  )) as SpendingReportView;
  expect(group.segments).toContain("Groceries");
  expect(group.bars.length).toBe(all.bars.length);

  const cashFlow = (await time.request("GET /api/reports/cash-flow?range=all", () =>
    history.browser.get("/api/reports/cash-flow?range=all"),
  )) as CashFlowReportView;
  expect(cashFlow.bars.length).toBe(all.bars.length);
  expect(cashFlow.total.income).toBeGreaterThan(0);
});
