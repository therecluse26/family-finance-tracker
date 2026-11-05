import { type Database, listAccounts } from "../db/index.ts";
import {
  endCharge,
  paydays,
  type RecurringCharge,
  recurringCharges,
  type SteadyIncome,
  steadyIncome,
  typeSteadyIncome,
} from "../recurring/index.ts";
import { afterSteadyIncomeTyped } from "../tailoring/index.ts";
import type { RecurringChargeView, RecurringRoutes, SteadyIncomeView } from "./recurring-views.ts";

// The Recurring charge, Steady Income, and payday routes, through the recurring module.
export function recurringRoutes(database: Database): RecurringRoutes {
  // The credit cards, for "on card" (spec 07, Recurring charges page).
  const cardIds = async () =>
    new Set(
      (await listAccounts(database))
        .filter((account) => account.kind === "credit")
        .map((account) => account.id),
    );
  const view = (charge: RecurringCharge, cards: ReadonlySet<string>): RecurringChargeView => ({
    id: charge.id,
    merchantName: charge.merchant.name,
    category: charge.category,
    schedule: charge.schedule,
    nextExpectedDate: charge.nextExpectedDate,
    latestAmount: charge.latestAmount,
    priceHistory: charge.priceHistory.map(({ date, amount }) => ({ date, amount })),
    accountId: charge.accountId,
    onCard: cards.has(charge.accountId),
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
      const [charges, cards] = await Promise.all([recurringCharges(database), cardIds()]);
      return charges.map((charge) => view(charge, cards));
    },

    async end(id, memberId) {
      const ended = await endCharge(database, id, memberId);
      return ended === undefined ? undefined : view(ended, await cardIds());
    },

    async steadyIncome() {
      return incomeView(await steadyIncome(database));
    },

    async typeSteadyIncome(amount, memberId) {
      const typed = await typeSteadyIncome(database, amount, memberId);
      // A typed figure can make an Income redraft due (spec 05, Which Proposals exist).
      await afterSteadyIncomeTyped();
      return incomeView(typed);
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
