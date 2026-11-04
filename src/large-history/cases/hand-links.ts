import { expect } from "vitest";
import { runFollowUp } from "../../follow-up/index.ts";
import type { ReviewItemView } from "../../server/review-views.ts";
import { timedCase } from "../index.ts";

// A Member links an Unclear pair by hand, then undoes the link, with the follow-up job each one
// starts.
timedCase("a hand link and its undo", async (history, time) => {
  const opened = await history.browser.get("/api/review-list");
  const { items } = (await opened.json()) as { items: ReviewItemView[] };
  const unclear = items.find((item) => item.kind === "unclear Transfer pair");
  if (unclear?.subject.type !== "transactions") {
    throw new Error("The history has no Unclear pair on the Review list.");
  }
  const [outTransactionId, inTransactionId] = unclear.subject.transactionIds;

  const { linkId } = (await time.request("POST /api/links (Transfer)", () =>
    history.browser.post("/api/links", { kind: "Transfer", outTransactionId, inTransactionId }),
  )) as { linkId: string };
  await time.job("Follow-up after a hand link", 10_000, () => runFollowUp());

  await time.request("DELETE /api/links/:id", () =>
    history.browser.send("DELETE", `/api/links/${linkId}`),
  );
  await time.job("Follow-up after undoing a link", 10_000, () => runFollowUp());
  expect(history.followUpsAsked()).toBeGreaterThan(0);
});
