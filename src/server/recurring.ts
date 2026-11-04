import type { Database } from "../db/index.ts";
import {
  endCharge,
  paydays,
  type RecurringCharge,
  recurringCharges,
  type SteadyIncome,
  steadyIncome,
  typeSteadyIncome,
} from "../recurring/index.ts";
import type { RecurringChargeView, RecurringRoutes, SteadyIncomeView } from "./recurring-views.ts";

// The Recurring charge, Steady Income, and payday routes, through the recurring module.
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
  const incomeView = (income: SteadyIncome): SteadyIncomeView => ({
    amount: income.amount,
    detected: income.detected,
    detectedFrom: income.detectedFrom,
    typed: income.typed,
  });

  return {
    async list() {
      return (await recurringCharges(database)).map(view);
    },

    async end(id, memberId) {
      const ended = await endCharge(database, id, memberId);
      return ended === undefined ? undefined : view(ended);
    },

    async steadyIncome() {
      return incomeView(await steadyIncome(database));
    },

    async typeSteadyIncome(amount, memberId) {
      return incomeView(await typeSteadyIncome(database, amount, memberId));
    },

    async paydays() {
      return (await paydays(database)).map((payday) => ({
        payerName: payday.payer.name,
        schedule: payday.schedule,
        date: payday.date,
        amount: payday.amount,
      }));
    },
  };
}
