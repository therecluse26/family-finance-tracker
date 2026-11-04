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
// for a rate limit, a 500, a thrown error, or no answer until the call is aborted. Each failure
// holds the key and the gateway token, in its message, its request, and its config, as an AI
// provider SDK's error can.
export type StubAnswer = "work" | "reject" | "rate limit" | "fail" | "throw" | "hang";

const STUB_STATUS = { reject: 401, "rate limit": 429, fail: 500 } as const;

// A reply's token counts, as an AI provider reports them.
export type StubUsage = {
  noCache: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
};

export class StubModels {
  answers: Record<AiTier, StubAnswer> = { quick: "work", writer: "work" };
  // What each reply that works says, and its usage and provider metadata.
  reply = OK_REPLY;
  usage: StubUsage = { noCache: 5, cacheRead: 0, cacheWrite: 0, output: 1 };
  providerMetadata: ProviderMetadata | undefined;
  readonly connections: AiConnection[] = [];
  readonly calls: { tier: AiTier; modelId: string; maxOutputTokens: number | undefined }[] = [];
  // Runs before each answer, so a test can act while the AI provider is answering.
  beforeAnswer: () => Promise<void> = async () => {};
  // A streamed reply that fails after its text and before its finish part, with its usage.
  streamFails = false;

  readonly makeModels: AiModelMaker = (connection, models: TierModels) => {
    this.connections.push(connection);
    const model = (tier: AiTier) =>
      new MockLanguageModelV4({
        provider: connection.provider,
        modelId: models[tier],
        doGenerate: async (options) => {
          this.calls.push({
            tier,
            modelId: models[tier],
            maxOutputTokens: options.maxOutputTokens,
          });
          await this.beforeAnswer();
          if (this.answers[tier] === "hang") await aborted(options.abortSignal);
          return this.answer(tier, connection);
        },
        doStream: async (options) => {
          this.calls.push({
            tier,
            modelId: models[tier],
            maxOutputTokens: options.maxOutputTokens,
          });
          await this.beforeAnswer();
          const { usage, finishReason, providerMetadata } = this.answer(tier, connection);
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
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "text-start" as const, id: "1" },
                { type: "text-delta" as const, id: "1", delta: this.reply },
                { type: "text-end" as const, id: "1" },
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
    return { quick: model("quick"), writer: model("writer") };
  };

  private answer(tier: AiTier, connection: AiConnection) {
    const secrets = `${connection.apiKey ?? ""} ${connection.gatewayToken ?? ""}`;
    const headers = {
      authorization: `Bearer ${connection.apiKey ?? ""}`,
      "cf-aig-authorization": `Bearer ${connection.gatewayToken ?? ""}`,
    };
    const answer = this.answers[tier];
    if (answer === "reject" || answer === "rate limit" || answer === "fail") {
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
    return {
      content: [{ type: "text" as const, text: this.reply }],
      finishReason: { unified: "length" as const, raw: "length" },
      usage: {
        inputTokens: { total: noCache + cacheRead + cacheWrite, noCache, cacheRead, cacheWrite },
        outputTokens: { total: output, text: output, reasoning: 0 },
      },
      ...(this.providerMetadata === undefined ? {} : { providerMetadata: this.providerMetadata }),
      warnings: [],
    };
  }
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
