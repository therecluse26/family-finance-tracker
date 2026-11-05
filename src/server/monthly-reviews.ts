import { alertsHeldBack } from "../anomalies/index.ts";
import { type Database, readAiSettings } from "../db/index.ts";
import { listReviews, readReview, tickPlanItem } from "../monthly-review/index.ts";
import { openReviewProposals } from "../proposals/index.ts";
import type { MonthlyReviewRoutes } from "./monthly-reviews-views.ts";
import { proposalView } from "./proposals.ts";

// The Reviews page's routes (spec 07, Reviews page): the past Monthly reviews, one review as it was
// written, and the plan's ticks, through the monthly-review module. Beside the review, the open
// Proposals come from the proposals module and the held-back Alerts from the anomalies module.
// Reading a review makes no AI call and writes nothing.
export function monthlyReviewRoutes(database: Database): MonthlyReviewRoutes {
  return {
    async list() {
      return {
        aiProvider: (await readAiSettings(database)) !== undefined,
        reviews: await listReviews(database),
      };
    },

    async view(month) {
      const found = await readReview(database, month);
      if (found === undefined) return undefined;
      const proposals = await openReviewProposals(database, found);
      const heldBack = await alertsHeldBack(database, month);
      return {
        month,
        review: found.review,
        ticked: found.ticks.map((tick) => tick.item),
        proposals: proposals.map(proposalView),
        heldBack: heldBack.map((alert) => ({
          id: alert.id,
          createdAt: alert.createdAt.toISOString(),
          heading: alert.heading,
          texts: alert.parts.map((part) => part.text),
        })),
      };
    },

    tick(month, item, memberId, done) {
      return tickPlanItem(database, { month, item, memberId, done });
    },
  };
}
