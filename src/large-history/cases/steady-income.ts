import { expect } from "vitest";
import { findIncomeSeries, findRecurringCharges } from "../../recurring/index.ts";
import { HISTORY_NOW } from "../history.ts";
import { timedCase } from "../index.ts";

// Steady Income and the predicted paydays, which work out each monthly series' fixed day from its
// history on each read (spec 06, Monthly series), and the checks step's two finds run again on
// the full history.
timedCase("Steady Income and paydays", async (history, time) => {
  const { steadyIncome } = (await time.request("GET /api/steady-income", () =>
    history.browser.get("/api/steady-income"),
  )) as { steadyIncome: { detected: number } };
  expect(steadyIncome.detected).toBeGreaterThan(0);
  const { paydays } = (await time.request("GET /api/paydays", () =>
    history.browser.get("/api/paydays"),
  )) as { paydays: unknown[] };
  expect(paydays.length).toBeGreaterThan(0);

  await time.job("Recurring charges found again on the full history", 10_000, () =>
    findRecurringCharges(history.database, HISTORY_NOW()),
  );
  await time.job("Income series found again on the full history", 5_000, () =>
    findIncomeSeries(history.database, HISTORY_NOW()),
  );
});
