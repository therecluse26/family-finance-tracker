// The goals module's interface (spec 05, Goals). Other modules import from here.
export {
  type Goal,
  type GoalList,
  type GoalReading,
  type GoalStartResult,
  type GoalTarget,
  goalStartToday,
  listGoalsWithProgress,
  markGoal,
  readGoalsWithProgress,
  readingOf as goalReadingOf,
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
export {
  GOAL_READING_TASK,
  GOAL_WORDS_LENGTH,
  type GoalSaveRefusal,
  type GoalWriting,
  type GoalWritingOptions,
  goalReadingReply,
  goalWriting,
  READINGS_PER_HOUR,
} from "./reading.ts";
