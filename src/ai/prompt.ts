import type { JSONValue, ModelMessage, TextPart } from "ai";
import * as z from "zod";
import { type AiUse, type ModelUse, USE_TIERS } from "./ai-view.ts";
import type { TypedValue } from "./typed.ts";
import { FIXED_RULES } from "./voice.ts";

// How the one AI call path shapes each prompt (spec 08, Prompt order and caching; Limits on each
// call). Every prompt keeps one order: the fixed rules, then the Household summary, then the task,
// then anything that changes. The use sets the reply's token limit and where the cache mark goes.
// No caller sets either.

// One message of a call. Attached notes travel inside a message's text. An app-built user message
// may come as `parts` instead, as the Household summary does, such as an Alert's facts in Alert
// advice.
export type AiMessage =
  | { role: "user" | "assistant"; text: string }
  | { role: "user"; parts: readonly SummaryPart[] };

// One piece of the Household summary: app-built text, or a number the app made, such as an amount
// or a date (src/ai/typed.ts). The AI reads the pieces as one text, in order.
export type SummaryPart = string | TypedValue;

// One Transaction of a Quick batch, as plain fields, such as its Merchant, amount, and date. It
// never holds the Transaction's ID: the AI answers each by its row number in the batch.
export type BatchItem = Readonly<Record<string, string | number | boolean | null>>;

// The schema a structured reply must pass. Optional fields are .nullable(), never .optional(), for
// OpenAI's strict mode. Counts, such as "4 to 7 cards", are part of it.
export type AiSchema<OUTPUT> = z.ZodType<OUTPUT>;

// One AI call. The fixed rules come first, and no call changes them. Then:
// - summary: the Household summary, as one text or as its pieces. Every Writer use and Chat have it,
//   and no Quick use does.
// - task: what this use asks, which stays the same from call to call, such as the instructions
//   and the fixed Category list. App-built.
// - batch: a Quick batch's Transactions, at most 100. Each goes out as its own text, a JSON object
//   with its row number in the batch.
// - facts: app-built facts this call needs past the summary, as pieces, such as Budget tailoring's
//   figures. It comes after the task and any batch, as one user message.
// - note: for Chat, the note a thread was started from with "Ask about this", as pieces, as the
//   summary may be. It goes after the task, before the turns.
// - changes: anything else that changes, such as Alert facts, feedback, or a Chat's turns.
// - alerts: for Alert advice, how many Alerts the call advises on, which sets its reply limit.
// - output: the schema of a structured reply. Without it, the reply is text.
// - tools: Chat's tools, such as the lookup tools (spec 08, Lookup tools), each made by aiTool.
//   Only Chat takes tools.
//
// A call takes no tool choice and no response schema of its own: the type says so, and the call
// path refuses one at run time.
export type AiCall<OUTPUT = undefined> = {
  use: ModelUse;
  summary?: string | readonly SummaryPart[];
  task: string;
  batch?: readonly BatchItem[];
  facts?: readonly SummaryPart[];
  note?: readonly SummaryPart[];
  changes?: readonly AiMessage[];
  alerts?: number;
  output?: AiSchema<OUTPUT>;
  tools?: AiTools;
  toolChoice?: never;
  responseFormat?: never;
};

// One tool the AI may call. Its description and input schema are built only from constants in the
// code, such as the fixed Category list, never from Household data. `run` checks its input against
// the schema, and answers with plain JSON data that the call path makes plain.
export type AiTool = {
  description: string;
  input: z.ZodObject;
  run(input: unknown): Promise<unknown>;
};

// The tools of one call, by name, such as search_transactions.
export type AiTools = Readonly<Record<string, AiTool>>;

// A tool whose run gets its input checked against its schema first. Optional fields are
// .nullable(), never .optional(), as in a reply schema.
export function aiTool<Shape extends z.ZodRawShape>(tool: {
  description: string;
  input: z.ZodObject<Shape>;
  run(input: z.infer<z.ZodObject<Shape>>): Promise<unknown>;
}): AiTool {
  return {
    description: tool.description,
    input: tool.input,
    run: async (input) => tool.run(tool.input.parse(input)),
  };
}

// Spec 08, Limits on each call: the most reply tokens each use may take. A model's thinking counts
// against the limit before its answer, so each limit leaves room for it. Only tokens used are
// billed. At 6,000, Category fix replies for 100 rows ran past the limit on real data.
const QUICK_BATCH_TOKENS = 12_000;
const REPLY_TOKENS: Record<Exclude<ModelUse, "alert advice">, number> = {
  "category fix": QUICK_BATCH_TOKENS,
  "merchant cleanup": QUICK_BATCH_TOKENS,
  "unclear transfer": QUICK_BATCH_TOKENS,
  "reimbursement linking": QUICK_BATCH_TOKENS,
  "reading a goal": 2_000,
  // The searches' own turns count as reply tokens, before the answer.
  "merchant lookup": 2_000,
  "insight cards": 8_000,
  "monthly review": 16_000,
  "budget tailoring": 8_000,
  chat: 8_000,
};
const ALERT_TOKENS = 1_000;
const ALERT_CALL_TOKENS = 4_000;

// Spec 08, Effort: how much each use's model thinks before it answers, sent on every call of the
// use to a model in the app's price table (src/ai/call.ts). A model that thinks by default spends
// its thinking from the reply limit. Quick batches and the Merchant lookup send none, and keep each
// model's own default.
export type Effort = "low" | "medium";
export const EFFORT: Record<ModelUse, Effort | undefined> = {
  "category fix": undefined,
  "merchant cleanup": undefined,
  "unclear transfer": undefined,
  "reimbursement linking": undefined,
  "merchant lookup": undefined,
  "reading a goal": "low",
  "alert advice": "low",
  "insight cards": "medium",
  "monthly review": "medium",
  "budget tailoring": "medium",
  chat: "low",
};

// A use's effort under each AI provider package's own option name, from its installed types:
// Anthropic sends it as output_config.effort, OpenAI's Chat Completions as reasoning_effort, and
// OpenRouter as reasoning.effort. Each package reads only its own key. An OpenAI-compatible
// endpoint reads none of these, so it gets nothing. Undefined for a use that sends none, and for
// the check on save and the key test.
export function effortOptions(use: AiUse): Record<string, Record<string, JSONValue>> | undefined {
  const effort = Object.hasOwn(EFFORT, use) ? EFFORT[use as ModelUse] : undefined;
  if (effort === undefined) return undefined;
  return {
    anthropic: { effort },
    openai: { reasoningEffort: effort },
    openrouter: { reasoning: { effort } },
  };
}

// A Quick batch holds up to 100 Transactions (spec 08, Limits on each call).
export const QUICK_BATCH_SIZE = 100;

// The Quick-tier uses that run in batches inside one sync job. Only they and Chat get cache marks
// (spec 08, Prompt order and caching): the rest run once, hours or days apart, so a cache write
// would be wasted.
const QUICK_BATCH_USES: ReadonlySet<ModelUse> = new Set([
  "category fix",
  "merchant cleanup",
  "unclear transfer",
  "reimbursement linking",
]);

// Whether the use runs in Quick batches, whose replies the call path keeps row by row.
export const isQuickBatchUse = (use: ModelUse): boolean => QUICK_BATCH_USES.has(use);

// Anthropic's 5-minute cache, and no other.
const CACHE_MARK = { anthropic: { cacheControl: { type: "ephemeral", ttl: "5m" } } } as const;
// OpenAI caches long prompts on its own unless told not to. With "explicit", it caches only where a
// call places a mark, and a one-shot call places none.
const NO_AUTOMATIC_CACHE = { openai: { promptCacheOptions: { mode: "explicit" } } } as const;

// The cache mark ends after the Household summary for Chat, after the tool definitions, which
// AI providers place before the messages. For Quick batches it ends after the task.
function cacheMarkAfter(use: ModelUse): "summary" | "task" | undefined {
  if (use === "chat") return "summary";
  return QUICK_BATCH_USES.has(use) ? "task" : undefined;
}

export function replyTokens(call: Pick<AiCall<unknown>, "use" | "alerts">): number {
  if (call.use !== "alert advice") return REPLY_TOKENS[call.use];
  return Math.min(ALERT_TOKENS * (call.alerts ?? 0), ALERT_CALL_TOKENS);
}

const CALL_KEYS: ReadonlySet<string> = new Set([
  "use",
  "summary",
  "task",
  "batch",
  "facts",
  "note",
  "changes",
  "alerts",
  "output",
  "tools",
]);
const MESSAGE_KEYS: ReadonlySet<string> = new Set(["role", "text"]);
const PARTS_MESSAGE_KEYS: ReadonlySet<string> = new Set(["role", "parts"]);
const TOOL_KEYS: ReadonlySet<string> = new Set(["description", "input", "run"]);
// A tool's name, as every AI provider takes it.
const TOOL_NAME = /^[a-z][a-z_]{0,63}$/;
// An ID's field name, such as id, transactionId, transaction_id, uuid, or accountGuid.
const ID_FIELD = /(?:^|_)(?:id|uuid|guid)$|(?:Id|ID|Uuid|UUID|Guid|GUID)$/;

const onlyKeys = (value: object, keys: ReadonlySet<string>) =>
  Object.keys(value).every((key) => keys.has(key));

const isMessage = (message: unknown): message is AiMessage =>
  typeof message === "object" &&
  message !== null &&
  (isPartsMessage(message) || isTextMessage(message));

const isPartsMessage = (message: object): boolean =>
  onlyKeys(message, PARTS_MESSAGE_KEYS) &&
  "role" in message &&
  message.role === "user" &&
  "parts" in message &&
  isParts(message.parts);

const isTextMessage = (message: object): boolean =>
  onlyKeys(message, MESSAGE_KEYS) &&
  "role" in message &&
  (message.role === "user" || message.role === "assistant") &&
  "text" in message &&
  typeof message.text === "string";

const isParts = (parts: unknown): boolean =>
  Array.isArray(parts) &&
  parts.every(
    (part) => typeof part === "string" || (typeof part === "number" && Number.isFinite(part)),
  );

const isSummary = (summary: unknown): boolean => typeof summary === "string" || isParts(summary);

const isBatchItem = (item: unknown): item is BatchItem =>
  typeof item === "object" &&
  item !== null &&
  !Array.isArray(item) &&
  Object.entries(item).every(
    ([field, value]) =>
      field !== "row" &&
      !ID_FIELD.test(field) &&
      (value === null || ["string", "number", "boolean"].includes(typeof value)),
  );

// Whether every object in a JSON schema lists each of its fields as required: an optional field
// is .nullable() instead.
function everyFieldRequired(node: unknown): boolean {
  if (Array.isArray(node)) return node.every(everyFieldRequired);
  if (node === null || typeof node !== "object") return true;
  const { properties, required } = node as { properties?: unknown; required?: unknown };
  if (typeof properties === "object" && properties !== null) {
    const listed = new Set(Array.isArray(required) ? required : []);
    if (!Object.keys(properties).every((field) => listed.has(field))) return false;
  }
  return Object.values(node).every(everyFieldRequired);
}

const isAiTool = (tool: unknown): tool is AiTool =>
  typeof tool === "object" &&
  tool !== null &&
  onlyKeys(tool, TOOL_KEYS) &&
  "description" in tool &&
  typeof tool.description === "string" &&
  "input" in tool &&
  tool.input instanceof z.ZodObject &&
  "run" in tool &&
  typeof tool.run === "function";

// Chat's tools: each made by aiTool, with a name every AI provider takes, and an input schema that
// passes as a reply schema does.
function checkTools(tools: unknown): void {
  if (typeof tools !== "object" || tools === null || Array.isArray(tools)) {
    throw new TypeError("A call's tools are an object of tools by name.");
  }
  for (const [name, tool] of Object.entries(tools)) {
    if (!TOOL_NAME.test(name) || !isAiTool(tool)) {
      throw new TypeError("Each tool is made by aiTool, under a lowercase name.");
    }
    checkSchema(tool.input);
  }
}

function checkSchema(schema: unknown): void {
  if (!(schema instanceof z.ZodType)) throw new TypeError("A reply schema is a Zod schema.");
  let json: unknown;
  try {
    json = z.toJSONSchema(schema);
  } catch {
    throw new TypeError("A reply schema must have a JSON Schema form.");
  }
  if (!everyFieldRequired(json)) {
    throw new TypeError("A reply schema's optional fields are .nullable(), never .optional().");
  }
}

// Refuses anything an AiCall does not hold, such as tools or a response schema of its own, and a
// call whose parts do not fit its use.
export function checkCall(call: AiCall<unknown>): void {
  const tier = USE_TIERS[call.use];
  const plain =
    tier !== undefined &&
    onlyKeys(call, CALL_KEYS) &&
    typeof call.task === "string" &&
    (call.summary === undefined || isSummary(call.summary)) &&
    (call.facts === undefined || (Array.isArray(call.facts) && isSummary(call.facts))) &&
    (call.note === undefined || (Array.isArray(call.note) && isSummary(call.note))) &&
    (call.changes === undefined ||
      (Array.isArray(call.changes) && call.changes.every(isMessage))) &&
    (call.batch === undefined || (Array.isArray(call.batch) && call.batch.every(isBatchItem)));
  if (!plain) {
    throw new TypeError(
      "An AI call holds only its summary, task, batch, text messages, and Chat's tools: no IDs.",
    );
  }
  if (call.note !== undefined && call.use !== "chat") {
    throw new TypeError("Only Chat takes an attached note.");
  }
  if (call.tools !== undefined) {
    if (call.use !== "chat") throw new TypeError("Only Chat takes tools.");
    checkTools(call.tools);
  }
  if ((call.summary !== undefined) !== (tier !== "quick")) {
    throw new TypeError("Every Writer use and Chat, and no Quick use, has the Household summary.");
  }
  if (
    call.batch !== undefined &&
    (!QUICK_BATCH_USES.has(call.use) ||
      call.batch.length === 0 ||
      call.batch.length > QUICK_BATCH_SIZE)
  ) {
    throw new TypeError("A Quick batch holds 1 to 100 Transactions, for a Quick batch use.");
  }
  const advice = call.use === "alert advice";
  if (
    advice
      ? !Number.isSafeInteger(call.alerts) || (call.alerts ?? 0) < 1
      : call.alerts !== undefined
  ) {
    throw new TypeError("Alert advice, and only Alert advice, says how many Alerts it covers.");
  }
  if (call.output !== undefined) checkSchema(call.output);
}

export type BuiltPrompt = {
  system: string;
  messages: ModelMessage[];
  maxOutputTokens: number;
  providerOptions: Record<string, Record<string, JSONValue>> | undefined;
};

const userText = (text: string, cached: boolean): ModelMessage => ({
  role: "user",
  content: text,
  ...(cached ? { providerOptions: CACHE_MARK } : {}),
});

// The Household summary, or another app-built message given as parts, as one user text: its pieces
// joined, each number as its text.
function summaryMessage(summary: string | readonly SummaryPart[], cached: boolean): ModelMessage {
  return userText(typeof summary === "string" ? summary : summary.map(String).join(""), cached);
}

// Every control character, and the line and paragraph separators.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters it replaces.
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu;

// A batch field's text as the AI reads it: well-formed, with a space for each control character.
const plainField = (text: string) => text.toWellFormed().replace(CONTROL, " ");

// JSON data as the AI reads it, such as a tool's result: each text and field name well-formed, with
// a space for each control character. Anything but JSON data is refused.
export function plainData(value: unknown): unknown {
  if (typeof value === "string") return plainField(value);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(plainData);
  if (typeof value === "object" && value !== null) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      return Object.fromEntries(
        Object.entries(value).map(([field, item]) => [plainField(field), plainData(item)]),
      );
    }
  }
  throw new TypeError("A tool answers with plain JSON data.");
}

// One Transaction of a Quick batch as JSON, with its row number, each text well-formed and with a
// space for each control character.
function batchRow(row: number, item: BatchItem): string {
  const fields = Object.entries(item).map(([field, value]) => [
    plainField(field),
    typeof value === "string" ? plainField(value) : value,
  ]);
  return JSON.stringify(Object.fromEntries([["row", row], ...fields]));
}

// The prompt in its one order, with its reply limit and cache mark.
export function buildPrompt(call: AiCall<unknown>): BuiltPrompt {
  checkCall(call);
  const markAfter = cacheMarkAfter(call.use);
  const messages: ModelMessage[] = [];
  if (call.summary !== undefined) {
    messages.push(summaryMessage(call.summary, markAfter === "summary"));
  }
  messages.push(userText(call.task, markAfter === "task"));
  if (call.batch !== undefined) {
    messages.push({
      role: "user",
      content: call.batch.map(
        (item, index): TextPart => ({
          type: "text",
          text: batchRow(index + 1, item),
        }),
      ),
    });
  }
  // Facts go as the summary's pieces do.
  if (call.facts !== undefined) messages.push(summaryMessage(call.facts, false));
  if (call.note !== undefined) messages.push(summaryMessage(call.note, false));
  for (const message of call.changes ?? []) {
    if ("parts" in message) {
      messages.push(summaryMessage(message.parts, false));
      continue;
    }
    messages.push({ role: message.role, content: message.text });
  }
  return {
    system: FIXED_RULES,
    messages,
    maxOutputTokens: replyTokens(call),
    providerOptions: markAfter === undefined ? NO_AUTOMATIC_CACHE : undefined,
  };
}

// Whether the answers hold each row of a batch of `rows` once.
function eachRowOnce(answers: readonly { row: number }[], rows: number): boolean {
  const seen = new Set(answers.map(({ row }) => row));
  return seen.size === rows && answers.every(({ row }) => row >= 1 && row <= rows);
}

// Each Quick batch's reply schema, with the schema of one row's answer and the batch's row count,
// so the call path can check a reply row by row.
const BATCH_REPLIES = new WeakMap<object, { answer: z.ZodObject; rows: number }>();

// The reply schema of a Quick batch: one answer per row, each row of the batch once. `answer` is
// the schema of one row's answer, an object without `row`. The AI provider gets this schema whole.
export function batchReply<Shape extends z.ZodRawShape>(answer: z.ZodObject<Shape>, rows: number) {
  const one = answer.extend({ row: z.number().int() });
  const reply = z.object({
    answers: z
      .array(one)
      .length(rows)
      .refine(
        (answers) => eachRowOnce(answers as readonly { row: number }[], rows),
        "Each row of the batch is answered once.",
      ),
  });
  BATCH_REPLIES.set(reply, { answer: one, rows });
  return reply;
}

// The rows of a Quick batch use's call with a batchReply schema, or undefined for any other call.
export function quickBatchOf(
  call: AiCall<unknown>,
): { answer: z.ZodObject; rows: number } | undefined {
  if (!QUICK_BATCH_USES.has(call.use) || call.output === undefined) return undefined;
  return BATCH_REPLIES.get(call.output);
}

// Spec 08, Limits on each call: the good rows of a Quick batch's reply that failed its schema as a
// whole. A row whose answer is missing, repeated, outside the batch, or fails its schema has no
// answer. Undefined when no row has one, or the reply is not JSON.
export function goodRows(
  batch: { answer: z.ZodObject; rows: number },
  text: string,
): { answers: { row: number }[] } | undefined {
  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    return undefined;
  }
  const list = typeof reply === "object" && reply !== null ? Reflect.get(reply, "answers") : null;
  if (!Array.isArray(list)) return undefined;
  const times = new Map<unknown, number>();
  for (const each of list) {
    const row = typeof each === "object" && each !== null ? Reflect.get(each, "row") : undefined;
    times.set(row, (times.get(row) ?? 0) + 1);
  }
  const answers: { row: number }[] = [];
  for (const each of list) {
    const parsed = batch.answer.safeParse(each);
    if (!parsed.success) continue;
    const { row } = parsed.data as { row: number };
    if (row >= 1 && row <= batch.rows && times.get(row) === 1)
      answers.push(parsed.data as { row: number });
  }
  return answers.length === 0 ? undefined : { answers };
}
