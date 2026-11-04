import { expect } from "vitest";
import { timedCase } from "../index.ts";

// The build's jobs: the first sync of the full history, then each follow-up step on all of it, one
// row per step (modules.ts). A cached build shows the times from when it was built, with the same
// code.
timedCase("the first sync of the full history, and its follow-up", async (history, time) => {
  for (const row of history.build.times) time.add(row);

  const shown = await history.database.$client.execute(
    "SELECT count(*) AS n FROM transactions WHERE hidden_reason IS NULL",
  );
  expect(Number(shown.rows[0]?.n)).toBe(history.generated.shown.length);
});
