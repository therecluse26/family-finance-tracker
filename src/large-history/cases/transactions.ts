import { expect } from "vitest";
import { runFollowUp } from "../../follow-up/index.ts";
import { timedCase } from "../index.ts";

// The Transactions page's reads, and a hand-set type with the follow-up job it starts.
timedCase("the Transactions page", async (history, time) => {
  await time.request("GET /api/accounts", () => history.browser.get("/api/accounts"));
  const { transactions } = (await time.request("GET /api/transactions (all)", () =>
    history.browser.get("/api/transactions"),
  )) as { transactions: { id: string; description: string }[] };
  expect(transactions.length).toBeGreaterThan(19_000);

  const checking = history.connectionIds.get("fake-lh-lakeshore");
  const accounts = await history.database.$client.execute({
    sql: "SELECT id FROM household_accounts WHERE connection_id = ? ORDER BY name",
    args: [checking ?? ""],
  });
  const account = String(accounts.rows[0]?.id);
  await time.request("GET /api/transactions?account=&from=&to= (one Account, one month)", () =>
    history.browser.get(`/api/transactions?account=${account}&from=2026-09-01&to=2026-09-30`),
  );

  // The Transactions page reads one page at a time, with its filters.
  type Page = {
    transactions: { id: string; merchant: string | null; postedDate: string }[];
    next: string | null;
  };
  const first = (await time.request("GET /api/transactions?limit=100 (first page)", () =>
    history.browser.get("/api/transactions?limit=100"),
  )) as Page;
  expect(first.transactions).toHaveLength(100);
  await time.request("GET /api/transactions?limit=100&after= (next page)", () =>
    history.browser.get(`/api/transactions?limit=100&after=${first.next}`),
  );
  await time.request("GET /api/transactions?category=&month= (a Category's month)", () =>
    history.browser.get("/api/transactions?category=Restaurants&month=2026-09&limit=100"),
  );
  await time.request("GET /api/transactions?type=Income&month= (last month's Income)", () =>
    history.browser.get("/api/transactions?type=Income&month=2026-10&limit=100"),
  );
  const refunds = (await time.request("GET /api/transactions?type=Refund", () =>
    history.browser.get("/api/transactions?type=Refund&limit=100"),
  )) as Page;
  const merchant = first.transactions.find((txn) => txn.merchant !== null)?.merchant ?? "";
  await time.request("GET /api/transactions?merchant= (one Merchant)", () =>
    history.browser.get(`/api/transactions?merchant=${encodeURIComponent(merchant)}&limit=100`),
  );
  const refund = refunds.transactions[0];
  if (refund === undefined) throw new Error("The history has no Refund.");
  await time.request("GET /api/transactions/:id (a linked Refund)", () =>
    history.browser.get(`/api/transactions/${refund.id}`),
  );
  // The Spending a Member may link money in to by hand: all 5 years before it, then the next page.
  const spending = `/api/transactions?type=Spending&from=2021-01-01&to=${refund.postedDate}&limit=100`;
  const candidates = (await time.request(
    "GET /api/transactions?type=Spending&from=&to= (hand-link Spending)",
    () => history.browser.get(spending),
  )) as Page;
  expect(candidates.next).not.toBeNull();
  await time.request("GET /api/transactions?type=Spending&after= (more hand-link Spending)", () =>
    history.browser.get(`${spending}&after=${candidates.next}`),
  );
  await time.request("GET /api/transactions?type=Spending&merchant= (hand-link Spending)", () =>
    history.browser.get(
      `/api/transactions?type=Spending&merchant=${encodeURIComponent(merchant)}&to=${refund.postedDate}&limit=100`,
    ),
  );

  const meal = transactions.find((txn) => txn.description === "NOODLE HOUSE #12");
  if (meal === undefined) throw new Error("The history has no Noodle House meal.");
  await time.request("GET /api/transactions/:id", () =>
    history.browser.get(`/api/transactions/${meal.id}`),
  );
  await time.request("PUT /api/transactions/:id/type", () =>
    history.browser.send("PUT", `/api/transactions/${meal.id}/type`, { type: "Transfer" }),
  );
  await time.job("Follow-up after a hand-set type", 10_000, () => runFollowUp());
});
