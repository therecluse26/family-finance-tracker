// The anomalies module's interface (spec 06, Anomalies; What an Alert says; The Alert list).
// Other modules import from here.
export { type Alert, alertList } from "./alert-list.ts";
export {
  ANOMALY_CHECKS_CAP,
  ANOMALY_CHECKS_STOPPED,
  checkAnomalies,
  startAnomalyChecks,
} from "./checks.ts";
export {
  checkOverspending,
  OVERSPENDING_CHECKS_CAP,
  OVERSPENDING_CHECKS_STOPPED,
  startOverspendingChecks,
} from "./overspending.ts";
export { type PriceIncrease, priceIncreases } from "./price-increase.ts";
export {
  type AlertFacts,
  alertText,
  type BudgetFact,
  type MerchantFact,
} from "./templates.ts";
