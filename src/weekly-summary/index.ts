// The weekly summary email's interface (spec 06, Weekly summary email). Other modules import from
// here.
export {
  buildWeeklySummary,
  COMING_UP_SHOWN,
  USUAL_WEEKS,
  type WeeklySummaryEmail,
} from "./build.ts";
export {
  type SummaryRun,
  sendWeeklySummaries,
  startWeeklySummary,
  WEEKLY_SUMMARY_RETRY_DELAYS_MS,
  WEEKLY_SUMMARY_STALE_MS,
  WEEKLY_SUMMARY_STOPPED,
  WEEKLY_SUMMARY_TRIES_CAP,
  WeeklySummaryJob,
  weeklySummarySettings,
} from "./sending.ts";
export type { WeeklySummarySettings, WeeklySummaryView } from "./view.ts";
export {
  SUMMARY_TIME,
  SUNDAY_MORNING,
  type SummaryWeek,
  summaryWeek,
  weekFrom,
} from "./week.ts";
