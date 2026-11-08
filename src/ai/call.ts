import {
  APICallError,
  createUIMessageStreamResponse,
  EmptyResponseBodyError,
  generateText,
  InvalidResponseDataError,
  JSONParseError,
  type LanguageModel,
  type LanguageModelMiddleware,
  NoContentGeneratedError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  RetryError,
  stepCountIs,
  streamText,
  type ToolSet,
  TypeValidationError,
  tool,
  type UIMessageChunk,
  wrapLanguageModel,
} from "ai";
import type { Database } from "../db/index.ts";
import type { Logger } from "../log.ts";
import type { AiProviderName, AiTier, ModelCheck, TierModels } from "./ai-view.ts";
import {
  type AiPause,
  AiPausedError,
  costMiddleware,
  type OutboundCall,
  STREAM_CUT,
} from "./outbound.ts";
import { tablePrice } from "./prices.ts";
import {
  type AiCall,
  type AiTools,
  buildPrompt,
  effortOptions,
  goodRows,
  plainData,
  quickBatchOf,
} from "./prompt.ts";
import {
  type AiConnection,
  type AiModelMaker,
  type AiModels,
  makeFetchModels,
  webSearchTools,
} from "./providers.ts";
import { callLog, type KeptFailure } from "./request-log.ts";
import { plainVoice } from "./voice.ts";

// The one AI call path (spec 10, Module seams: `ai`). Every model the app calls is made here, and
// each one sends every request through its cost gate, and counts its cost from the reply, whatever
// calls it: a one-shot prompt, a Chat turn, or a tool loop that sends tool results back. Only this
// file imports the AI SDK's call functions (src/seams.test.ts). The AI provider gets Household
// data as the app builds it (spec 08, What the AI provider gets).

// Spec 08, Failures: no reply within 120 seconds is an AI error.
const CALL_TIMEOUT_MS = 120_000;

// Spec 08, Answers: at most 5 tool calls for each question, counted across every round, the calls
// one round makes together included. After the 5th, the app offers no more tools, and the AI
// answers with what it has, so every tool loop ends.
const TOOL_CALLS = 5;

// What the AI reads when a tool fails, in place of the tool's own error, which can hold a query and
// its values.
const TOOL_FAILED = { error: "The lookup failed." };

// What the AI reads for a call past the 5th. The tool does not run.
const NO_MORE_TOOLS = { error: "No more lookups for this question." };

// Spec 08, Effort: the use's effort goes only to a model in the app's own price table for its AI
// provider, each of which takes it. A model with only a Member's price may not, such as gpt-4o or
// claude-sonnet-4-5, and its AI provider would refuse the whole call. Each option is merged into
// the call's own options for that AI provider, such as OpenAI's cache mode.
function effortMiddleware(counted: OutboundCall): LanguageModelMiddleware {
  const added =
    tablePrice(counted.provider, counted.model) === undefined
      ? undefined
      : effortOptions(counted.use);
  return {
    transformParams: async ({ params }) =>
      added === undefined
        ? params
        : {
            ...params,
            providerOptions: {
              ...params.providerOptions,
              ...Object.fromEntries(
                Object.entries(added).map(([name, options]) => [
                  name,
                  { ...params.providerOptions?.[name], ...options },
                ]),
              ),
            },
          },
  };
}

// The use's effort, then the cost gate and count (src/ai/outbound.ts) with the AI request log,
// around each model.
function privateModel(
  model: LanguageModel,
  database: Database,
  counted: OutboundCall,
): LanguageModel {
  if (typeof model === "string") throw new TypeError("A model is never a plain model-ID string.");
  return wrapLanguageModel({
    model,
    middleware: [
      effortMiddleware(counted),
      costMiddleware(counted, callLog(database, counted, keptFailureOf)),
    ],
  });
}

// The Household's models, each behind the cost gate, and counted as
// `countedAs` says for its tier. Only this file builds models: the AI provider packages' models
// from makeFetchModels, or a test's models from `makeModels` (src/seams.test.ts).
export function privateModels(
  database: Database,
  makeModels: AiModelMaker | undefined,
  connection: AiConnection,
  tiers: TierModels,
  countedAs: (tier: AiTier) => OutboundCall,
): AiModels {
  const models = (makeModels ?? makeFetchModels())(connection, tiers);
  return {
    quick: privateModel(models.quick, database, countedAs("quick")),
    writer: privateModel(models.writer, database, countedAs("writer")),
    chat: privateModel(models.chat, database, countedAs("chat")),
    ...(models.lookup === undefined
      ? {}
      : { lookup: privateModel(models.lookup, database, countedAs("quick")) }),
  };
}

// The HTTP status of a failed call, and nothing else: an AI SDK error also holds the request and
// the response, and a provider error can hold the key in its headers or config.
function statusOf(error: unknown): number | undefined {
  const last = RetryError.isInstance(error) ? error.lastError : error;
  return APICallError.isInstance(last) ? last.statusCode : undefined;
}

// The fixed prompt of the check on save and the key test. It holds no Household data.
const CHECK_PROMPT = "Reply with OK.";

// One call with a 1-token reply, and no retry, with a model from privateModels counted as the
// check on save. A 401 or 403 means the AI provider rejected the key.
export async function checkModel(model: LanguageModel, logger: Logger): Promise<ModelCheck> {
  try {
    await generateText({
      model,
      prompt: CHECK_PROMPT,
      maxOutputTokens: 1,
      maxRetries: 0,
      timeout: CALL_TIMEOUT_MS,
    });
    return "worked";
  } catch (error) {
    const status = statusOf(error);
    if (status === 401 || status === 403) return "key rejected";
    logger.warn("The AI provider did not answer the check on save", { status: status ?? null });
    return "failed";
  }
}

// Spec 08, Failures: what went wrong when an AI call failed. "key rejected" is the AI provider's
// 401 or 403. Every other failure is an AI error: no answer from the AI provider ("network"), no
// reply within 120 seconds, a rate limit, a server error, or a reply that fails its schema. Any
// other refusal by the AI provider, such as a 400, counts as a server error.
export type AiFailure = "network" | "timeout" | "rate limit" | "server error" | "bad reply";

// A failed AI call. It holds the kind of failure, the HTTP status, and why the reply ended, such as
// "length" for one cut off at its limit, never the AI SDK's error, which can hold the prompt, the
// reply, the request's headers, and the key.
export class AiCallError extends Error {
  readonly failure: AiFailure | "key rejected";
  readonly status: number | undefined;
  finishReason: string | undefined;
  constructor(failure: AiFailure | "key rejected", status?: number, finishReason?: string) {
    super(`The AI call failed: ${failure}.`);
    this.name = "AiCallError";
    this.failure = failure;
    this.status = status;
    this.finishReason = finishReason;
  }
}

// Node's codes for a connection that failed or dropped.
const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

function networkCode(error: unknown): boolean {
  let cause = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof cause !== "object" || cause === null) return false;
    const { code } = cause as { code?: unknown };
    if (typeof code === "string" && (NETWORK_CODES.has(code) || code.startsWith("UND_ERR_"))) {
      return true;
    }
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

// The failure an error stands for, or undefined for an error that is not the AI provider's, such
// as a paused gate or a database error, which the call path throws on.
function callErrorOf(error: unknown): AiCallError | undefined {
  const last = RetryError.isInstance(error) ? error.lastError : error;
  if (APICallError.isInstance(last)) {
    const status = last.statusCode;
    if (status === undefined) return new AiCallError("network");
    if (status === 401 || status === 403) return new AiCallError("key rejected", status);
    if (status === 429) return new AiCallError("rate limit", status);
    if (status === 408) return new AiCallError("timeout", status);
    return new AiCallError("server error", status);
  }
  if (
    NoObjectGeneratedError.isInstance(last) ||
    NoOutputGeneratedError.isInstance(last) ||
    NoContentGeneratedError.isInstance(last) ||
    JSONParseError.isInstance(last) ||
    TypeValidationError.isInstance(last) ||
    InvalidResponseDataError.isInstance(last) ||
    EmptyResponseBodyError.isInstance(last)
  ) {
    return new AiCallError(
      "bad reply",
      undefined,
      NoObjectGeneratedError.isInstance(last) ? last.finishReason : undefined,
    );
  }
  return networkCode(last) ? new AiCallError("network") : undefined;
}

// What the AI request log keeps for a failed model call: the kind of failure and the AI provider's
// HTTP status, never the error, which can hold the prompt, the reply, the headers, and the key.
// The app's 120-second timeout aborts the call with a TimeoutError.
function keptFailureOf(error: unknown): KeptFailure {
  if (error === STREAM_CUT) return { failure: "stopped", status: null };
  const failed = callErrorOf(error);
  if (failed !== undefined) return { failure: failed.failure, status: failed.status ?? null };
  const name = error instanceof Error || error instanceof DOMException ? error.name : undefined;
  if (name === "TimeoutError") return { failure: "timeout", status: null };
  if (name === "AbortError") return { failure: "stopped", status: null };
  return { failure: "app error", status: null };
}

// "Test the key" (spec 08, Test the key): one call with the fixed prompt and a 1-token reply, no
// retry, and the 120-second limit, with a model from privateModels counted as the key test. A
// failure maps as every AI call's does, but for a 404, which the test alone names: the AI provider
// does not know the model. Throws a plain Error for a failure that is not the AI provider's, such
// as a database error, never the error itself, which can hold the key.
export async function testModel(
  model: LanguageModel,
  logger: Logger,
): Promise<"worked" | AiFailure | "key rejected" | "model unknown"> {
  // The timeout is the app's own, so a test's fake clock moves it.
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new DOMException("No reply within 120 seconds.", "TimeoutError")),
    CALL_TIMEOUT_MS,
  );
  try {
    await generateText({
      model,
      prompt: CHECK_PROMPT,
      maxOutputTokens: 1,
      maxRetries: 0,
      abortSignal: timeout.signal,
    });
    return "worked";
  } catch (error) {
    if (timeout.signal.aborted) return "timeout";
    const failed = callErrorOf(error);
    if (failed?.status === 404) return "model unknown";
    if (failed !== undefined) return failed.failure;
    logger.warn("The key test failed in the app", {
      error: error instanceof Error ? error.name : "unknown",
    });
    throw new Error("The key test failed in the app.");
  } finally {
    clearTimeout(timer);
  }
}

// The AI SDK's tools for a call's tools. Each result goes out as plain JSON data. `ran` counts the
// tools run for this question: past the 5th, a call gets a fixed reply and runs nothing.
function toolSet(tools: AiTools, ran: { count: number }): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, each]) => [
      name,
      tool({
        description: each.description,
        inputSchema: each.input,
        execute: async (input: unknown) => {
          // Counted before any wait, so calls the AI makes together cannot pass the cap.
          if (ran.count >= TOOL_CALLS) return NO_MORE_TOOLS;
          ran.count += 1;
          try {
            return plainData(await each.run(input));
          } catch {
            return TOOL_FAILED;
          }
        },
      }),
    ]),
  );
}

// A call's tools, and the loop that runs them: at most 5 tool calls for the question.
function toolLoop(tools: AiTools | undefined, ran: { count: number }) {
  if (tools === undefined) return {};
  return {
    tools: toolSet(tools, ran),
    // A round with a tool call runs at least one tool until the 5th, so the loop takes at most 5
    // rounds of calls, then one answer.
    stopWhen: stepCountIs(TOOL_CALLS + 1),
    // The tools stay in the request, as an AI provider needs them to read earlier calls.
    prepareStep: () => (ran.count < TOOL_CALLS ? undefined : { toolChoice: "none" as const }),
  };
}

// Whether the AI provider has a web search for the Merchant lookup (spec 08, Merchant web lookup).
export function hasWebSearch(provider: AiProviderName): boolean {
  return webSearchTools(provider) !== undefined;
}

// One call with a model from privateModels: the prompt in its one order, its use's reply limit,
// and, with a schema, a structured reply checked against it. With tools, the AI SDK runs each tool
// the AI calls and sends its result back, one model call each round. The AI SDK makes no retry of
// its own: background uses retry on their own schedule, and Chat and reading a Goal never retry by
// themselves (spec 08, Failures). Throws an AiCallError when the AI provider fails.
// The Merchant lookup offers its AI provider's web search tools, which the AI provider runs on its
// own servers in the same call: the AI SDK runs no tool of the app's, and makes one model call.
export async function callModel<OUTPUT>(
  model: LanguageModel,
  call: AiCall<OUTPUT>,
  webSearch?: AiProviderName,
): Promise<{ text: string; output: OUTPUT }> {
  const searchTools = webSearch === undefined ? undefined : webSearchTools(webSearch);
  if (webSearch !== undefined && searchTools === undefined) {
    throw new TypeError("This AI provider has no web search.");
  }
  if (searchTools !== undefined && call.tools !== undefined) {
    throw new TypeError("A call with web search takes no tools of its own.");
  }
  const prompt = buildPrompt(call);
  // The timeout is the app's own, so a test's fake clock moves it.
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new DOMException("No reply within 120 seconds.", "TimeoutError")),
    CALL_TIMEOUT_MS,
  );
  const ran = { count: 0 };
  // A Quick batch's reply that fails its schema keeps its good rows (spec 08, Limits on each call).
  const batch = quickBatchOf(call);
  let finishReason: string | undefined;
  try {
    const result = await generateText({
      model,
      system: prompt.system,
      messages: prompt.messages,
      maxOutputTokens: prompt.maxOutputTokens,
      ...(prompt.providerOptions === undefined ? {} : { providerOptions: prompt.providerOptions }),
      ...(call.output === undefined ? {} : { output: Output.object({ schema: call.output }) }),
      ...toolLoop(call.tools, ran),
      ...(searchTools === undefined ? {} : { tools: searchTools }),
      maxRetries: 0,
      abortSignal: timeout.signal,
    });
    finishReason = result.finishReason;
    // The AI SDK checks a structured reply against its schema when it is read.
    const output = (call.output === undefined ? undefined : result.output) as OUTPUT;
    return { text: result.text, output };
  } catch (error) {
    if (timeout.signal.aborted) throw new AiCallError("timeout");
    // A reply cut off at its limit gives no answers.
    if (
      batch !== undefined &&
      NoObjectGeneratedError.isInstance(error) &&
      error.finishReason !== "length"
    ) {
      const kept = goodRows(batch, error.text ?? "");
      if (kept !== undefined) return { text: error.text ?? "", output: kept as OUTPUT };
    }
    const failed = callErrorOf(error);
    if (failed === undefined) throw error;
    failed.finishReason ??= finishReason;
    throw failed;
  } finally {
    clearTimeout(timer);
  }
}

// How a streamed answer ended: with the AI's whole text, as it wrote it; with an AI error or a
// rejected key; or paused by its gate between rounds, such as at the AI cost cap.
export type StreamEnd =
  | { answered: string }
  | { failed: AiFailure | "key rejected" }
  | { paused: AiPause };

// What ends a streamed answer that failed. An error that is none of these, such as a database
// error in a gate, counts as a server error: a stream cannot throw to its route.
function streamEndOf(error: unknown, timedOut: boolean): StreamEnd {
  if (timedOut) return { failed: "timeout" };
  if (error instanceof AiPausedError) return { paused: error.pause };
  return { failed: callErrorOf(error)?.failure ?? "server error" };
}

// AI text in the one plain voice as it streams (src/ai/voice.ts). The voice reads the spaces around
// an emoji, so the text so far is shown up to its last whitespace, and what comes after waits for
// more text. Each new piece sends only what is shown past what was shown before.
function voicedText() {
  let aiText = "";
  let shown = "";
  const past = (next: string) => {
    if (next.length <= shown.length) return "";
    const added = next.slice(shown.length);
    shown = next;
    return added;
  };
  const lastSpace = (text: string) => {
    let cut = text.length;
    while (cut > 0 && !/\s/u.test(text[cut - 1] ?? "")) cut -= 1;
    return cut;
  };
  return {
    add(delta: string): string {
      aiText += delta;
      return past(plainVoice(aiText.slice(0, lastSpace(aiText))));
    },
    end: () => past(plainVoice(aiText)),
    text: () => aiText,
  };
}

// Chat's answer as it streams (spec 08, Answers): one model round, then one more for each round
// of tool calls, with callModel's 5-call cap, 120-second limit, and no retry. The browser gets
// the answer's text in the one plain voice, through @ai-sdk/react's message stream, and nothing
// else: no tool call, no tool result, no reasoning. The answer runs to its end even when the
// browser leaves, and `ended` runs once, before the stream's last part. It returns the words the
// browser shows for a failure, or undefined when the answer stands.
export function streamModel(
  model: LanguageModel,
  call: AiCall<undefined>,
  hooks: { ended: (end: StreamEnd) => Promise<string | undefined> },
): Response {
  if (call.output !== undefined) throw new TypeError("A streamed answer is text.");
  const prompt = buildPrompt(call);
  // The timeout is the app's own, so a test's fake clock moves it.
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new DOMException("No reply within 120 seconds.", "TimeoutError")),
    CALL_TIMEOUT_MS,
  );
  const ran = { count: 0 };
  const result = streamText({
    model,
    system: prompt.system,
    messages: prompt.messages,
    maxOutputTokens: prompt.maxOutputTokens,
    ...(prompt.providerOptions === undefined ? {} : { providerOptions: prompt.providerOptions }),
    ...toolLoop(call.tools, ran),
    maxRetries: 0,
    abortSignal: timeout.signal,
    // Errors come as parts of the stream, which answer() reads.
    onError: () => {},
  });
  const text = voicedText();
  let left = false;
  let send: (chunk: UIMessageChunk) => void = () => {};
  let textStarted = false;
  const sendText = (delta: string) => {
    if (delta === "") return;
    if (!textStarted) send({ type: "text-start", id: "answer" });
    textStarted = true;
    send({ type: "text-delta", id: "answer", delta });
  };

  async function answer(): Promise<void> {
    let failure: unknown;
    let failed = false;
    try {
      for await (const part of result.fullStream) {
        if (part.type === "text-start" && /\S$/u.test(text.text())) {
          // Each round's text starts a new paragraph.
          sendText(text.add("\n\n"));
        } else if (part.type === "text-delta") {
          sendText(text.add(part.text));
        } else if (part.type === "error" && !failed) {
          failed = true;
          failure = part.error;
        }
      }
    } catch (error) {
      if (!failed) failure = error;
      failed = true;
    } finally {
      clearTimeout(timer);
    }
    const end: StreamEnd = failed
      ? streamEndOf(failure, timeout.signal.aborted)
      : { answered: text.text() };
    const words = await hooks.ended(end);
    if (words !== undefined) {
      send({ type: "error", errorText: words });
      return;
    }
    sendText(text.end());
    if (textStarted) send({ type: "text-end", id: "answer" });
    send({ type: "finish" });
  }

  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      send = (chunk) => {
        if (!left) controller.enqueue(chunk);
      };
      send({ type: "start" });
      void answer()
        .catch(() => send({ type: "error", errorText: "The answer stopped. Try again." }))
        .finally(() => {
          if (!left) controller.close();
          left = true;
        });
    },
    cancel() {
      left = true;
    },
  });
  return createUIMessageStreamResponse({ stream });
}
