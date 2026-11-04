import { expect } from "vitest";
import { runFollowUp } from "../../follow-up/index.ts";
import type { ReviewItemView } from "../../server/review-views.ts";
import { timedCase } from "../index.ts";

// Settling the Review list: a Member accepts the best answer of one item of each kind, then the
// follow-up job the answers start runs.
timedCase("answering Review list items", async (history, time) => {
  const opened = await history.browser.get("/api/review-list");
  const { items } = (await opened.json()) as { items: ReviewItemView[] };
  const firsts = new Map<string, ReviewItemView>();
  for (const item of items) if (!firsts.has(item.kind)) firsts.set(item.kind, item);
  expect(firsts.size).toBeGreaterThan(0);

  for (const [kind, item] of firsts) {
    await time.request(`POST /api/review-list/:id/answer (${kind})`, () =>
      history.browser.post(`/api/review-list/${item.id}/answer`, { value: item.bestAnswer.value }),
    );
  }
  expect(history.followUpsAsked()).toBeGreaterThan(0);
  await time.job("Follow-up after the answers", 10_000, () => runFollowUp());

  const count = await history.browser.get("/api/review-list/count");
  expect(((await count.json()) as { open: number }).open).toBeLessThan(items.length);
});
