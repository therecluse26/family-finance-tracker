// The ai module's interface. Other modules import from here. It is the only module that imports
// the AI SDK and the AI provider packages. householdAi is the one way to call the AI: no model
// leaves this module, and every call passes the privacy filter, then the cost gate.
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
  type ModelCheck,
  type ModelUse,
  onGateway,
} from "./ai-view.ts";
export { AiCallError, type AiFailure, type StreamEnd } from "./call.ts";
export { type AiCost, aiCost, type CountedCall } from "./cost.ts";
export { type AiReply, type HouseholdAi, householdAi } from "./household-ai.ts";
export { type AiPause, AiPausedError } from "./outbound.ts";
export { PrivacyRefusal } from "./privacy.ts";
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
  AiRetryJob,
  type AiRetryRunner,
  FOLLOW_UP_AI_USES,
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
