import { isCategory } from "../categories/index.ts";
import { type Database, listAccounts } from "../db/index.ts";
import {
  addChargeTransaction,
  type ChargeEdit,
  chargeCandidates,
  deleteChargePriceChange,
  editCharge,
  endCharge,
  paydays,
  type RecurringCharge,
  recurringCharges,
  removeChargeTransaction,
  type SteadyIncome,
  setChargePriceChange,
  steadyIncome,
  typeSteadyIncome,
} from "../recurring/index.ts";
import { afterSteadyIncomeTyped } from "../tailoring/index.ts";
import type {
  RecurringChargeEditView,
  RecurringChargeView,
  RecurringRoutes,
  SteadyIncomeView,
} from "./recurring-views.ts";

// The Recurring charge, Steady Income, and payday routes, through the recurring module.
export function recurringRoutes(database: Database): RecurringRoutes {
  // The credit cards, for "on card" (spec 07, Recurring charges page).
  const cardIds = async () =>
    new Set(
      (await listAccounts(database))
        .filter((account) => account.kind === "credit")
        .map((account) => account.id),
    );
  const view = (charge: RecurringCharge, cards: ReadonlySet<string>): RecurringChargeView => {
    const added = new Set(charge.addedByHand);
    return {
      id: charge.id,
      name: charge.name,
      merchantName: charge.merchant.name,
      category: charge.category,
      categoryByHand: charge.categoryByHand,
      priceBand: charge.priceBand === null ? null : charge.priceBand / 10,
      defaultPriceBand: charge.defaultPriceBand / 10,
      schedule: charge.schedule,
      nextExpectedDate: charge.nextExpectedDate,
      latestAmount: charge.latestAmount,
      priceHistory: charge.priceHistory.map(({ transactionId, date, amount }) => ({
        transactionId,
        date,
        amount,
        addedByHand: added.has(transactionId),
      })),
      priceChanges: charge.priceChanges.map(({ id, fromDate, amount, byHand }) => ({
        id,
        fromDate,
        amount,
        byHand,
      })),
      accountId: charge.accountId,
      onCard: cards.has(charge.accountId),
      status: charge.status,
    };
  };
  const editView = async (edit: ChargeEdit): Promise<RecurringChargeEditView> =>
    typeof edit === "string" ? edit : view(edit, await cardIds());
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

    async edit(id, edits) {
      const { category, priceBand, name } = edits;
      return editView(
        await editCharge(database, id, {
          ...(name === undefined ? {} : { name }),
          ...(category === undefined
            ? {}
            : { category: category !== null && isCategory(category) ? category : null }),
          // Tenths of a percent.
          ...(priceBand === undefined
            ? {}
            : { priceBand: priceBand === null ? null : Math.round(priceBand * 10) }),
        }),
      );
    },

    async setPriceChange(id, change) {
      return editView(await setChargePriceChange(database, id, change));
    },

    async deletePriceChange(id, changeId) {
      return editView(await deleteChargePriceChange(database, id, changeId));
    },

    async addTransaction(id, transactionId) {
      return editView(await addChargeTransaction(database, id, transactionId));
    },

    async removeTransaction(id, transactionId) {
      return editView(await removeChargeTransaction(database, id, transactionId));
    },

    async candidates(id, filter) {
      return chargeCandidates(database, id, filter);
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
