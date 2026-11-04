import { expect } from "vitest";
import { timedCase } from "../index.ts";

// The Dashboard's Spending, Income, and Saving by month over the full history.
timedCase("totals by month", async (history, time) => {
  const { months } = (await time.request("GET /api/totals", () =>
    history.browser.get("/api/totals"),
  )) as { months: unknown[] };
  expect(months.length).toBeGreaterThanOrEqual(60);
});
