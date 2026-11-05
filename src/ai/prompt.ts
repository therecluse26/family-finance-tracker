import type { JSONValue, ModelMessage, TextPart } from "ai";
import * as z from "zod";
import { type ModelUse, USE_TIERS } from "./ai-view.ts";
import { MEMBER_TYPED, TYPED_PART } from "./privacy.ts";
import { type TypedValue, typedValueOf } from "./typed.ts";
import { FIXED_RULES } from "./voice.ts";

// How the one AI call path shapes each prompt (spec 08, Prompt order and caching; Limits on each
// call). Every prompt keeps one order: the fixed rules, then the Household summary, then the task,
// then anything that changes. The use sets the reply's token limit and where the cache mark goes.
// No caller sets either.

// One message of a call. Attached notes travel inside a message's text. `typed` marks text a
// Member wrote, such as a Chat message, a note a Member wrote, or an earlier AI reply in a Chat's
// history: the privacy filter does its best on it, but never refuses the call over it (spec 08,
// Privacy filter). Without it, the text is app-built, and the filter's final check reads it. A
// typed message never holds app-built text.
export type AiMessage = { role: "user" | "assistant"; text: string; typed?: boolean };

// One piece of the Household summary: app-built text, or a number the app made, such as an amount
// or a date, as a typed value (src/ai/typed.ts). The privacy filter reads each text and keeps each
// typed value as it is, so the AI reads "49.99" as the app built it, even when an Account's last 4
// is 4999. The AI reads the pieces as one text, in order.
export type SummaryPart = string | TypedValue;

// One Transaction of a Quick batch, as plain fields, such as its Merchant, amount, and date. It
// never holds the Transaction's ID: the AI answers each by its row number in the batch.
export type BatchItem = Readonly<Record<string, string | number | boolean | null>>;

// The schema a structured reply must pass. Optional fields are .nullable(), never .optional(), for
// OpenAI's strict mode. Counts, such as "4 to 7 cards", are part of it.
export type AiSchema<OUTPUT> = z.ZodType<OUTPUT>;

// One AI call. The fixed rules come first, and no call changes them. Then:
// - summary: the Household summary, as one text or as its pieces. Every Writer use has it, and no
//   Quick use does.
// - task: what this use asks, which stays the same from call to call, such as the instructions
//   and the fixed Category list. App-built.
// - batch: a Quick batch's Transactions, at most 100. Each goes out as its own text, a JSON object
//   with its row number in the batch, so the privacy filter reads each on its own and a removal
//   never joins two rows.
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
  changes?: readonly AiMessage[];
  alerts?: number;
  output?: AiSchema<OUTPUT>;
  tools?: AiTools;
  toolChoice?: never;
  responseFormat?: never;
};

// One tool the AI may call. The privacy filter's final check skips each tool's input schema, so its
// description and input schema are built only from constants in the code, such as the fixed
// Category list, never from Household data. `run` checks its input against the schema, and answers
// with plain JSON data that the call path makes plain and the privacy filter reads on its way out.
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

// Spec 08, Limits on each call: the most reply tokens each use may take.
const QUICK_BATCH_TOKENS = 4_000;
const REPLY_TOKENS: Record<Exclude<ModelUse, "alert advice">, number> = {
  "category fix": QUICK_BATCH_TOKENS,
  "merchant cleanup": QUICK_BATCH_TOKENS,
  "unclear transfer": QUICK_BATCH_TOKENS,
  "reimbursement linking": QUICK_BATCH_TOKENS,
  "reading a goal": 300,
  "insight cards": 1_000,
  "monthly review": 4_000,
  "budget tailoring": 1_500,
  chat: 1_500,
};
const ALERT_TOKENS = 300;
const ALERT_CALL_TOKENS = 1_200;

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
  "changes",
  "alerts",
  "output",
  "tools",
]);
const MESSAGE_KEYS: ReadonlySet<string> = new Set(["role", "text", "typed"]);
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
  onlyKeys(message, MESSAGE_KEYS) &&
  "role" in message &&
  (message.role === "user" || message.role === "assistant") &&
  "text" in message &&
  typeof message.text === "string" &&
  (!("typed" in message) || message.typed === undefined || typeof message.typed === "boolean");

// A typed value made in src/ai/typed.ts, in its form.
function isTypedValue(value: unknown): boolean {
  try {
    return typedValueOf(value) !== undefined;
  } catch {
    return false;
  }
}

const isSummary = (summary: unknown): boolean =>
  typeof summary === "string" ||
  (Array.isArray(summary) &&
    summary.every((part) => typeof part === "string" || isTypedValue(part)));

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
    (call.changes === undefined ||
      (Array.isArray(call.changes) && call.changes.every(isMessage))) &&
    (call.batch === undefined || (Array.isArray(call.batch) && call.batch.every(isBatchItem)));
  if (!plain) {
    throw new TypeError(
      "An AI call holds only its summary, task, batch, text messages, and Chat's tools: no IDs.",
    );
  }
  if (call.tools !== undefined) {
    if (call.use !== "chat") throw new TypeError("Only Chat takes tools.");
    checkTools(call.tools);
  }
  if ((call.summary !== undefined) !== (tier === "writer")) {
    throw new TypeError("Every Writer use, and no Quick use, has the Household summary.");
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

// The Household summary as one user message. Given as pieces, each text is a text part, and each
// typed value a text part of its bare value with the filter's mark, which the filter takes off.
function summaryMessage(summary: string | readonly SummaryPart[], cached: boolean): ModelMessage {
  if (typeof summary === "string") return userText(summary, cached);
  return {
    role: "user",
    content: summary.flatMap((part): TextPart[] => {
      if (typeof part === "string") return part === "" ? [] : [{ type: "text", text: part }];
      return [
        {
          type: "text",
          text: String(typedValueOf(part)),
          providerOptions: { privacyFilter: { [TYPED_PART]: part as unknown as JSONValue } },
        },
      ];
    }),
    ...(cached ? { providerOptions: CACHE_MARK } : {}),
  };
}

// Every control character, and the line and paragraph separators.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters it replaces.
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu;

// A batch field's text as the AI reads it: well-formed, with a space for each control character.
const plainField = (text: string) => text.toWellFormed().replace(CONTROL, " ");

// JSON data as the AI reads it, such as a tool's result: each text and field name well-formed, with
// a space for each control character. Its JSON then holds no escape but \" and \\, so the privacy
// filter reads the characters the AI reads. Anything but JSON data is refused.
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

// Whether JSON text holds an escape other than \" and \\, such as \n, which the AI reads as another
// character than the privacy filter read.
export const holdsOtherEscape = (json: string) => json.replace(/\\[\\"]/g, "").includes("\\");

// A Quick batch with each text value filtered on its own, before any row is written as JSON (spec
// 08, Privacy filter). A removal then never takes a row number, a field name, or the next field
// with it, so each row stays one JSON object with its own row number. Each value is made plain
// first, so the filter reads the characters the AI reads. The call path filters the whole request
// again on its way out.
export function filterBatch<OUTPUT>(
  call: AiCall<OUTPUT>,
  filter: (text: string) => string,
): AiCall<OUTPUT> {
  checkCall(call);
  if (call.batch === undefined) return call;
  return {
    ...call,
    batch: call.batch.map((item) =>
      Object.fromEntries(
        Object.entries(item).map(([field, value]) => [
          field,
          typeof value === "string" ? filter(plainField(value)) : value,
        ]),
      ),
    ),
  };
}

// One Transaction of a Quick batch as JSON. The privacy filter reads this JSON text, and the AI
// model reads the decoded values, so both must hold the same characters: JSON writes a newline as
// "\n" and a lone surrogate as "\ud800", and that letter would break the filter's digit runs and
// stick to a name. With every control character a space and every text well-formed, the JSON holds
// no escape but \" and \\, which hold no letter or digit. A row that still holds another is
// refused.
function batchRow(row: number, item: BatchItem): string {
  const fields = Object.entries(item).map(([field, value]) => [
    plainField(field),
    typeof value === "string" ? plainField(value) : value,
  ]);
  const text = JSON.stringify(Object.fromEntries([["row", row], ...fields]));
  if (holdsOtherEscape(text)) {
    throw new TypeError("A Quick batch row's JSON holds an escape the AI reads differently.");
  }
  return text;
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
  for (const message of call.changes ?? []) {
    messages.push({
      role: message.role,
      content: message.text,
      ...(message.typed === true ? { providerOptions: MEMBER_TYPED } : {}),
    });
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

// The reply schema of a Quick batch: one answer per row, each row of the batch once. `answer` is
// the schema of one row's answer, an object without `row`.
export function batchReply<Shape extends z.ZodRawShape>(answer: z.ZodObject<Shape>, rows: number) {
  return z.object({
    answers: z
      .array(answer.extend({ row: z.number().int() }))
      .length(rows)
      .refine(
        (answers) => eachRowOnce(answers as readonly { row: number }[], rows),
        "Each row of the batch is answered once.",
      ),
  });
}
