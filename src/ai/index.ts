// The ai module's interface. Other modules import from here. It is the only module that imports
// the AI SDK and the AI provider packages. householdAi is the one way to call the AI: no model
// leaves this module, and every call passes the cost gate.

export {
  aiActivity,
  aiActivityWatchers,
  showRunActivity,
  startAiActivity,
} from "./activity.ts";
export {
  AI_PROVIDERS,
  AI_USES,
  type AiProviderName,
  type AiSave,
  type AiSettings,
  type AiSettingsInput,
  type AiStatus,
  type AiTier,
  type AiUsageView,
  type AiUse,
  type AiView,
  type BaseUrlProblem,
  baseUrlProblem,
  DEFAULT_COST_CAP_CENTS,
  DEFAULT_MODELS,
  type KeyTest,
  type KeyTestResult,
  type ModelCheck,
  type ModelUse,
  onGateway,
} from "./ai-view.ts";
export { AiCallError, type AiFailure, type StreamEnd } from "./call.ts";
export { type AiCost, aiCost, type CountedCall } from "./cost.ts";
export {
  type AiReply,
  BAD_REPLIES_IN_A_ROW,
  generateBatch,
  type HouseholdAi,
  householdAi,
} from "./household-ai.ts";
export { type AiPause, AiPausedError } from "./outbound.ts";
export {
  type AiCall,
  type AiMessage,
  type AiSchema,
  type AiTool,
  type AiTools,
  aiTool,
  type BatchItem,
  batchReply,
  QUICK_BATCH_SIZE,
  type SummaryPart,
} from "./prompt.ts";
export type { AiConnection, AiModelMaker } from "./providers.ts";
export {
  AI_REQUEST_LOG_CLEANUP_CAP,
  AI_REQUEST_LOG_CLEANUP_STOPPED,
  AI_REQUEST_LOG_MAX_BYTES,
  AI_REQUEST_LOG_PAGE,
  AiRequestLogCleanupJob,
  type AiRequestLogOptions,
  aiRequestLogRoutes,
  cleanUpAiRequestLog,
  startAiRequestLogCleanup,
} from "./request-log.ts";
export type { AiRequestLogPage, AiRequestLogRoutes } from "./request-log-view.ts";
export {
  AiRetryJob,
  type AiRetryRunner,
  FOLLOW_UP_AI_USES,
  MONTHLY_REVIEW_RETRY_MS,
  RETRY_DELAYS_MS,
  runAiRetries,
  startAiRetries,
} from "./retries.ts";
export {
  type AiGates,
  type AiNotices,
  type AiOptions,
  aiSettings,
  defaultGates,
  KEY_REJECTED_CONDITION,
} from "./settings.ts";
export {
  type TypedValue,
  typedAmount,
  typedCount,
  typedDate,
  typedMonth,
} from "./typed.ts";
export { FIXED_RULES, plainVoice } from "./voice.ts";
