import { expect } from "vitest";
import type { AlertView } from "../../server/alerts-views.ts";
import { timedCase } from "../index.ts";

// The Alert list, with every Anomaly the Anomaly checks found in the full history.
timedCase("Alert list", async (history, time) => {
  const { alerts } = (await time.request("GET /api/alerts", () =>
    history.browser.get("/api/alerts"),
  )) as { alerts: AlertView[] };
  expect(alerts.length).toBeGreaterThan(0);
  expect(alerts.every((alert) => alert.state === "found in history")).toBe(true);
});
