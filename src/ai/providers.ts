import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { type LanguageModel, wrapLanguageModel } from "ai";
import { type AiProviderName, type AiTier, onGateway, type TierModels } from "./ai-view.ts";

// Every model the app uses comes from here, built from a provider instance (spec 10, Module
// seams). A plain model-ID string would go to Vercel's AI Gateway, so the app never passes one.
// Each model carries its AI provider's data-use setting on every call (spec 08, AI providers and
// their data-use settings).

// The AI provider, the decrypted secrets, and where they go.
export type AiConnection = {
  provider: AiProviderName;
  apiKey: string | undefined;
  baseUrl: string | null;
  gatewayToken: string | undefined;
};

export type AiModels = Record<AiTier, LanguageModel>;

export type AiModelMaker = (connection: AiConnection, models: TierModels) => AiModels;

// Written out, so no environment variable, such as OPENAI_BASE_URL, can send the key elsewhere.
const DEFAULT_BASE_URLS: Record<Exclude<AiProviderName, "openai-compatible">, string> = {
  anthropic: "https://api.anthropic.com/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

// The API key travels in a header on every request. fetch drops Authorization on a redirect to
// another host, but not x-api-key or cf-aig-authorization, so the app follows no redirect.
export function noRedirects(base: typeof fetch): typeof fetch {
  return (input, init) => base(input, { ...init, redirect: "error" });
}

// Cloudflare AI Gateway keeps the model, tokens, and cost, but no prompt text, with this header.
function gatewayHeaders(connection: AiConnection): Record<string, string> {
  if (!onGateway(connection.baseUrl)) return {};
  return {
    "cf-aig-collect-log-payload": "false",
    ...(connection.gatewayToken === undefined
      ? {}
      : { "cf-aig-authorization": `Bearer ${connection.gatewayToken}` }),
  };
}

// OpenAI stores each call unless told not to. The AI SDK's default is store: true, so every call
// through this model sends store: false, whatever the caller passed.
function withStoreOff(model: LanguageModel): LanguageModel {
  if (typeof model === "string") throw new TypeError("A model is never a plain model-ID string.");
  return wrapLanguageModel({
    model,
    middleware: {
      transformParams: async ({ params }) => ({
        ...params,
        providerOptions: {
          ...params.providerOptions,
          openai: { ...params.providerOptions?.openai, store: false },
        },
      }),
    },
  });
}

export function makeFetchModels(base: typeof fetch = fetch): AiModelMaker {
  const guarded = noRedirects(base);
  return (connection, models) => {
    const headers = gatewayHeaders(connection);
    const { apiKey } = connection;
    switch (connection.provider) {
      // Anthropic needs no setting. The app never sends it feedback.
      case "anthropic": {
        const anthropic = createAnthropic({
          apiKey,
          baseURL: connection.baseUrl ?? DEFAULT_BASE_URLS.anthropic,
          headers,
          fetch: guarded,
        });
        return { quick: anthropic(models.quick), writer: anthropic(models.writer) };
      }
      // Chat Completions, which takes a 1-token reply for the check on save.
      case "openai": {
        const openai = createOpenAI({
          apiKey,
          baseURL: connection.baseUrl ?? DEFAULT_BASE_URLS.openai,
          headers,
          fetch: guarded,
        });
        return {
          quick: withStoreOff(openai.chat(models.quick)),
          writer: withStoreOff(openai.chat(models.writer)),
        };
      }
      // OpenRouter's default is data_collection: "allow". Every call from these models denies it.
      case "openrouter": {
        const openrouter = createOpenRouter({
          apiKey,
          baseURL: connection.baseUrl ?? DEFAULT_BASE_URLS.openrouter,
          headers,
          compatibility: "strict",
          fetch: guarded,
        });
        const settings = { provider: { data_collection: "deny" as const } };
        return {
          quick: openrouter.chat(models.quick, settings),
          writer: openrouter.chat(models.writer, settings),
        };
      }
      // No setting is possible. The settings page says the app cannot check its data use.
      case "openai-compatible": {
        if (connection.baseUrl === null) {
          throw new TypeError("An OpenAI-compatible endpoint needs a base URL.");
        }
        const endpoint = createOpenAICompatible({
          name: "openai-compatible",
          baseURL: connection.baseUrl,
          ...(apiKey === undefined ? {} : { apiKey }),
          headers,
          fetch: guarded,
        });
        return { quick: endpoint(models.quick), writer: endpoint(models.writer) };
      }
    }
  };
}
