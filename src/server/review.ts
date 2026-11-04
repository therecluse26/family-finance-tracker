import { type Database, listAccounts, readShownTransactions } from "../db/index.ts";
import {
  answerReviewItem,
  countReviewItems,
  openReviewItems,
  otherReviewChoices,
} from "../review/index.ts";
import type { ReviewItemView, ReviewRoutes, ReviewTransactionView } from "./review-views.ts";

// The Review list routes, through the review module. Each item comes with the Transactions or the
// loan it is about, read once for the whole list.
export function reviewRoutes(database: Database): ReviewRoutes {
  return {
    async open() {
      const items = await openReviewItems(database);
      const shown = new Map(
        (
          await readShownTransactions(
            database,
            items.flatMap((item) =>
              item.subject.type === "transactions" ? item.subject.transactionIds : [],
            ),
          )
        ).map((txn) => [txn.id, txn]),
      );
      const accountNames = new Map(
        (await listAccounts(database)).map((account) => [account.id, account.name]),
      );
      return items.map((item): ReviewItemView => {
        const transactions =
          item.subject.type === "transactions"
            ? item.subject.transactionIds.flatMap((id): ReviewTransactionView[] => {
                const txn = shown.get(id);
                if (txn === undefined) return [];
                return [
                  {
                    id: txn.id,
                    amount: txn.amount,
                    postedDate: txn.postedDate,
                    authorizedDate: txn.authorizedDate,
                    description: txn.description,
                    merchantName: txn.merchantName,
                    accountName: accountNames.get(txn.accountId) ?? null,
                  },
                ];
              })
            : [];
        return {
          ...item,
          transactions,
          loanName:
            item.subject.type === "loan"
              ? (accountNames.get(item.subject.accountId) ?? null)
              : null,
          createdAt: item.createdAt.toISOString(),
        };
      });
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
