import { expect } from "vitest";
import type { ReviewItemView } from "../../server/review-views.ts";
import { timedCase } from "../index.ts";

// The Review list page's reads: every open item, the menu's count, and "Not this" for an item of
// each kind.
timedCase("opening the Review list", async (history, time) => {
  const { items } = (await time.request("GET /api/review-list", () =>
    history.browser.get("/api/review-list"),
  )) as { items: ReviewItemView[] };
  await time.request("GET /api/review-list/count", () =>
    history.browser.get("/api/review-list/count"),
  );

  const kinds = new Map(items.map((item) => [item.kind, item.id]));
  expect(kinds.size).toBeGreaterThan(0);
  for (const [kind, id] of kinds) {
    await time.request(`GET /api/review-list/:id/choices (${kind})`, () =>
      history.browser.get(`/api/review-list/${id}/choices`),
    );
  }
});
