import type { Database } from "../db/index.ts";
import {
  readLoanSettings,
  readTransactionDetail,
  setLoanSettings,
  setTransactionType,
  totalsByMonth,
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
  };
}
