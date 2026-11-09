import { expect } from "vitest";
import type { AccountView } from "../../server/bank-views.ts";
import type { BalancesReportView } from "../../server/reports-views.ts";
import { timedCase } from "../index.ts";

// Balances and debt on the Reports page (spec 07, Reports): every Account's month-ends over the
// whole history, a Manual loan's too, then one Account's balance line.
timedCase("the Balances and debt report", async (history, time) => {
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

  const all = (await time.request("GET /api/reports/balances?range=all", () =>
    history.browser.get("/api/reports/balances?range=all"),
  )) as BalancesReportView;
  expect(all.months.length).toBeGreaterThan(50);
  expect(all.cashOnHand).toHaveLength(all.months.length);
  expect(all.creditUse.cards.length).toBeGreaterThan(0);
  expect(all.loans.length).toBeGreaterThan(0);

  const { accounts } = (await (await history.browser.get("/api/accounts")).json()) as {
    accounts: AccountView[];
  };
  const checking = accounts.find((account) => account.subtype === "checking")?.id ?? "";
  const one = (await time.request("GET /api/reports/balances?range=all&account= (checking)", () =>
    history.browser.get(`/api/reports/balances?range=all&account=${checking}`),
  )) as BalancesReportView;
  expect(one.account?.points.length).toBeGreaterThan(1_000);
});
