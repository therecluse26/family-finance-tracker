// The recurring module's interface (spec 06, Recurring charges; spec 05, Steady Income). Other
// modules import from here.
export {
  chargeSchedule,
  endCharge,
  findRecurringCharges,
  type RecurringCharge,
  recurringCharges,
  startRecurringCharges,
} from "./charges.ts";
export { type ComingUp, type ComingUpRow, comingUp } from "./coming-up.ts";
export {
  findIncomeSeries,
  type IncomeSchedule,
  type Payday,
  paydayAfter,
  paydays,
  type SteadyIncome,
  steadyIncome,
  typeSteadyIncome,
} from "./income.ts";
export { groupOf as merchantGroupOf, householdToday } from "./merchant-days.ts";
export {
  addDays,
  addMonths,
  type ChargeSchedule,
  daysBetween,
  lastActiveDay,
  nextExpected,
  SCHEDULES,
  type Schedule,
} from "./schedules.ts";
export {
  earlierOnSchedule,
  fewestToFind,
  type SeriesTxn,
  type Status,
  withinChargeBand,
} from "./series.ts";
