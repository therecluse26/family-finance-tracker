import { expect } from "vitest";
import type { ComingUpView } from "../../server/coming-up-views.ts";
import { timedCase } from "../index.ts";

// "Coming up" over the full history: every Recurring charge, payday, card, and loan it reads.
timedCase('the dashboard\'s "Coming up"', async (history, time) => {
  const view = (await time.request("GET /api/coming-up", () =>
    history.browser.get("/api/coming-up"),
  )) as ComingUpView;
  expect(view.checking).not.toBeNull();
  expect(view.rows.length).toBeGreaterThan(0);
});
