// The anomalies module's interface (spec 06, Anomalies; What an Alert says; The Alert list).
// Other modules import from here.
export {
  type Alert,
  alertList,
  alertsHeldBack,
  type MergedAlert,
  mergedAlertList,
} from "./alert-list.ts";
export {
  ALERT_NOTE_MS,
  type AlertNote,
  type AlertNoteGroup,
  alertNotes,
  markAlertNote,
} from "./alert-notes.ts";
export {
  ANOMALY_CHECKS_CAP,
  ANOMALY_CHECKS_STOPPED,
  checkAnomalies,
  startAnomalyChecks,
} from "./checks.ts";
export { markNotAProblem } from "./not-a-problem.ts";
export {
  checkOverspending,
  OVERSPENDING_CHECKS_CAP,
  OVERSPENDING_CHECKS_STOPPED,
  startOverspendingChecks,
} from "./overspending.ts";
export { type PriceIncrease, priceIncreases } from "./price-increase.ts";
export {
  ALERT_SENDING_CAP,
  ALERT_SENDING_STOPPED,
  DEFAULT_WEEKLY_CAP,
  decideAlerts,
  setWeeklyCap,
  startAlertSending,
  weeklyCap,
} from "./sending.ts";
export {
  type AlertFacts,
  alertText,
  type BudgetFact,
  type MerchantFact,
  mergedHeading,
} from "./templates.ts";
