import { type LanguageModel, type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import type { AiProviderName, AiUse } from "./ai-view.ts";
import type { AiCost } from "./cost.ts";
import { type CallTokens, costOf, type ModelPrice, nanosOfDollars } from "./prices.ts";

// The one place every AI call leaves the app (spec 10, Module seams: `ai`). Each model the app
// hands out is wrapped here, so every model call, one round of Chat included, first passes its
// gate, then has its cost counted from the reply's usage. The check and the count live in
// costMiddleware, which imports nothing but types from the AI SDK, so a single call path, such as
// the privacy filter's, can stack it on the same wrap.

// Why an AI use takes its no-AI path instead of a call.
export type AiPause =
  | "no AI provider"
  | "waits for history"
  | "key rejected"
  // Background AI at the AI cost cap.
  | "cost cap"
  // Chat or reading a Goal at the AI cost cap: the screen asks the Member first.
  | "send anyway?"
  // A model with no price makes no call.
  | "no price";

// A model call stopped by its gate. A call already running finishes.
export class AiPausedError extends Error {
  readonly pause: AiPause;
  constructor(pause: AiPause) {
    super(`AI is paused: ${pause}.`);
    this.name = "AiPausedError";
    this.pause = pause;
  }
}

export type OutboundCall = {
  use: AiUse;
  provider: AiProviderName;
  model: string;
  price: ModelPrice;
  // Runs before each model call. A pause starts no call.
  gate: () => Promise<AiPause | undefined>;
  cost: AiCost;
};

// A model's usage and provider metadata, as the AI SDK's language model interface reports them.
type ProviderUsage = {
  inputTokens: {
    total: number | undefined;
    noCache: number | undefined;
    cacheRead: number | undefined;
    cacheWrite: number | undefined;
  };
  outputTokens: { total: number | undefined };
};
type ProviderMetadata = Record<string, Record<string, unknown>> | undefined;

type PartOf<S> = S extends ReadableStream<infer Part> ? Part : never;

// About 4 characters a token: a rough count for a streamed reply that ended before its usage came.
const roughTokens = (text: string) => Math.ceil(text.length / 4);

// The AI SDK's usage.inputTokenDetails and output tokens, from the provider's usage. An AI
// provider that reports only the input total has no cached tokens.
function tokensOf(usage: ProviderUsage): CallTokens {
  const cacheReadTokens = usage.inputTokens.cacheRead ?? 0;
  const cacheWriteTokens = usage.inputTokens.cacheWrite ?? 0;
  return {
    noCacheTokens:
      usage.inputTokens.noCache ??
      Math.max(0, (usage.inputTokens.total ?? 0) - cacheReadTokens - cacheWriteTokens),
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: usage.outputTokens.total ?? 0,
  };
}

// On OpenRouter, the reply's own usage.cost in dollars, which replaces the price table.
function openRouterCost(metadata: ProviderMetadata): number | undefined {
  const usage = metadata?.openrouter?.usage;
  if (typeof usage !== "object" || usage === null || !("cost" in usage)) return undefined;
  const { cost } = usage;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

// The cost check before each model call and the cost count after it.
export function costMiddleware(call: OutboundCall): LanguageModelMiddleware {
  async function pass(): Promise<void> {
    const pause = await call.gate();
    if (pause !== undefined) throw new AiPausedError(pause);
  }

  async function count(usage: ProviderUsage, metadata: ProviderMetadata): Promise<void> {
    const tokens = tokensOf(usage);
    const replyCost = call.provider === "openrouter" ? openRouterCost(metadata) : undefined;
    await call.cost.record({
      use: call.use,
      provider: call.provider,
      model: call.model,
      ...tokens,
      costNanos: replyCost === undefined ? costOf(tokens, call.price) : nanosOfDollars(replyCost),
    });
  }

  return {
    wrapGenerate: async ({ doGenerate }) => {
      await pass();
      const result = await doGenerate();
      await count(result.usage, result.providerMetadata);
      return result;
    },
    // A streamed call is counted once: at its finish part, or, when it is closed or fails first,
    // from the prompt's rough input tokens and the output that came. A sent call always counts.
    wrapStream: async ({ doStream, params }) => {
      await pass();
      const { stream, ...rest } = await doStream();
      const reader = stream.getReader();
      let counted = false;
      let outputText = "";
      async function countOnce(usage: ProviderUsage, metadata: ProviderMetadata): Promise<void> {
        if (counted) return;
        counted = true;
        await count(usage, metadata);
      }
      const countCut = () =>
        countOnce(
          {
            inputTokens: {
              total: roughTokens(JSON.stringify(params.prompt)),
              noCache: undefined,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: roughTokens(outputText) },
          },
          undefined,
        );
      return {
        ...rest,
        stream: new ReadableStream<PartOf<typeof stream>>({
          async pull(controller) {
            let next: Awaited<ReturnType<typeof reader.read>>;
            try {
              next = await reader.read();
            } catch (error) {
              try {
                await countCut();
              } finally {
                controller.error(error);
              }
              return;
            }
            if (next.done) {
              await countCut();
              controller.close();
              return;
            }
            const part = next.value;
            if (part.type === "finish") await countOnce(part.usage, part.providerMetadata);
            if (part.type === "text-delta" || part.type === "reasoning-delta") {
              outputText += part.delta;
            }
            controller.enqueue(part);
          },
          async cancel(reason) {
            try {
              await countCut();
            } finally {
              await reader.cancel(reason);
            }
          },
        }),
      };
    },
  };
}

export function outbound(model: LanguageModel, call: OutboundCall): LanguageModel {
  if (typeof model === "string") throw new TypeError("A model is never a plain model-ID string.");
  return wrapLanguageModel({ model, middleware: costMiddleware(call) });
}
