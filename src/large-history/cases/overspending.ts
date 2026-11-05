import { expect } from "vitest";
import { alertList, checkOverspending } from "../../anomalies/index.ts";
import { draftFirstBudgets } from "../../budgets/index.ts";
import { HISTORY_LAST_DAY } from "../history.ts";
import { timedCase } from "../index.ts";

const at = (date: string) => new Date(`${date}T14:00:00.000Z`);

// The Overspending checks follow-up step on every Transaction of the full history, in the history's
// last month, so they fire on that month's Spending: the first Budget draft on its 1st, then the
// checks on its 20th, when On pace may fire, and on its last day.
timedCase("Overspending checks", async (history, time) => {
  const month = HISTORY_LAST_DAY.slice(0, 7);
  expect(await draftFirstBudgets(history.database, at(`${month}-01`))).toBe(true);
  const rows = await history.database.$client.execute("SELECT id FROM transactions");
  const ids = rows.rows.map((row) => String(row.id));
  expect(ids.length).toBeGreaterThan(10_000);

  await time.job("Overspending checks on the full history on the 20th", 5_000, () =>
    checkOverspending(history.database, ids, at(`${month}-20`)),
  );
  await time.job("Overspending checks on the full history on the month's last day", 5_000, () =>
    checkOverspending(history.database, ids, at(HISTORY_LAST_DAY)),
  );
  // Each Alert fires at most once: a second run finds nothing new.
  expect(await checkOverspending(history.database, ids, at(HISTORY_LAST_DAY))).toBe(0);
  const fired = (await alertList(history.database)).filter((alert) =>
    ["Over Budget", "On pace", "Card interest or fee"].includes(alert.kind),
  );
  expect(fired.length).toBeGreaterThan(0);
});
