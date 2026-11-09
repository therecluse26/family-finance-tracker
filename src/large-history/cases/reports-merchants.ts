import { expect } from "vitest";
import type { MerchantsReportView, RecurringReportView } from "../../server/reports-views.ts";
import { timedCase } from "../index.ts";

// The Reports page's Merchants and Recurring charges reports over the whole history: the top 10
// Merchants, one Merchant, and the Recurring charges.
timedCase("the Merchants and Recurring charges reports", async (history, time) => {
  const top = (await time.request("GET /api/reports/merchants?range=all", () =>
    history.browser.get("/api/reports/merchants?range=all"),
  )) as MerchantsReportView;
  expect(top.months.length).toBeGreaterThanOrEqual(60);
  expect(top.series).toHaveLength(10);

  const key = top.series[0]?.key ?? "";
  const one = (await time.request("GET /api/reports/merchants?range=all&merchant=", () =>
    history.browser.get(`/api/reports/merchants?range=all&merchant=${encodeURIComponent(key)}`),
  )) as MerchantsReportView;
  expect(one.series.map((each) => each.key)).toEqual([key]);
  expect(one.usual).not.toBeNull();

  const recurring = (await time.request("GET /api/reports/recurring?range=all", () =>
    history.browser.get("/api/reports/recurring?range=all"),
  )) as RecurringReportView;
  expect(recurring.charges.length).toBeGreaterThan(0);
  expect(recurring.changes.length).toBeGreaterThanOrEqual(recurring.charges.length);
});
