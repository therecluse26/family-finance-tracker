// Test support: AI SDK test models and a fetch that captures each request, so no test calls an AI
// provider. Keys and tokens are made up when the test runs. Never real keys.
import { APICallError, type ProviderMetadata, simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { Database } from "../db/index.ts";
import { newTestDatabase } from "../db/testing.ts";
import { createLogger } from "../log.ts";
import { type Secrets, unlockSecrets } from "../secrets/index.ts";
import { newMasterKey } from "../secrets/testing.ts";
import type { AiTier, TierModels } from "./ai-view.ts";
import type { AiConnection, AiModelMaker } from "./providers.ts";

export type TestAi = { database: Database; secrets: Secrets; close(): void };

export async function newTestAi(): Promise<TestAi> {
  const db = await newTestDatabase();
  const quiet = createLogger(() => {}, { throwOnSecretField: true });
  const secrets = await unlockSecrets(db.database, newMasterKey().masterKey, { logger: quiet });
  return { database: db.database, secrets, close: db.close };
}

// A tool's answer as the AI reads it: plain JSON data.
export function asTheAiReads(answer: unknown): unknown {
  return JSON.parse(JSON.stringify(answer));
}

// A made-up API key or gateway token: letters and digits, as AI providers' dashboards show them.
export function newAiKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export type CapturedRequest = {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  redirect: RequestInit["redirect"];
};

const OK_REPLY = "O";

// A fetch that keeps each request and answers with `status`. A 200 answer is a 1-token reply in
// Anthropic's Messages shape, or in OpenAI's Chat Completions shape, which OpenRouter and
// OpenAI-compatible endpoints share.
export class CapturingFetch {
  status = 200;
  readonly requests: CapturedRequest[] = [];

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    this.requests.push({ url, headers, body, redirect: init?.redirect });
    const model = String(body.model ?? "");
    const answer =
      this.status !== 200
        ? { error: { message: "refused", type: "authentication_error" } }
        : url.endsWith("/messages")
          ? {
              id: "msg_test",
              type: "message",
              role: "assistant",
              model,
              content: [{ type: "text", text: OK_REPLY }],
              stop_reason: "max_tokens",
              usage: { input_tokens: 5, output_tokens: 1 },
            }
          : {
              id: "chatcmpl-test",
              object: "chat.completion",
              created: 1_790_000_000,
              model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: OK_REPLY },
                  finish_reason: "length",
                },
              ],
              usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
            };
    return new Response(JSON.stringify(answer), {
      status: this.status,
      headers: { "content-type": "application/json" },
    });
  };
}

// How a test model answers its one call: a 1-token reply, a 401 as for a rejected key, a 429 as
// for a rate limit, a 404 as for a model the AI provider does not know, a 500, a thrown error, or
// no answer until the call is aborted. Each failure
// holds the key and the gateway token, in its message, its request, and its config, as an AI
// provider SDK's error can.
export type StubAnswer =
  | "work"
  | "reject"
  | "rate limit"
  | "unknown model"
  | "bad request"
  | "fail"
  | "throw"
  | "hang";

const STUB_STATUS = {
  reject: 401,
  "rate limit": 429,
  "unknown model": 404,
  "bad request": 400,
  fail: 500,
} as const;

// A reply's token counts, as an AI provider reports them.
export type StubUsage = {
  noCache: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
};

// One message of a request, as the model gets it.
export type StubMessage = {
  role: string;
  content: string | readonly { type: string; text?: string; output?: unknown }[];
};

// One part of a streamed reply, as a model sends it.
type StreamPart =
  Awaited<ReturnType<MockLanguageModelV4["doStream"]>>["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

// A tool call a test model makes: the tool's name and its input.
export type StubToolCall = { toolName: string; input: unknown };

export class StubModels {
  answers: Record<AiTier, StubAnswer> = { quick: "work", writer: "work", chat: "work" };
  // What each reply that works says, and its usage and provider metadata.
  reply = OK_REPLY;
  // When set, makes each reply that works from the request's messages in place of `reply`, such as
  // a Quick batch's answers to the rows it was sent.
  replyTo: ((messages: StubMessage[]) => string) | undefined;
  // Why each text reply ends: "length" for one cut off at its reply limit.
  finishReason: "stop" | "length" = "stop";
  // When set, each text reply starts with reasoning whose text the AI provider hides, as
  // Anthropic's Claude 5 models send it by default: a reasoning part with no text.
  hiddenReasoning = false;
  // When set, a reply that works calls these tools in place of a text reply, while it returns any.
  callTools: ((messages: StubMessage[]) => readonly StubToolCall[]) | undefined;
  // The tools each call offered by name, and its tool choice, such as "auto" or "none".
  readonly offered: { tools: string[]; toolChoice: string | undefined }[] = [];
  // The messages of each request, as the model got them.
  readonly prompts: StubMessage[][] = [];
  // The JSON schema each request asked its reply to fit, or undefined for a text reply.
  readonly schemas: unknown[] = [];
  usage: StubUsage = { noCache: 5, cacheRead: 0, cacheWrite: 0, output: 1 };
  providerMetadata: ProviderMetadata | undefined;
  readonly connections: AiConnection[] = [];
  // Each call's tier, model, reply limit, and the effort it sent under its AI provider's own
  // option name.
  readonly calls: {
    tier: AiTier;
    modelId: string;
    maxOutputTokens: number | undefined;
    effort?: string;
  }[] = [];
  // Runs before each answer, so a test can act while the AI provider is answering.
  beforeAnswer: () => Promise<void> = async () => {};
  // A streamed reply that fails after its text and before its finish part, with its usage.
  streamFails = false;
  // A streamed reply's text and tool input go out in pieces of this many characters, or in one.
  streamPiece: number | undefined;
  // How many web searches the AI provider runs in each Merchant lookup before its reply. Each shows
  // in the reply as a provider-executed tool call and its result, as a real provider's does.
  searches = 1;
  // How the lookup model answers, in place of the Quick model's answer, when set.
  lookupAnswer: StubAnswer | undefined;

  readonly makeModels: AiModelMaker = (connection, models: TierModels) => {
    this.connections.push(connection);
    // The lookup model is the Quick model with the provider's web search (spec 08, Merchant web
    // lookup). A custom model has none.
    const model = (tier: AiTier, lookup = false) =>
      new MockLanguageModelV4({
        provider: connection.provider,
        modelId: models[tier],
        doGenerate: async (options) => {
          this.calls.push({
            tier,
            modelId: models[tier],
            maxOutputTokens: options.maxOutputTokens,
            ...effortSent(connection, options.providerOptions),
          });
          this.prompts.push(options.prompt as StubMessage[]);
          this.schemas.push(
            options.responseFormat?.type === "json" ? options.responseFormat.schema : undefined,
          );
          this.offered.push({
            tools: (options.tools ?? []).map((each) => each.name),
            toolChoice: options.toolChoice?.type,
          });
          await this.beforeAnswer();
          if (this.answers[tier] === "hang") await aborted(options.abortSignal);
          return this.answer(
            tier,
            connection,
            options.prompt as StubMessage[],
            options.toolChoice?.type !== "none",
            lookup,
          );
        },
        doStream: async (options) => {
          this.calls.push({
            tier,
            modelId: models[tier],
            maxOutputTokens: options.maxOutputTokens,
            ...effortSent(connection, options.providerOptions),
          });
          this.prompts.push(options.prompt as StubMessage[]);
          this.schemas.push(
            options.responseFormat?.type === "json" ? options.responseFormat.schema : undefined,
          );
          this.offered.push({
            tools: (options.tools ?? []).map((each) => each.name),
            toolChoice: options.toolChoice?.type,
          });
          await this.beforeAnswer();
          if (this.answers[tier] === "hang") await aborted(options.abortSignal);
          const { content, usage, finishReason, providerMetadata } = this.answer(
            tier,
            connection,
            options.prompt as StubMessage[],
            options.toolChoice?.type !== "none",
            lookup,
          );
          if (this.streamFails) {
            const text = this.reply;
            let sent = false;
            return {
              stream: new ReadableStream({
                pull(controller) {
                  if (sent) return controller.error(new Error("The connection dropped."));
                  sent = true;
                  controller.enqueue({ type: "text-delta" as const, id: "1", delta: text });
                },
              }),
            };
          }
          const pieces = (text: string) => {
            const size = this.streamPiece ?? Math.max(text.length, 1);
            const each: string[] = [];
            for (let start = 0; start < text.length; start += size) {
              each.push(text.slice(start, start + size));
            }
            return each;
          };
          return {
            stream: simulateReadableStream<StreamPart>({
              chunks: [
                ...content.flatMap((part): StreamPart[] =>
                  part.type === "tool-result"
                    ? [part]
                    : part.type === "reasoning"
                      ? [
                          { type: "reasoning-start" as const, id: "0" },
                          { type: "reasoning-end" as const, id: "0" },
                        ]
                      : part.type === "text"
                        ? [
                            { type: "text-start" as const, id: "1" },
                            ...pieces(part.text).map((delta) => ({
                              type: "text-delta" as const,
                              id: "1",
                              delta,
                            })),
                            { type: "text-end" as const, id: "1" },
                          ]
                        : [
                            {
                              type: "tool-input-start" as const,
                              id: part.toolCallId,
                              toolName: part.toolName,
                            },
                            ...pieces(part.input).map((delta) => ({
                              type: "tool-input-delta" as const,
                              id: part.toolCallId,
                              delta,
                            })),
                            { type: "tool-input-end" as const, id: part.toolCallId },
                            part,
                          ],
                ),
                {
                  type: "finish" as const,
                  finishReason,
                  usage,
                  ...(providerMetadata === undefined ? {} : { providerMetadata }),
                },
              ],
            }),
          };
        },
      });
    return {
      quick: model("quick"),
      writer: model("writer"),
      chat: model("chat"),
      ...(connection.provider === "openai-compatible" ? {} : { lookup: model("quick", true) }),
    };
  };

  private answer(
    tier: AiTier,
    connection: AiConnection,
    messages: StubMessage[],
    mayCall = false,
    lookup = false,
  ) {
    const secrets = `${connection.apiKey ?? ""} ${connection.gatewayToken ?? ""}`;
    const headers = {
      authorization: `Bearer ${connection.apiKey ?? ""}`,
      "cf-aig-authorization": `Bearer ${connection.gatewayToken ?? ""}`,
    };
    const answer = (lookup ? this.lookupAnswer : undefined) ?? this.answers[tier];
    if (
      answer === "reject" ||
      answer === "rate limit" ||
      answer === "unknown model" ||
      answer === "bad request" ||
      answer === "fail"
    ) {
      throw Object.assign(
        new APICallError({
          message: `Refused the key ${secrets}`,
          url: "https://ai.example.test/v1/chat/completions",
          requestBodyValues: { headers },
          statusCode: STUB_STATUS[answer],
          responseHeaders: headers,
          responseBody: secrets,
        }),
        { config: { headers } },
      );
    }
    if (answer === "throw") {
      throw Object.assign(new Error(`connect ETIMEDOUT ${secrets}`), { config: { headers } });
    }
    const { noCache, cacheRead, cacheWrite, output } = this.usage;
    const toolCalls = (mayCall ? this.callTools?.(messages) : undefined) ?? [];
    const searches = lookup
      ? Array.from({ length: this.searches }, (_, index) => [
          {
            type: "tool-call" as const,
            toolCallId: `search-${index + 1}`,
            toolName: "web_search",
            input: JSON.stringify({ query: "a business" }),
            providerExecuted: true,
          },
          {
            type: "tool-result" as const,
            toolCallId: `search-${index + 1}`,
            toolName: "web_search",
            result: [{ url: "https://shop.example/", title: "A shop", content: "A shop." }],
          },
        ]).flat()
      : [];
    return {
      content:
        toolCalls.length === 0
          ? [
              ...searches,
              ...(this.hiddenReasoning ? [{ type: "reasoning" as const, text: "" }] : []),
              { type: "text" as const, text: this.replyTo?.(messages) ?? this.reply },
            ]
          : toolCalls.map((call, index) => ({
              type: "tool-call" as const,
              toolCallId: `call-${index + 1}`,
              toolName: call.toolName,
              input: JSON.stringify(call.input),
            })),
      finishReason:
        toolCalls.length === 0
          ? { unified: this.finishReason, raw: this.finishReason }
          : { unified: "tool-calls" as const, raw: "tool_use" },
      usage: {
        inputTokens: { total: noCache + cacheRead + cacheWrite, noCache, cacheRead, cacheWrite },
        outputTokens: { total: output, text: output, reasoning: 0 },
      },
      ...(this.providerMetadata === undefined ? {} : { providerMetadata: this.providerMetadata }),
      warnings: [],
    };
  }
}

// The effort a call sent, read as its AI provider's package reads it: Anthropic's effort, OpenAI's
// reasoningEffort, or OpenRouter's reasoning.effort. An OpenAI-compatible endpoint reads none.
function effortSent(
  connection: AiConnection,
  options: Record<string, Record<string, unknown>> | undefined,
): { effort?: string } {
  const own = (name: string) => options?.[name];
  const effort =
    connection.provider === "anthropic"
      ? own("anthropic")?.effort
      : connection.provider === "openai"
        ? own("openai")?.reasoningEffort
        : connection.provider === "openrouter"
          ? (own("openrouter")?.reasoning as { effort?: unknown } | undefined)?.effort
          : undefined;
  return typeof effort === "string" ? { effort } : {};
}

// Waits until the call is aborted, then throws as fetch does.
function aborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    const abort = () =>
      reject(Object.assign(new Error("The call was aborted."), { name: "AbortError" }));
    if (signal?.aborted) abort();
    signal?.addEventListener("abort", abort, { once: true });
  });
}
