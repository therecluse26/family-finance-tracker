import { isCategory } from "../categories/index.ts";
import { transactionWebLookupLine } from "../categorization/index.ts";
import { type Database, readShownTransactions } from "../db/index.ts";
import {
  addManualLoan,
  editManualLoan,
  linkByHand,
  listManualLoanViews,
  readLoanSettings,
  readTransactionDetail,
  removeSplit,
  setLoanSettings,
  setTransactionType,
  splitTransaction,
  totalsByMonth,
  undoLink,
} from "../money-movement/index.ts";
import type { MoneyMovementRoutes } from "./money-movement-views.ts";
import { transactionRows } from "./transaction-rows.ts";

// The money-movement routes, through the money-movement module.
export function moneyMovementRoutes(database: Database): MoneyMovementRoutes {
  return {
    // The Transaction and the other side of each of its links, as the Transactions page shows them,
    // in one batch.
    async transaction(transactionId) {
      const detail = await readTransactionDetail(database, transactionId);
      if (detail === undefined) return undefined;
      const otherIds = [detail.transferLink, ...detail.otherLinks].flatMap((link) =>
        link?.otherTransactionId == null ? [] : [link.otherTransactionId],
      );
      const rows = await transactionRows(
        database,
        await readShownTransactions(database, [transactionId, ...otherIds]),
      );
      const transaction = rows.find((row) => row.id === transactionId);
      if (transaction === undefined) return undefined;
      // The line about the business, when a Web lookup chose a part's Category.
      const byLookup = transaction.parts.some(
        (part) =>
          part.categoryChosenBy === "Web lookup" || part.categoryChosenBy === "Web lookup, unsure",
      );
      const line = byLookup ? await transactionWebLookupLine(database, transactionId) : undefined;
      return {
        transaction,
        decision:
          detail.decision === null ? null : { ...detail.decision, parts: transaction.parts },
        transferLink: detail.transferLink,
        otherLinks: detail.otherLinks,
        matched: rows.filter((row) => row.id !== transactionId),
        webLookup: line === undefined ? null : { description: line },
      };
    },

    setType(transactionId, type) {
      return setTransactionType(database, transactionId, type);
    },

    split(transactionId, body) {
      const parts = body.parts.map(({ amount, category }) => {
        if (!isCategory(category)) throw new Error("The route takes only a Category.");
        return { amount, category };
      });
      return splitTransaction(database, transactionId, parts);
    },

    removeSplit(transactionId) {
      return removeSplit(database, transactionId);
    },

    totals() {
      return totalsByMonth(database);
    },

    loan(accountId) {
      return readLoanSettings(database, accountId);
    },

    setLoan(accountId, { loanType, apr }) {
      return setLoanSettings(database, accountId, {
        ...(loanType === undefined ? {} : { loanType }),
        ...(apr === undefined ? {} : { memberApr: apr }),
      });
    },

    link(body, memberId) {
      return linkByHand(database, body, memberId);
    },

    undoLink(linkId, memberId) {
      return undoLink(database, linkId, memberId);
    },

    manualLoans() {
      return listManualLoanViews(database);
    },

    addManualLoan(body, memberId) {
      return addManualLoan(database, body, memberId);
    },

    editManualLoan(id, body, memberId) {
      return editManualLoan(database, id, body, memberId);
    },
  };
}
