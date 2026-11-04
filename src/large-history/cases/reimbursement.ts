import { expect } from "vitest";
import { runFollowUp } from "../../follow-up/index.ts";
import { MONEY_FROM_PERSON_KIND } from "../../money-movement/index.ts";
import type { ReviewChoiceView, ReviewItemView } from "../../server/review-views.ts";
import { timedCase } from "../index.ts";

// Money from a person: a Member opens "Not this" on its Review list item and links it to Spending
// as a Reimbursement, then the follow-up job decides the money and the Spending again.
timedCase("linking a Reimbursement from the Review list", async (history, time) => {
  const opened = await history.browser.get("/api/review-list");
  const { items } = (await opened.json()) as { items: ReviewItemView[] };
  const item = items.find((each) => each.kind === MONEY_FROM_PERSON_KIND);
  if (item === undefined) throw new Error("The history has no money from a person.");

  const { choices } = (await time.request("GET /api/review-list/:id/choices (Reimbursement)", () =>
    history.browser.get(`/api/review-list/${item.id}/choices`),
  )) as { choices: ReviewChoiceView[] };
  const link = choices.find((choice) => choice.value.startsWith("link "));
  if (link === undefined) throw new Error("No Spending to link.");
  await time.request("POST /api/review-list/:id/answer (Reimbursement)", () =>
    history.browser.post(`/api/review-list/${item.id}/answer`, { value: link.value }),
  );
  await time.job("Follow-up after a Reimbursement link", 10_000, () => runFollowUp());

  const links = await history.database.$client.execute(
    "SELECT count(*) AS n FROM spending_links WHERE kind = 'Reimbursement'",
  );
  expect(Number(links.rows[0]?.n)).toBe(1);
});
