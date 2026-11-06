import { expect } from "vitest";
import { addGoal, listAccounts } from "../../db/index.ts";
import { checkGoalsDone, listGoalsWithProgress, startGoal } from "../../goals/index.ts";
import { HISTORY_NOW } from "../history.ts";
import { timedCase } from "../index.ts";

// The Done check (spec 05, Done) with 50 active Goals over the full history, as the follow-up job
// and the Month start job run it (CLAUDE.md, K3). Each kind of Goal, started on May 1, 2026, half a
// year before the history ends. Each spend less Goal has an amount of $1, so the check reads each
// complete month since the start; the Saving Goals of $1 are met, so it writes too.
const STARTS_ON = "2026-05-01";
const GOALS = 50;

timedCase("Goal Done check", async (history, time) => {
  const busiest = (
    await history.database.$client.execute(
      `SELECT merchant_id, merchant_clean_name FROM transactions
       WHERE merchant_clean_name IS NOT NULL
       GROUP BY merchant_clean_name ORDER BY count(*) DESC LIMIT 4`,
    )
  ).rows;
  const accounts = await listAccounts(history.database);
  const depository = accounts.filter((account) => account.kind === "depository");
  expect(busiest.length).toBe(4);
  const readings = [
    ...["Groceries", "Restaurants", "Gas", "Superstores"].map((category) => ({
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
    { target: { kind: "Saving" }, change: { amount: 100 } },
    {
      target: { kind: "Accounts", accountIds: depository.map((each) => each.id) },
      change: { amount: 500_000_000 },
    },
  ];
  for (let index = 0; index < GOALS; index += 1) {
    const reading = readings[index % readings.length];
    if (reading === undefined) throw new Error("No reading.");
    const id = await addGoal(history.database, {
      words: "A Goal",
      authorId: null,
      date: STARTS_ON,
      deadline: null,
      ...reading,
    });
    const spendLess = reading.target.kind === "Category" || reading.target.kind === "Merchant";
    await startGoal(history.database, id, {
      goalAmount: spendLess ? 100 : undefined,
      now: new Date(`${STARTS_ON}T14:00:00Z`),
    });
  }

  await time.job("Goal Done check with 50 Goals", 5_000, () =>
    checkGoalsDone(history.database, HISTORY_NOW()),
  );

  const goals = await listGoalsWithProgress(history.database, HISTORY_NOW());
  expect(goals).toHaveLength(GOALS);
  // Each Saving Goal is met, so the check wrote: 5 of the 50. Only the Saving Goals are counted,
  // since whether a spend less Goal is met depends on the made-up history: a Category with no
  // Spending in a complete month, such as Superstores, meets $1 too.
  expect(
    goals.filter((goal) => goal.status === "done" && goal.reading.target?.kind === "Saving"),
  ).toHaveLength(GOALS / readings.length);
});
