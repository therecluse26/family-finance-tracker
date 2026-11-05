// The tailoring module's interface (spec 05, The AI's part in a draft; Which Proposals exist).
// Other modules import from here.

export {
  afterSteadyIncomeTyped,
  checkBenchmarkRedraft,
  checkIncomeRedraft,
  checkNewBankRedraft,
  factsRedraft,
  type RedraftTrigger,
  startRedrafts,
} from "./redrafts.ts";
export {
  BudgetTailoringJob,
  REDRAFT_STOPPED_TEXT,
  requestGoalTailoring,
  requestTailoringJob,
  runWaitingTailoring,
  startBudgetTailoring,
  TAILORING_RUN_CAP,
  TAILORING_STOPPED_TEXT,
  tailorFirstDraft,
} from "./runs.ts";
export { TAILORING_TASK, type TailoringReply, tailoringReply } from "./tailoring.ts";
