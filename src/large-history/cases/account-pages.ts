import { expect } from "vitest";
import { assignToUnconnectedAccount } from "../../db/index.ts";
import type { AccountView, BalancesView } from "../../server/bank-views.ts";
import { timedCase } from "../index.ts";

// The Account list and an Account's page: the list, then a year of balances and Transactions for
// the checking Account, an Unconnected account with 1,000 assigned Transactions, and a Manual loan.
timedCase("the Account list and Account pages", async (history, time) => {
  const unconnected = await history.browser.post("/api/unconnected-accounts", {
    name: "Credit union savings",
    kind: "savings",
    institutionName: "",
    mask: "",
    balance: null,
  });
  const savings = ((await unconnected.json()) as { account: { id: string } }).account.id;
  const moved = await history.database.$client.execute(
    "SELECT id FROM transactions WHERE pending = 0 AND rowid % 20 = 0 LIMIT 1000",
  );
  for (const row of moved.rows) {
    await assignToUnconnectedAccount(history.database, String(row.id), savings);
  }
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
  const loan = ((await added.json()) as { loan: { id: string } }).loan.id;

  const { accounts } = (await time.request("GET /api/accounts (Account list)", () =>
    history.browser.get("/api/accounts"),
  )) as { accounts: AccountView[] };
  expect(accounts.find((account) => account.id === loan)?.estimated).toBe(true);
  const checking = accounts.find((account) => account.subtype === "checking")?.id ?? "";

  const from = "2025-11-04";
  await time.request("GET /api/accounts/:id/balances?from= (checking, one year)", () =>
    history.browser.get(`/api/accounts/${checking}/balances?from=${from}`),
  );
  await time.request("GET /api/transactions?account=&from= (checking, one year)", () =>
    history.browser.get(`/api/transactions?account=${checking}&from=${from}`),
  );
  const line = (await time.request("GET /api/accounts/:id/balances (Unconnected account)", () =>
    history.browser.get(`/api/accounts/${savings}/balances`),
  )) as BalancesView;
  expect(line.points.length).toBeGreaterThan(500);
  await time.request("GET /api/accounts/:id/balances (Manual loan)", () =>
    history.browser.get(`/api/accounts/${loan}/balances`),
  );
});
