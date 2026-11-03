import type { Database } from "../db/index.ts";
import {
  answerReviewItem,
  countReviewItems,
  openReviewItems,
  otherReviewChoices,
} from "../review/index.ts";
import type { ReviewRoutes } from "./review-views.ts";

// The Review list routes, through the review module.
export function reviewRoutes(database: Database): ReviewRoutes {
  return {
    async open() {
      return (await openReviewItems(database)).map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString(),
      }));
    },

    count() {
      return countReviewItems(database);
    },

    otherChoices(id) {
      return otherReviewChoices(database, id);
    },

    answer(id, value, memberId) {
      return answerReviewItem(database, id, value, memberId);
    },
  };
}
