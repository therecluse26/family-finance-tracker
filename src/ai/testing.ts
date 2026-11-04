// Test support: AI SDK test models and a fetch that captures each request, so no test calls an AI
// provider. Keys and tokens are made up when the test runs. Never real keys.
import { APICallError } from "ai";
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

// How a test model answers its one call: a 1-token reply, a 401 as for a rejected key, or a
// failure. Each failure holds the key and the gateway token, in its message, its request, and its
// config, as an AI provider SDK's error can.
export type StubAnswer = "work" | "reject" | "fail" | "throw";

export class StubModels {
  answers: Record<AiTier, StubAnswer> = { quick: "work", writer: "work" };
  readonly connections: AiConnection[] = [];
  readonly calls: { tier: AiTier; modelId: string; maxOutputTokens: number | undefined }[] = [];
  // Runs before each answer, so a test can act while the AI provider is answering.
  beforeAnswer: () => Promise<void> = async () => {};

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
          return this.answer(tier, connection);
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
    if (answer === "reject" || answer === "fail") {
      throw Object.assign(
        new APICallError({
          message: `Refused the key ${secrets}`,
          url: "https://ai.example.test/v1/chat/completions",
          requestBodyValues: { headers },
          statusCode: answer === "reject" ? 401 : 500,
          responseHeaders: headers,
          responseBody: secrets,
        }),
        { config: { headers } },
      );
    }
    if (answer === "throw") {
      throw Object.assign(new Error(`connect ETIMEDOUT ${secrets}`), { config: { headers } });
    }
    return {
      content: [{ type: "text" as const, text: OK_REPLY }],
      finishReason: { unified: "length" as const, raw: "length" },
      usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    };
  }
}
