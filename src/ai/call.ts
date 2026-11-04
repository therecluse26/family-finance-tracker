import { APICallError, generateText, type LanguageModel, RetryError, wrapLanguageModel } from "ai";
import { type Database, listAccounts, listMembersByJoinOrder } from "../db/index.ts";
import { readHouseholdFacts } from "../household/index.ts";
import type { Logger } from "../log.ts";
import type { AiTier, ModelCheck, ModelUse, TierModels } from "./ai-view.ts";
import { costMiddleware, type OutboundCall } from "./outbound.ts";
import { MEMBER_TYPED, type PrivacyFacts, privacyFilter } from "./privacy.ts";
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

// What the filter hides, read fresh for each request, so a new Member or Account counts at once.
export async function readPrivacyFacts(database: Database): Promise<PrivacyFacts> {
  const [members, accounts, facts] = await Promise.all([
    listMembersByJoinOrder(database),
    listAccounts(database),
    readHouseholdFacts(database),
  ]);
  return {
    members,
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

// One message of a call. Attached notes travel inside a message's text. `typed` marks text a
// Member wrote, such as a Chat message, a note a Member wrote, or an earlier AI reply in a Chat's
// history: the privacy filter does its best on it, but never refuses the call over it (spec 08,
// Privacy filter). Without it, the text is app-built, and the filter's final check reads it.
export type AiMessage = { role: "user" | "assistant"; text: string; typed?: boolean };

// One AI call: the fixed rules, then the messages, such as the Household summary, the task text,
// a Quick batch, or a Chat turn. The use picks the model tier, the gate, and the line in the
// month's cost.
//
// A call takes no tools and no response schema for now: the type says so, and callModel refuses
// one at run time. The leak check skips tool and response schemas, so the Chat ticket must build
// them only from constants in the code, never from Household data.
export type AiCall = {
  use: ModelUse;
  system: string;
  messages: AiMessage[];
  maxOutputTokens?: number;
  tools?: never;
  toolChoice?: never;
  output?: never;
  responseFormat?: never;
  schema?: never;
};

const CALL_KEYS: ReadonlySet<string> = new Set(["use", "system", "messages", "maxOutputTokens"]);
const MESSAGE_KEYS: ReadonlySet<string> = new Set(["role", "text", "typed"]);

const onlyKeys = (value: object, keys: ReadonlySet<string>) =>
  Object.keys(value).every((key) => keys.has(key));

// Refuses anything an AiCall does not hold, such as tools or a response schema.
function checkCall(call: AiCall): void {
  const plain =
    onlyKeys(call, CALL_KEYS) &&
    typeof call.system === "string" &&
    Array.isArray(call.messages) &&
    call.messages.every(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        onlyKeys(message, MESSAGE_KEYS) &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.text === "string" &&
        (message.typed === undefined || typeof message.typed === "boolean"),
    );
  if (!plain) {
    throw new TypeError("An AI call holds only text messages: no tools and no response schema.");
  }
}

// One call with a model from privateModels.
export async function callModel(model: LanguageModel, call: AiCall): Promise<{ text: string }> {
  checkCall(call);
  const { text } = await generateText({
    model,
    system: call.system,
    messages: call.messages.map((message) => ({
      role: message.role,
      content: message.text,
      ...(message.typed === true ? { providerOptions: MEMBER_TYPED } : {}),
    })),
    ...(call.maxOutputTokens === undefined ? {} : { maxOutputTokens: call.maxOutputTokens }),
    timeout: CALL_TIMEOUT_MS,
  });
  return { text };
}
