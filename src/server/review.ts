import { type Database, listAccounts, readShownParts, readShownTransactions } from "../db/index.ts";
import {
  answerReviewItem,
  countReviewItems,
  kindsGroupedByAccounts,
  otherReviewChoices,
  reviewListItems,
} from "../review/index.ts";
import type { ReviewItemView, ReviewRoutes, ReviewTransactionView } from "./review-views.ts";

// The Review list routes, through the review module. Each item comes with the Transactions or the
// loan it is about, and each Transaction's Categories, read once for the whole list.
export function reviewRoutes(database: Database): ReviewRoutes {
  return {
    async open() {
      const items = await reviewListItems(database);
      const ids = items.flatMap((item) =>
        item.subject.type === "transactions" ? item.subject.transactionIds : [],
      );
      const shown = new Map(
        (await readShownTransactions(database, ids)).map((txn) => [txn.id, txn]),
      );
      const parts = await readShownParts(database, ids);
      const accountNames = new Map(
        (await listAccounts(database)).map((account) => [account.id, account.name]),
      );
      // An item of a grouped kind with two shown Transactions groups with the others between the
      // same two Accounts, as the count counts them.
      const grouped = new Set(kindsGroupedByAccounts());
      const groupOf = (kind: string, ids: readonly string[]) => {
        if (!grouped.has(kind)) return null;
        const accounts = ids.flatMap((id) => {
          const txn = shown.get(id);
          return txn === undefined ? [] : [txn.accountId];
        });
        if (accounts.length !== 2) return null;
        return `accounts ${kind} ${accounts.sort().join(" ")}`;
      };
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
                    categories: [
                      ...new Set(
                        (parts.get(txn.id) ?? []).flatMap((part) =>
                          part.category === null ? [] : [part.category],
                        ),
                      ),
                    ],
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
          group:
            item.subject.type === "transactions"
              ? groupOf(item.kind, item.subject.transactionIds)
              : null,
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
