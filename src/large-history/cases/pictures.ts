import { expect } from "vitest";
import { draftFirstBudgets } from "../../budgets/index.ts";
import type { PictureView } from "../../pictures/index.ts";
import { HISTORY_NOW } from "../history.ts";
import { timedCase } from "../index.ts";

// Each picture on the picture menu over the full history, for its last complete month, with the
// Budgets of the first draft.
timedCase("the pictures on the picture menu", async (history, time) => {
  expect(await draftFirstBudgets(history.database, HISTORY_NOW())).toBe(true);

  for (const [name, query] of [
    ["days, by Category", "type=days&category=Groceries"],
    ["days, by Merchant", "type=days&merchant=Streamflix&merchant=Tunebox"],
    ["trend", "type=trend&category=Groceries"],
    ["cards", "type=cards"],
    ["recurring", "type=recurring&category=Entertainment"],
  ] as const) {
    const { picture } = (await time.request(`GET /api/picture (${name})`, () =>
      history.browser.get(`/api/picture?month=2026-10&${query}`),
    )) as { picture: PictureView | null };
    expect(picture, name).not.toBeNull();
  }
});
