// The money-movement module's interface (spec 03, Money movement). Other modules import from here.
export {
  decideProvisionalAgain,
  ProvisionalResultsJob,
  readTransactionDecision,
  runMatching,
  setTransactionType,
  startMoneyMovement,
  type TransactionDecision,
} from "./matching.ts";
export {
  DECISION_STEPS,
  type Decision,
  type DecisionInput,
  type DecisionRule,
  type DecisionStep,
  type Part,
  registerDecisionRule,
  whole,
} from "./order.ts";
export { type MonthTotals, monthOf, totalsByMonth } from "./totals.ts";
export {
  HAND_SET_TYPES,
  type HandSetType,
  TRANSACTION_TYPES,
  type TransactionType,
} from "./types.ts";
