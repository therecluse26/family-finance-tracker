import { expect } from "vitest";
import { draftFirstBudgets } from "../../budgets/index.ts";
import type { NumberTilesView } from "../../server/bank-views.ts";
import type { UsualMonthView } from "../../server/budgets-views.ts";
import { HISTORY_NOW } from "../history.ts";
import { timedCase } from "../index.ts";

// The dashboard's number tiles and "A usual month" over the full history, with a Manual loan in
// the Debt and the Budgets of the first draft.
timedCase("the dashboard's number tiles and A usual month", async (history, time) => {
  const added = await history.browser.post("/api/manual-loans", {
    lender: "Lakeside Credit",
    kind: "personal",
    balance: 1_500_000,
    balanceDate: "2021-11-01",
    apr: 9.5,
    regularPayment: 30_000,
    escrow: null,
    loanType: null,
  });
  expect(added.status).toBe(200);
  expect(await draftFirstBudgets(history.database, HISTORY_NOW())).toBe(true);

  const tiles = (await time.request("GET /api/number-tiles", () =>
    history.browser.get("/api/number-tiles"),
  )) as NumberTilesView;
  expect(tiles.spending.trend).toHaveLength(12);
  expect(tiles.debt.estimatedLoans).toBe(1);

  const usual = (await time.request("GET /api/usual-month?month=", () =>
    history.browser.get("/api/usual-month?month=2026-11"),
  )) as UsualMonthView;
  expect(usual.usual).not.toBeNull();
  expect(usual.groups[0]?.bars).toHaveLength(13);
});
