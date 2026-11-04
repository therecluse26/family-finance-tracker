import { isCategory } from "../categories/index.ts";
import type { Database } from "../db/index.ts";
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

// The money-movement routes, through the money-movement module.
export function moneyMovementRoutes(database: Database): MoneyMovementRoutes {
  return {
    transaction(transactionId) {
      return readTransactionDetail(database, transactionId);
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
