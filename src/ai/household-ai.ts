import {
  claimAiBack,
  giveBackMerchantLookup,
  listAccounts,
  listMemberNamesById,
  markAiAway,
  markAiRedoDue,
  readAiSettings,
  readAiSettingsVersion,
  readWebLookupSwitch,
  reserveMerchantLookup,
  storeWebSearchRefused,
} from "../db/index.ts";
import { log } from "../log.ts";
import { isActivityUse, startAiActivity } from "./activity.ts";
import { isBackground, MERCHANT_LOOKUPS_A_MONTH } from "./ai-view.ts";
import { AiCallError, type AiFailure, callModel, type StreamEnd, streamModel } from "./call.ts";
import { type AiPause, AiPausedError } from "./outbound.ts";
import { type AiCall, isQuickBatchUse } from "./prompt.ts";
import { aiRetries } from "./retries.ts";
import {
  type AiOptions,
  aiCalls,
  markKeyRejected,
  noticesOf,
  webSearchMissing,
  webSearchModel,
} from "./settings.ts";
import { plainVoice } from "./voice.ts";

// The AI's reply, or why the use has none.
// - pause: no call went out, such as with no AI provider, at the AI cost cap, or with a rejected
//   key. The use takes its no-AI path.
// - retryAt: a background use's call failed with an AI error, or its retry is not due yet. The use
//   leaves its work, and its AI retry starts the work again at retryAt (src/ai/retries.ts). In the
//   follow-up job, the step leaves those Transactions unhandled and stops the job.
// - failed: an AI error with no retry left. A background use takes its no-AI path. Chat and
//   reading a Goal never retry by themselves: the screen shows the error with "Try again".
// - badReply: a Quick batch's reply that failed its schema, or was cut off (spec 08, Failures). It
//   is not an outage: its rows take the no-AI path, and the use's later batches go on. Only the
//   BAD_REPLIES_IN_A_ROW-th bad reply in a row of one use is an AI error, with its retries.
// - noWebSearch: the AI provider refused a Merchant lookup's search request with the Quick model
//   (spec 08, Merchant web lookup). It is not an AI error: AI is not away, no retry waits, and no
//   lookup runs until the Quick model changes.
export type AiReply<OUTPUT = undefined> =
  | { ready: true; text: string; output: OUTPUT }
  | { ready: false; pause: AiPause }
  | { ready: false; retryAt: Date }
  | { ready: false; failed: AiFailure }
  | { ready: false; failed: "bad reply"; badReply: true }
  | { ready: false; failed: "server error"; noWebSearch: true };

// The bad reply in a row of one Quick batch use that counts as an AI error, so a model that always
// answers badly stops after its retries (K4).
export const BAD_REPLIES_IN_A_ROW = 3;

// The statuses with which an AI provider refuses a request it cannot run, such as a web search
// tool its model does not take: 400, 404 for a model it has no search for, and 422.
const SEARCH_REFUSED = new Set([400, 404, 422]);
const refusedSearch = (status: number | undefined) =>
  status !== undefined && SEARCH_REFUSED.has(status);

// The one way other modules call the AI. Every call goes out through the cost gate, and its cost
// counts (src/ai/call.ts). The AI provider gets Household data as the app builds it, real names
// included (spec 08, What the AI provider gets).
export type HouseholdAi = {
  // A pause, such as no AI provider or the AI cost cap, makes no call: the use takes its no-AI
  // path. At the cap, Chat and reading a Goal pause with "send anyway?" until the Member says
  // yes with `sendAnyway`. A 401 or 403 from the AI provider pauses AI until a Member fixes the
  // key, with a System notice.
  generate<OUTPUT = undefined>(
    call: AiCall<OUTPUT>,
    options?: { sendAnyway?: boolean },
  ): Promise<AiReply<OUTPUT>>;
  // AI text for the screen, in the one plain voice: no emoji, and "!" turned into ".".
  forScreen(aiText: string): Promise<string>;
  // forScreen for many AI texts, such as a Chat thread's answers.
  forScreenAll(aiTexts: readonly string[]): Promise<string[]>;
  // Why a use would pause now, as generate and stream pause, or undefined when it may call. It
  // makes no call.
  pauseFor(use: AiCall["use"], options?: { sendAnyway?: boolean }): Promise<AiPause | undefined>;
  // Whether a background use waits for its AI retry, so a call now would not go out.
  retryWaits(use: AiCall["use"]): Promise<boolean>;
  // Each Account's name as the AI reads it, by its ID: its own name and last 4, such as "Everyday
  // Checking ending 1234". Two Accounts that would read the same get " 2", " 3" in ID order, so
  // each name the AI writes means one Account.
  accountNames(): Promise<ReadonlyMap<string, string>>;
  // Each Member's name, by their ID.
  memberNames(): Promise<ReadonlyMap<string, string>>;
  // The Merchant lookup (spec 08, Merchant web lookup). Whether a lookup may run now: AI is set up
  // with an AI provider that has a web search, and the Web lookup's switch is on. It makes no call,
  // and says nothing of the AI cost cap, which pauses the call itself.
  webLookupOn(): Promise<boolean>;
  // Merchants wait past one run's cap of lookups: makes the redo of no-AI work due, and starts it,
  // so their lookups run without a Member's press. Each such redo takes 50 of the month's 200
  // places, so the month's cap ends the chain (known finding K4).
  lookupsWait(): Promise<void>;
  // Takes one lookup's place under the month's cap of 200, in one step, or undefined at the cap
  // (known finding K18). `giveBack` returns the place when no call went out.
  reserveLookup(): Promise<{ giveBack(): Promise<void> } | undefined>;
  // Chat's answer, streamed to the browser as the AI writes it (spec 08, Answers), as @ai-sdk/react
  // reads it. A pause makes no call, as for generate. `ended` runs once when the answer ends,
  // before the browser hears that it ended: with the AI's whole text, or with why it failed. A failure never retries by itself, and the browser shows `ended`'s words
  // for it with "Try again". `chatThreadId` names the answer's thread, which the AI request log
  // links each call's text to, so deleting the thread deletes it.
  stream(
    call: AiCall,
    options: {
      sendAnyway?: boolean;
      chatThreadId?: string;
      ended: (end: StreamEnd) => Promise<string | undefined>;
    },
  ): Promise<{ ready: true; response: Response } | { ready: false; pause: AiPause }>;
};

export function householdAi(options: AiOptions): HouseholdAi {
  const { database, logger = log } = options;
  const calls = aiCalls(options);
  const retries = aiRetries(database, noticesOf(options), logger);
  // Each Quick batch use's bad replies in a row. A reply that works ends the row.
  const badReplies = new Map<AiCall["use"], number>();

  // Spec 08, Failures: a rejected key pauses AI until a Member fixes it, with one System notice.
  const keyRejected = (generation: number) => markKeyRejected(options, generation);

  // Spec 08, Redo of no-AI work: a background use that takes its no-AI path marks AI away, and the
  // first one that works after an outage brings it back, which starts one redo. A pause ends on its
  // own, such as when the AI cost cap resets, and the redo module checks for that. Waiting for the
  // history is not a pause of AI: the first AI run follows it. Never fails the use.
  async function noteBackground(reply: AiReply<unknown>): Promise<void> {
    try {
      if (reply.ready) {
        if (await claimAiBack(database, new Date())) {
          logger.info("AI came back after an outage");
          await options.aiBack?.();
        }
      } else if ("pause" in reply) {
        if (reply.pause !== "waits for history") await markAiAway(database, "pause", new Date());
      } else if (!("badReply" in reply) && !("noWebSearch" in reply)) {
        await markAiAway(database, "outage", new Date());
      }
    } catch (error) {
      logger.warn("Whether AI is away could not be recorded", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  // The AI provider refused a lookup's search request with the Quick model it was made from, at
  // `generation`. A save since then may have changed the model, so it notes nothing then.
  async function searchRefused(generation: number): Promise<void> {
    const { settings, generation: now } = await readAiSettingsVersion(database);
    if (settings === undefined || now !== generation) return;
    await storeWebSearchRefused(database, webSearchModel(settings));
    logger.info("The AI provider refused web search with the Quick model");
  }

  async function generate<OUTPUT>(
    call: AiCall<OUTPUT>,
    { sendAnyway = false } = {},
  ): Promise<AiReply<OUTPUT>> {
    const reply = await generateOnce(call, { sendAnyway });
    if (isBackground(call.use)) await noteBackground(reply);
    return reply;
  }

  async function generateOnce<OUTPUT>(
    call: AiCall<OUTPUT>,
    { sendAnyway }: { sendAnyway: boolean },
  ): Promise<AiReply<OUTPUT>> {
    const { use } = call;
    const background = isBackground(use);
    // The use checks its own retry time, whatever started it.
    if (background) {
      const retryAt = await retries.waitsUntil(use, new Date());
      if (retryAt !== undefined) return { ready: false, retryAt };
    }
    const found = await calls.modelFor(use, { sendAnyway });
    if (!found.ready) return found;
    // Spec 08, Live AI status: a background call shows from here to its end, whatever the end.
    const ended = isActivityUse(use) ? startAiActivity(use) : undefined;
    try {
      const reply = await callModel(found.model, call, found.webSearch);
      badReplies.delete(use);
      if (background) await retries.worked(use);
      return { ready: true, ...reply };
    } catch (error) {
      // The gate closed between modelFor and the call, such as at the AI cost cap.
      if (error instanceof AiPausedError) return { ready: false, pause: error.pause };
      if (!(error instanceof AiCallError)) throw error;
      const { failure, status, finishReason } = error;
      // Never the prompt or the reply: only the use, what failed, and why the reply ended.
      logger.warn("An AI call failed", {
        use,
        failure,
        status: status ?? null,
        ...(finishReason === undefined ? {} : { finishReason }),
      });
      if (failure === "key rejected") {
        if (background) await retries.ended(use);
        await keyRejected(found.generation);
        return { ready: false, pause: "key rejected" };
      }
      if (use === "merchant lookup" && failure === "server error" && refusedSearch(status)) {
        await searchRefused(found.generation);
        return { ready: false, failed: failure, noWebSearch: true };
      }
      if (!background) return { ready: false, failed: failure };
      // A Merchant lookup reads web pages, so a bad reply is not an outage either.
      if (failure === "bad reply" && (isQuickBatchUse(use) || use === "merchant lookup")) {
        const inARow = (badReplies.get(use) ?? 0) + 1;
        badReplies.set(use, inARow);
        if (inARow < BAD_REPLIES_IN_A_ROW) return { ready: false, failed: failure, badReply: true };
      }
      const retryAt = await retries.failed(use, new Date());
      return retryAt === undefined ? { ready: false, failed: failure } : { ready: false, retryAt };
    } finally {
      ended?.();
    }
  }

  return {
    generate,
    async stream(call, { sendAnyway = false, chatThreadId, ended }) {
      const { use } = call;
      if (isBackground(use)) throw new TypeError("Only Chat streams its answer.");
      const found = await calls.modelFor(use, {
        sendAnyway,
        ...(chatThreadId === undefined ? {} : { chatThreadId }),
      });
      if (!found.ready) return found;
      const response = streamModel(found.model, call, {
        async ended(end) {
          if ("failed" in end) {
            // Never the prompt or the reply: only the use and what failed.
            logger.warn("An AI call failed", { use, failure: end.failed });
            if (end.failed === "key rejected") await keyRejected(found.generation);
          }
          return ended(end);
        },
      });
      return { ready: true, response };
    },
    forScreen: async (aiText) => plainVoice(aiText),
    forScreenAll: async (aiTexts) => aiTexts.map(plainVoice),
    async pauseFor(use, { sendAnyway = false } = {}) {
      const found = await calls.modelFor(use, { sendAnyway });
      return found.ready ? undefined : found.pause;
    },
    accountNames: async () => accountNamesOf(await listAccounts(database)),
    memberNames: async () =>
      new Map((await listMemberNamesById(database)).map(({ id, name }) => [id, plainName(name)])),
    async retryWaits(use) {
      return (await retries.waitsUntil(use, new Date())) !== undefined;
    },
    async webLookupOn() {
      const stored = await readAiSettings(database);
      if (stored === undefined || (await webSearchMissing(database, stored)) !== null) return false;
      return readWebLookupSwitch(database);
    },
    async lookupsWait() {
      await markAiRedoDue(database, new Date());
      await options.aiBack?.();
    },
    async reserveLookup() {
      const month = await options.cost.currentMonth();
      if (!(await reserveMerchantLookup(database, month, MERCHANT_LOOKUPS_A_MONTH))) {
        return undefined;
      }
      return { giveBack: () => giveBackMerchantLookup(database, month) };
    },
  };
}

// Every control character, and the line and paragraph separators.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters it replaces.
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu;

// A name as one plain line: well-formed, with a space for each control character.
const plainName = (name: string) =>
  name.toWellFormed().replace(CONTROL, " ").replace(/ {2,}/g, " ").trim();

// Each Account's name as the AI reads it, by its ID (HouseholdAi.accountNames).
function accountNamesOf(
  accounts: readonly { id: string; name: string; mask: string | null }[],
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  const taken = new Map<string, number>();
  for (const account of [...accounts].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const mask = plainName(account.mask ?? "");
    const base = `${plainName(account.name) || "Account"}${mask === "" ? "" : ` ending ${mask}`}`;
    const key = base.toLowerCase();
    const count = (taken.get(key) ?? 0) + 1;
    taken.set(key, count);
    names.set(account.id, count === 1 ? base : `${base} ${count}`);
  }
  return names;
}

// One Quick batch, kept row by row (spec 08, Limits on each call). `callFor` makes the call for
// some of the items, in their order, and its rows answer by their place among them; `inBatch`
// turns such an answer into one for the same row among all `items`. The rows with no answer go
// once more, in batches of half the size: all of them after a bad reply, such as one cut off at
// its limit. Returns each answer with its row among `items`, or why the batch has none, as
// generate does. A second call that does not work ends the tries, and its rows have no answer.
export async function generateBatch<ITEM, ANSWER extends { row: number }>(
  ai: HouseholdAi,
  items: readonly ITEM[],
  callFor: (items: readonly ITEM[]) => AiCall<{ answers: ANSWER[] }>,
  inBatch: (answer: ANSWER, asked: readonly ITEM[]) => ANSWER = (answer) => answer,
): Promise<AiReply<{ answers: ANSWER[] }>> {
  const first = await ai.generate(callFor(items));
  if (!first.ready && !("badReply" in first)) return first;
  const answers = first.ready ? [...first.output.answers] : [];
  const answered = new Set(answers.map(({ row }) => row));
  const left = items.flatMap((_, index) => (answered.has(index + 1) ? [] : [index + 1]));
  const size = Math.ceil(items.length / 2);
  let last: AiReply<{ answers: ANSWER[] }> = first;
  for (let start = 0; start < left.length; start += size) {
    const rows = left.slice(start, start + size);
    const asked = rows.map((row) => items[row - 1] as ITEM);
    last = await ai.generate(callFor(asked));
    if (!last.ready) {
      if ("badReply" in last) continue;
      break;
    }
    for (const answer of last.output.answers) {
      const row = rows[answer.row - 1];
      if (row !== undefined) answers.push({ ...inBatch(answer, asked), row });
    }
  }
  if (answers.length > 0) {
    return { ready: true, text: first.ready ? first.text : "", output: { answers } };
  }
  return last;
}
