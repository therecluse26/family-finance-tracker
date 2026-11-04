import { expect } from "vitest";
import { runFollowUp } from "../../follow-up/index.ts";
import { timedCase } from "../index.ts";

// The Exclude switch on the checking Account, which holds a side of most Transfers, then off
// again. Each switch makes Matching run again over the Account's history. The totals come back.
timedCase("Exclude on and off", async (history, time) => {
  const accounts = await history.database.$client.execute({
    sql: "SELECT id FROM household_accounts WHERE connection_id = ? AND subtype = 'checking'",
    args: [history.connectionIds.get("fake-lh-lakeshore") ?? ""],
  });
  const checking = String(accounts.rows[0]?.id);
  const totals = async () => (await history.browser.get("/api/totals")).json();
  const before = await totals();

  for (const [excluded, state] of [
    [true, "on"],
    [false, "off"],
  ] as const) {
    await time.request(`PUT /api/accounts/:id/exclude (${state})`, () =>
      history.browser.send("PUT", `/api/accounts/${checking}/exclude`, { excluded }),
    );
    await time.job(`Follow-up after Exclude ${state}`, 10_000, () => runFollowUp());
  }

  expect(await totals()).toEqual(before);
});
