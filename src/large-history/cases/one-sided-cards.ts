import { expect } from "vitest";
import { runFollowUp } from "../../follow-up/index.ts";
import type { TransferAnswerView } from "../../server/money-movement-views.ts";
import type { ReviewItemView } from "../../server/review-views.ts";
import { timedCase } from "../index.ts";

const ONE_SIDED_KIND = "one-sided Transfer";
const MONEY_FROM_PERSON_KIND = "money from a person";

// The Money movement cards on the Review list (spec 03, Review list items): "Keep it as a
// Transfer" on the largest one-sided Transfer card five years make, every Transfer to a bank with
// no Connection, which remembers the answer for its key, then the follow-up job it starts. Then the
// remembered answers in Settings → Categories, and Delete, which sends the card's Transactions back
// through the follow-up job, so they ask again. Last, "Keep all as Income" on the largest money
// from a person card, when five years make one.
timedCase("Money movement cards on the Review list", async (history, time) => {
  const open = async () =>
    ((await (await history.browser.get("/api/review-list")).json()) as { items: ReviewItemView[] })
      .items;
  const largest = (items: ReviewItemView[], kind: string) =>
    items
      .filter((item) => item.kind === kind)
      .sort((a, b) => b.transactions.length - a.transactions.length)[0];
  const card = largest(await open(), ONE_SIDED_KIND);
  expect(card?.transactions.length).toBeGreaterThan(20);
  const ids = card?.transactions.map((txn) => txn.id) ?? [];

  await time.request(
    `POST /api/review-list/:id/answer (a one-sided Transfer card of ${ids.length})`,
    () => history.browser.post(`/api/review-list/${card?.id}/answer`, { value: "keep" }),
  );
  await time.job("Follow-up after answering the largest one-sided card", 10_000, () =>
    runFollowUp(),
  );
  const asking = (items: ReviewItemView[]) =>
    items.filter(
      (item) => item.kind === ONE_SIDED_KIND && item.transactions.some((t) => ids.includes(t.id)),
    );
  expect(asking(await open())).toEqual([]);

  const { answers } = (await time.request("GET /api/transfer-answers", () =>
    history.browser.get("/api/transfer-answers"),
  )) as { answers: TransferAnswerView[] };
  expect(answers.length).toBeGreaterThan(0);
  const remembered = answers.find((answer) => answer.answer === "Keep it as a Transfer");
  await time.request("DELETE /api/transfer-answers/:id", () =>
    history.browser.send("DELETE", `/api/transfer-answers/${remembered?.id}`),
  );
  await time.job("Follow-up after deleting a remembered answer", 10_000, () => runFollowUp());
  const back = asking(await open());
  expect(back).toHaveLength(1);
  expect(back[0]?.transactions.length).toBe(ids.length);

  const person = largest(await open(), MONEY_FROM_PERSON_KIND);
  if (person !== undefined && person.transactions.length > 1) {
    await time.request(
      `POST /api/review-list/:id/answer (a money from a person card of ${person.transactions.length})`,
      () => history.browser.post(`/api/review-list/${person.id}/answer`, { value: "keep" }),
    );
    await time.job("Follow-up after answering the largest money from a person card", 10_000, () =>
      runFollowUp(),
    );
  }
});
