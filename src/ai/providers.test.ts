import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import type { AiProviderName } from "./ai-view.ts";
import { type AiConnection, makeFetchModels } from "./providers.ts";
import { CapturingFetch, newAiKey } from "./testing.ts";

// Each AI provider's models, as their requests leave the app (spec 08, AI providers and their
// data-use settings), on a fetch that captures each request. No test calls an AI provider.

const MODELS = { quick: "quick-model", writer: "writer-model" };
const GATEWAY = "https://gateway.ai.cloudflare.com/v1/account-id/gateway-id";

const connection = (provider: AiProviderName, more: Partial<AiConnection> = {}): AiConnection => ({
  provider,
  apiKey: newAiKey(),
  baseUrl: provider === "openai-compatible" ? "http://ollama.local:11434/v1" : null,
  gatewayToken: undefined,
  ...more,
});

// One call to each tier's model, as a later AI use makes it, and the requests that left.
async function callBoth(to: AiConnection, callerOptions: Record<string, unknown> = {}) {
  const capture = new CapturingFetch();
  const models = makeFetchModels(capture.fetch)(to, MODELS);
  for (const model of [models.quick, models.writer]) {
    await generateText({
      model,
      prompt: "Hello",
      maxOutputTokens: 1,
      maxRetries: 0,
      ...callerOptions,
    });
  }
  return capture.requests;
}

describe("the AI providers' models", () => {
  it("sends store: false to OpenAI on every call, even when a caller asks to store", async () => {
    const requests = await callBoth(connection("openai"), {
      providerOptions: { openai: { store: true } },
    });

    expect(requests.map((request) => request.url)).toEqual([
      "https://api.openai.com/v1/chat/completions",
      "https://api.openai.com/v1/chat/completions",
    ]);
    expect(requests.map((request) => [request.body.model, request.body.store])).toEqual([
      ["quick-model", false],
      ["writer-model", false],
    ]);
  });

  it('sends provider: { data_collection: "deny" } to OpenRouter on every call, and asks for its cost', async () => {
    const requests = await callBoth(connection("openrouter"));

    expect(requests.map((request) => request.url)).toEqual([
      "https://openrouter.ai/api/v1/chat/completions",
      "https://openrouter.ai/api/v1/chat/completions",
    ]);
    for (const request of requests) {
      expect(request.body.provider).toEqual({ data_collection: "deny" });
      expect(request.body.usage).toEqual({ include: true });
    }
  });

  it("sends Anthropic the key and no feedback setting", async () => {
    const to = connection("anthropic");
    const requests = await callBoth(to);

    expect(requests.map((request) => request.url)).toEqual([
      "https://api.anthropic.com/v1/messages",
      "https://api.anthropic.com/v1/messages",
    ]);
    expect(requests[0]?.headers["x-api-key"]).toBe(to.apiKey);
    expect(requests[0]?.body).not.toHaveProperty("store");
    expect(requests[0]?.body).not.toHaveProperty("provider");
  });

  it("sends an OpenAI-compatible endpoint its base URL, with a key only when one is set", async () => {
    const withKey = connection("openai-compatible");
    const [keyed] = await callBoth(withKey);
    const [keyless] = await callBoth(connection("openai-compatible", { apiKey: undefined }));

    expect(keyed?.url).toBe("http://ollama.local:11434/v1/chat/completions");
    expect(keyed?.headers.authorization).toBe(`Bearer ${withKey.apiKey}`);
    expect(keyless?.headers).not.toHaveProperty("authorization");
  });

  it("sends a Cloudflare AI Gateway cf-aig-collect-log-payload: false and the gateway token", async () => {
    for (const provider of ["anthropic", "openai"] as const) {
      const to = connection(provider, {
        baseUrl: `${GATEWAY}/${provider}`,
        gatewayToken: newAiKey(),
      });
      const requests = await callBoth(to);

      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.url.startsWith(`${GATEWAY}/${provider}/`)).toBe(true);
        expect(request.headers["cf-aig-collect-log-payload"]).toBe("false");
        expect(request.headers["cf-aig-authorization"]).toBe(`Bearer ${to.gatewayToken}`);
      }
    }
  });

  it("sends the gateway header with no token, and no gateway header to any other base URL", async () => {
    const [gateway] = await callBoth(connection("openai", { baseUrl: `${GATEWAY}/openai` }));
    const [proxy] = await callBoth(
      connection("openai", { baseUrl: "https://gateway.ai.cloudflare.com.evil.example/v1" }),
    );

    expect(gateway?.headers["cf-aig-collect-log-payload"]).toBe("false");
    expect(gateway?.headers).not.toHaveProperty("cf-aig-authorization");
    expect(proxy?.headers).not.toHaveProperty("cf-aig-collect-log-payload");
  });

  it("asks fetch to follow no redirect, for every AI provider", async () => {
    for (const provider of ["anthropic", "openai", "openrouter", "openai-compatible"] as const) {
      const requests = await callBoth(connection(provider));
      expect(requests.map((request) => request.redirect)).toEqual(["error", "error"]);
    }
  });
});

const listen = (server: Server) =>
  new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server: Server) => new Promise((resolve) => server.close(resolve));
const origin = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

describe("a redirect from the AI provider's base URL", () => {
  it("never carries the key or the gateway token to another host", async () => {
    const seenElsewhere: unknown[] = [];
    const elsewhere = createServer((req, res) => {
      seenElsewhere.push(req.headers);
      res.end("{}");
    });
    const redirecting = createServer((req, res) => {
      res.writeHead(307, { location: `${origin(elsewhere)}${req.url}` });
      res.end();
    });
    await Promise.all([elsewhere, redirecting].map(listen));
    try {
      // Only here: real fetch, to a local server in place of the AI provider, so the test stays
      // offline.
      for (const provider of ["anthropic", "openai-compatible"] as const) {
        const models = makeFetchModels(fetch)(
          connection(provider, { baseUrl: `${origin(redirecting)}/v1`, gatewayToken: newAiKey() }),
          MODELS,
        );
        await expect(
          generateText({ model: models.quick, prompt: "Hello", maxOutputTokens: 1, maxRetries: 0 }),
        ).rejects.toThrow();
      }
      expect(seenElsewhere).toEqual([]);
    } finally {
      await Promise.all([elsewhere, redirecting].map(close));
    }
  });
});

describe("the ai module's library rules", () => {
  const sources = readdirSync(new URL(".", import.meta.url))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({ name, code: readFileSync(new URL(name, import.meta.url), "utf8") }));

  it("registers no AI SDK telemetry integration", () => {
    for (const { name, code } of sources) {
      expect([name, /registerTelemetry|telemetry\s*:/.test(code)]).toEqual([name, false]);
    }
  });

  it("refuses a plain model-ID string", () => {
    const models = makeFetchModels(new CapturingFetch().fetch)(connection("openai"), MODELS);

    expect(typeof models.quick).not.toBe("string");
    expect(typeof models.writer).not.toBe("string");
  });
});
