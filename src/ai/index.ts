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
export type { AiCall, AiMessage } from "./call.ts";
export { type AiCost, aiCost, type CountedCall } from "./cost.ts";
export { type AiReply, type HouseholdAi, householdAi } from "./household-ai.ts";
export { type AiPause, AiPausedError } from "./outbound.ts";
export { PrivacyRefusal } from "./privacy.ts";
export type { AiConnection, AiModelMaker } from "./providers.ts";
export { type AiGates, type AiOptions, aiSettings, defaultGates } from "./settings.ts";
