import { expect } from "vitest";
import type { HistoryStatusView } from "../../server/bank-views.ts";
import { timedCase } from "../index.ts";

// The history loading progress, which Settings → Banks and the dashboard read again every few
// seconds while a history load runs, over the whole history: once with every history loaded, and
// once with the biggest bank's history still loading.
timedCase("the history loading progress", async (history, time) => {
  const done = (await time.request("GET /api/history-status (every history loaded)", () =>
    history.browser.get("/api/history-status"),
  )) as HistoryStatusView;
  expect(done.loading).toEqual([]);

  // Untimed setup: the bank with the most Transactions goes back to loading its history.
  const biggest = await history.database.$client.execute(
    "SELECT connection_id FROM transactions GROUP BY connection_id ORDER BY count(*) DESC LIMIT 1",
  );
  const connectionId = String(biggest.rows[0]?.connection_id);
  await history.database.$client.execute({
    sql: "UPDATE connections SET history_loaded = 0 WHERE id = ?",
    args: [connectionId],
  });

  const loading = (await time.request("GET /api/history-status (one bank loading)", () =>
    history.browser.get("/api/history-status"),
  )) as HistoryStatusView;
  expect(loading.loading).toHaveLength(1);
  expect(loading.loading[0]?.connectionId).toBe(connectionId);
  expect(loading.loading[0]?.transactions).toBeGreaterThan(1_000);

  // Settings → Banks' poll: the Connection list alone.
  await time.request("GET /api/connections (poll while a history loads)", () =>
    history.browser.get("/api/connections"),
  );
});
