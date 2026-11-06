import {
  APICallError,
  createUIMessageStreamResponse,
  EmptyResponseBodyError,
  generateText,
  InvalidResponseDataError,
  JSONParseError,
  type LanguageModel,
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
import {
  type Database,
  listAccounts,
  listMembersByJoinOrder,
  listRemovedMembers,
} from "../db/index.ts";
import { readHouseholdFacts } from "../household/index.ts";
import type { Logger } from "../log.ts";
import type { AiTier, ModelCheck, TierModels } from "./ai-view.ts";
import { type AiPause, AiPausedError, costMiddleware, type OutboundCall } from "./outbound.ts";
import { type PrivacyFacts, PrivacyRefusal, privacyFilter } from "./privacy.ts";
import { type AiCall, type AiTools, buildPrompt, plainData } from "./prompt.ts";
import {
  type AiConnection,
  type AiModelMaker,
  type AiModels,
  makeFetchModels,
} from "./providers.ts";

// The one AI call path (spec 08, Privacy filter; spec 10, Module seams: `ai`). Every model the app
// calls is made here, and each one sends every request first through the privacy filter, then
// through its cost gate, and counts its cost from the reply, whatever calls it: a one-shot prompt,
// a Chat turn, or a tool loop that sends tool results back. Only this file imports the AI SDK's
// call functions (src/seams.test.ts). If the filter cannot decide, or cannot read what it hides,
// the request does not go out, and nothing is counted.

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

// What the filter hides, read fresh for each request, so a new Member or Account counts at once.
export async function readPrivacyFacts(database: Database): Promise<PrivacyFacts> {
  const [members, removedMembers, accounts, facts] = await Promise.all([
    listMembersByJoinOrder(database),
    listRemovedMembers(database),
    listAccounts(database),
    readHouseholdFacts(database),
  ]);
  return {
    members,
    removedMembers,
    accounts: accounts.map(({ id, name, memberName, institutionName, kind, subtype, mask }) => ({
      id,
      name,
      memberName,
      institutionName,
      kind,
      subtype,
      mask,
    })),
    zipCode: facts?.zipCode,
    ages: facts?.ages ?? [],
  };
}

// The privacy filter as the outer middleware, then the cost gate and count (src/ai/outbound.ts).
// The AI SDK runs the first middleware's transformParams first, so a request the filter refuses
// never reaches the gate, the AI provider, or the count, and the count sees only the filtered
// request that really goes out.
function privateModel(
  model: LanguageModel,
  database: Database,
  counted: OutboundCall,
): LanguageModel {
  if (typeof model === "string") throw new TypeError("A model is never a plain model-ID string.");
  return wrapLanguageModel({
    model,
    middleware: [
      {
        transformParams: async ({ params }) =>
          privacyFilter(await readPrivacyFacts(database)).params(params),
      },
      costMiddleware(counted),
    ],
  });
}

// The Household's models, each behind the privacy filter and then the cost gate, and counted as
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
  };
}

// The HTTP status of a failed call, and nothing else: an AI SDK error also holds the request and
// the response, and a provider error can hold the key in its headers or config.
function statusOf(error: unknown): number | undefined {
  const last = RetryError.isInstance(error) ? error.lastError : error;
  return APICallError.isInstance(last) ? last.statusCode : undefined;
}

// One call with a 1-token reply, and no retry, with a model from privateModels counted as the
// check on save. A 401 or 403 means the AI provider rejected the key.
export async function checkModel(model: LanguageModel, logger: Logger): Promise<ModelCheck> {
  try {
    await generateText({
      model,
      prompt: "Reply with OK.",
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

// A failed AI call. It holds the kind of failure and the HTTP status, never the AI SDK's error,
// which can hold the prompt, the reply, the request's headers, and the key.
export class AiCallError extends Error {
  readonly failure: AiFailure | "key rejected";
  readonly status: number | undefined;
  constructor(failure: AiFailure | "key rejected", status?: number) {
    super(`The AI call failed: ${failure}.`);
    this.name = "AiCallError";
    this.failure = failure;
    this.status = status;
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
// as a privacy refusal, a paused gate, or a database error, which the call path throws on.
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
    return new AiCallError("bad reply");
  }
  return networkCode(last) ? new AiCallError("network") : undefined;
}

// The AI SDK's tools for a call's tools. Each result goes out as plain JSON data, which the privacy
// filter reads on its way out, like every other part of the request. `ran` counts the tools run for
// this question: past the 5th, a call gets a fixed reply and runs nothing.
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

// One call with a model from privateModels: the prompt in its one order, its use's reply limit,
// and, with a schema, a structured reply checked against it. With tools, the AI SDK runs each tool
// the AI calls and sends its result back, one model call each round. The AI SDK makes no retry of
// its own: background uses retry on their own schedule, and Chat and reading a Goal never retry by
// themselves (spec 08, Failures). Throws an AiCallError when the AI provider fails.
export async function callModel<OUTPUT>(
  model: LanguageModel,
  call: AiCall<OUTPUT>,
): Promise<{ text: string; output: OUTPUT }> {
  const prompt = buildPrompt(call);
  // The timeout is the app's own, so a test's fake clock moves it.
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new DOMException("No reply within 120 seconds.", "TimeoutError")),
    CALL_TIMEOUT_MS,
  );
  const ran = { count: 0 };
  try {
    const result = await generateText({
      model,
      system: prompt.system,
      messages: prompt.messages,
      maxOutputTokens: prompt.maxOutputTokens,
      ...(prompt.providerOptions === undefined ? {} : { providerOptions: prompt.providerOptions }),
      ...(call.output === undefined ? {} : { output: Output.object({ schema: call.output }) }),
      ...toolLoop(call.tools, ran),
      maxRetries: 0,
      abortSignal: timeout.signal,
    });
    // The AI SDK checks a structured reply against its schema when it is read.
    const output = (call.output === undefined ? undefined : result.output) as OUTPUT;
    return { text: result.text, output };
  } catch (error) {
    if (timeout.signal.aborted) throw new AiCallError("timeout");
    throw callErrorOf(error) ?? error;
  } finally {
    clearTimeout(timer);
  }
}

// How a streamed answer ended: with the AI's whole text, as it wrote it, with "Member A" labels;
// with an AI error or a rejected key; paused by its gate between rounds, such as at the AI cost
// cap; or refused by the privacy filter, so its request did not go out.
export type StreamEnd =
  | { answered: string }
  | { failed: AiFailure | "key rejected" }
  | { paused: AiPause }
  | { refused: true };

// What ends a streamed answer that failed. An error that is none of these, such as a database
// error in a gate, counts as a server error: a stream cannot throw to its route.
function streamEndOf(error: unknown, timedOut: boolean): StreamEnd {
  if (timedOut) return { failed: "timeout" };
  if (error instanceof AiPausedError) return { paused: error.pause };
  if (error instanceof PrivacyRefusal) return { refused: true };
  return { failed: callErrorOf(error)?.failure ?? "server error" };
}

// Where AI text so far may be cut for the screen: after its last whitespace, and before a "Member"
// that a label's letters may still follow. What comes after waits for more text.
function screenCut(text: string): number {
  let cut = text.length;
  while (cut > 0 && !/\s/u.test(text[cut - 1] ?? "")) cut -= 1;
  const label = /[Mm]ember\s*$/u.exec(text.slice(0, cut));
  return label === null ? cut : label.index;
}

// AI text as the screen shows it while it streams. `screen` turns the text so far into the
// screen's words, such as a Member's name in place of "Member A". Each new piece of text sends
// only what the screen shows past what it showed before, so a label split over two pieces is never
// sent half turned.
function screenedText(screen: (aiText: string) => string) {
  let aiText = "";
  let shown = "";
  const past = (next: string) => {
    if (next.length <= shown.length) return "";
    const added = next.slice(shown.length);
    shown = next;
    return added;
  };
  return {
    add(delta: string): string {
      aiText += delta;
      return past(screen(aiText.slice(0, screenCut(aiText))));
    },
    end: () => past(screen(aiText)),
    text: () => aiText,
  };
}

// Chat's answer as it streams (spec 08, Answers): one model round, then one more for each round
// of tool calls, with callModel's 5-call cap, 120-second limit, and no retry. The browser gets
// the answer's text as the screen shows it, through @ai-sdk/react's message stream, and nothing
// else: no tool call, no tool result, no reasoning. The answer runs to its end even when the
// browser leaves, and `ended` runs once, before the stream's last part. It returns the words the
// browser shows for a failure, or undefined when the answer stands.
export function streamModel(
  model: LanguageModel,
  call: AiCall<undefined>,
  hooks: {
    screen: (aiText: string) => string;
    ended: (end: StreamEnd) => Promise<string | undefined>;
  },
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
  const text = screenedText(hooks.screen);
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
