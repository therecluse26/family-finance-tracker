import type { Database } from "../db/index.ts";
import { setTransactionType, totalsByMonth } from "../money-movement/index.ts";
import type { MoneyMovementRoutes } from "./money-movement-views.ts";

// The money-movement routes, through the money-movement module.
export function moneyMovementRoutes(database: Database): MoneyMovementRoutes {
  return {
    setType(transactionId, type) {
      return setTransactionType(database, transactionId, type);
    },

    totals() {
      return totalsByMonth(database);
    },
  };
}
