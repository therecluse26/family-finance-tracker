import { expect } from "vitest";
import type { AlertFacts } from "../../anomalies/index.ts";
import { storeAlerts } from "../../db/index.ts";
import type { AiBoxView } from "../../server/ai-box-views.ts";
import { timedCase } from "../index.ts";

const FACTS: AlertFacts = {
  kind: "Over Budget",
  budget: {
    category: "Restaurants",
    spent: 60_000,
    budget: 48_000,
    period: "monthly",
    span: "2026-10",
  },
  latest: { merchant: { id: null, name: "Corner Bistro" }, amount: 4_250, date: "2026-10-19" },
};

// The AI box over the full history, which holds every Alert found in it, and 500 Alerts from the
// last 7 days, one of them Done.
timedCase('the dashboard\'s AI box, "This week"', async (history, time) => {
  const now = Date.now();
  await storeAlerts(
    history.database,
    Array.from({ length: 500 }, (_, index) => ({
      id: `bench-note-${index}`,
      kind: "Over Budget" as const,
      createdAt: new Date(now - (index + 1) * 60_000),
      facts: FACTS,
      text: `Restaurants is over Budget ${index}.`,
      category: "Restaurants",
      state: "sent" as const,
      transactionIds: [],
    })),
  );

  const marked = await time.request("PUT /api/ai-box/alert-notes/:id/done", () =>
    history.browser.send("PUT", "/api/ai-box/alert-notes/bench-note-0/done", { done: true }),
  );
  expect(marked).toEqual({ done: true });

  const box = (await time.request("GET /api/ai-box", () =>
    history.browser.get("/api/ai-box"),
  )) as AiBoxView;
  expect(box.groups[0]?.notes).toHaveLength(500);
  expect(box.worthActingOn).toBe(499);
});
