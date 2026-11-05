import { expect } from "vitest";
import { addGoal, listAccounts } from "../../db/index.ts";
import { startGoal } from "../../goals/index.ts";
import type { GoalView } from "../../server/goals-views.ts";
import { timedCase } from "../index.ts";

// Every kind of Goal with its progress over the full history: 3 Categories, the 4 busiest
// Merchants, Saving, Accounts and a loan, each started on May 1, 2026, half a year before the
// history ends. Then a Member marks one dropped.
const STARTS_ON = "2026-05-01";

timedCase("Goals", async (history, time) => {
  const busiest = (
    await history.database.$client.execute(
      `SELECT merchant_id, merchant_clean_name FROM transactions
       WHERE merchant_clean_name IS NOT NULL
       GROUP BY merchant_clean_name ORDER BY count(*) DESC LIMIT 4`,
    )
  ).rows;
  const accounts = await listAccounts(history.database);
  const depository = accounts.filter((account) => account.kind === "depository");
  const loan = accounts.find((account) => account.kind === "loan");
  expect(busiest.length).toBe(4);
  const readings = [
    ...["Groceries", "Restaurants", "Gas"].map((category) => ({
      target: { kind: "Category", category },
      change: { percent: 10 },
    })),
    ...busiest.map((row) => ({
      target: {
        kind: "Merchant",
        merchant: {
          id: row.merchant_id === null ? null : String(row.merchant_id),
          name: String(row.merchant_clean_name),
        },
      },
      change: { percent: 10 },
    })),
    { target: { kind: "Saving" }, change: { amount: 1_000_000 } },
    {
      target: { kind: "Accounts", accountIds: depository.map((each) => each.id) },
      change: { amount: 500_000 },
    },
    { target: { kind: "loan", accountId: loan?.id ?? "" }, change: null },
  ];
  for (const reading of readings) {
    const id = await addGoal(history.database, {
      words: "A Goal",
      authorId: null,
      date: STARTS_ON,
      deadline: "2027-12-31",
      ...reading,
    });
    // A spend less Goal's amount comes from a Proposal: here, $1 a month, which no month meets, so
    // each request reads every complete month since the start.
    const goalAmount =
      reading.target.kind === "Category" || reading.target.kind === "Merchant" ? 100 : undefined;
    await startGoal(history.database, id, { goalAmount, now: new Date(`${STARTS_ON}T14:00:00Z`) });
  }

  const { goals } = (await time.request("GET /api/goals", () =>
    history.browser.get("/api/goals"),
  )) as { goals: GoalView[] };
  expect(goals.filter((goal) => goal.progress !== null).length).toBe(loan === undefined ? 9 : 10);

  await time.request("POST /api/goals/:id/status", () =>
    history.browser.send("POST", `/api/goals/${goals[0]?.id}/status`, { status: "dropped" }),
  );
});
