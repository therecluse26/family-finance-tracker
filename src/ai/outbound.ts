import type { LanguageModelMiddleware } from "ai";
import type { AiProviderName, AiUse } from "./ai-view.ts";
import type { AiCost } from "./cost.ts";
import { type CallTokens, costOf, type ModelPrice, nanosOfDollars } from "./prices.ts";

// The cost gate and the cost count (spec 10, Module seams: `ai`). src/ai/call.ts, the one AI call
// path, stacks costMiddleware on every model it hands out, behind the privacy filter, so every
// model call, one round of Chat included, first passes the filter, then its gate, then has its
// cost counted from the reply's usage. While the AI request log is on, it also hands the log the
// filtered request and the reply (spec 08, AI request log). This file imports nothing but types
// from the AI SDK.

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
  // The Chat thread a Chat answer's calls are for. The AI request log links their text to it.
  chatThreadId?: string;
};

// A model call's request, as the AI SDK hands it to the model: after the privacy filter.
export type CallOptions = Parameters<
  NonNullable<LanguageModelMiddleware["transformParams"]>
>[0]["params"];

// One part of a reply that the AI request log keeps: the AI's text, its reasoning, or a tool call
// with its input as the AI wrote it.
export type ReplyPart =
  | { type: "text" | "reasoning"; text: string }
  | { type: "tool call"; toolName: string; input: string };

// The AI request log, as the cost middleware sees it (src/ai/request-log.ts).
export type CallLog = {
  // Runs after the gate, before the call goes out. Undefined while the log keeps nothing.
  start(params: CallOptions): Promise<KeptCall | undefined>;
};

export type KeptCall = {
  // Runs once, when the call ends: with its AI usage row's ID when it counted, the reply so far,
  // and the error when it failed. It never throws, so the log never fails a call.
  end(end: {
    aiCallId: number | undefined;
    reply: readonly ReplyPart[];
    error?: unknown;
  }): Promise<void>;
};

// Adds a streamed piece of text or reasoning to the reply.
function addPiece(reply: ReplyPart[], type: "text" | "reasoning", piece: string): void {
  const last = reply.at(-1);
  if (last !== undefined && last.type === type) last.text += piece;
  else reply.push({ type, text: piece });
}

type GeneratedContent = Awaited<
  ReturnType<Parameters<NonNullable<LanguageModelMiddleware["wrapGenerate"]>>[0]["doGenerate"]>
>["content"];

// The parts of a reply the log keeps, from a generated reply's content.
function replyOf(content: GeneratedContent): ReplyPart[] {
  const reply: ReplyPart[] = [];
  for (const part of content) {
    if (part.type === "text" || part.type === "reasoning") {
      addPiece(reply, part.type, part.text);
    } else if (part.type === "tool-call") {
      reply.push({ type: "tool call", toolName: part.toolName, input: part.input });
    }
  }
  return reply;
}

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

// What a streamed call that ended before its finish part failed with, for the AI request log.
export const STREAM_CUT = Object.freeze({ name: "StreamCut" });

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

// The cost check before each model call and the cost count after it, and the AI request log's
// copy of the call when `log` keeps one.
export function costMiddleware(call: OutboundCall, log?: CallLog): LanguageModelMiddleware {
  async function pass(): Promise<void> {
    const pause = await call.gate();
    if (pause !== undefined) throw new AiPausedError(pause);
  }

  // Returns the AI usage row's ID.
  async function count(usage: ProviderUsage, metadata: ProviderMetadata): Promise<number> {
    const tokens = tokensOf(usage);
    const replyCost = call.provider === "openrouter" ? openRouterCost(metadata) : undefined;
    return call.cost.record({
      use: call.use,
      provider: call.provider,
      model: call.model,
      ...tokens,
      costNanos: replyCost === undefined ? costOf(tokens, call.price) : nanosOfDollars(replyCost),
    });
  }

  return {
    wrapGenerate: async ({ doGenerate, params }) => {
      await pass();
      const kept = await log?.start(params);
      let result: Awaited<ReturnType<typeof doGenerate>>;
      try {
        result = await doGenerate();
      } catch (error) {
        // A failed call counts nothing, so its kept text has no AI usage row.
        await kept?.end({ aiCallId: undefined, reply: [], error });
        throw error;
      }
      const aiCallId = await count(result.usage, result.providerMetadata);
      await kept?.end({ aiCallId, reply: replyOf(result.content) });
      return result;
    },
    // A streamed call is counted once: at its finish part, or, when it is closed or fails first,
    // from the prompt's rough input tokens and the output that came. A sent call always counts.
    wrapStream: async ({ doStream, params }) => {
      await pass();
      const kept = await log?.start(params);
      let opened: Awaited<ReturnType<typeof doStream>>;
      try {
        opened = await doStream();
      } catch (error) {
        await kept?.end({ aiCallId: undefined, reply: [], error });
        throw error;
      }
      const { stream, ...rest } = opened;
      const reader = stream.getReader();
      let counted = false;
      let aiCallId: number | undefined;
      let outputText = "";
      // The reply so far, and the first error the stream sent as a part, for the log.
      const reply: ReplyPart[] = [];
      let streamError: { error: unknown } | undefined;
      let ended = false;
      async function countOnce(usage: ProviderUsage, metadata: ProviderMetadata): Promise<void> {
        if (counted) return;
        counted = true;
        aiCallId = await count(usage, metadata);
      }
      // The log's copy, once: when the finish part comes, or when the stream ends, fails, or is
      // closed first. A stream cut off before its finish part ends with `cut`.
      async function endOnce(failure?: { error: unknown }): Promise<void> {
        if (ended || kept === undefined) return;
        ended = true;
        const error = streamError ?? failure;
        await kept.end({ aiCallId, reply, ...(error === undefined ? {} : { error: error.error }) });
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
                await endOnce({ error });
              } finally {
                controller.error(error);
              }
              return;
            }
            if (next.done) {
              const cut = !counted;
              await countCut();
              await endOnce(cut && streamError === undefined ? { error: STREAM_CUT } : undefined);
              controller.close();
              return;
            }
            const part = next.value;
            if (part.type === "text-delta" || part.type === "reasoning-delta") {
              outputText += part.delta;
              addPiece(reply, part.type === "text-delta" ? "text" : "reasoning", part.delta);
            } else if (part.type === "tool-call") {
              reply.push({ type: "tool call", toolName: part.toolName, input: part.input });
            } else if (part.type === "error" && streamError === undefined) {
              streamError = { error: part.error };
            }
            if (part.type === "finish") {
              await countOnce(part.usage, part.providerMetadata);
              await endOnce();
            }
            controller.enqueue(part);
          },
          async cancel(reason) {
            try {
              await countCut();
              await endOnce({ error: STREAM_CUT });
            } finally {
              await reader.cancel(reason);
            }
          },
        }),
      };
    },
  };
}
