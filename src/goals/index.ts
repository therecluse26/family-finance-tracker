// The goals module's interface (spec 05, Goals). Other modules import from here.
export {
  type Goal,
  type GoalList,
  type GoalReading,
  type GoalStartResult,
  type GoalTarget,
  listGoalsWithProgress,
  markGoal,
  startGoal,
} from "./goals.ts";
export {
  type GoalChange,
  type GoalKind,
  type GoalProgress,
  type GoalState,
  goalAmountFrom,
  NO_GOAL_AMOUNT,
} from "./progress.ts";
