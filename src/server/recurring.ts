import type { Database } from "../db/index.ts";
import { endCharge, type RecurringCharge, recurringCharges } from "../recurring/index.ts";
import type { RecurringChargeView, RecurringRoutes } from "./recurring-views.ts";

// The Recurring charge routes, through the recurring module.
export function recurringRoutes(database: Database): RecurringRoutes {
  const view = (charge: RecurringCharge): RecurringChargeView => ({
    id: charge.id,
    merchantName: charge.merchant.name,
    category: charge.category,
    schedule: charge.schedule,
    nextExpectedDate: charge.nextExpectedDate,
    latestAmount: charge.latestAmount,
    priceHistory: charge.priceHistory.map(({ date, amount }) => ({ date, amount })),
    accountId: charge.accountId,
    status: charge.status,
  });

  return {
    async list() {
      return (await recurringCharges(database)).map(view);
    },

    async end(id, memberId) {
      const ended = await endCharge(database, id, memberId);
      return ended === undefined ? undefined : view(ended);
    },
  };
}
