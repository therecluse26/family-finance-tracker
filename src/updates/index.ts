// The updates module's interface (spec 12, Updates). Other modules import from here.
export {
  type AvailableUpdate,
  GITHUB_API,
  startUpdateCheck,
  switchUpdateCheck,
  type UpdateCheckFailure,
  UpdateCheckJob,
  type UpdateCheckOptions,
  type UpdateCheckResult,
  type UpdateStatus,
  updateStatus,
} from "./update-check.ts";
